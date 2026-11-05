# Guía de contribución — OC-Automation

Reglas de trabajo para el repositorio. Léelas antes del primer PR: **un merge a `main` despliega a producción de inmediato**, sin aprobación manual.

> **Idioma:** esta guía está en español, como el resto de la documentación. Pero **todo lo que queda en el repositorio va en inglés**: nombres de ramas, mensajes de commit, títulos y descripciones de PR. Los comentarios del código siguen en español, que es como está escrito hoy.

---

## Resumen

| | |
|---|---|
| Ramas permanentes | `main` (producción) y `develop` (integración) |
| Cómo entran los cambios | **Siempre por Pull Request.** Nadie commitea directo a `main` ni a `develop` |
| Mensajes de commit | Conventional Commits: `type: description`, en inglés |
| Quién abre los PR | **Siempre una persona, a mano, desde GitHub.** Nunca una herramienta |
| Despliegue | Automático al hacer merge a `main` |
| Chequeo de los PR | [validar-pr.yml](.github/workflows/validar-pr.yml) en cada PR a `develop`: linter, pruebas y prueba de humo de `/api` |
| Menciones a IA | Prohibidas en commits y PRs |

---

## Ramas

`main` es el código que está corriendo en producción. Cada merge dispara el workflow [deploy.yml](.github/workflows/deploy.yml), que sincroniza el VPS y reconstruye los contenedores. No hay paso de aprobación intermedio: **lo que entra a `main`, sale a producción.**

`develop` es donde se integra el trabajo en curso. No despliega nada.

### A dónde va cada cambio

| Tipo de cambio | Rama de trabajo | PR hacia | Sale de |
|---|---|---|---|
| Funcionalidad nueva | `feature/<nombre>` | `develop` | `develop` |
| Corrección no urgente | `fix/<nombre>` | `develop` | `develop` |
| Documentación, refactor, mantenimiento | `docs/<nombre>`, `refactor/<nombre>`, `chore/<nombre>` | `develop` | `develop` |
| **Corrección urgente en producción** | `hotfix/<nombre>` | **`main`** | `main` |
| Publicar lo acumulado | — | `develop` → `main` | — |

Los nombres de rama van en inglés y en minúsculas, con guiones: `feature/supplier-autocomplete`, `fix/oc-modal-close-button`, `hotfix/gemini-model-name`.

### La regla del hotfix

Un `hotfix/*` es la **única** excepción para apuntar a `main`, y solo aplica cuando producción está rota o hay un riesgo real para el negocio. Una mejora que puede esperar al próximo release no es un hotfix.

Después de que el hotfix entra a `main` hay que **traerlo de vuelta a `develop`**, o se pierde en el siguiente release y el bug reaparece:

```bash
git checkout develop
git pull origin develop
git merge origin/main
git push origin develop
```

Si el merge no es limpio, resuélvelo en una rama y abre un PR a `develop`.

### Publicar un release

Cuando `develop` esté estable, se abre un PR de `develop` hacia `main`. Ese PR es el que despliega, así que antes de aprobarlo conviene revisar la lista completa de commits que entran.

---

## Commits

Formato **Conventional Commits**, en inglés:

```
type: short description in imperative mood
```

- Tipo en minúscula, dos puntos, espacio, descripción.
- Modo imperativo: `add`, `fix`, `update` — no `added`, `fixes`, `updating`.
- Sin punto final. Máximo ~72 caracteres en la primera línea.
- El cuerpo (opcional, tras una línea en blanco) explica el **porqué**, no el qué: el diff ya dice qué cambió.

### Tipos

| Tipo | Cuándo |
|---|---|
| `feat` | Funcionalidad nueva visible para el usuario |
| `fix` | Corrección de un bug |
| `docs` | Solo documentación |
| `refactor` | Reestructuración sin cambio de comportamiento |
| `perf` | Mejora de rendimiento |
| `style` | Formato, espacios, sin efecto en la lógica |
| `test` | Pruebas |
| `build` | Dependencias, Dockerfile, `package.json` |
| `ci` | Workflows de GitHub Actions |
| `chore` | Mantenimiento que no encaja arriba |

### Ejemplos

```
feat: send approved purchase orders to treasury as payment requests
fix: close button clipped out of the purchase order modal
ci: deploy via rsync from the runner instead of git fetch on the VPS
build: install system Chromium in Docker so Puppeteer works on the VPS
docs: document per-environment AUTH_REDIRECT_URI setup
```

Con cuerpo:

```
fix: keep rsync from touching attributes of the data/ directory

The deploy user does not own data/, so setting times or permissions on it
fails with exit code 23 even when the contents synced correctly.
```

### Prohibido en commits y PRs

**No se menciona ninguna herramienta de IA.** Ni Claude, ni Copilot, ni ChatGPT, ni ninguna otra. Esto incluye:

- Trailers `Co-Authored-By:` que apunten a un asistente.
- Footers del estilo `Generated with ...` o `🤖 ...`.
- Referencias en el cuerpo del commit o en la descripción del PR.

El commit lo firma la persona que lo hace. Si usas un asistente, el resultado es tuyo y respondes por él igual que por el código que escribes a mano.

También fuera: `wip`, `cambios`, `arreglos`, `.` y cualquier mensaje que no diga qué cambió.

---

## Pull Requests

### Los PR se abren a mano

**El Pull Request lo crea siempre una persona, desde la interfaz de GitHub.** No se abren con `gh pr create`, ni con bots, ni con asistentes de IA, ni con ninguna automatización.

Esto no es una preferencia estética: el PR a `main` es lo único que separa un cambio de producción, y quien lo abre es quien se hace responsable de lo que va a desplegar. Esa decisión no se delega en una herramienta.

**Si estás usando un asistente de IA:** su trabajo termina en `git push` de la rama. Deja el PR sin abrir y avisa que la rama está lista; la persona a cargo lo revisa y lo abre. Tampoco corresponde hacer merge, aprobar, ni cerrar PRs ajenos.

### Checklist

1. Saca la rama desde la base correcta (`develop`, salvo hotfix).
2. Haz commits pequeños y coherentes.
3. Empuja la rama: `git push -u origin <rama>`.
4. Abre el PR **a mano** en GitHub, con título en el mismo formato del commit: `type: description`.
5. En la descripción, en inglés: qué cambia, por qué, y cómo probarlo.
6. Si toca la UI, incluye captura.
7. Espera revisión. No hagas merge de tu propio PR sin que alguien lo apruebe.

Antes de pedir revisión, verifica:

- [ ] La rama apunta a la base correcta (`develop`, o `main` solo si es hotfix).
- [ ] Los commits siguen Conventional Commits y están en inglés.
- [ ] Ningún commit menciona herramientas de IA.
- [ ] No se subió `.env`, `data/local.db`, `node_modules/` ni logs.
- [ ] Ningún secreto quedó escrito en el código (claves, tokens, contraseñas).
- [ ] `npm run lint` y `npm test` pasan en local.
- [ ] Probaste el flujo afectado en local.

---

## Validación de los PR

Cada PR hacia `develop` corre [validar-pr.yml](.github/workflows/validar-pr.yml) (chequeo `validar`). El PR queda en rojo si falla cualquiera de estos pasos:

| Paso | Comando | Qué revisa |
|---|---|---|
| Linter | `npm run lint` | ESLint con las reglas recomendadas: errores, no formato |
| Pruebas unitarias | `npm test` | `apiRrhh` y el cálculo de totales de la API, la OC y la OS, sin base de datos (`test/*.test.js`) |
| Prueba de humo | `npm run test:humo` | El servidor real, con `MODO_PRUEBA=1`, contra un Postgres temporal: llave de `/api`, orden de servicio aprobada y en borrador, idempotencia y requerimiento (`test/humo/`) |

Antes de la prueba de humo, el workflow:

1. comprueba que la base sea local (`node test/humo/entorno-local.js`);
2. aplica las migraciones con `deploy/aplicar-migraciones.sh`, el mismo script del deploy;
3. asigna la clave de `erp_app`;
4. carga `supabase/seeds/local-p0.sql`.

La base es un contenedor del runner que muere con el job. El workflow no usa secrets ni toca el VPS.

### Correrlo en local

`npm run lint` y `npm test` no necesitan base: córrelos antes de abrir el PR.

La prueba de humo escribe en Postgres, así que va contra una base desechable y no contra la tuya de desarrollo. En una terminal de Git Bash aparte, desde la raíz del repo:

```bash
# 1. Postgres desechable en 127.0.0.1:55433, sin volumen con nombre
docker run -d --name oc-automation-db-ci -e POSTGRES_DB=erp -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=ciadmin0local0only -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C.UTF-8" \
  -p 127.0.0.1:55433:5432 postgres:17-alpine

# 2. El entorno del workflow, con el puerto 55433 (no son secretos: la base es desechable)
export MODO_PRUEBA=1 PUERTO_COTIZACIONES=3002 POSTGRES_DB=erp POSTGRES_PASSWORD=ciadmin0local0only \
  PGHOST=127.0.0.1 PGPORT=55433 PGUSER=postgres ERP_DB_HOST=127.0.0.1 ERP_DB_PORT=55433 \
  ERP_DB_NAME=erp ERP_DB_USER=erp_app ERP_DB_PASSWORD=ciapp0local0only \
  RRHH_API_KEY=ci0local0api0key0not0secret

# 3. Los pasos del workflow (db-esperar.js reemplaza el healthcheck del CI)
node test/humo/entorno-local.js
node src/scripts/db-esperar.js
DB_CONTAINER=oc-automation-db-ci bash deploy/aplicar-migraciones.sh
node src/scripts/db-clave-app.js
docker exec -i oc-automation-db-ci psql -X -U postgres -d erp -v ON_ERROR_STOP=1 < supabase/seeds/local-p0.sql
npm run test:humo

# 4. Borrar la base
docker rm -fv oc-automation-db-ci
```

- La guarda aborta antes de escribir si `MODO_PRUEBA` no está activo, si `PGHOST` o `ERP_DB_HOST` no son `127.0.0.1` o `localhost`, si hay alguna credencial externa definida o si un `.env` en la carpeta inyectaría variables.
- La prueba de humo no arranca si ya hay algo escuchando en `PUERTO_COTIZACIONES`, por ejemplo tu servidor de desarrollo.
- En Windows hace falta Node 22.12 o superior: `better-sqlite3` no publica binario de Node 20 para Windows. El CI usa Node 20, el del Dockerfile.

### Errores de lint que ya existían

Cuando se creó el chequeo, el código ya tenía 125 avisos de ESLint. Están en `eslint-suppressions.json`: el linter los tolera y falla con cualquier error nuevo.

- Si tu PR agrega un error, arréglalo. No lo agregues a la lista.
- Si arreglas avisos que ya estaban, el linter también falla hasta que bajes la lista: corre `npx eslint . --prune-suppressions` y commitea el archivo.
- Si mueves o renombras un archivo con avisos conocidos, cambia su ruta en la lista.
- La meta es vaciarla.

---

## Entorno local

```bash
npm install
cp .env.example .env     # y llenarlo con las credenciales reales
npm run dev              # consola web en http://localhost:3001, con recarga automática
```

Scripts disponibles:

| Comando | Qué hace |
|---|---|
| `npm run dev` | Consola web con reinicio automático al editar `.js` |
| `npm start` | Consola web sin watch (es lo que corre el contenedor) |
| `npm run correos` | Procesa el buzón una vez |
| `npm run correos:test` | Modo prueba, sin conectar al buzón |
| `npm run lint` | Linter (ver «Validación de los PR») |
| `npm test` | Pruebas unitarias, sin base de datos |
| `npm run test:humo` | Prueba de humo de `/api`; necesita una base local preparada (ver «Validación de los PR») |

**`AUTH_REDIRECT_URI` es distinta en cada entorno.** En local tiene que ser `http://localhost:3001/auth/callback`; con la URL de producción, el login te saca del localhost y la cookie de sesión se marca `Secure`, que el navegador descarta sobre `http://`. Esa URL además debe estar registrada en Azure AD (*App registration → Authentication → Web*), o Microsoft responde `AADSTS50011`.

Cada entorno tiene su propio `.env` y el archivo no viaja en el deploy, así que configurarlo una vez de cada lado es suficiente.

La UI son HTML estáticos que el servidor lee del disco en cada petición: para ver un cambio en [ui/](ui/) basta con recargar el navegador, sin reiniciar.

---

## Estilo de código

ESLint (`npm run lint`) revisa errores, no el formato. Para el estilo, sigue lo que ya está escrito:

- `'use strict'` al inicio de cada módulo, CommonJS (`require`), 2 espacios de indentación.
- Cabecera de bloque con `// ── Sección ─────`.
- Comentarios en español que explican **por qué**, no qué. Los buenos comentarios de este repo documentan la trampa que motivó el código — imítalos.
- Nombres de variables y funciones en español, como el resto (`obtenerProyectos`, `cerrarModal`).

---

## Trampas conocidas

Cosas que ya costaron un incidente. Consérvalas:

- **`data/` en el VPS pertenece al UID 10001** (el usuario del contenedor). El deploy hace dos llamadas a rsync por esto, y la segunda no lleva `--delete` a propósito. Ver los comentarios en [deploy.yml](.github/workflows/deploy.yml) antes de tocarlo.
- **`.env` y `data/local.db` están excluidos del deploy.** Nunca los subas al repositorio.
- **Postgres es la fuente de verdad.** Todo el SQL vive en `src/repo/`: fuera de ahí no se escribe SQL, y ahí adentro no se toman decisiones de negocio. El SQLite de `data/local.db` ya no es un caché — solo guarda las sesiones y el mapeo de tesorería.
- **SharePoint quedó para archivos, correo y login.** Los PDF de respaldo van a su Drive; las once listas están congeladas desde el corte y ninguna operación de datos sale por Microsoft Graph. No vuelvas a leer de ellas.
- **En desarrollo, `MODO_PRUEBA=1`.** La base es local, pero el buzón, el Drive y tesorería son los de producción: sin esta variable, probar el flujo completo sube archivos y responde correos de verdad.
- **Las pruebas automáticas cubren poco.** `npm test` y la prueba de humo cubren la API de RRHH y el cálculo de totales; la consola, el correo y los PDF siguen sin pruebas. Prueba a mano el flujo que tocaste y descríbelo en el PR. `src/test.js` no es parte de `npm test`: es un script manual que necesita la base.
