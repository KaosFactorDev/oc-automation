-- La bandeja de Configuración queda solo para documentos sueltos sin proyecto.
--
-- Hasta ahora erp.vw_documentos_sin_proyecto juntaba los seis tipos, y eso la
-- llenaba de cosas que no se resuelven ahí:
--
--   · Requerimientos. Un requerimiento sin proyecto es trabajo del comprador,
--     no de configuración: se revisa en la pestaña Requerimientos, donde ya
--     estaban los botones para asignarle proyecto o anularlo. Ahora aparece
--     arriba de todo, marcado «Sin proyecto — revisar», con el texto que traía
--     el correo. Los de obra cerrada, igual, marcados «Obra cerrada».
--   · Historial de precios. Un precio sin proyecto no es una compra pendiente:
--     sigue sirviendo para sugerir proveedor y precio. En producción eran 58
--     cotizaciones manuales que nunca tuvieron obra.
--   · Documentos anulados. Ya no van a avanzar; listarlos era ruido permanente.
--
-- Lo que queda: órdenes de compra, de servicio, remisiones y movimientos de
-- inventario vivos sin proyecto. Son raros —nacen con proyecto desde la
-- consola— y casi siempre vienen de la importación de SharePoint.
--
-- Mismas columnas que antes, para no romper repo/_proyecto.js.
CREATE OR REPLACE VIEW erp.vw_documentos_sin_proyecto AS
  SELECT 'orden_compra'::text AS tipo, o.id, o.numero_oc AS numero,
         o.proyecto_texto, o.created_at, 'sin_proyecto'::text AS motivo,
         NULL::text AS proyecto
    FROM erp.ordenes_compra o
   WHERE o.proyecto_id IS NULL AND o.estado IS DISTINCT FROM 'anulada'
  UNION ALL
  SELECT 'orden_servicio', s.id, s.numero_os, s.proyecto_texto, s.created_at,
         'sin_proyecto', NULL
    FROM erp.ordenes_servicio s
   WHERE s.proyecto_id IS NULL AND s.estado IS DISTINCT FROM 'anulada'
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

COMMENT ON VIEW erp.vw_documentos_sin_proyecto IS
  'Documentos sueltos (OC, OS, remisiones, movimientos de inventario) vivos y sin proyecto, para asignarlos desde Configuración. Los requerimientos se revisan en su pestaña; los precios y los anulados no se listan.';
