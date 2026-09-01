-- ═══════════════════════════════════════════════════════════════════════════
-- Control de Costos: de libro de Excel a vista
--
-- ── Cómo funcionaba ────────────────────────────────────────────────────────
-- controlCostos.js escribía filas en la tabla tblGastos de "Control
-- Costos.xlsx", en el Drive de SharePoint, mediante la Workbook API. Seis
-- lugares del servidor lo llamaban:
--
--   registrarGasto()  al aprobar una OC, al aprobar una OS, y al aprobar una
--                     salida de almacén
--   actualizarFila()  al marcar una OC como pagada o entregada, y una OS como
--                     pagada o cumplida
--
-- actualizarFila() buscaba la fila leyendo TODA la tabla del libro y recorriendo
-- las filas hasta encontrar el número de documento. Con cada OC aprobada esa
-- búsqueda se alargaba.
--
-- ── Tres problemas que desaparecen ─────────────────────────────────────────
--
--  1. La fila desincronizada. El libro era una COPIA de datos que ya estaban en
--     las órdenes: si la escritura fallaba —y se llamaba con .catch() que solo
--     escribía una advertencia en el log— el gasto no quedaba registrado y nadie
--     se enteraba. Como vista, no hay copia que pueda faltar.
--
--  2. Las órdenes anuladas después de aprobarse. registrarGasto() escribía al
--     aprobar, pero anular no borraba la fila: actualizarFila() solo se llamaba
--     para pago y entrega. El libro sumaba gastos de órdenes que ya no existían.
--     La vista las excluye por definición.
--
--  3. La búsqueda lineal. Filtrar por proyecto, proveedor o rango de fechas
--     ahora es una consulta con índices.
--
-- ── Lo que se conserva ─────────────────────────────────────────────────────
-- Las mismas 14 columnas que tenía tblGastos, con los mismos nombres de
-- concepto, para que el reporte que la gente ya conoce salga igual. Una ruta
-- exporta la vista a .xlsx con ExcelJS y la sube al mismo sitio: el Excel pasa
-- de ser base de datos a ser reporte.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW erp.vw_gastos AS

-- ── Órdenes de compra ──────────────────────────────────────────────────────
-- Cuentan desde que se aprueban. Las anuladas y los borradores quedan fuera:
-- un borrador todavía no compromete plata, y una anulada dejó de hacerlo.
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

UNION ALL

-- ── Órdenes de servicio ────────────────────────────────────────────────────
-- El "subtotal" de una OS es su columna `valor`, que es lo que registraba
-- controlCostos.js.
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
  -- En una OS el equivalente a la entrega es el cumplimiento.
  s.fecha_cumplido::date              AS fecha_entrega,
  s.creado_por
FROM erp.ordenes_servicio s
  LEFT JOIN erp.proyectos   p  ON p.id  = s.proyecto_id
  LEFT JOIN erp.proveedores pr ON pr.nit = s.proveedor_nit
WHERE s.estado NOT IN ('borrador', 'anulada')

UNION ALL

-- ── Salidas de almacén ─────────────────────────────────────────────────────
-- El consumo de material ya comprado. Se agrupa por documento (SA-####), que es
-- la unidad con la que se aprueba y como se registraba en el libro. Sin IVA:
-- el precio del movimiento ya lo incluye.
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

COMMENT ON VIEW erp.vw_gastos IS
  'Control de Costos. Reemplaza la tabla tblGastos del libro Control Costos.xlsx: los gastos se derivan de las órdenes aprobadas y de las salidas de almacén, así que no hay copia que pueda quedar desincronizada.';

-- ── Resúmenes ───────────────────────────────────────────────────────────────
-- El libro tenía hojas "Por Proyecto", "Por Proveedor" y "Por Tipo Gasto" con
-- fórmulas. Como vistas se calculan al consultarse y no pueden quedar viejas.

CREATE OR REPLACE VIEW erp.vw_gastos_por_proyecto AS
SELECT COALESCE(proyecto, '(sin proyecto)') AS proyecto,
       count(*)      AS documentos,
       sum(subtotal) AS subtotal,
       sum(iva)      AS iva,
       sum(total)    AS total
  FROM erp.vw_gastos
 GROUP BY 1
 ORDER BY sum(total) DESC;

CREATE OR REPLACE VIEW erp.vw_gastos_por_proveedor AS
SELECT COALESCE(proveedor_nombre, '(sin proveedor)') AS proveedor,
       proveedor_nit,
       count(*)      AS documentos,
       sum(total)    AS total
  FROM erp.vw_gastos
 GROUP BY 1, 2
 ORDER BY sum(total) DESC;

CREATE OR REPLACE VIEW erp.vw_gastos_por_tipo AS
SELECT tipo_gasto,
       count(*)      AS documentos,
       sum(total)    AS total
  FROM erp.vw_gastos
 GROUP BY 1
 ORDER BY sum(total) DESC;

-- Las vistas heredan los permisos de las tablas base, pero conviene ser
-- explícito para que un GRANT futuro sobre las tablas no deje las vistas atrás.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    EXECUTE 'GRANT SELECT ON erp.vw_gastos, erp.vw_gastos_por_proyecto, '
         || 'erp.vw_gastos_por_proveedor, erp.vw_gastos_por_tipo TO erp_app';
  END IF;
END
$$;
