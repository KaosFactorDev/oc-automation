# Operación de la base de datos

Comandos, respaldos y los problemas con los que ya nos tropezamos.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run db:up` | Levanta Postgres en Docker (local) |
| `npm run db:down` | Lo apaga. **Conserva los datos** |
| `npm run db:push` | Aplica las migraciones pendientes |
| `npm run db:clave` | Asigna a `erp_app` la contraseña de `ERP_DB_PASSWORD` |
| `npm run db:reset` | Borra el volumen y rehace todo: levanta, espera, migra, asigna contraseña. **Borra los datos** |
| `npm run db:psql` | Abre `psql` contra la base local |
| `npm run revisar-listas` | Chequeo previo: qué rechazaría el esquema |
| `npm run corregir-listas` | Corrige en SharePoint lo que se puede corregir solo |
| `npm run db:importar` | Carga las 11 listas en Postgres |

Banderas útiles:

```bash
npm run db:push -- --dry-run           # ver qué migraría, sin aplicar
npm run revisar-listas -- --detalle    # todas las filas de cada hallazgo
npm run revisar-listas -- --cache      # leer del SQLite (rápido, puede estar viejo)
npm run corregir-listas -- --aplicar   # sin esto, solo muestra el plan
npm run db:importar -- --dry-run       # import completo que revierte al final
npm run db:importar -- --truncate      # vaciar antes de cargar
npm run db:importar -- --cache         # leer del SQLite (ensayo)
```

## Flujo completo

```bash
npm run db:reset                       # 1. base limpia con el esquema
npm run revisar-listas                 # 2. ¿qué rechazaría el esquema?
npm run corregir-listas -- --aplicar   # 3. arreglar SharePoint (si hay qué)
npm run revisar-listas                 # 4. confirmar que quedó limpio
npm run db:importar                    # 5. cargar
```

`db:importar` es **idempotente**: correrlo dos veces deja el mismo resultado.
Actualiza las cabeceras por `ON CONFLICT` y borra los hijos antes de recargarlos.
Como SharePoint sigue siendo la fuente de verdad, volver a correrlo es la forma
de poner Postgres al día.

Lo único que **no** hace es borrar: un documento eliminado en SharePoint queda
en Postgres. En el flujo actual casi no pasa, porque `corregir-listas` anula en
vez de borrar.

## Configuración

Las credenciales van como **variables sueltas, no como URL**. Una contraseña
aleatoria suele traer `/ % @ #` o `:`, y esos caracteres rompen una URL: con
`H!JV8k.%Vbi*^/W` el parser falla con *Invalid URL* porque la barra corta la
sección de autoridad.

```bash
# Base y rol de administración (migraciones, DDL)
POSTGRES_DB=erp
POSTGRES_USER=postgres
POSTGRES_PASSWORD=...
PGHOST=localhost
PGPORT=55432
PGUSER=postgres

# Rol de la aplicación (lectura y escritura, sin DDL)
ERP_DB_HOST=localhost      # en el VPS: db
ERP_DB_PORT=55432          # en el VPS: 5432
ERP_DB_NAME=erp
ERP_DB_USER=erp_app
ERP_DB_PASSWORD=...
```

Genera las contraseñas **solo con letras y dígitos**:

```bash
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40
```

## Respaldos

Con SharePoint, respaldaba Microsoft. Autoalojando es responsabilidad del VPS, y
no es opcional: sin esto, un disco perdido se lleva las órdenes de compra de la
empresa.

`deploy/respaldo-db.sh` corre en el **host**, no dentro de un contenedor, para
poder usar `docker exec` y escribir en un directorio que sobreviva a un
`compose down`.

```bash
chmod +x deploy/respaldo-db.sh
crontab -e
# 15 3 * * * cd /ruta/al/proyecto && ./deploy/respaldo-db.sh >> logs/respaldo-db.log 2>&1
```

Escribe a `.parcial` y solo renombra al final, verifica el gzip y descarta un
dump sospechosamente pequeño: creer que hay copia y que no sirva es la peor
forma de perder datos. Retiene 30 días (`RETENCION_DIAS`).

`respaldos/` está en `.gitignore` y excluido del rsync del despliegue — la
primera llamada corre con `--delete` y sin esa exclusión cada deploy habría
borrado los respaldos.

### Restaurar

```bash
gunzip -c respaldos/erp-2026-08-28.sql.gz | \
  docker exec -i oc-automation-db psql -U postgres -d erp
```

Sobre una base que ya tiene datos, primero:

```bash
docker exec -i oc-automation-db psql -U postgres -d erp -c 'DROP SCHEMA erp CASCADE'
```

Probado: restaurar en una base nueva da un resultado idéntico —18 tablas, 9
funciones, 78 índices, las 6 migraciones registradas— con las funciones
operando.

## Levantar en el VPS

Pendiente. El servicio `db` ya está en `docker-compose.yml`.

```bash
# 1. POSTGRES_PASSWORD y ERP_DB_* en el .env del VPS (ERP_DB_HOST=db, ERP_DB_PORT=5432)
docker compose up -d db

# 2. crear el rol y darle contraseña
docker exec -it oc-automation-db psql -U postgres -d erp
#   (la migración crea erp_app sin contraseña; db:clave se la asigna)

# 3. migrar e importar — MIGRATION_DB_URL con localhost:5432 desde el host
npm run db:push
npm run db:importar

# 4. dejar el respaldo en el cron
```

La base **no publica puertos**. Para llegar desde afuera, túnel SSH:

```bash
ssh -L 55432:localhost:5432 usuario@vps
```

## Problemas conocidos

Todos aparecieron de verdad; quedan acá para no volver a perder tiempo.

### `password authentication failed` y la contraseña parece correcta

Si tiene un `#`, **docker compose y `dotenv` la parsean distinto**: compose se
queda con el valor completo, `dotenv` lo corta en el `#`. El contenedor y la
aplicación terminan con contraseñas diferentes. Entre comillas coinciden, pero
es más simple no usar símbolos.

Otro caso: si cambiaste `POSTGRES_PASSWORD` **después** de crear el volumen, la
base conserva la vieja — Postgres solo la aplica al inicializar. Hace falta
`npm run db:reset`.

### `Invalid URL` al conectar

La contraseña tiene `/ % @ #` o `:` dentro de una `DATABASE_URL` escrita a mano.
Usa las variables sueltas `ERP_DB_*`.

### `The server does not support SSL connections`

Postgres en Docker no habla TLS. La URL de migraciones necesita
`?sslmode=disable`; `db-migrar.js` ya lo pone. No es un problema de seguridad
mientras la base no publique puertos: el tráfico no sale del host.

### `spawnSync npx.cmd EINVAL` en Windows

Desde el parche de CVE-2024-27980, Node no lanza un `.cmd` sin `shell: true`.
`db-migrar.js` lo esquiva invocando el `.js` del CLI con el mismo Node — sin
shell de por medio, y la URL llega intacta.

### `ON CONFLICT DO UPDATE command cannot affect row a second time`

Dos filas del mismo `INSERT` chocan en la clave. Pasa con los proveedores que
colapsan al normalizar el NIT. La deduplicación tiene que ocurrir en el cliente;
`importar-listas.js` ya lo hace, quedándose con la última aparición.

### `duplicate key value violates unique constraint "..._numero_key"`

Un número de documento repetido. `npm run revisar-listas` dice cuáles, y
`npm run corregir-listas` los resuelve en SharePoint.

### El chequeo previo da verde y el import falla

Pasaba cuando `revisar-listas` leía del caché SQLite y el import leía de
SharePoint: el caché tenía 276 órdenes de compra cuando SharePoint ya tenía 282.
Ya no ocurre por dos razones: el chequeo lee de SharePoint por defecto, y el
caché se eliminó. La bandera `--cache` quedó como atajo histórico y ya no tiene
datos que leer.

### `supabase start` se queda bajando imágenes

No hace falta: el stack completo son varios GB y solo se usa el motor de
migraciones. `npm run db:up` levanta un `postgres:17-alpine` y basta.
