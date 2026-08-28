# Migración de SharePoint a Postgres

Documentación de la migración de las fuentes de datos del ERP hacia una base
Postgres autoalojada. Empieza por acá.

## Dónde estamos

| Etapa | Estado |
|---|---|
| Postgres corriendo en Docker (local) | **Hecho** |
| Esquema `erp` (11 listas de SharePoint) | **Hecho** |
| Carga inicial de datos | **Hecho** — 12.584 filas |
| Capa de repositorio en la aplicación | Pendiente — es lo que sigue |
| Corte a Postgres y retiro de SharePoint | Pendiente |
| Postgres en el VPS | Pendiente |

**Nada de esto cambia todavía el comportamiento del ERP.** La aplicación sigue
leyendo y escribiendo en SharePoint exactamente igual que antes. Lo que existe
hoy es la base, el esquema y las herramientas para cargarla; ningún camino de
código de la aplicación toca Postgres aún.

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
```

El detalle de cada variable está en `.env.example`, y el de cada comando en
[operacion-base-de-datos.md](operacion-base-de-datos.md).
