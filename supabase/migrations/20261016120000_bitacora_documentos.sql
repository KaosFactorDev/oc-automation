-- Bitácora de las órdenes de compra y de servicio.
--
-- Hasta acá un documento solo guardaba la ÚLTIMA versión de sí mismo y, en las
-- columnas *_por, quién hizo cada transición. No quedaba qué cambió, ni cuándo, ni
-- por qué. Y como esas columnas se llenaban con USUARIO_EMAIL —la cuenta fija del
-- servidor—, tampoco decían de verdad quién.
--
-- Desde esta migración, cada acción sobre una orden deja una fila acá con:
--   · quién (el correo de la sesión de la consola, o la persona de RRHH que la pidió
--     por la API),
--   · qué acción (crear, editar, aprobar, anular, pagar, entregar, cumplir…),
--   · el motivo, cuando la acción lo exige,
--   · y el documento COMPLETO antes y después —cabecera e ítems—, en jsonb.
--
-- Guardar las dos fotos completas, y no un diff, es a propósito: el diff se calcula
-- al mostrarlo, y si mañana se agrega una columna al documento, las fotos viejas
-- siguen diciendo exactamente cómo estaba.
--
-- ⚠ SOLO SE AGREGA. Una bitácora que se puede editar no prueba nada. Por eso:
--   · erp_app (la aplicación) solo puede leer e insertar: se le quitan UPDATE,
--     DELETE y TRUNCATE, que los privilegios por defecto del esquema le darían;
--   · y un trigger rechaza cualquier UPDATE o DELETE, venga de quien venga, incluido
--     el dueño de la tabla. Corregir algo es agregar una fila nueva que lo explique.

CREATE TABLE erp.documentos_historial (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documento_tipo  text        NOT NULL,
  documento_id    bigint      NOT NULL,
  -- El número como estaba en ese momento: un borrador no lo tiene todavía, y así la
  -- fila se entiende sin cruzarla con el documento.
  numero          text,
  accion          text        NOT NULL,
  usuario         text        NOT NULL,
  usuario_nombre  text,
  -- consola: una persona en la consola · api-rrhh: KAOS por /api · sistema: un
  -- proceso sin persona (correo, scripts).
  origen          text        NOT NULL DEFAULT 'consola',
  motivo          text,
  antes           jsonb,
  despues         jsonb,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documentos_historial_tipo_valido
    CHECK (documento_tipo IN ('orden_compra', 'orden_servicio')),
  CONSTRAINT documentos_historial_origen_valido
    CHECK (origen IN ('consola', 'api-rrhh', 'sistema')),
  CONSTRAINT documentos_historial_accion_no_vacia CHECK (btrim(accion) <> ''),
  CONSTRAINT documentos_historial_usuario_no_vacio CHECK (btrim(usuario) <> '')
);

-- Sin FK al documento: hay dos tablas posibles, y la bitácora tiene que sobrevivir a
-- lo que le pase al documento.
CREATE INDEX documentos_historial_documento_idx
  ON erp.documentos_historial (documento_tipo, documento_id, creado_en);
CREATE INDEX documentos_historial_creado_idx
  ON erp.documentos_historial (creado_en DESC);

COMMENT ON TABLE erp.documentos_historial IS
  'Bitácora de solo agregar de las órdenes de compra y de servicio: quién, qué acción, '
  'motivo y el documento completo antes y después. No admite UPDATE ni DELETE.';

-- ── Solo agregar ────────────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON erp.documentos_historial FROM erp_app;
GRANT SELECT, INSERT ON erp.documentos_historial TO erp_app;

CREATE FUNCTION erp.documentos_historial_inmutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'erp.documentos_historial es de solo agregar: no se modifica ni se borra'
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER documentos_historial_sin_update_delete
  BEFORE UPDATE OR DELETE ON erp.documentos_historial
  FOR EACH ROW EXECUTE FUNCTION erp.documentos_historial_inmutable();

CREATE TRIGGER documentos_historial_sin_truncate
  BEFORE TRUNCATE ON erp.documentos_historial
  FOR EACH STATEMENT EXECUTE FUNCTION erp.documentos_historial_inmutable();
