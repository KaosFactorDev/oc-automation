# OC-Automation — ERP de Compras y Servicios · Civiltech IC

Consola web de gestión de requerimientos, órdenes de compra, órdenes de servicio e inventarios para **Civiltech Ingeniería y Construcción S.A.S.**

Desde julio 2026 el sistema está **centralizado en un VPS Linux con Docker**: una sola consola web a la que todos entran por navegador (ya no se instala en cada equipo). La información vive en SharePoint (nube corporativa) con un caché SQLite local que hace las lecturas instantáneas.

> **¿Vas a trabajar en el código?** Lee primero [CONTRIBUTING.md](CONTRIBUTING.md) — flujo de ramas, convención de commits y entorno local. Ten presente que **un merge a `main` despliega a producción de inmediato**.

---

## Módulos

| Módulo | Función |
|--------|---------|
| **1.1 Requerimientos** | Visualiza solicitudes de compra recibidas por correo o cargadas manualmente. Consecutivo automático y atómico por proyecto. Comparativa de proveedores por ítem y reconsulta/homologación de insumos. Genera OC(s) en borrador. Exporta el requerimiento (detallado o resumido) y su remisión. Bloquea emisión si el proveedor no está registrado. |
| **1.2 Generar OC** | Genera órdenes de compra desde una cotización (PDF, Excel, imagen). IA extrae ítems y precios. Autocomplete NIT ↔ Proveedor en tabla de ítems. Permite vincular la OC a un requerimiento existente. Bloquea emisión si algún proveedor no está registrado. |
| **1.3 Registro OCs** | Historial de órdenes de compra con búsqueda, filtros (Aprobadas excluye entregadas), aprobación, pago, entrega y anulación. Descarga del registro en Excel. Envío de la OC aprobada a **tesorería** como solicitud de pago. |
| **1.4 Órdenes de Servicio** | Crea nuevas órdenes de servicio con asistencia de IA para generar el clausulado. Soporta contrato **IVA pleno** o **AIU**, y extracción de la oferta económica con IA. |
| **1.5 Registro OSs** | Historial de órdenes de servicio emitidas con edición de borradores, aprobación, pago y cumplido. Descarga del registro en Excel. |
| **1.6 Inventarios** | Almacén por proyecto: entradas a partir de OC entregadas, salidas con validación de stock, devoluciones, stock y valorización en tiempo real, documentos en borrador que se aprueban o anulan, y **Análisis IA** de consumos contra rendimientos APU. |
| **Configuración ERP** (⚙) | Datos de la empresa (logo, emisor, firmante, IVA y observaciones por defecto), catálogo de proveedores (alta, edición y detección de los que tienen historial pero no están inscritos), administración de proyectos y —solo para administradores— gestión de usuarios del ERP. |

---

## Arquitectura

```
Correos (Outlook / abastecimiento@civiltechic.com)
         │
         ▼
   index.js (procesamiento automático, disparado por cron)
         │
         ├─ leerCorreos.js          ← Lectura de buzón vía Microsoft Graph API
         ├─ parsearAsunto.js        ← "SOLICITUD REQUERIMIENTO 0001 20260410 MISTRAL"
         ├─ procesarCorreo.js       ← Orquestador del flujo de un correo
         │    ├─ leerRequerimiento.js    ← Extracción desde Excel adjunto
         │    ├─ leerRequerimientoPDF.js ← Extracción desde PDF/imagen (Gemini AI)
         │    └─ consultaProveedor.js    ← Proveedor y precio sugerido por ítem
         └─ requerimientos.js       ← Crea el Requerimiento 'pendiente' en SharePoint

Consola web (http://localhost:3001)
         │
         ▼
   servidor-cotizaciones.js  (HTTP nativo, ~90 rutas, sirve ui/consola.html)
         │
         ├─ authService.js          ← Login Microsoft OAuth 2.0 + sesiones
         ├─ graphStorage.js         ← Wrapper Microsoft Graph API (SharePoint)
         ├─ db.js                   ← Caché SQLite (lectura rápida sin red)
         ├─ syncService.js          ← Sincronización SharePoint → SQLite (c/2 min)
         ├─ contador.js             ← Numeración consecutiva OC / OS
         ├─ configApp.js            ← Configuración de la aplicación
         ├─ consultaProveedor.js    ← Comparativa de proveedores
         ├─ controlCostos.js        ← Registro de gastos en "Control Costos.xlsx"
         ├─ tesoreriaClient.js      ← Solicitudes de pago hacia Cash_Flow
         ├─ ocTemplate.js           ← Documentos OC (HTML + Excel)
         ├─ osTemplate.js           ← Documentos OS (HTML + Excel)
         ├─ remisionTemplate.js     ← Remisiones (HTML + Excel)
         ├─ requerimientoTemplate.js← PDF de respaldo del requerimiento
         ├─ pdfGenerator.js         ← HTML → PDF (Puppeteer / Chromium)
         └─ Gemini API              ← Extracción de cotizaciones, cláusulas de OS,
                                      homologación de insumos y análisis de inventario
```

El servidor es un archivo monolítico: las rutas se resuelven con una cadena de `if` sobre
`req.method` + `url`, sin framework ni router. Al agregar una ruta nueva importa dónde se
inserta, porque los `match` de expresión regular compiten entre sí (el primero que coincide
gana).

**Base de datos dual:**

- **SharePoint** — fuente de verdad. Todas las escrituras van primero a SharePoint.
- **SQLite local** (`data/local.db`, gestionado por `db.js`) — caché de lectura rápida. Se sincroniza automáticamente desde SharePoint cada 2 minutos via `syncService.js`. Permite que la consola cargue instantáneamente aunque SharePoint tarde.

> Cada escritura a SharePoint actualiza también SQLite de forma inmediata para que la UI refleje los cambios sin esperar el ciclo de sincronización.

| Lista SharePoint | Tabla SQLite | Contenido |
|-----------------|-------------|-----------|
| `HistorialPrecios` | `historial_precios` | Precios pagados por OC y cotización (Buscador de Precios) |
| `Proveedores` | `proveedores` | Catálogo activo de proveedores con NIT, nombre, zona, municipio |
| `Insumos` | `insumos` | Catálogo maestro de insumos |
| `Proyectos` | `proyectos` | Proyectos activos y su zona |
| `OrdenesCompra` | `ordenes_compra` | Órdenes de compra emitidas |
| `OrdenesServicio` | `ordenes_servicio` | Órdenes de servicio emitidas |
| `Requerimientos` | `requerimientos` | Solicitudes de compra procesadas |
| `Remisiones` | `remisiones` | Remisiones generadas |
| `MovimientosInventario` | `movimientos_inventario` | Entradas, salidas y devoluciones de almacén |
| `UsuariosERP` | `usuarios` | Usuarios con acceso al ERP y sus roles |
| `ConfiguracionApp` | *(sin caché)* | Logo, emisor, firmante, IVA y observaciones por defecto |
| *(local)* | `consecutivos_proyecto` | Contador atómico de consecutivos por proyecto |
| *(local)* | `mapeo_proyectos_tesoreria` | Última equivalencia proyecto ERP ↔ proyecto de tesorería |
| *(local)* | `sesiones` | Sesiones activas (solo local, nunca va a SharePoint) |
| *(local)* | `sync_state` | Última sincronización y conteo por lista |

Las listas `OrdenesServicio`, `HistorialPrecios`, `MovimientosInventario` y `UsuariosERP` se
**autoaprovisionan**: si no existen en el sitio, el servidor las crea al arrancar (ver
`asegurarLista*()` en `servidor-cotizaciones.js`). Las demás se crean con
`src/scripts/crear-listas.js`.

Los catálogos (`historial_precios`, `proveedores`, `insumos`, `proyectos`, `usuarios`) usan
columnas tipadas; los documentos (`requerimientos`, `ordenes_compra`, `ordenes_servicio`,
`remisiones`, `movimientos_inventario`) guardan un JSON en la columna `data` con índices
`json_extract`, para no atarse a un esquema rígido que cambia seguido.

> **Campo NIT en SharePoint:** la lista `Proveedores` usa el campo `razonSocial` para el nombre legal. La columna `nombre` es la representación local en SQLite.

---

## Autenticación y Seguridad

### Módulo de Autenticación (Microsoft OAuth 2.0)

A partir de mayo 2026, el ERP implementa **autenticación centralizada con Microsoft 365**:

- **Flujo OAuth 2.0**: Los usuarios inician sesión con su cuenta corporativa Microsoft (correo de Civiltech).
- **Aprobación de usuarios**: Solo usuarios registrados y aprobados por un administrador pueden acceder.
- **Almacenamiento dual**: Registro en SharePoint (fuente de verdad) + SQLite (caché local para velocidad).
- **Sesiones seguras**: Cookies HttpOnly, SameSite=Lax, TTL de 8 horas con renovación automática.
- **Auditoría**: Registro de login, logout y cambios de permisos en SharePoint.

**Usuario administrador por defecto**: El correo configurado en `.env` como `USUARIO_EMAIL` se registra automáticamente como admin la primera vez que el servidor arranca.

### Gestión de Usuarios

Acceder a **Configuración ERP → Usuarios** (solo para administradores):

- **Aprobar usuario**: Usuario nuevo intenta login, aparece en lista como "pendiente" → admin lo aprueba.
- **Cambiar rol**: Asignar rol `admin`, `operador` u otro.
- **Desactivar usuario**: Un usuario activo puede ser desactivado (revoca acceso inmediato).

---

## Características destacadas

### Consecutivo automático por proyecto
Cada requerimiento recibe un consecutivo oficial asignado atómicamente por el sistema (`consecutivoSistema`), diferente al número que el usuario escribe en el formulario de solicitud. El contador vive en SQLite (`consecutivos_proyecto`) y es independiente por proyecto, garantizando unicidad incluso con múltiples usuarios simultáneos.

### Marca de agua en borradores
Los documentos OC y OS en estado *borrador* muestran una marca de agua diagonal "NO APROBADO" al imprimir o exportar a PDF, eliminada automáticamente al aprobar el documento.

### Detección automática de proyecto
Al cargar un requerimiento manual sin seleccionar proyecto, el sistema lo detecta del documento: para Excel lo extrae del encabezado (sin IA, lectura síncrona) y para PDF lo extrae del procesamiento con Gemini AI. El proyecto detectado se muestra en el mensaje de confirmación.

### Creación manual de requerimientos sin formato
El modal "Cargar requerimiento" ofrece dos modos: **Subir formato** (Excel/PDF CT-ADMIN-FO-002) y **Digitar ítems**, para cuando no existe el formato diligenciado. En el segundo modo se capturan proyecto, solicitante y los ítems (insumo, cantidad, unidad, necesidad, posible proveedor) directamente en la consola. El requerimiento resultante pasa por la misma resolución de proyecto y consulta de proveedor/precio histórico que los que llegan por correo, por lo que queda igual en estado *pendiente*. El proyecto es obligatorio en este modo: al no haber documento, no hay de dónde detectarlo.

### Formatos de exportación de requerimiento
El botón "Exportar selección" en la vista de requerimiento permite elegir entre:
- **Detallado**: tabla completa con columnas Solicit., Cubierta, Pendiente, Unidad, Necesidad, Posible proveedor y Estado.
- **Resumido**: tabla compacta con solo #, Insumo, Solicit., Pendiente y Unidad.

Ambos formatos generan un documento HTML listo para imprimir con botones flotantes "Imprimir / Guardar PDF" y "Cerrar" (igual que el template de OC).

### Remisión automática
Al marcar una OC como *entregada*, el sistema genera su remisión de materiales si esa OC todavía no tiene una. Si después se anula la OC, la anulación se propaga en cascada a las remisiones que la incluían.

### PDF de respaldo en SharePoint
El PDF se genera con Chromium headless (Puppeteer) y se sube solo a SharePoint, sin intervención del usuario:

| Documento | Cuándo se sube | Carpeta |
|-----------|----------------|---------|
| Requerimiento | Al crearse (correo o carga manual) | `RequerimientosPDF` |
| Orden de compra | Al marcarse *entregada* | `OrdenesCompraPDF` |
| Orden de servicio | Al marcarse *pagada* | `OrdenesServicioPDF` |

Cada módulo tiene un botón **📁 Carpeta de PDFs** que abre la carpeta correspondiente en SharePoint. Para documentos anteriores a esta función existen los scripts `src/scripts/backfill-pdf-*.js`.

### Análisis IA de inventario
En **1.6 Inventarios → Análisis IA** se puede pegar la tabla de rendimientos APU del proyecto y preguntar en lenguaje natural. Gemini recibe el stock real (entradas, salidas, valor consumido) del proyecto filtrado y responde señalando sobreconsumos, desviaciones y proyecciones de impacto presupuestal.

---

## Ciclo de vida de los documentos

Conocer estos estados es lo más importante antes de tocar el backend: cada transición dispara efectos secundarios en SharePoint, en Control Costos y —opcionalmente— en inventario.

### Orden de compra

```
borrador ──aprobar──> aprobada ──pagar+entregar──> finalizada
    │                    │
    └──────anular────────┴──> anulada
```

- **aprobar** — es la transición pesada. Asigna el número consecutivo real (`contador.js`; **el borrador no tiene número**), y en segundo plano: registra el gasto en `Control Costos.xlsx`, alimenta `HistorialPrecios` con los precios de cada ítem (base + IVA), y recalcula el estado del requerimiento de origen.
- **pagar** / **entregar** — son banderas independientes, no estados. Cuando ambas quedan en verdadero sobre una OC `aprobada`, el estado pasa solo a `finalizada`. Ambas actualizan la fila en Control Costos.
- **entregar** — además genera la remisión, sube el PDF a SharePoint y, si el usuario lo marca en la UI (`autoEntrada` / `autoSalida`), crea y aprueba de una vez los movimientos de inventario de la OC.
- **anular** — propaga la anulación a las remisiones asociadas.

### Orden de servicio

```
borrador ──aprobar──> aprobada ──pagar / cumplir──> finalizada
    │                    │
    └──────anular────────┴──> anulada
```

Mismo patrón: el número se asigna al aprobar, el gasto va a Control Costos y el PDF se sube al marcarse pagada.

### Requerimiento

`pendiente → parcial → gestionado` (o `anulado`). El estado **no se fija a mano**: `calcularEstadoRequerimiento()` lo recalcula comparando las cantidades solicitadas contra lo ya cubierto por las OC vinculadas.

### Movimiento de inventario

Las entradas, salidas y devoluciones se crean agrupadas en un lote (`batchId` con prefijo `BORR-EA-`, `BORR-SA-` o `BORR-DEV-`) y nacen como **borrador**: no afectan el stock. Al aprobar el documento recibe su referencia definitiva (`docRef`) y `estadoDoc: 'aprobado'`, y solo entonces cuenta. Las salidas aprobadas además registran su valor en Control Costos como "Salida Almacén". Una devolución se guarda como salida con la nota `DEVOLUCION:<ref>`.

---

## Integración con tesorería (Cash_Flow)

Desde el **1.3 Registro OCs** una OC `aprobada` o `finalizada` se puede enviar al módulo de tesorería (Pagos Diarios) como solicitud de pago.

- **Es deliberadamente manual.** El proyecto de tesorería y el concepto los elige una persona, y queda registrado quién lo hizo (`solicitado_por`). Los nombres de proyecto no coinciden entre los dos sistemas (`CT25-202 Micropilotes IZZI 96` vs `0378 IZZI 96`), así que la primera vez se empareja a mano y el sistema **recuerda esa elección** para preseleccionarla después (tabla local `mapeo_proyectos_tesoreria`). Es una sugerencia, nunca un automatismo.
- **Las credenciales no salen del servidor.** `tesoreriaClient.js` es el único módulo que las conoce; el navegador solo habla con las rutas `/tesoreria/*` del ERP, nunca con Supabase directamente.
- **Si falta cualquiera de las cuatro variables** `TESORERIA_*`, la integración simplemente no aparece en la consola en vez de dar errores.
- La Edge Function del lado de tesorería es idempotente, así que reintentar un envío es seguro.
- Para verificar la configuración: `node src/scripts/verificar-tesoreria.js`.

---

## Requisitos

**En el VPS** (modo productivo) solo hace falta **Docker Engine + plugin Compose**. Node y sus dependencias viven dentro de la imagen.

**Para desarrollo local:**

| Herramienta | Versión mínima | Descarga |
|-------------|---------------|----------|
| Node.js | 18 LTS o superior | https://nodejs.org |
| Tailscale (opcional) | latest | https://tailscale.com/download |

> Tailscale es necesario solo si se requiere acceso público desde redes externas.
>
> **Python ya no es un requisito.** `src/generarOC.py` quedó como código heredado y ningún
> módulo lo invoca; el `python3` del `Dockerfile` está solo para compilar `better-sqlite3`.
> La generación de Excel se hace en Node con ExcelJS.

---

## Instalación

Para producción, ver [Despliegue en VPS con Docker](#despliegue-en-vps-con-docker). Para desarrollo local:

```bash
git clone https://github.com/KaosFactorDev/oc-automation.git
cd oc-automation
npm install
cp .env.example .env   # y completar los valores (ver Variables de entorno)
npm run dev            # http://localhost:3001
```

> En local, `AUTH_REDIRECT_URI` **tiene que ser** `http://localhost:3001/auth/callback`. Con la
> URL de producción el login saca del localhost y la cookie de sesión se marca `Secure`, que el
> navegador descarta sobre `http://`.

---

## Variables de entorno

Copiar `.env.example` a `.env` y completar los valores. Las credenciales corporativas
(Azure, SharePoint, Gemini) ya vienen configuradas en la copia maestra de OneDrive —
solo es necesario actualizar los campos personales:

```env
# ── Rutas a las bases de datos (fallback CSV — usar solo si SQLite está vacío) ──
PATH_COMPRAS=./data/compras.csv
PATH_PROVEEDORES=./data/proveedores_depurados_final.csv
PATH_PROYECTOS=./data/tabla_proyectos.csv

# ── Microsoft Graph API ───────────────────────────────────────────────────────
TENANT_ID=<azure-tenant-id>
CLIENT_ID=<azure-client-id>
CLIENT_SECRET=<azure-client-secret>

# ── SharePoint ────────────────────────────────────────────────────────────────
SHAREPOINT_HOSTNAME=civiltechic.sharepoint.com
SHAREPOINT_SITE_PATH=/sites/NombreSitio

# ── Buzón de requerimientos ───────────────────────────────────────────────────
MAILBOX=abastecimiento@civiltechic.com

# ── Identificación del usuario (bootstrap del admin inicial) ──────────────────
USUARIO_EMAIL=correo@civiltechic.com        # ← PERSONALIZAR (será admin la primera vez)
# El nombre del firmante sale del login de Microsoft y el cargo se edita
# después en el panel de usuarios (/usuarios).

# ── Autenticación OAuth 2.0 ──────────────────────────────────────────────────
# Para desarrollo local:
AUTH_REDIRECT_URI=http://localhost:3001/auth/callback

# Para acceso público con Tailscale Funnel (ver sección "Acceso Público"):
# AUTH_REDIRECT_URI=https://[HOSTNAME].[TAILNET].ts.net/auth/callback

# ── IA (extracción de cotizaciones) ──────────────────────────────────────────
GEMINI_API_KEY=<api-key>
GEMINI_MODEL=gemini-flash-latest   # alias que Google mantiene apuntando al flash GA vigente

# ── Numeración de documentos ──────────────────────────────────────────────────
OC_PREFIX=OC-
OC_PAD=4
OS_PREFIX=OS-
OS_PAD=4

# ── Servidor ──────────────────────────────────────────────────────────────────
PUERTO_COTIZACIONES=3001

# ── Procesamiento automático de correos ───────────────────────────────────────
POLLING_INTERVAL_MIN=5

# ── SQLite (caché local) ──────────────────────────────────────────────────────
SQLITE_PATH=./data/local.db
SYNC_INTERVAL_MIN=2

# ── Tesorería / Pagos Diarios (opcional) ─────────────────────────────────────
# Si falta cualquiera de las cuatro, la integración no aparece en la consola.
TESORERIA_URL=https://<project-ref>.supabase.co
TESORERIA_ANON_KEY=<anon / publishable key>
TESORERIA_EMAIL=<usuario dedicado con rol 'solicitante'>
TESORERIA_PASSWORD=<contraseña>

# ── Zona horaria (obligatoria en Docker/Linux) ───────────────────────────────
# Sin esto, el horario laboral del cron de correos no se evalúa en hora de Colombia.
TZ=America/Bogota
```

> `GEMINI_MODEL` existe para no tener que tocar código cuando Google retira una versión
> (ya pasó con `gemini-2.5-flash` y `gemini-3.5-flash`). Dejar el alias salvo que se
> necesite comportamiento determinista, en cuyo caso se fija una versión concreta.

---

## Uso

En producción no hay que ejecutar nada a mano: los dos contenedores del VPS levantan solos. Los comandos de abajo son para desarrollo local o para el modelo anterior de instalación por equipo.

### Consola web

```bash
npm start        # consola web en http://localhost:3001
npm run dev      # igual, con reinicio automático al editar un .js
```

En Windows también sirve el doble clic en `iniciar-erp.bat`.

> La ventana de la terminal debe permanecer abierta mientras se use la consola.
>
> La UI son HTML estáticos que el servidor lee del disco en cada petición: para ver un cambio en `ui/` basta recargar el navegador, sin reiniciar.

### Acceso desde otros equipos / redes externas (con Tailscale)

Si se requiere acceder al ERP desde otro equipo o red externa:

1. **Instalar Tailscale** en el equipo servidor:
   - Descargar desde https://tailscale.com/download/windows
   - Instalar y iniciar sesión con cuenta Microsoft

2. **Habilitar Funnel** (en PowerShell como Administrador):
   ```
   tailscale funnel 3001
   ```

3. **Obtener URL pública**:
   ```
   tailscale status
   ```
   Anotar la URL del equipo: `https://[HOSTNAME].[TAILNET].ts.net`

4. **Actualizar .env**:
   ```env
   AUTH_REDIRECT_URI=https://[HOSTNAME].[TAILNET].ts.net/auth/callback
   ```

5. **Registrar en Azure AD**:
   - Portal Azure → App registration (`oc-automation`) → Autenticación
   - Add Redirect URI: `https://[HOSTNAME].[TAILNET].ts.net/auth/callback`

6. **Reiniciar servidor** (`iniciar-erp.bat`)

**Nota**: La URL es permanente — no cambia al reiniciar el servidor. Solo cambiaría si el hostname del equipo cambia.

### Procesamiento automático de correos

En el VPS lo dispara el contenedor `mailer` según [`deploy/crontab`](deploy/crontab). Para correrlo a mano:

```bash
npm run correos          # procesa el buzón una vez
npm run correos:test     # modo prueba, sin conectar al buzón
node index.js --watch    # polling continuo cada POLLING_INTERVAL_MIN
```

> El procesamiento de correos **debe correr en un solo lugar**. Si se levanta en paralelo
> (por ejemplo, el `mailer` del VPS y además un equipo local), los mismos correos se
> procesarían dos veces.

### Tarea programada de Windows *(modelo anterior)*

```powershell
# Instalar
.\instalar-tarea.ps1

# Desinstalar
.\desinstalar-tarea.ps1
```

### Actualizar una instalación de Windows *(modelo anterior)*

```bash
# Doble clic en:
actualizar.bat
```

El archivo `.env` y los datos locales no se modifican durante la actualización.
En el VPS esto no aplica: ver [Actualizaciones — despliegue automático](#actualizaciones--despliegue-automático).

---

## Despliegue en VPS con Docker

A partir de julio 2026 el ERP se centraliza en un VPS Linux: una sola consola web accesible por navegador para todos los usuarios (ya no se ejecuta localmente en cada equipo), y el procesamiento automático de correos corre dentro de un contenedor con cron en vez de la Tarea Programada de Windows.

`docker-compose.yml` define dos servicios que comparten la misma imagen (`Dockerfile`):

| Servicio | Rol |
|----------|-----|
| `app` | Consola web (`src/servidor-cotizaciones.js`), una sola instancia. Las sesiones viven en SQLite, no en memoria, así que soporta múltiples usuarios concurrentes sin cambios. |
| `mailer` | Ejecuta `node index.js` con **supercronic** según `deploy/crontab` — mismo horario que la Tarea Programada de Windows (L-V, cada 5 min, 6:00am–6:55pm hora de Colombia). |

**El reverse proxy (Caddy) NO vive en este repositorio.** Es un proyecto aparte en el VPS,
`~/edge-proxy/`, compartido por todas las apps que se desplieguen ahí (no solo oc-automation) —
ver la sección [Reverse proxy compartido (`edge-proxy`)](#reverse-proxy-compartido-edge-proxy) más
abajo para el detalle y el por qué. `app` solo se une a la red externa `edge` (declarada al final
de `docker-compose.yml`) para que ese Caddy compartido lo pueda alcanzar; no publica ningún puerto
al VPS directamente.

### Requisitos del VPS

- Un VPS Linux (Debian/Ubuntu recomendado) con acceso SSH.
- **Docker Engine + plugin Compose** instalados. En Debian/Ubuntu, el script oficial es el camino más rápido:
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER   # cerrar sesión y volver a entrar para que aplique
  docker compose version          # confirma que el plugin quedó instalado
  ```
- Puertos **80 y 443** abiertos en el firewall del VPS (y en el panel del proveedor, si aplica) para que el Caddy compartido pueda servir la consola y, más adelante, emitir el certificado HTTPS.
- Git (o alguna forma de subir el código, ej. `scp`/`rsync`) para llevar el repositorio al VPS.
- El reverse proxy compartido (`~/edge-proxy/`) ya levantado — ver la sección de más abajo. Si es
  el primer proyecto que se despliega en ese VPS, hay que crearlo antes del primer despliegue.

### Primer despliegue (dar de alta el sistema en el VPS)

> **Importante:** llevar también el `data/local.db` existente del equipo central, no arrancar con la carpeta `data/` vacía. `bootstrapAdmin()` y el registro de usuario en el login (`servidor-cotizaciones.js`) deciden si un usuario ya existe mirando el **caché SQLite local** (`localDb.countUsuarios()` / `getUsuarioByEmail()`), no la lista `UsuariosERP` de SharePoint real. Si arranca vacía, la primera vez que el servidor levante o que alguien haga login va a **crear un usuario/admin duplicado en SharePoint**, aunque ya exista. Copiando el `local.db` real se evita ese arranque en frío.
>
> `data/` se monta directo desde la carpeta del proyecto en el VPS (`./data:/app/data`, ver `docker-compose.yml`) — no es un volumen aparte, así que lo que copies ahí con `scp` es exactamente lo que va a usar el contenedor. El contenedor corre con un usuario de sistema fijo (UID/GID `10001`), por eso el `chown` del paso 2 es necesario: sin él, Docker no puede escribir `local.db` en esa carpeta.

```bash
# 0. Si el reverse proxy compartido (~/edge-proxy/) todavía no existe en este VPS, crearlo
#    primero -- ver la sección "Reverse proxy compartido (edge-proxy)" más abajo.

# 1. Llevar el código al VPS (una sola vez)
git clone <url-del-repositorio> oc-automation
cd oc-automation

# 2. Copiar el .env Y el data/local.db reales del equipo central al VPS
#    (ejecutar desde la máquina que sí los tiene, apuntando al VPS)
scp .env           "usuario@vps:/ruta/oc-automation/.env"
scp data/local.db  "usuario@vps:/ruta/oc-automation/data/local.db"

# En el VPS: dar permisos de escritura al usuario del contenedor (UID/GID 10001)
sudo chown -R 10001:10001 data

# 3. Ya en el VPS, dentro de la carpeta del proyecto:
docker compose build
docker compose up -d

# 4. Verificar
docker compose ps
docker compose logs -f app      # consola web
docker compose logs -f mailer   # procesamiento de correos
```

Con esto el sistema queda dado de alta: ya **no** hace falta instalar Node.js, Python, `npm install`, `iniciar-erp.bat` ni `instalar-tarea.ps1` en el VPS — todo vive dentro de los contenedores. Esos pasos (documentados en `INSTALACION.md`) solo aplican al modelo anterior de instalación local por equipo.

El directorio `data/` (caché SQLite, incluye sesiones y consecutivos por proyecto) se monta directo desde la carpeta del proyecto en el VPS (bind mount, no un volumen aparte) y persiste entre reinicios y actualizaciones mientras no se borre esa carpeta.

### Reverse proxy compartido (`edge-proxy`)

Caddy no corre dentro de este `docker-compose.yml` — es un proyecto aparte en el VPS,
`~/edge-proxy/`, que es el único dueño de los puertos 80/443 **de todo el servidor**, no solo de
oc-automation. La razón: si el día de mañana se despliega otra app en el mismo VPS, esa app no
podría publicar su propio proxy en 80/443 — ya estarían tomados. Con un proxy compartido, cada app
nueva solo se conecta a la misma red y agrega un bloque al `Caddyfile` compartido, sin pelear por
puertos ni tocar código de nadie.

**Crear el proxy compartido (una sola vez por VPS, si no existe todavía):**
```bash
docker network create edge

mkdir -p ~/edge-proxy && cd ~/edge-proxy
cat > docker-compose.yml <<'EOF'
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - edge

networks:
  edge:
    external: true

volumes:
  caddy_data:
  caddy_config:
EOF

cat > Caddyfile <<'EOF'
# oc-automation -- mientras no haya dominio propio, sirve HTTP plano en el puerto 80.
:80 {
	reverse_proxy oc-automation-app:3001
}

# Cuando oc-automation tenga dominio propio, reemplazar el bloque anterior por:
#   erp.civiltechic.com {
#       reverse_proxy oc-automation-app:3001
#   }

# Próximo proyecto en este VPS -- agregar aquí un bloque nuevo, ej.:
#   otro-dominio.com {
#       reverse_proxy <container_name-del-otro-proyecto>:<puerto>
#   }
EOF

docker compose up -d
```

`oc-automation-app` en el `Caddyfile` es el `container_name` fijo del servicio `app` de este
repo (ver `docker-compose.yml`) — por eso Caddy lo puede alcanzar por nombre aunque viva en otro
proyecto de Compose, siempre que ambos estén conectados a la misma red `edge`.

**Para agregar un proyecto nuevo más adelante:** en el `docker-compose.yml` de ese proyecto,
ponerle `container_name` fijo a su servicio web, unirlo a la red externa `edge` (mismo patrón que
`app` en este repo), y agregar su bloque correspondiente en `~/edge-proxy/Caddyfile`. Después
`docker compose up -d` en el proyecto nuevo y `docker compose restart` en `~/edge-proxy/` para que
Caddy recargue el archivo.

### Pendiente hasta tener dominio propio

Microsoft OAuth exige `https://` en `AUTH_REDIRECT_URI` para dominios públicos (solo permite `http://localhost`), así que el login por internet no queda 100% operativo hasta ese momento. Mientras tanto se puede probar por túnel SSH (`ssh -L 3001:localhost:3001 usuario@vps`) o Tailscale, igual que en el modelo anterior. Cuando el dominio esté listo:

1. Apuntar el registro DNS A del dominio a la IP del VPS.
2. Editar `~/edge-proxy/Caddyfile` reemplazando el bloque `:80` de oc-automation por el dominio (ver comentarios en el archivo) y `docker compose restart` en `~/edge-proxy/`.
3. Actualizar `AUTH_REDIRECT_URI` en el `.env` de oc-automation en el VPS a `https://<dominio>/auth/callback`.
4. Registrar esa misma URL en Azure AD (App registration → Autenticación).
5. `docker compose up -d` en `~/oc-automation/` para aplicar el cambio del `.env`.

### Actualizaciones — despliegue automático

**Todo push a `main` despliega solo.** El workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) empuja el código al VPS por `rsync` sobre SSH, reconstruye los contenedores y **espera al healthcheck**: si la app no llega a `healthy` en 2 minutos, el deploy falla mostrando los logs.

El runner es quien empuja (antes el VPS jalaba con `git fetch`). Se invirtió el flujo porque la organización tiene las deploy keys deshabilitadas por política, así que el VPS ya no necesita credenciales de GitHub y el repo puede ser privado.

Son **dos llamadas de `rsync` a propósito**:

| Llamada | Qué sincroniza | Por qué así |
|---------|---------------|-------------|
| 1 — Código | Todo menos `data/`, `.env`, `.git`, `node_modules`, `logs/`, `temp/` | Con `--delete` y escritura atómica |
| 2 — Plantillas | Solo `data/`, excluyendo `local.db*` | **Sin `--delete`**: la base de datos no depende de que la lista de excludes esté bien escrita, sino de que la operación de borrar no exista en esa llamada |

Lo que un deploy sobrescriba o borre queda respaldado en `../deploy-backups/<sha>/` dentro del VPS.

**Rollback manual** (el `.git/` del VPS queda intacto porque está excluido del rsync):

```bash
cd <VPS_PATH>
git fetch origin main && git reset --hard origin/main
docker compose up -d --build
```

**Despliegue a mano**, si hiciera falta:

```bash
git pull
docker compose build
docker compose up -d
```

Secrets requeridos en el repositorio: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PATH` y `VPS_PORT` (opcional, por defecto 22).

---

## Estructura del proyecto

```
oc-automation/
├── index.js                          ← Punto de entrada del procesamiento de correos
├── Dockerfile                        ← Imagen compartida por los servicios app y mailer
├── docker-compose.yml                ← Servicios app (consola) + mailer (cron)
├── .env / .env.example               ← Configuración (el .env no va a git)
├── README.md · INSTALACION.md · CONTRIBUTING.md
│
├── .github/workflows/
│   └── deploy.yml                    ← Despliegue automático al VPS por rsync/SSH
│
├── deploy/
│   └── crontab                       ← Horario del mailer (supercronic)
│
├── src/
│   ├── servidor-cotizaciones.js      ← Servidor web (puerto 3001) + API REST + auth middleware
│   ├── authService.js                ← Autenticación Microsoft OAuth 2.0 + sesiones
│   ├── db.js                         ← Caché SQLite local + usuarios, sesiones y consecutivos
│   ├── syncService.js                ← Sincronización SharePoint → SQLite (cada 2 min)
│   ├── graphStorage.js               ← Wrapper Microsoft Graph API (SharePoint / OneDrive)
│   ├── leerCorreos.js                ← Lectura de correos vía Microsoft Graph
│   ├── procesarCorreo.js             ← Orquestador de procesamiento de correos
│   ├── parsearAsunto.js              ← Parser de asunto de correo
│   ├── leerRequerimiento.js          ← Extracción desde Excel de requerimiento
│   ├── leerRequerimientoPDF.js       ← Extracción desde PDF/imagen (Gemini AI)
│   ├── requerimientos.js             ← Operaciones sobre lista Requerimientos
│   ├── consultaProveedor.js          ← Búsqueda de proveedor óptimo (historial + zona)
│   ├── contador.js                   ← Numeración consecutiva OC / OS
│   ├── configApp.js                  ← Configuración persistente de la app
│   ├── controlCostos.js              ← Registro de gastos en "Control Costos.xlsx"
│   ├── tesoreriaClient.js            ← Cliente de tesorería (Cash_Flow / Pagos Diarios)
│   ├── ocTemplate.js                 ← Plantilla de documento OC (HTML + Excel)
│   ├── osTemplate.js                 ← Plantilla de documento OS (HTML + Excel)
│   ├── remisionTemplate.js           ← Plantilla de remisión (HTML + Excel)
│   ├── requerimientoTemplate.js      ← HTML del requerimiento para su PDF de respaldo
│   ├── pdfGenerator.js               ← HTML → PDF con Puppeteer / Chromium
│   ├── rotar-logs.js                 ← Rotación de archivos de log
│   ├── generarOC.py                  ← (heredado, sin uso — ningún módulo lo invoca)
│   └── scripts/                      ← Utilidades de una sola ejecución (ver más abajo)
│
├── ui/
│   ├── consola.html                  ← Interfaz web (SPA, todos los módulos)
│   ├── cotizaciones.html             ← UI anterior, servida en /legacy
│   └── categorizar-insumos.html      ← Herramienta suelta, sin ruta que la sirva
│
└── data/                             ← Bind mount en el VPS; persiste entre despliegues
    ├── local.db                      ← SQLite caché (generado automáticamente)
    ├── compras.csv                   ← Fallback CSV historial precios (solo si SQLite vacío)
    ├── proveedores_depurados_final.csv ← Fallback CSV proveedores (solo si SQLite vacío)
    ├── tabla_proyectos.csv           ← Fallback CSV proyectos (solo si SQLite vacío)
    ├── plantilla_oc.xlsx             ← Plantilla Excel para OCs
    └── CT-ADMIN-FO-002_...xlsx       ← Formato de solicitud de requerimiento
```

En la raíz quedan además los archivos del modelo anterior de instalación local por equipo
(`iniciar-erp.bat`, `actualizar.bat`, `instalar-tarea.ps1`, `desinstalar-tarea.ps1`,
`iniciar-erp-tray.ps1`). Siguen sirviendo para levantar el ERP en un Windows, pero en
producción ya no se usan: todo corre en el VPS.

### Scripts (`src/scripts/`)

Son utilidades de una sola ejecución, no parte del ciclo normal. Se corren a mano con `node`.

| Script | Para qué |
|--------|----------|
| `crear-listas.js` · `esquemas.js` | Crea las listas en SharePoint según su esquema (setup inicial) |
| `init-sqlite.js` | Poblado inicial SharePoint → SQLite |
| `migrarCSV.js` | Migra `compras.csv` → lista `HistorialPrecios` |
| `migrarOC.js` | Retroalimenta `HistorialPrecios` con las OC ya aprobadas |
| `migrar-proveedores.js` · `cargar-insumos.js` · `provisionar-proyectos.js` | Siembra de catálogos |
| `crear-control-costos.js` | Genera el libro `Control Costos.xlsx` |
| `backfill-pdf-requerimientos.js` · `backfill-pdf-ordenes-compra.js` · `backfill-pdf-ordenes-servicio.js` | Genera y sube los PDF de documentos anteriores a la función de PDF automático |
| `verificar-tesoreria.js` | Diagnostica la integración con tesorería (variables, login, rol) |
| `limpiar-ocs-prueba.js` · `wipe-datos-prueba.js` | Limpieza de datos de prueba — **destructivos** |

---

## Solución de problemas

| Problema | Causa probable | Solución |
|----------|---------------|----------|
| "Puerto 3001 en uso" | Otro proceso usa el puerto | Cambiar `PUERTO_COTIZACIONES=3002` en `.env` |
| "Error de autenticación" | CLIENT_SECRET expirado | Solicitar al administrador el nuevo valor |
| "AADSTS500113" (login falla) | AUTH_REDIRECT_URI no registrada en Azure AD | Registrar la URL en Azure portal → App → Autenticación |
| "Pantalla de login infinita" | Usuario no aprobado aún | Administrador debe aprobar usuario en Configuración |
| "Sesión expirada" | Cookie expiró después de 8h | Hacer logout y login de nuevo |
| La página no carga | Consola CMD cerrada | Volver a ejecutar `iniciar-erp.bat` |
| Los datos no aparecen | Sin conexión a internet | Verificar conectividad — datos en SharePoint |
| Buscador de Precios vacío | Lista `HistorialPrecios` vacía en SQLite | Esperar sync (2 min) o forzar con `GET /sync` |
| Precios sugeridos desactualizados | Cache activo (60 seg) | Esperar 1 min y recargar, o reiniciar consola |
| Proyectos no aparecen en desplegable | SQLite desincronizado | Forzar sincronización con `GET /sync` |
| Tailscale Funnel no funciona | Tailscale servicio no activo | Instalar Tailscale o reiniciar el servicio |
| URL de Tailscale cambia | Hostname cambió | Actualizar Azure AD y .env con nueva URL |
| No aparece la columna "Tesorería" en 1.3 | Falta alguna variable `TESORERIA_*` | Completar el `.env` y verificar con `node src/scripts/verificar-tesoreria.js` |
| Se creó un usuario/admin duplicado en SharePoint | El servidor arrancó con `data/` vacío | Restaurar el `data/local.db` real antes de levantar (ver Primer despliegue) |
| Falla la extracción con IA | Modelo de Gemini retirado por Google | Dejar `GEMINI_MODEL=gemini-flash-latest` o fijar una versión vigente |
| Una salida de almacén no descuenta stock | El documento sigue en borrador | Aprobar el documento en 1.6 Inventarios |

---

## Notas importantes

- **El procesamiento de correos corre en un solo lugar** (el contenedor `mailer` del VPS). Levantarlo en paralelo en otra máquina duplicaría requerimientos.
- **Scripts de `src/scripts/`**: son de una sola ejecución y varios son destructivos. No correrlos contra producción sin entender qué borran.
- **Archivos CSV en `data/`**: son fallback de último recurso. En operación normal, todos los datos vienen de SQLite (sincronizado desde SharePoint). Mantenerlos como respaldo pero no como fuente principal.
- **SharePoint es la fuente de verdad**; SQLite es caché. Toda escritura nueva debe ir primero a SharePoint y después reflejarse en SQLite (`localDb.upsertDocumento(...)`), porque no hay una capa que lo garantice sola.
- **No hay pruebas automatizadas.** `npm test` no está implementado y `src/test.js` es un script suelto de exploración. Los cambios se validan a mano contra la consola.

---

## Gestión de proveedores

La lista `Proveedores` en SharePoint es el catálogo oficial. Para mantenerla actualizada:

- **Inscribir proveedor**: Configuración ERP → formulario con NIT, nombre, zona, municipio, teléfono, correo.
- **Detectar sin registrar**: botón "Detectar sin registrar" en la sección de proveedores. Cruza el historial de OCs y OSs contra el catálogo y muestra los que aún no están inscritos.
- **Validación automática**: antes de generar una OC (módulos 1.1 y 1.2), el sistema verifica que todos los proveedores seleccionados estén inscritos. Si alguno no lo está, bloquea la emisión y abre el formulario de inscripción.

**Normalización de NIT**: el sistema compara solo los 9 primeros dígitos del NIT (sin dígito de verificación ni puntos), por lo que `900.123.456-1`, `900123456` y `9001234561` se consideran el mismo proveedor.

---

## Contribuir

Convenciones de ramas, commits y despliegue: ver [CONTRIBUTING.md](CONTRIBUTING.md).

---

*Civiltech Ingeniería y Construcción S.A.S. · Agosto 2026*
