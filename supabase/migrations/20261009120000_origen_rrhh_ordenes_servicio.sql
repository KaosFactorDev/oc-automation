-- Procedencia de las órdenes de servicio que crea RRHH (KAOS) por la API.
--
-- RRHH registra en el ERP los exámenes médicos de ingreso como orden de
-- servicio, por POST /api/ordenes-servicio. Ver docs/contrato-api-rrhh.md.
--
--   · Cuatro columnas de procedencia. Son anulables a propósito: las órdenes
--     que no vienen de RRHH las dejan en NULL.
--   · Un índice único parcial sobre origen_solicitud_id. Es la idempotencia de
--     la API: un origenSolicitudId, una orden. Si dos POST iguales llegan en
--     paralelo, el segundo INSERT falla con 23505 y la API devuelve la que ya
--     existe. Parcial, para que las órdenes sin procedencia no choquen.
--   · La clave rrhhTopeAprobacionOS: hasta ese total (con IVA) la orden entra
--     aprobada; por encima entra en borrador. Si falta o no es un número, no
--     se aprueba nada automáticamente.
--
-- Los requerimientos (dotación) no necesitan columnas: su procedencia va en
-- origen_correo_id como 'rrhh:<uuid>', que ya tiene índice único.
--
-- No cambia nada para el código desplegado: columnas anulables, un índice que
-- solo cubre filas nuevas y una clave de configuración que nadie lee todavía.

ALTER TABLE erp.ordenes_servicio
  ADD COLUMN IF NOT EXISTS origen_sistema               text,
  ADD COLUMN IF NOT EXISTS origen_solicitud_id          uuid,
  ADD COLUMN IF NOT EXISTS origen_solicitado_por        text,
  ADD COLUMN IF NOT EXISTS origen_solicitado_por_nombre text;

COMMENT ON COLUMN erp.ordenes_servicio.origen_sistema IS
  'Sistema que creó la orden por la API ("rrhh-app"). NULL si se creó en la consola.';
COMMENT ON COLUMN erp.ordenes_servicio.origen_solicitud_id IS
  'Id de la solicitud en KAOS. Llave de idempotencia y de reconciliación de la API.';
COMMENT ON COLUMN erp.ordenes_servicio.origen_solicitado_por IS
  'Correo de la persona de RRHH que pidió la orden.';
COMMENT ON COLUMN erp.ordenes_servicio.origen_solicitado_por_nombre IS
  'Nombre de la persona de RRHH que pidió la orden, para saber a quién llamar.';

CREATE UNIQUE INDEX IF NOT EXISTS ordenes_servicio_origen_solicitud_key
  ON erp.ordenes_servicio (origen_solicitud_id)
  WHERE origen_solicitud_id IS NOT NULL;

-- ON CONFLICT: si ya lo cambiaron, no se pisa.
INSERT INTO erp.configuracion (clave, valor, descripcion)
VALUES ('rrhhTopeAprobacionOS', '500000',
        'Tope en COP (total con IVA) hasta el cual una orden de servicio creada por RRHH vía API entra aprobada. Por encima entra en borrador.')
ON CONFLICT (clave) DO NOTHING;
