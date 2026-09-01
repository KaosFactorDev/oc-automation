# CSV archivados

Estos tres archivos fueron la fuente de datos original del ERP y, después, el
respaldo que se usaba cuando el caché SQLite estaba vacío:

| Archivo | Contenido | Filas |
|---|---|---|
| `compras.csv` | Historial de precios pagados | 3.771 |
| `proveedores_depurados_final.csv` | Catálogo de proveedores | 363 |
| `tabla_proyectos.csv` | Proyectos con su zona | 24 |

Su contenido está en Postgres desde la migración: `erp.historial_precios`,
`erp.proveedores` y `erp.proyectos`. Ningún código los lee.

Se conservan como respaldo histórico de la carga inicial, no como fuente. Si
hace falta consultarlos, es un archivo de texto; si hace falta compararlos con
la base, la consulta va contra las tablas.
