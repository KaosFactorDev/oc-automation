# Migración de SharePoint a Postgres

Documentación de la migración de las fuentes de datos del ERP hacia una base
Postgres autoalojada. Empieza por acá.

## Dónde estamos

| Etapa | Estado |
|---|---|
| Postgres corriendo en Docker (local) | **Hecho** |
| Esquema `erp` (11 listas de SharePoint) | **Hecho** — 18 tablas, 10 funciones, 78 índices |
| Carga inicial de datos | **Hecho** — 12.584 filas |
| Capa de repositorio en la aplicación | **Hecho** — 0 operaciones de datos por Graph |
| Caché SQLite retirado | **Hecho** — `db.js` de 737 a 124 líneas |
| Control de Costos: de libro Excel a vista SQL | Pendiente |
| Retirar los CSV | Pendiente |
| Postgres en el VPS y corte | Pendiente |

### Lo que la aplicación ya lee y escribe en Postgres

Configuración, proveedores, proyectos, insumos, usuarios, requerimientos,
órdenes de compra, órdenes de servicio, remisiones e inventario. Verificado por
HTTP contra las rutas reales:

| Ruta | Filas |
|---|---:|
| `/ordenes` | 282 |
| `/os/ordenes` | 147 |
| `/requerimientos` | 132 |
| `/remisiones` | 130 |
| `/inventario/stock` | 528 |
| `/inventario/movimientos` | 1.533 |
| `/proveedores` | 424 |
| `/inventario/documentos` | 268 |

### Lo que todavía va a SharePoint

Solo **`controlCostos.js`**, que escribe en el libro de Excel. Eso es la etapa
siguiente.

Fuera de `graphStorage.js` no queda ni un `addListItem`, `updateListItem`,
`getListItem` ni `getListItems` en la aplicación.

### Lo que se queda en SharePoint a propósito

La autenticación, el Drive —los PDF de OC, OS y requerimientos— y la lectura del
buzón. Por decisión de alcance solo migran los datos, no los archivos.

## Los documentos

| Archivo | Para qué |
|---|---|
| [migracion-sharepoint-postgres.md](migracion-sharepoint-postgres.md) | Qué se migró, por qué, y qué falta. Empieza acá si vienes nuevo |
| [esquema-erp.md](esquema-erp.md) | Referencia del esquema: tablas, reglas y equivalencia lista → tabla |
| [operacion-base-de-datos.md](operacion-base-de-datos.md) | Comandos, respaldos, restauración y problemas conocidos |

## Arranque rápido

Para levantar la base en un equipo nuevo, con Docker Desktop corriendo:

```bash
# En .env: POSTGRES_PASSWORD, ERP_DB_PASSWORD (solo letras y dígitos),
#          PGHOST/PGPORT/PGUSER, ERP_DB_*
npm run db:reset      # levanta, migra y asigna la contraseña del rol de la app
npm run db:importar   # carga las 11 listas desde SharePoint
npm run dev           # la consola, leyendo de Postgres
```

El detalle de cada variable está en `.env.example`, y el de cada comando en
[operacion-base-de-datos.md](operacion-base-de-datos.md).
