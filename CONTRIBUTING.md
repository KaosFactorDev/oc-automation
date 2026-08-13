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
| Despliegue | Automático al hacer merge a `main` |
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

1. Saca la rama desde la base correcta (`develop`, salvo hotfix).
2. Haz commits pequeños y coherentes.
3. Abre el PR con título en el mismo formato del commit: `type: description`.
4. En la descripción, en inglés: qué cambia, por qué, y cómo probarlo.
5. Si toca la UI, incluye captura.
6. Espera revisión. No hagas merge de tu propio PR sin que alguien lo apruebe.

Antes de pedir revisión, verifica:

- [ ] La rama apunta a la base correcta (`develop`, o `main` solo si es hotfix).
- [ ] Los commits siguen Conventional Commits y están en inglés.
- [ ] Ningún commit menciona herramientas de IA.
- [ ] No se subió `.env`, `data/local.db`, `node_modules/` ni logs.
- [ ] Ningún secreto quedó escrito en el código (claves, tokens, contraseñas).
- [ ] Probaste el flujo afectado en local.

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

**`AUTH_REDIRECT_URI` es distinta en cada entorno.** En local tiene que ser `http://localhost:3001/auth/callback`; con la URL de producción, el login te saca del localhost y la cookie de sesión se marca `Secure`, que el navegador descarta sobre `http://`. Esa URL además debe estar registrada en Azure AD (*App registration → Authentication → Web*), o Microsoft responde `AADSTS50011`.

Cada entorno tiene su propio `.env` y el archivo no viaja en el deploy, así que configurarlo una vez de cada lado es suficiente.

La UI son HTML estáticos que el servidor lee del disco en cada petición: para ver un cambio en [ui/](ui/) basta con recargar el navegador, sin reiniciar.

---

## Estilo de código

El repositorio no tiene linter. Sigue lo que ya está escrito:

- `'use strict'` al inicio de cada módulo, CommonJS (`require`), 2 espacios de indentación.
- Cabecera de bloque con `// ── Sección ─────`.
- Comentarios en español que explican **por qué**, no qué. Los buenos comentarios de este repo documentan la trampa que motivó el código — imítalos.
- Nombres de variables y funciones en español, como el resto (`obtenerProyectos`, `cerrarModal`).

---

## Trampas conocidas

Cosas que ya costaron un incidente. Consérvalas:

- **`data/` en el VPS pertenece al UID 10001** (el usuario del contenedor). El deploy hace dos llamadas a rsync por esto, y la segunda no lleva `--delete` a propósito. Ver los comentarios en [deploy.yml](.github/workflows/deploy.yml) antes de tocarlo.
- **`.env` y `data/local.db` están excluidos del deploy.** Nunca los subas al repositorio.
- **SharePoint es la fuente de verdad**, SQLite es solo caché de lectura. Toda escritura va primero a SharePoint y después actualiza SQLite.
- **No hay pruebas automatizadas.** `npm test` es el stub por defecto. Prueba a mano el flujo que tocaste y descríbelo en el PR.
