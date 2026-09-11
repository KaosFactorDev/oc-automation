-- La bandeja pasa a cubrir los dos motivos por los que un requerimiento no
-- puede avanzar a orden de compra.
--
-- Hasta ahora listaba solo los documentos SIN proyecto. Pero un requerimiento
-- atado a una obra cerrada está igual de trabado: el dato es correcto —el correo
-- nombró esa obra y así conserva su zona para elegir proveedor— pero no se le
-- compra a un proyecto que ya terminó.
--
-- Los dos casos se miran en el mismo sitio porque la pregunta de quien abre la
-- bandeja es una sola: qué requerimientos no pueden convertirse en orden, y qué
-- les falta.
--
-- `motivo` es lo que los distingue, porque la acción es distinta:
--   sin_proyecto       → asignarle uno
--   proyecto_inactivo  → reasignar a una obra abierta, o reactivar esa en KAOS

CREATE OR REPLACE VIEW erp.vw_documentos_sin_proyecto AS
  -- Sin proyecto: los seis tipos.
  SELECT 'requerimiento'::text AS tipo, r.id, r.consecutivo AS numero,
         r.proyecto_texto, r.created_at, 'sin_proyecto'::text AS motivo,
         NULL::text AS proyecto
    FROM erp.requerimientos r WHERE r.proyecto_id IS NULL
  UNION ALL
  SELECT 'orden_compra', o.id, o.numero_oc, o.proyecto_texto, o.created_at,
         'sin_proyecto', NULL
    FROM erp.ordenes_compra o WHERE o.proyecto_id IS NULL
  UNION ALL
  SELECT 'orden_servicio', s.id, s.numero_os, s.proyecto_texto, s.created_at,
         'sin_proyecto', NULL
    FROM erp.ordenes_servicio s WHERE s.proyecto_id IS NULL
  UNION ALL
  SELECT 'remision', m.id, m.numero, m.proyecto_texto, m.created_at,
         'sin_proyecto', NULL
    FROM erp.remisiones m WHERE m.proyecto_id IS NULL
  UNION ALL
  SELECT 'movimiento_inventario', i.id, i.id::text, i.proyecto_texto, i.created_at,
         'sin_proyecto', NULL
    FROM erp.movimientos_inventario i WHERE i.proyecto_id IS NULL
  UNION ALL
  SELECT 'historial_precio', h.id, h.id::text, h.proyecto_texto, h.created_at,
         'sin_proyecto', NULL
    FROM erp.historial_precios h WHERE h.proyecto_id IS NULL

  UNION ALL

  -- Con proyecto, pero cerrado. Solo requerimientos: son los únicos que avanzan
  -- a orden de compra, que es lo que el estado del proyecto bloquea. Y solo los
  -- que aún no se gestionaron: uno cerrado o anulado ya no va a avanzar, así que
  -- listarlo sería ruido permanente.
  SELECT 'requerimiento', r.id, r.consecutivo, NULL, r.created_at,
         'proyecto_inactivo', p.codigo
    FROM erp.requerimientos r
    JOIN erp.proyectos p ON p.id = r.proyecto_id
   WHERE NOT p.activo
     AND r.estado IN ('pendiente', 'parcial');

COMMENT ON VIEW erp.vw_documentos_sin_proyecto IS
  'Lo que no puede avanzar a orden de compra: documentos sin proyecto, y requerimientos pendientes atados a una obra inactiva. `motivo` dice cuál de los dos y por tanto qué hay que hacer.';
