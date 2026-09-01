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
| `npm run db:verificar` | Compara SharePoint contra Postgres: ¿están todos los datos? |
| `npm run revisar-listas` | Chequeo previo: qué rechazaría el esquema |
| `npm run corregir-listas` | Corrige en SharePoint lo que se puede corregir solo |
| `npm run db:importar` | Carga las 11 listas en Postgres |

Banderas útiles:

```bash
npm run db:push -- --dry-run           # ver qué migraría, sin aplicar
npm run revisar-listas -- --detalle    # todas las filas de cada hallazgo
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

Con SharePoint la copia la hacía Microsoft. Autoalojando, el respaldo es del
VPS: sin esto, un disco perdido se lleva las órdenes de compra de la empresa.

```bash
./deploy/respaldo-db.sh          # a mano
crontab -l                       # ver lo programado
```

Cada corrida deja `respaldos/erp-AAAA-MM-DD.sql.gz`, conserva 30 días y borra lo
anterior. El script se protege de dos formas de tener una copia inservible sin
saberlo: escribe a `.parcial` y solo renombra al terminar —así un dump cortado a
la mitad no queda con nombre de respaldo válido—, y verifica el gzip con
`gzip -t` antes de darlo por bueno. Si pesa menos de 2 KB, lo descarta.

### La hora: el cron de Ubuntu ignora CRON_TZ

**El host está en Europe/Berlin, no en hora de Colombia** — van 7 horas. Lo
natural sería poner `CRON_TZ=America/Bogota` al principio del crontab, y no
funciona: se comprobó programando un job con esa variable para dos minutos más
tarde en hora de Bogotá, y nunca disparó.

Así que la hora del crontab es la **del host**:

```cron
15 8 * * * cd /home/deploy/oc-automation && ./deploy/respaldo-db.sh >> logs/respaldo-db.log 2>&1
```

08:15 en Berlín son la 01:15 en Colombia en verano y las 02:15 en invierno —
madrugada en los dos casos, que es lo que se quería. Si algún día se mueve la
hora, hay que hacer la cuenta a mano.

### Restaurar, y por qué hay que probarlo

Un respaldo que nunca se restauró es una esperanza, no una copia. La prueba:

```bash
docker exec oc-automation-db psql -U postgres -d postgres   -c "CREATE DATABASE erp_prueba_restauracion;"
gunzip -c respaldos/erp-2026-09-02.sql.gz |   docker exec -i oc-automation-db psql -U postgres -d erp_prueba_restauracion
# comparar conteos contra erp, y después:
docker exec oc-automation-db psql -U postgres -d postgres   -c "DROP DATABASE erp_prueba_restauracion;"
```

Hecho el 2026-09-02: las siete tablas principales devolvieron el mismo conteo que
el original.

Para restaurar de verdad sobre una base con datos, primero hay que vaciarla:

```bash
docker exec -i oc-automation-db psql -U postgres -d erp -c 'DROP SCHEMA erp CASCADE'
gunzip -c respaldos/erp-AAAA-MM-DD.sql.gz |   docker exec -i oc-automation-db psql -U postgres -d erp
```

## Probar antes de desplegar

La pregunta «están todos los datos» no se responde mirando la consola: 282
órdenes en pantalla no dicen si SharePoint tiene 286.

```bash
npm run db:verificar                  # SharePoint vs Postgres
npm run db:verificar -- --detalle     # cada diferencia, no solo el conteo
```

Compara cuatro cosas, y no todas prueban lo mismo:

| Comprueba | Por qué |
|---|---|
| **Identidades** (`sp_id`) | Un conteo que cuadra no prueba nada si una fila se perdió y otra se duplicó |
| **Conteos** | Resumen rápido, nada más |
| **Dinero** | Los totales de OC y OS, donde una diferencia se nota |
| **Coherencia interna** | Números duplicados, ítems que no suman la cabecera, documentos sin proyecto, contadores por debajo del máximo emitido |

Dos detalles que evitan falsos positivos:

- **Proveedores y usuarios colapsan a propósito.** La migración fusionó 14
  proveedores duplicados y varias filas por persona, así que esos `sp_id`
  desaparecieron. Comparar por `sp_id` daría un falso negativo; se comparan por
  su llave natural —NIT y correo—, que es la pregunta correcta: no «¿está esta
  fila?» sino «¿está este proveedor?».
- **Una fila nueva no es una fila perdida.** SharePoint asigna el id de forma
  creciente. Si todo lo que falta tiene un `sp_id` por encima del último
  importado, se creó después; un hueco *dentro* del rango ya importado es otra
  cosa y el script lo distingue.

### Lo que el verificador NO prueba

Que las escrituras funcionen. Las lecturas están cubiertas; las escrituras hay
que probarlas en la consola, y ahí aparece un problema: **la base es local, pero
SharePoint, el buzón y tesorería son los de producción.**

```bash
# En .env
MODO_PRUEBA=1
npm run dev
```

Con eso, las escrituras que salen del equipo se cortan:

| Acción en la consola | Sin MODO_PRUEBA | Con MODO_PRUEBA |
|---|---|---|
| Crear o editar requerimiento, OC, OS | solo Postgres local | igual |
| **Aprobar** una OC u OS | solo Postgres local: emite el consecutivo, registra el precio, recalcula el requerimiento | igual |
| Registrar movimientos de inventario | solo Postgres local | igual |
| **Generar el PDF** | lo sube al **Drive real** | queda en `./temp/prueba/` |
| **Exportar Control de Costos** | **sobrescribe el libro real** | queda en `./temp/prueba/` |
| **Enviar a tesorería** | escribe en el Supabase de **producción** | se rechaza |
| Botón de revisar el buzón | lee el buzón real y **responde correos** | no envía |

Las lecturas siguen saliendo, a propósito: leer el catálogo de SharePoint o un
correo no cambia nada de nadie. Solo se corta lo que deja rastro.

Que los PDF queden en disco es mejor que suprimirlos: se pueden abrir y revisar,
que es justo lo que se quiere al probar. La fila queda con
`pdf_url = prueba-local://…`, así que una OC probada se reconoce de inmediato.

**En el VPS se deja sin definir.** Un despliegue que no envía correos en silencio
sería peor que el problema. Para que el olvido no cueste, el arranque avisa
cuando la combinación es la peligrosa —base local con escrituras vivas—:

```
  ⚠  Base de datos LOCAL con escrituras externas VIVAS.
     Generar un PDF lo sube al Drive real. [...]
     Para probar sin tocar producción:  MODO_PRUEBA=1 en .env
```

El mailer es un proceso aparte (`npm run correos`), así que `npm run dev` no
toca correos ni con el modo apagado.

### El ciclo cuando el verificador marca diferencias

```bash
npm run revisar-listas            # ¿hay algo que el esquema rechace?
npm run corregir-listas           # en seco; -- --aplicar para escribir
npm run db:importar               # trae lo nuevo, actualiza lo existente
npm run db:verificar              # debe quedar en cero
```

El import es idempotente: correrlo dos veces no duplica nada.

## El corte en el VPS

Pendiente. Es la última etapa de la migración. La base **no publica puertos** y
vive en la red interna de Docker, así que solo la alcanzan la app y el mailer;
para llegar desde tu equipo, túnel SSH:

```bash
ssh -L 55432:localhost:5432 usuario@vps
```

### El orden importa

**Importar primero, desplegar después.** La versión desplegada hoy lee de
SharePoint; la nueva lee de Postgres. Si se despliega antes de importar, la
aplicación arranca contra una base vacía y la gente ve un ERP sin datos. Al
revés no pasa nada: una base ya cargada esperando el despliegue es inofensiva.

Conviene hacerlo fuera de horario laboral y no un viernes.

### Antes de empezar

```bash
# 1. Confirmar que nadie está aprobando documentos en este momento.
#    Un documento aprobado entre el import y el despliegue se pierde:
#    queda en SharePoint, que ya nadie va a leer.
```

No hace falta respaldar SharePoint: el import solo lee, las listas quedan
intactas y son el respaldo del corte.

Ese último punto es la parte delicada del corte, y no la resuelve ningún script:
hay que avisar al equipo y verificar que la consola esté quieta.

### El procedimiento

```bash
# ── 1. Variables en el .env del VPS ────────────────────────────────────────
#   POSTGRES_PASSWORD=...        (solo letras y dígitos; ver .env.example)
#   ERP_DB_HOST=db               (nombre del servicio, no localhost)
#   ERP_DB_PORT=5432             (el puerto interno, no 55432)
#   ERP_DB_NAME=erp
#   ERP_DB_USER=erp_app
#   ERP_DB_PASSWORD=...
#   MIGRATION_DB_URL=postgresql://postgres:CLAVE@localhost:5432/erp?sslmode=disable

# ── 2. Levantar solo la base ───────────────────────────────────────────────
docker compose up -d db
npm run db:esperar

# ── 3. Migrar el esquema ───────────────────────────────────────────────────
npm run db:push
npm run db:clave                 # asigna la contraseña al rol erp_app

# ── 4. Revisar los datos de SharePoint ANTES de importar ───────────────────
npm run revisar-listas           # solo informa, no cambia nada
npm run corregir-listas          # en seco; -- --aplicar para escribir
npm run revisar-listas           # confirmar que quedó limpio

# ── 5. Importar ────────────────────────────────────────────────────────────
npm run db:importar

# ── 6. Verificar contra el origen ──────────────────────────────────────────
npm run db:verificar             # debe terminar en cero diferencias

# ── 7. Sincronizar los contadores ──────────────────────────────────────────
docker exec oc-automation-db psql -U postgres -d erp   -c "SELECT * FROM erp.sincronizar_contadores();"
#   Sin esto, la primera OC nueva puede reusar un número existente.

# ── 8. Ahora sí, desplegar ─────────────────────────────────────────────────
#   Merge a main. Verificar en la consola: /ordenes, /requerimientos,
#   /gastos e /inventario/stock deben mostrar los mismos totales del paso 6.

# ── 9. Dejar el respaldo en el cron del host ───────────────────────────────
crontab -e     # ver la sección "Respaldos"
```

### Si algo sale mal

El plan de reversa es corto porque SharePoint queda intacto: el import solo
**lee** de las listas. Revertir el despliegue a la versión anterior devuelve un
ERP que funciona, leyendo de SharePoint como hasta ahora.

Eso deja de ser cierto en cuanto alguien apruebe un documento contra Postgres:
desde ahí, revertir pierde ese documento. Conviene confirmar que la consola
responde bien antes de que el equipo empiece a trabajar, y no al revés.

### Después del corte

Las listas de SharePoint quedan de solo lectura de hecho —nada las escribe—,
pero siguen ahí. Vale dejarlas unas semanas como red de seguridad antes de
archivarlas, y no borrarlas: el `sp_id` de cada fila apunta a ellas y es el
único rastro del origen de los datos.

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
