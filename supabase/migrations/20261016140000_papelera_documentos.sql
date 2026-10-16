-- Papelera de las órdenes de compra y de servicio.
--
-- Anular y mandar a la papelera son cosas distintas, y conviven:
--   · ANULAR: la orden existió y no sigue. Queda visible, con su número quemado.
--   · PAPELERA: la orden no debía existir (un duplicado, un error). Desaparece de
--     listados, Control de Costos, requerimientos e informes, y SE PUEDE RESTAURAR.
--
-- Nada se borra. La orden queda en su tabla con quién, cuándo y por qué fue a la
-- papelera; sin esas tres columnas, está viva.
--
-- ── Lo que la papelera deshace, y cómo se rehace ───────────────────────────
-- Una orden entregada dejó cosas en otros documentos: su entrada y salida de
-- almacén, su remisión, sus precios en el historial. Mandarla a la papelera los
-- deshace —anula los movimientos, anula la remisión (o la deja para reemplazo si
-- tiene otras órdenes), retira los precios— y cada cambio queda anotado en
-- erp.papelera_efectos con el valor que tenía antes. Restaurar recorre esas filas
-- y devuelve cada valor: queda exactamente como estaba, sin inferir nada.

ALTER TABLE erp.ordenes_compra
  ADD COLUMN IF NOT EXISTS papelera_en     timestamptz,
  ADD COLUMN IF NOT EXISTS papelera_por    text,
  ADD COLUMN IF NOT EXISTS papelera_motivo text;

ALTER TABLE erp.ordenes_servicio
  ADD COLUMN IF NOT EXISTS papelera_en     timestamptz,
  ADD COLUMN IF NOT EXISTS papelera_por    text,
  ADD COLUMN IF NOT EXISTS papelera_motivo text;

-- Las tres van juntas, y la papelera siempre tiene motivo.
ALTER TABLE erp.ordenes_compra ADD CONSTRAINT ordenes_compra_papelera_coherente
  CHECK ((papelera_en IS NULL AND papelera_por IS NULL AND papelera_motivo IS NULL)
      OR (papelera_en IS NOT NULL AND btrim(coalesce(papelera_por, '')) <> ''
          AND btrim(coalesce(papelera_motivo, '')) <> ''));
ALTER TABLE erp.ordenes_servicio ADD CONSTRAINT ordenes_servicio_papelera_coherente
  CHECK ((papelera_en IS NULL AND papelera_por IS NULL AND papelera_motivo IS NULL)
      OR (papelera_en IS NOT NULL AND btrim(coalesce(papelera_por, '')) <> ''
          AND btrim(coalesce(papelera_motivo, '')) <> ''));

CREATE INDEX IF NOT EXISTS ordenes_compra_papelera_idx
  ON erp.ordenes_compra (papelera_en DESC) WHERE papelera_en IS NOT NULL;
CREATE INDEX IF NOT EXISTS ordenes_servicio_papelera_idx
  ON erp.ordenes_servicio (papelera_en DESC) WHERE papelera_en IS NOT NULL;

COMMENT ON COLUMN erp.ordenes_compra.papelera_en IS
  'Cuándo se mandó a la papelera. NULL = la orden está viva. Ver erp.papelera_efectos.';
COMMENT ON COLUMN erp.ordenes_servicio.papelera_en IS
  'Cuándo se mandó a la papelera. NULL = la orden está viva. Ver erp.papelera_efectos.';

-- ── Lo que la papelera cambió en otros documentos ───────────────────────────
CREATE TABLE erp.papelera_efectos (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documento_tipo  text        NOT NULL,
  documento_id    bigint      NOT NULL,
  tabla           text        NOT NULL,
  fila_id         bigint      NOT NULL,
  -- Las columnas que se cambiaron, con el valor que tenían ANTES. Es lo que
  -- restaurar vuelve a escribir.
  antes           jsonb       NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  revertido_en    timestamptz,
  CONSTRAINT papelera_efectos_tipo_valido
    CHECK (documento_tipo IN ('orden_compra', 'orden_servicio')),
  CONSTRAINT papelera_efectos_tabla_valida
    CHECK (tabla IN ('movimientos_inventario', 'remisiones', 'historial_precios'))
);

CREATE INDEX papelera_efectos_pendientes_idx
  ON erp.papelera_efectos (documento_tipo, documento_id)
  WHERE revertido_en IS NULL;

COMMENT ON TABLE erp.papelera_efectos IS
  'Cada cambio que hizo la papelera en otro documento (movimiento de almacén, remisión, '
  'precio), con el valor anterior. Restaurar la orden los revierte y marca revertido_en.';

-- ── Control de Costos: lo que está en la papelera no cuenta ─────────────────
-- Misma vista que en 20260901140000, con el filtro de papelera en las órdenes.
-- Las salidas de almacén no lo necesitan: la papelera las anula, y las anuladas
-- ya quedaban fuera.
CREATE OR REPLACE VIEW erp.vw_gastos AS
SELECT
  'orden_compra'                      AS origen,
  o.id                                AS origen_id,
  o.numero_oc                         AS numero,
  o.fecha_creacion::date              AS fecha_documento,
  p.codigo                            AS proyecto,
  o.proveedor_nit,
  pr.razon_social                     AS proveedor_nombre,
  COALESCE(nullif(o.tipo_gasto, ''), 'Orden de compra') AS tipo_gasto,
  o.subtotal,
  o.iva,
  o.total,
  o.estado,
  o.fecha_aprobacion::date            AS fecha_aprobacion,
  o.fecha_pago::date                  AS fecha_pago,
  o.fecha_entrega::date               AS fecha_entrega,
  o.creado_por
FROM erp.ordenes_compra o
  LEFT JOIN erp.proyectos   p  ON p.id  = o.proyecto_id
  LEFT JOIN erp.proveedores pr ON pr.nit = o.proveedor_nit
WHERE o.estado NOT IN ('borrador', 'anulada')
  AND o.papelera_en IS NULL

UNION ALL

SELECT
  'orden_servicio'                    AS origen,
  s.id                                AS origen_id,
  s.numero_os                         AS numero,
  s.fecha_creacion::date              AS fecha_documento,
  p.codigo                            AS proyecto,
  s.proveedor_nit,
  pr.razon_social                     AS proveedor_nombre,
  COALESCE(nullif(s.tipo_gasto, ''), 'Orden de servicio') AS tipo_gasto,
  s.valor                             AS subtotal,
  s.iva,
  s.total,
  s.estado,
  s.fecha_aprobacion::date            AS fecha_aprobacion,
  s.fecha_pago::date                  AS fecha_pago,
  s.fecha_cumplido::date              AS fecha_entrega,
  s.creado_por
FROM erp.ordenes_servicio s
  LEFT JOIN erp.proyectos   p  ON p.id  = s.proyecto_id
  LEFT JOIN erp.proveedores pr ON pr.nit = s.proveedor_nit
WHERE s.estado NOT IN ('borrador', 'anulada')
  AND s.papelera_en IS NULL

UNION ALL

SELECT
  'salida_almacen'                    AS origen,
  min(m.id)                           AS origen_id,
  m.documento_ref                     AS numero,
  max(m.fecha)::date                  AS fecha_documento,
  p.codigo                            AS proyecto,
  NULL                                AS proveedor_nit,
  NULL                                AS proveedor_nombre,
  'Salida Almacén'                    AS tipo_gasto,
  sum(m.valor_total)                  AS subtotal,
  0::numeric(16,2)                    AS iva,
  sum(m.valor_total)                  AS total,
  'ejecutado'                         AS estado,
  max(m.fecha)::date                  AS fecha_aprobacion,
  NULL::date                          AS fecha_pago,
  max(m.fecha)::date                  AS fecha_entrega,
  min(m.creado_por)                   AS creado_por
FROM erp.movimientos_inventario m
  LEFT JOIN erp.proyectos p ON p.id = m.proyecto_id
WHERE m.tipo = 'salida'
  AND m.estado <> 'anulado'
  AND m.estado_doc = 'aprobado'
  AND m.documento_ref IS NOT NULL
GROUP BY m.documento_ref, p.codigo;

-- ── La bandeja de sin proyecto tampoco las lista ────────────────────────────
-- Misma vista que en 20261006130000, con el filtro de papelera.
CREATE OR REPLACE VIEW erp.vw_documentos_sin_proyecto AS
  SELECT 'orden_compra'::text AS tipo, o.id, o.numero_oc AS numero,
         o.proyecto_texto, o.created_at, 'sin_proyecto'::text AS motivo,
         NULL::text AS proyecto
    FROM erp.ordenes_compra o
   WHERE o.proyecto_id IS NULL AND o.estado IS DISTINCT FROM 'anulada'
     AND o.papelera_en IS NULL
  UNION ALL
  SELECT 'orden_servicio', s.id, s.numero_os, s.proyecto_texto, s.created_at,
         'sin_proyecto', NULL
    FROM erp.ordenes_servicio s
   WHERE s.proyecto_id IS NULL AND s.estado IS DISTINCT FROM 'anulada'
     AND s.papelera_en IS NULL
  UNION ALL
  SELECT 'remision', m.id, m.numero, m.proyecto_texto, m.created_at,
         'sin_proyecto', NULL
    FROM erp.remisiones m
   WHERE m.proyecto_id IS NULL AND m.estado IS DISTINCT FROM 'anulada'
  UNION ALL
  SELECT 'movimiento_inventario', i.id, i.id::text, i.proyecto_texto, i.created_at,
         'sin_proyecto', NULL
    FROM erp.movimientos_inventario i
   WHERE i.proyecto_id IS NULL AND i.estado IS DISTINCT FROM 'anulado';
