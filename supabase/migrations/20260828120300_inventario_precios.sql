-- ═══════════════════════════════════════════════════════════════════════════
-- 004 — Inventario e historial de precios
--
-- Cubre las 2 listas restantes:
--   MovimientosInventario · HistorialPrecios
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Movimientos de inventario ──────────────────────────────────────────────
-- Entradas y salidas de almacén. En SQLite era un blob JSON con dos índices
-- json_extract; acá son columnas con tipos y llaves reales.

CREATE TABLE erp.movimientos_inventario (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo            text          NOT NULL,
  fecha           timestamptz   NOT NULL,
  proyecto_id     bigint        REFERENCES erp.proyectos(id) ON DELETE RESTRICT,
  orden_compra_id bigint        REFERENCES erp.ordenes_compra(id) ON DELETE SET NULL,
  insumo          text          NOT NULL,
  unidad          text          NOT NULL DEFAULT 'UND',
  cantidad        numeric(16,3) NOT NULL DEFAULT 0,
  precio_unitario numeric(16,2) NOT NULL DEFAULT 0,
  -- En SharePoint valorTotal se guardaba y podía discrepar de cantidad ×
  -- precio. Acá se calcula y no puede.
  valor_total     numeric(16,2) GENERATED ALWAYS AS
    (round(cantidad * precio_unitario, 2)) STORED,
  responsable     text,
  notas           text,
  estado          text          NOT NULL DEFAULT 'activo',
  -- Consecutivo propio del almacén: EA-#### para entradas, SA-#### para
  -- salidas. Lo emite erp.siguiente_documento_almacen() (ver la migración numeracion).
  documento_ref   text,
  estado_doc      text          NOT NULL DEFAULT 'borrador',
  -- Agrupa los movimientos cargados en una misma operación, para poder
  -- anularlos juntos.
  batch_id        text,
  creado_por      text,
  fecha_creacion  timestamptz   NOT NULL DEFAULT now(),
  sp_id           text          UNIQUE,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT movimientos_tipo_valido       CHECK (tipo IN ('entrada', 'salida')),
  CONSTRAINT movimientos_estado_valido     CHECK (estado IN ('activo', 'anulado')),
  CONSTRAINT movimientos_estado_doc_valido CHECK (estado_doc IN ('borrador', 'aprobado', 'anulado')),
  CONSTRAINT movimientos_insumo_no_vacio   CHECK (btrim(insumo) <> ''),
  -- Una cantidad negativa acá significaría una entrada que resta o una salida
  -- que suma. El signo lo lleva la columna tipo, no la cantidad.
  CONSTRAINT movimientos_cantidad_positiva CHECK (cantidad >= 0)
);

CREATE INDEX movimientos_proyecto_idx  ON erp.movimientos_inventario (proyecto_id);
CREATE INDEX movimientos_tipo_idx      ON erp.movimientos_inventario (tipo);
CREATE INDEX movimientos_oc_idx        ON erp.movimientos_inventario (orden_compra_id);
CREATE INDEX movimientos_insumo_idx    ON erp.movimientos_inventario (erp.norm(insumo));
CREATE INDEX movimientos_fecha_idx     ON erp.movimientos_inventario (fecha DESC);
CREATE INDEX movimientos_batch_idx     ON erp.movimientos_inventario (batch_id)
  WHERE batch_id IS NOT NULL;
CREATE INDEX movimientos_documento_idx ON erp.movimientos_inventario (documento_ref)
  WHERE documento_ref IS NOT NULL;

CREATE TRIGGER movimientos_updated_at BEFORE UPDATE ON erp.movimientos_inventario
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Historial de precios ───────────────────────────────────────────────────
-- Es la tabla que alimenta el Buscador de Precios y la sugerencia de proveedor
-- de consultaProveedor.js. La lista de SharePoint reemplazó a compras.csv y
-- heredó su problema: la fecha es una columna de TEXTO con cuatro formatos
-- conviviendo (medidos sobre las 5.472 filas actuales):
--
--   "junio 23, 2026"        3.721 filas   (formato del CSV original)
--   "23 de junio de 2026"   1.562 filas   (es-CO largo, al aprobar una OC)
--   "2026-06-23"              123 filas   (ISO)
--   "23/04/2026"           ~ 66 filas    (DD/MM/YYYY)
--
-- Se guardan las dos: fecha_texto conserva el original sin tocarlo, y fecha es
-- la interpretación. Donde el parseo falle, fecha queda NULL y el dato crudo
-- sigue ahí para revisar — nada se pierde y nada se inventa.

CREATE TABLE erp.historial_precios (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proyecto_id      bigint        REFERENCES erp.proyectos(id) ON DELETE RESTRICT,
  numero_compra    text,
  tipo_compra      text,
  insumo           text          NOT NULL,
  cantidad         numeric(16,3) NOT NULL DEFAULT 0,
  precio_unitario  numeric(16,2) NOT NULL,
  valor_total      numeric(16,2) NOT NULL DEFAULT 0,
  fecha            date,
  fecha_texto      text,
  proveedor_nit    text          REFERENCES erp.proveedores(nit) ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Nombre tal como venía en la fuente. Se conserva porque en el histórico hay
  -- filas cuyo NIT no resuelve a ningún proveedor del catálogo.
  proveedor_nombre text,
  estado_compra    text,
  forma_pago       text,
  anticipo         numeric(16,2) NOT NULL DEFAULT 0,
  zona             text          REFERENCES erp.zonas(zona) ON UPDATE CASCADE,
  sp_id            text          UNIQUE,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT historial_insumo_no_vacio   CHECK (btrim(insumo) <> ''),
  CONSTRAINT historial_precio_no_negativo CHECK (precio_unitario >= 0)
);

-- El buscador consulta por insumo normalizado y ordena por fecha descendente:
-- este índice compuesto cubre las dos cosas en una pasada.
CREATE INDEX historial_insumo_fecha_idx
  ON erp.historial_precios (erp.norm(insumo), fecha DESC NULLS LAST);
CREATE INDEX historial_proveedor_idx ON erp.historial_precios (proveedor_nit);
CREATE INDEX historial_proyecto_idx  ON erp.historial_precios (proyecto_id);
CREATE INDEX historial_fecha_idx     ON erp.historial_precios (fecha DESC NULLS LAST);
-- Filas que quedaron sin fecha interpretable, para poder listarlas y limpiarlas.
CREATE INDEX historial_sin_fecha_idx ON erp.historial_precios (id) WHERE fecha IS NULL;

CREATE TRIGGER historial_precios_updated_at BEFORE UPDATE ON erp.historial_precios
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

COMMENT ON COLUMN erp.historial_precios.fecha_texto IS
  'Valor original de la columna fecha en SharePoint, sin normalizar. Se conserva como respaldo del parseo a la columna fecha.';
