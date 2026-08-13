# OC-Automation — ERP de Compras y Servicios · Civiltech IC

Consola web de gestión de requerimientos, órdenes de compra y órdenes de servicio para **Civiltech Ingeniería y Construcción S.A.S.** Se ejecuta localmente en cada equipo pero toda la información se almacena en SharePoint (nube corporativa), lo que permite que varios usuarios accedan a los mismos datos sin sincronización manual.

> **¿Vas a trabajar en el código?** Lee primero [CONTRIBUTING.md](CONTRIBUTING.md) — flujo de ramas, convención de commits y entorno local. Ten presente que **un merge a `main` despliega a producción de inmediato**.

---

## Módulos

| Módulo | Función |
|--------|---------|
| **1.1 Requerimientos** | Visualiza solicitudes de compra recibidas por correo o cargadas manualmente. Consecutivo automático y atómico por proyecto. Comparativa de proveedores. Genera OC(s) en borrador. Bloquea emisión si el proveedor no está registrado. |
| **1.2 Generar OC** | Genera órdenes de compra desde una cotización (PDF, Excel, imagen). IA extrae ítems y precios. Autocomplete NIT ↔ Proveedor en tabla de ítems. Bloquea emisión si algún proveedor no está registrado. |
| **1.3 Registro OCs** | Historial de órdenes de compra con búsqueda, filtros (Aprobadas excluye entregadas), aprobación, pago y entrega. |
| **1.4 Órdenes de Servicio** | Crea nuevas órdenes de servicio con asistencia de IA para generar el clausulado. |
| **1.5 Registro OSs** | Historial de órdenes de servicio emitidas con edición de borradores y aprobación. |
| **Configuración ERP** | Administración de proveedores registrados: alta, edición, búsqueda y detección de proveedores con historial OC/OS no inscritos en el catálogo. |

---

## Arquitectura

```
Correos (Outlook / abastecimiento@civiltechic.com)
         │
         ▼
   index.js (procesamiento automático)
         │
         ├─ leerCorreos.js          ← Lectura de buzón vía Microsoft Graph API
         ├─ leerRequerimiento.js    ← Extracción desde Excel adjunto
         ├─ leerRequerimientoPDF.js ← Extracción desde PDF/imagen (Gemini AI)
         └─ requerimientos.js       ← Escritura a lista SharePoint "Requerimientos"

Consola web (http://localhost:3001)
         │
         ▼
   servidor-cotizaciones.js
         │
         ├─ graphStorage.js         ← Wrapper Microsoft Graph API (SharePoint)
         ├─ db.js                   ← Caché SQLite (lectura rápida sin red)
         ├─ syncService.js          ← Sincronización SharePoint → SQLite (c/2 min)
         ├─ ocTemplate.js           ← Generación de documentos OC (HTML + Excel)
         ├─ osTemplate.js           ← Generación de documentos OS (HTML + Excel)
         ├─ remisionTemplate.js     ← Generación de remisiones
         ├─ contador.js             ← Numeración consecutiva OC / OS
         ├─ configApp.js            ← Configuración de la aplicación
         └─ Gemini API              ← Extracción de ítems desde cotizaciones
```

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
| `UsuariosERP` | `usuarios` | Usuarios con acceso al ERP y sus roles |
| *(local)* | `consecutivos_proyecto` | Contador atómico de consecutivos por proyecto |
| *(local)* | `sesiones` | Sesiones activas (solo local, nunca va a SharePoint) |

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

### Formatos de exportación de requerimiento
El botón "Exportar selección" en la vista de requerimiento permite elegir entre:
- **Detallado**: tabla completa con columnas Solicit., Cubierta, Pendiente, Unidad, Necesidad, Posible proveedor y Estado.
- **Resumido**: tabla compacta con solo #, Insumo, Solicit., Pendiente y Unidad.

Ambos formatos generan un documento HTML listo para imprimir con botones flotantes "Imprimir / Guardar PDF" y "Cerrar" (igual que el template de OC).

---

## Requisitos

| Herramienta | Versión mínima | Descarga |
|-------------|---------------|----------|
| Node.js | 18 LTS o superior | https://nodejs.org |
| Python | 3.10 o superior | https://www.python.org/downloads/ |
| openpyxl (Python) | cualquiera | `pip install openpyxl` |
| Tailscale (opcional) | latest | https://tailscale.com/download |

> Durante la instalación de Python marcar **"Add Python to PATH"**.
> Tailscale es necesario solo si se requiere acceso público desde redes externas.

---

## Instalación

```bash
# 1. Clonar o copiar la carpeta del software al equipo
#    Recomendado: C:\OC-Automation\

# 2. Instalar dependencias Node.js
npm install

# 3. Configurar el archivo de entorno
#    Editar .env con los datos personales del usuario (ver sección Variables de entorno)
```

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

# ── Python (solo si no está en PATH) ─────────────────────────────────────────
# PYTHON_PATH=C:\Python313\python.exe
```

---

## Uso

### Consola web (uso diario)

```bash
# Opción A — doble clic en:
iniciar-erp.bat

# Opción B — desde CMD:
node src\servidor-cotizaciones.js
```

Abrir el navegador en **http://localhost:3001**

> La ventana CMD debe permanecer abierta mientras se use la consola.

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

```bash
# Ejecutar una sola vez (para Tarea Programada de Windows)
node index.js

# Polling continuo cada N minutos
node index.js --watch

# Modo prueba (sin conexión al buzón)
node index.js --test
```

> El procesamiento automático de correos **solo debe correr en el equipo central** (Brayan).
> Los demás equipos solo abren la consola web.

### Tarea programada de Windows

```powershell
# Instalar
.\instalar-tarea.ps1

# Desinstalar
.\desinstalar-tarea.ps1
```

### Actualizaciones

```bash
# Doble clic en:
actualizar.bat
```

El archivo `.env` y los datos locales no se modifican durante la actualización.

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

### Actualizaciones

```bash
git pull
docker compose build
docker compose up -d
```

---

## Estructura del proyecto

```
oc-automation/
├── index.js                          ← Punto de entrada (polling / test)
├── iniciar-erp.bat                   ← Abre la consola web
├── actualizar.bat                    ← Actualiza el software
├── instalar-tarea.ps1                ← Instala tarea programada de Windows
├── desinstalar-tarea.ps1             ← Desinstala tarea programada
├── .env                              ← Configuración local (no subir a git)
├── .env.example                      ← Plantilla de configuración
├── INSTALACION.md                    ← Guía de instalación detallada
│
├── src/
│   ├── servidor-cotizaciones.js      ← Servidor web principal (puerto 3001) + API REST + auth middleware
│   ├── authService.js                ← Autenticación Microsoft OAuth 2.0 + sesiones
│   ├── db.js                         ← Caché SQLite local + tablas de usuarios y sesiones
│   ├── syncService.js                ← Sincronización SharePoint → SQLite (cada 2 min)
│   ├── leerCorreos.js                ← Lectura de correos vía Microsoft Graph
│   ├── procesarCorreo.js             ← Orquestador de procesamiento de correos
│   ├── leerRequerimiento.js          ← Extracción desde Excel de requerimiento
│   ├── leerRequerimientoPDF.js       ← Extracción desde PDF/imagen (Gemini AI)
│   ├── requerimientos.js             ← Operaciones sobre lista Requerimientos
│   ├── ocTemplate.js                 ← Plantilla de documento OC (HTML + Excel)
│   ├── osTemplate.js                 ← Plantilla de documento OS (HTML + Excel)
│   ├── remisionTemplate.js           ← Plantilla de remisión
│   ├── generarOC.py                  ← Generación de OC en Excel con openpyxl
│   ├── graphStorage.js               ← Wrapper Microsoft Graph API
│   ├── consultaProveedor.js          ← Búsqueda de proveedor óptimo (historial + zona)
│   ├── controlCostos.js              ← Lista de control de costos
│   ├── configApp.js                  ← Configuración persistente de la app
│   ├── contador.js                   ← Numeración consecutiva OC / OS
│   ├── parsearAsunto.js              ← Parser de asunto de correo
│   ├── rotar-logs.js                 ← Rotación de archivos de log
│   └── scripts/
│       ├── crear-listas.js           ← Crea listas en SharePoint (setup inicial)
│       ├── migrarCSV.js              ← Migra historial CSV → SharePoint
│       ├── migrarOC.js               ← Migra OCs antiguas → SharePoint
│       ├── cargar-insumos.js         ← Carga catálogo de insumos a SharePoint
│       ├── migrar-proveedores.js     ← Migra proveedores a SharePoint
│       ├── provisionar-proyectos.js  ← Crea proyectos en SharePoint
│       └── wipe-datos-prueba.js      ← Limpia datos de prueba
│
├── ui/
│   └── consola.html                  ← Interfaz web (SPA)
│
└── data/
    ├── local.db                      ← SQLite caché (generado automáticamente)
    ├── compras.csv                   ← Fallback CSV historial precios (solo si SQLite vacío)
    ├── proveedores_depurados_final.csv ← Fallback CSV proveedores (solo si SQLite vacío)
    ├── tabla_proyectos.csv           ← Fallback CSV proyectos (solo si SQLite vacío)
    ├── plantilla_oc.xlsx             ← Plantilla Excel para OCs
    └── CT-ADMIN-FO-002_...xlsx       ← Formato de solicitud de requerimiento
```

---

## Solución de problemas

| Problema | Causa probable | Solución |
|----------|---------------|----------|
| "Puerto 3001 en uso" | Otro proceso usa el puerto | Cambiar `PUERTO_COTIZACIONES=3002` en `.env` |
| "Error de autenticación" | CLIENT_SECRET expirado | Solicitar al administrador el nuevo valor |
| "AADSTS500113" (login falla) | AUTH_REDIRECT_URI no registrada en Azure AD | Registrar la URL en Azure portal → App → Autenticación |
| "Pantalla de login infinita" | Usuario no aprobado aún | Administrador debe aprobar usuario en Configuración |
| "Sesión expirada" | Cookie expiró después de 8h | Hacer logout y login de nuevo |
| "Python no encontrado" | Python no está en PATH | Agregar `PYTHON_PATH=ruta\python.exe` en `.env` |
| La página no carga | Consola CMD cerrada | Volver a ejecutar `iniciar-erp.bat` |
| Los datos no aparecen | Sin conexión a internet | Verificar conectividad — datos en SharePoint |
| Buscador de Precios vacío | Lista `HistorialPrecios` vacía en SQLite | Esperar sync (2 min) o forzar con `GET /sync` |
| Precios sugeridos desactualizados | Cache activo (60 seg) | Esperar 1 min y recargar, o reiniciar consola |
| Proyectos no aparecen en desplegable | SQLite desincronizado | Forzar sincronización con `GET /sync` |
| Tailscale Funnel no funciona | Tailscale servicio no activo | Instalar Tailscale o reiniciar el servicio |
| URL de Tailscale cambia | Hostname cambió | Actualizar Azure AD y .env con nueva URL |

---

## Notas importantes

- **Tarea programada**: instalar solo en el equipo central. Los demás equipos únicamente abren la consola web.
- **Scripts de migración** (`src/scripts/`): se ejecutaron una vez para poblar SharePoint. No ejecutar en equipos adicionales.
- **Archivos CSV en `data/`**: son fallback de último recurso. En operación normal, todos los datos vienen de SQLite (sincronizado desde SharePoint). Mantenerlos como respaldo pero no como fuente principal.
- **Desinstalación**: eliminar la carpeta del software. No instala nada en el sistema operativo más allá de su carpeta propia.

---

## Gestión de proveedores

La lista `Proveedores` en SharePoint es el catálogo oficial. Para mantenerla actualizada:

- **Inscribir proveedor**: Configuración ERP → formulario con NIT, nombre, zona, municipio, teléfono, correo.
- **Detectar sin registrar**: botón "Detectar sin registrar" en la sección de proveedores. Cruza el historial de OCs y OSs contra el catálogo y muestra los que aún no están inscritos.
- **Validación automática**: antes de generar una OC (módulos 1.1 y 1.2), el sistema verifica que todos los proveedores seleccionados estén inscritos. Si alguno no lo está, bloquea la emisión y abre el formulario de inscripción.

**Normalización de NIT**: el sistema compara solo los 9 primeros dígitos del NIT (sin dígito de verificación ni puntos), por lo que `900.123.456-1`, `900123456` y `9001234561` se consideran el mismo proveedor.

---

*Civiltech Ingeniería y Construcción S.A.S. · Mayo 2026*
