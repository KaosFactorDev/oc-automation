-- ═══════════════════════════════════════════════════════════════════════════
-- 003 — Documentos
--
-- Cubre 4 de las 11 listas:
--   Requerimientos · OrdenesCompra · OrdenesServicio · Remisiones
--
-- El cambio de fondo respecto a SharePoint (y al SQLite actual, que guarda un
-- blob JSON en una columna "data") es que los ítems dejan de ser un string
-- itemsJson y pasan a ser tablas hijas. Eso es lo que permite después:
--   - sumar por insumo, proveedor o proyecto sin leer todos los documentos
--   - que el control de costos sea una consulta y no un archivo aparte
--   - detectar un ítem sin descripción al escribirlo, no meses después cuando
--     el PDF sale con la celda vacía
--
-- Los ítems de OC venían con DOS formas distintas según por dónde se creó la
-- orden: 692 traen la clave "descripcion" (alta manual) y 546 traen "insumo"
-- (generación desde un requerimiento). El código lo parcheaba en 9 lugares con
-- la expresión (descripcion o insumo). Acá hay una sola columna y el import
-- resuelve la ambigüedad una vez.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Requerimientos ─────────────────────────────────────────────────────────

CREATE TABLE erp.requerimientos (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consecutivo          text        NOT NULL DEFAULT '',
  -- Consecutivo que asigna el sistema (REQ-####). Existía en los datos pero
  -- no estaba declarado como columna en esquemas.js.
  consecutivo_sistema  text,
  proyecto_id          bigint      REFERENCES erp.proyectos(id) ON DELETE RESTRICT,
  fecha_solicitud      timestamptz,
  solicitante          text,
  estado               text        NOT NULL DEFAULT 'pendiente',
  origen_correo_id     text,
  adjunto_url          text,
  bloqueado_por        text,
  bloqueado_hasta      timestamptz,
  notas                text,
  sp_id                text        UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requerimientos_estado_valido
    CHECK (estado IN ('pendiente', 'parcial', 'gestionado', 'cerrado', 'anulado'))
);

CREATE INDEX requerimientos_proyecto_idx    ON erp.requerimientos (proyecto_id);
CREATE INDEX requerimientos_estado_idx      ON erp.requerimientos (estado);
CREATE INDEX requerimientos_consecutivo_idx ON erp.requerimientos (consecutivo);

-- Un mismo correo no debe generar dos requerimientos. Antes esto se evitaba
-- releyendo la lista completa y comparando en memoria.
CREATE UNIQUE INDEX requerimientos_origen_correo_key
  ON erp.requerimientos (origen_correo_id)
  WHERE origen_correo_id IS NOT NULL AND origen_correo_id <> '';

CREATE TRIGGER requerimientos_updated_at BEFORE UPDATE ON erp.requerimientos
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

COMMENT ON TABLE erp.requerimientos IS
  'La columna ocsGeneradas de SharePoint no se migra: era una lista de ids en texto separada por comas, duplicando lo que ya dice ordenes_compra.requerimiento_id.';

-- ── Ítems de requerimiento ─────────────────────────────────────────────────

CREATE TABLE erp.requerimiento_items (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requerimiento_id  bigint        NOT NULL REFERENCES erp.requerimientos(id) ON DELETE CASCADE,
  linea             smallint      NOT NULL,
  insumo            text          NOT NULL,
  cantidad          numeric(16,3) NOT NULL DEFAULT 0,
  unidad            text          NOT NULL DEFAULT 'UND',
  necesidad         text,
  posible_proveedor text,
  -- Cuando se homologa un insumo escrito a mano contra el catálogo, se guarda
  -- acá el nombre canónico con el que quedó emparejado.
  homologado_con    text,
  descartado        boolean       NOT NULL DEFAULT false,
  -- Resultado de consultaProveedor.js: proveedor y precio sugeridos, más las
  -- alertas. Es información derivada y de forma variable, así que jsonb es el
  -- tipo correcto — a diferencia del resto del documento, que sí es estable.
  consulta          jsonb,
  CONSTRAINT requerimiento_items_insumo_no_vacio CHECK (btrim(insumo) <> ''),
  CONSTRAINT requerimiento_items_linea_unica     UNIQUE (requerimiento_id, linea)
);

CREATE INDEX requerimiento_items_req_idx    ON erp.requerimiento_items (requerimiento_id);
CREATE INDEX requerimiento_items_insumo_idx ON erp.requerimiento_items (erp.norm(insumo));

-- ── Órdenes de compra ──────────────────────────────────────────────────────

CREATE TABLE erp.ordenes_compra (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Nullable a propósito: el número solo se asigna al aprobar. En SharePoint
  -- las órdenes sin aprobar guardaban cadena vacía y no se podía poner un
  -- índice único encima. En Postgres varios NULL sí conviven bajo UNIQUE.
  numero_oc                 text,
  requerimiento_id          bigint        REFERENCES erp.requerimientos(id) ON DELETE SET NULL,
  requerimiento_origen      text,
  cotizacion_id             text,
  proveedor_nit             text          REFERENCES erp.proveedores(nit) ON UPDATE CASCADE ON DELETE RESTRICT,
  proyecto_id               bigint        REFERENCES erp.proyectos(id) ON DELETE RESTRICT,
  subtotal                  numeric(16,2) NOT NULL DEFAULT 0,
  iva                       numeric(16,2) NOT NULL DEFAULT 0,
  total                     numeric(16,2) NOT NULL DEFAULT 0,
  estado                    text          NOT NULL DEFAULT 'borrador',
  tipo_gasto                text,
  lugar_entrega             text,
  fecha_entrega_prevista    timestamptz,
  condiciones_comerciales   text,
  observaciones             text,
  creado_por                text,
  fecha_creacion            timestamptz   NOT NULL DEFAULT now(),
  aprobado_por              text,
  fecha_aprobacion          timestamptz,
  anulado_por               text,
  fecha_anulacion           timestamptz,
  motivo_anulacion          text,
  pagado                    boolean       NOT NULL DEFAULT false,
  pagado_por                text,
  fecha_pago                timestamptz,
  entregado                 boolean       NOT NULL DEFAULT false,
  entregado_por             text,
  fecha_entrega             timestamptz,
  -- Los PDF y XLSX siguen viviendo en el Drive de SharePoint; acá solo la URL.
  pdf_url                   text,
  xlsx_url                  text,
  -- Integración con tesorería (Cash_Flow). Estaban en los datos sin estar
  -- declarados en esquemas.js.
  solicitud_tesoreria_id    text,
  solicitud_tesoreria_por   text,
  fecha_solicitud_tesoreria timestamptz,
  sp_id                     text          UNIQUE,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ordenes_compra_estado_valido
    CHECK (estado IN ('borrador', 'aprobada', 'anulada', 'pagada', 'entregada', 'finalizada')),
  -- Una orden aprobada sin número es imposible de rastrear en el consecutivo.
  CONSTRAINT ordenes_compra_aprobada_con_numero
    CHECK (estado IN ('borrador', 'anulada') OR numero_oc IS NOT NULL)
);

CREATE UNIQUE INDEX ordenes_compra_numero_key ON erp.ordenes_compra (numero_oc)
  WHERE numero_oc IS NOT NULL;
CREATE INDEX ordenes_compra_proyecto_idx   ON erp.ordenes_compra (proyecto_id);
CREATE INDEX ordenes_compra_proveedor_idx  ON erp.ordenes_compra (proveedor_nit);
CREATE INDEX ordenes_compra_estado_idx     ON erp.ordenes_compra (estado);
CREATE INDEX ordenes_compra_req_idx        ON erp.ordenes_compra (requerimiento_id);
CREATE INDEX ordenes_compra_aprobacion_idx ON erp.ordenes_compra (fecha_aprobacion DESC);

CREATE TRIGGER ordenes_compra_updated_at BEFORE UPDATE ON erp.ordenes_compra
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Ítems de orden de compra ───────────────────────────────────────────────

CREATE TABLE erp.orden_compra_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orden_compra_id  bigint        NOT NULL REFERENCES erp.ordenes_compra(id) ON DELETE CASCADE,
  linea            smallint      NOT NULL,
  -- Una sola columna donde antes había "descripcion" o "insumo" según el
  -- camino de creación.
  descripcion      text          NOT NULL,
  -- Nombre tal como lo escribió quien hizo el requerimiento, antes de
  -- homologarlo contra el catálogo. Solo lo traen los ítems generados desde
  -- un requerimiento.
  insumo_original  text,
  cantidad         numeric(16,3) NOT NULL DEFAULT 0,
  unidad           text          NOT NULL DEFAULT 'UND',
  precio_unitario  numeric(16,2) NOT NULL DEFAULT 0,
  descuento_pct    numeric(5,2)  NOT NULL DEFAULT 0,
  iva_pct          numeric(5,2)  NOT NULL DEFAULT 0,
  -- Calculadas, no guardadas por el código. Antes cada plantilla y cada ruta
  -- repetía la misma aritmética y podían discrepar.
  valor_bruto      numeric(16,2) GENERATED ALWAYS AS
    (round(cantidad * precio_unitario * (1 - descuento_pct / 100), 2)) STORED,
  valor_iva        numeric(16,2) GENERATED ALWAYS AS
    (round(cantidad * precio_unitario * (1 - descuento_pct / 100) * iva_pct / 100, 2)) STORED,
  CONSTRAINT orden_compra_items_descripcion_no_vacia CHECK (btrim(descripcion) <> ''),
  CONSTRAINT orden_compra_items_pct_rango
    CHECK (descuento_pct BETWEEN 0 AND 100 AND iva_pct BETWEEN 0 AND 100),
  CONSTRAINT orden_compra_items_linea_unica UNIQUE (orden_compra_id, linea)
);

CREATE INDEX orden_compra_items_oc_idx   ON erp.orden_compra_items (orden_compra_id);
CREATE INDEX orden_compra_items_desc_idx ON erp.orden_compra_items (erp.norm(descripcion));

-- ── Órdenes de servicio ────────────────────────────────────────────────────

CREATE TABLE erp.ordenes_servicio (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero_os                    text,
  requerimiento_id             bigint        REFERENCES erp.requerimientos(id) ON DELETE SET NULL,
  proyecto_id                  bigint        REFERENCES erp.proyectos(id) ON DELETE RESTRICT,
  proveedor_nit                text          REFERENCES erp.proveedores(nit) ON UPDATE CASCADE ON DELETE RESTRICT,
  tipo_servicio                text,
  clausulas                    text,
  oferta_economica_ref         text,
  oferta_economica_condiciones text,
  valor                        numeric(16,2) NOT NULL DEFAULT 0,
  iva                          numeric(16,2) NOT NULL DEFAULT 0,
  total                        numeric(16,2) NOT NULL DEFAULT 0,
  -- Contrato con AIU: administración, imprevistos y utilidad.
  tipo_contrato                text          NOT NULL DEFAULT 'IVA_PLENO',
  aiu_a                        numeric(16,2) NOT NULL DEFAULT 0,
  aiu_i                        numeric(16,2) NOT NULL DEFAULT 0,
  aiu_u                        numeric(16,2) NOT NULL DEFAULT 0,
  estado                       text          NOT NULL DEFAULT 'borrador',
  tipo_gasto                   text,
  lugar_prestacion             text,
  fecha_inicio                 timestamptz,
  fecha_fin                    timestamptz,
  condiciones_comerciales      text,
  observaciones                text,
  creado_por                   text,
  fecha_creacion               timestamptz   NOT NULL DEFAULT now(),
  aprobado_por                 text,
  fecha_aprobacion             timestamptz,
  anulado_por                  text,
  fecha_anulacion              timestamptz,
  motivo_anulacion             text,
  pagado                       boolean       NOT NULL DEFAULT false,
  pagado_por                   text,
  fecha_pago                   timestamptz,
  cumplido                     boolean       NOT NULL DEFAULT false,
  cumplido_por                 text,
  fecha_cumplido               timestamptz,
  pdf_url                      text,
  sp_id                        text          UNIQUE,
  created_at                   timestamptz   NOT NULL DEFAULT now(),
  updated_at                   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ordenes_servicio_estado_valido
    CHECK (estado IN ('borrador', 'aprobada', 'anulada', 'finalizada')),
  CONSTRAINT ordenes_servicio_tipo_contrato_valido
    CHECK (tipo_contrato IN ('IVA_PLENO', 'AIU')),
  CONSTRAINT ordenes_servicio_aprobada_con_numero
    CHECK (estado IN ('borrador', 'anulada') OR numero_os IS NOT NULL),
  -- Las fechas de un servicio no pueden ir al revés.
  CONSTRAINT ordenes_servicio_rango_fechas
    CHECK (fecha_inicio IS NULL OR fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

CREATE UNIQUE INDEX ordenes_servicio_numero_key ON erp.ordenes_servicio (numero_os)
  WHERE numero_os IS NOT NULL;
CREATE INDEX ordenes_servicio_proyecto_idx   ON erp.ordenes_servicio (proyecto_id);
CREATE INDEX ordenes_servicio_proveedor_idx  ON erp.ordenes_servicio (proveedor_nit);
CREATE INDEX ordenes_servicio_estado_idx     ON erp.ordenes_servicio (estado);
CREATE INDEX ordenes_servicio_aprobacion_idx ON erp.ordenes_servicio (fecha_aprobacion DESC);

CREATE TRIGGER ordenes_servicio_updated_at BEFORE UPDATE ON erp.ordenes_servicio
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Ítems de orden de servicio ─────────────────────────────────────────────

CREATE TABLE erp.orden_servicio_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orden_servicio_id  bigint        NOT NULL REFERENCES erp.ordenes_servicio(id) ON DELETE CASCADE,
  linea              smallint      NOT NULL,
  descripcion        text          NOT NULL,
  cantidad           numeric(16,3) NOT NULL DEFAULT 0,
  unidad             text          NOT NULL DEFAULT 'GLB',
  precio_unitario    numeric(16,2) NOT NULL DEFAULT 0,
  iva_pct            numeric(5,2)  NOT NULL DEFAULT 0,
  valor_bruto        numeric(16,2) GENERATED ALWAYS AS
    (round(cantidad * precio_unitario, 2)) STORED,
  CONSTRAINT orden_servicio_items_descripcion_no_vacia CHECK (btrim(descripcion) <> ''),
  CONSTRAINT orden_servicio_items_iva_rango            CHECK (iva_pct BETWEEN 0 AND 100),
  CONSTRAINT orden_servicio_items_linea_unica          UNIQUE (orden_servicio_id, linea)
);

CREATE INDEX orden_servicio_items_os_idx ON erp.orden_servicio_items (orden_servicio_id);

-- ── Remisiones ─────────────────────────────────────────────────────────────

CREATE TABLE erp.remisiones (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero                text        NOT NULL,
  fecha                 timestamptz,
  proyecto_id           bigint      REFERENCES erp.proyectos(id) ON DELETE RESTRICT,
  observaciones         text,
  responsable_entrega   text,
  responsable_recepcion text,
  lugar_entrega         text,
  estado                text        NOT NULL DEFAULT 'activa',
  motivo_anulacion      text,
  alertas               text,
  creado_por            text,
  fecha_creacion        timestamptz NOT NULL DEFAULT now(),
  sp_id                 text        UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remisiones_estado_valido
    CHECK (estado IN ('activa', 'anulada', 'requiere-reemplazo')),
  CONSTRAINT remisiones_numero_no_vacio CHECK (btrim(numero) <> '')
);

CREATE UNIQUE INDEX remisiones_numero_key   ON erp.remisiones (numero);
CREATE INDEX        remisiones_proyecto_idx ON erp.remisiones (proyecto_id);
CREATE INDEX        remisiones_estado_idx   ON erp.remisiones (estado);

CREATE TRIGGER remisiones_updated_at BEFORE UPDATE ON erp.remisiones
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Remisión ↔ órdenes de compra ───────────────────────────────────────────
-- En SharePoint eran dos columnas de texto: ocIds con un array JSON de ids y
-- ocsAsociadas con los números en texto para mostrar. La segunda no se migra:
-- se deriva de esta tabla con un join.

CREATE TABLE erp.remision_ordenes (
  remision_id     bigint NOT NULL REFERENCES erp.remisiones(id) ON DELETE CASCADE,
  orden_compra_id bigint NOT NULL REFERENCES erp.ordenes_compra(id) ON DELETE RESTRICT,
  PRIMARY KEY (remision_id, orden_compra_id)
);

CREATE INDEX remision_ordenes_oc_idx ON erp.remision_ordenes (orden_compra_id);

-- ── Ítems de remisión ──────────────────────────────────────────────────────
-- Son los ítems de las OC asociadas, consolidados por descripción y unidad.

CREATE TABLE erp.remision_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  remision_id bigint        NOT NULL REFERENCES erp.remisiones(id) ON DELETE CASCADE,
  linea       smallint      NOT NULL,
  descripcion text          NOT NULL,
  cantidad    numeric(16,3) NOT NULL DEFAULT 0,
  unidad      text          NOT NULL DEFAULT 'UND',
  observacion text,
  CONSTRAINT remision_items_descripcion_no_vacia CHECK (btrim(descripcion) <> ''),
  CONSTRAINT remision_items_linea_unica          UNIQUE (remision_id, linea)
);

CREATE INDEX remision_items_remision_idx ON erp.remision_items (remision_id);
