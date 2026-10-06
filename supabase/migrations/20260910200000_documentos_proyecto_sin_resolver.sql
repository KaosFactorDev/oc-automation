-- Un documento cuyo proyecto no está en el catálogo deja de inventar el
-- proyecto: se guarda sin proyecto y con el texto que llegó, para que una
-- persona lo asigne después.
--
-- Cómo era hasta ahora: los seis módulos de `src/repo/` resolvían el proyecto
-- por código normalizado y, si no lo encontraban, hacían
--
--   INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
--   VALUES ($1, $1, false, true)
--
-- Nacía inactivo y marcado, así que no ensuciaba los desplegables, pero el
-- catálogo crecía con una fila por cada variante mal escrita que entrara por
-- correo. Así aparecieron los 23 proyectos señalados de la migración.
--
-- Qué cambia: el documento se sigue creando igual —esa parte no se toca, un
-- requerimiento legítimo no se puede perder porque alguien tecleó mal el
-- proyecto en el asunto— pero `proyecto_id` queda en NULL y el texto original
-- se guarda en `proyecto_texto`.
--
-- Las seis columnas `proyecto_id` ya admitían NULL, y
-- `erp.siguiente_consecutivo_req(NULL)` ya devolvía cadena vacía a propósito,
-- así que el camino sin proyecto ya estaba previsto en el esquema. Lo único
-- que faltaba era dónde dejar el texto.

ALTER TABLE erp.requerimientos          ADD COLUMN IF NOT EXISTS proyecto_texto text;
ALTER TABLE erp.ordenes_compra          ADD COLUMN IF NOT EXISTS proyecto_texto text;
ALTER TABLE erp.ordenes_servicio        ADD COLUMN IF NOT EXISTS proyecto_texto text;
ALTER TABLE erp.remisiones              ADD COLUMN IF NOT EXISTS proyecto_texto text;
ALTER TABLE erp.movimientos_inventario  ADD COLUMN IF NOT EXISTS proyecto_texto text;
ALTER TABLE erp.historial_precios       ADD COLUMN IF NOT EXISTS proyecto_texto text;

COMMENT ON COLUMN erp.requerimientos.proyecto_texto IS
  'Texto del proyecto tal como llegó, cuando no se pudo resolver contra el catálogo. Es la única pista que tiene quien lo asigne después. NULL cuando el proyecto sí resolvió.';

-- Los pendientes se buscan por `proyecto_id IS NULL`. El índice parcial es
-- diminuto —solo las filas sin asignar— y es el que alimenta la bandeja.
CREATE INDEX IF NOT EXISTS requerimientos_sin_proyecto_idx
  ON erp.requerimientos (created_at DESC) WHERE proyecto_id IS NULL;
CREATE INDEX IF NOT EXISTS ordenes_compra_sin_proyecto_idx
  ON erp.ordenes_compra (created_at DESC) WHERE proyecto_id IS NULL;
CREATE INDEX IF NOT EXISTS ordenes_servicio_sin_proyecto_idx
  ON erp.ordenes_servicio (created_at DESC) WHERE proyecto_id IS NULL;
CREATE INDEX IF NOT EXISTS remisiones_sin_proyecto_idx
  ON erp.remisiones (created_at DESC) WHERE proyecto_id IS NULL;
CREATE INDEX IF NOT EXISTS movimientos_sin_proyecto_idx
  ON erp.movimientos_inventario (created_at DESC) WHERE proyecto_id IS NULL;
CREATE INDEX IF NOT EXISTS historial_sin_proyecto_idx
  ON erp.historial_precios (created_at DESC) WHERE proyecto_id IS NULL;

-- Una vista para la bandeja de pendientes: los seis tipos en una sola lista,
-- con el texto que llegó y con qué proyectos se le parecen, para que asignar
-- sea elegir y no adivinar.
CREATE OR REPLACE VIEW erp.vw_documentos_sin_proyecto AS
  SELECT 'requerimiento'::text AS tipo, id, consecutivo AS numero,
         proyecto_texto, created_at
    FROM erp.requerimientos          WHERE proyecto_id IS NULL
  UNION ALL
  SELECT 'orden_compra', id, numero_oc, proyecto_texto, created_at
    FROM erp.ordenes_compra          WHERE proyecto_id IS NULL
  UNION ALL
  SELECT 'orden_servicio', id, numero_os, proyecto_texto, created_at
    FROM erp.ordenes_servicio        WHERE proyecto_id IS NULL
  UNION ALL
  SELECT 'remision', id, numero, proyecto_texto, created_at
    FROM erp.remisiones              WHERE proyecto_id IS NULL
  UNION ALL
  SELECT 'movimiento_inventario', id, id::text, proyecto_texto, created_at
    FROM erp.movimientos_inventario  WHERE proyecto_id IS NULL
  UNION ALL
  SELECT 'historial_precio', id, id::text, proyecto_texto, created_at
    FROM erp.historial_precios       WHERE proyecto_id IS NULL;

COMMENT ON VIEW erp.vw_documentos_sin_proyecto IS
  'Bandeja de documentos a los que falta asignarles proyecto, de los seis tipos. Ordenar por created_at DESC.';
