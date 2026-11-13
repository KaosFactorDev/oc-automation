-- Proyectos borrados en KAOS: dejan de estar activos en el ERP (T-124).
--
-- La API de KAOS no emite borrados: un proyecto borrado simplemente deja de
-- aparecer. La reconciliación completa (`kaos-sync --todo`, cada noche) ya lo
-- notaba por `visto_en`, pero solo lo imprimía. La fila del espejo se quedaba con
-- su último estado ('Activo'), así que `kaos-aplicar` mantenía activo el proyecto
-- en el catálogo y el desplegable de tesorería lo seguía ofreciendo.
--
-- `eliminado_en` deja constancia de que una reconciliación completa ya no lo
-- recibió. Lo pone `kaos-sync --todo` y se borra en cuanto el proyecto vuelve a
-- aparecer. `kaos-aplicar` lo lee para desactivar la fila del catálogo; los
-- documentos que apuntan al proyecto no se tocan.

ALTER TABLE erp.proyectos_kaos
  ADD COLUMN IF NOT EXISTS eliminado_en timestamptz;

COMMENT ON COLUMN erp.proyectos_kaos.eliminado_en IS
  'Cuándo una reconciliación completa (kaos-sync --todo) dejó de recibir este '
  'proyecto de KAOS: lo borraron allá. NULL mientras KAOS lo siga entregando. Se '
  'limpia si vuelve a aparecer. kaos-aplicar desactiva la fila ligada del catálogo.';
