# Migración de SharePoint a Postgres

Documentación de la migración de las fuentes de datos del ERP hacia una base
Postgres autoalojada. Empieza por acá.

## Dónde estamos

| Etapa | Estado |
|---|---|
| Postgres corriendo en Docker (local) | **Hecho** |
| Esquema `erp` (11 listas de SharePoint) | **Hecho** — 18 tablas, 5 vistas, 10 funciones |
| Carga inicial de datos | **Hecho** — 12.587 filas |
| Capa de repositorio en la aplicación | **Hecho** — 0 operaciones de datos por Graph |
| Caché SQLite retirado | **Hecho** — `db.js` de 737 a 124 líneas |
| Control de Costos: de libro Excel a vista SQL | **Hecho** — `erp.vw_gastos` + 3 resúmenes |
| Retirar los CSV | **Hecho** — archivados en `data/_archivo-csv-2026/` |
| Postgres en el VPS y corte | **Pendiente** — la única que falta |

Las cinco fuentes de datos originales están resueltas:

| Fuente original | Hoy |
|---|---|
| 11 listas de SharePoint | Migradas. La aplicación no las lee |
| `Control Costos.xlsx` | Vista SQL; el libro es un reporte que se regenera |
| `compras.csv` | Archivado |
| `proveedores_depurados_final.csv`, `tabla_proyectos.csv` | Archivados |
| `data/local.db` (SQLite) | Solo sesiones y mapeo de tesorería |

### Verificado por HTTP contra las rutas reales

| Ruta | Filas |
|---|---:|
| `/ordenes` | 282 |
| `/os/ordenes` | 147 |
| `/requerimientos` | 132 |
| `/remisiones` | 130 |
| `/gastos` | 394 |
| `/inventario/stock` | 528 |
| `/inventario/movimientos` | 1.652 |
| `/proveedores` | 424 |
| `/insumos` | 880 |

Los gastos suman **$1.297.862.289** repartidos en 185 órdenes de compra, 122
órdenes de servicio y 87 salidas de almacén.

### Lo que se queda en SharePoint a propósito

La autenticación, el Drive —los PDF de OC, OS y requerimientos—, la lectura del
buzón y la subida del libro de Control de Costos, que ahora es un entregable.
Por decisión de alcance solo migran los datos, no los archivos.

Fuera de `graphStorage.js` no queda ni un `addListItem`, `updateListItem`,
`getListItem` ni `getListItems` en la aplicación.

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
