# Guía de instalación — OC-Automation (Civiltech)

## ¿Qué es este software?

OC-Automation es la consola de gestión de Órdenes de Compra y Servicio de Civiltech.
Se instala localmente en cada equipo, pero toda la información se almacena en SharePoint
(nube corporativa). Esto significa que varios usuarios pueden ver y gestionar los mismos
requerimientos desde equipos distintos sin necesidad de sincronizar nada manualmente.

**Arquitectura:**
- El equipo central (Brayan) procesa automáticamente los correos de requerimiento.
- Los demás equipos solo acceden a la consola web para revisar y aprobar OCs/OS.

> **A partir de julio 2026 existe una segunda forma de dar de alta el sistema: con Docker en un
> VPS Linux**, centralizando la consola web y el procesamiento de correos en un solo servidor
> para todos los usuarios (en vez de instalar el software en cada equipo Windows). Si vas a montar
> el sistema así, salta directo a [Alta del sistema con Docker (VPS Linux)](#alta-del-sistema-con-docker-vps-linux);
> el resto de esta guía (Node.js/Python, copia maestra en OneDrive, `iniciar-erp.bat`, etc.)
> aplica solo a la instalación local por equipo Windows.

---

## Base de datos en la nube

Toda la información de precios, proveedores e insumos se almacena en SharePoint (listas de la nube corporativa):

| Lista SharePoint | Contenido |
|---|---|
| HistorialPrecios | Precios pagados por OC y cotización — fuente del Buscador de Precios |
| Proveedores | Catálogo activo de proveedores |
| Insumos | Catálogo maestro de insumos |
| Proyectos | Proyectos activos y su zona |
| OrdenesCompra / OrdenesServicio | Documentos emitidos |
| Requerimientos / Remisiones | Solicitudes y entregas |

Los archivos CSV en `data/` son respaldo de emergencia — el software los usa automáticamente
solo si no puede conectar con SharePoint. En condiciones normales, los CSV no son necesarios.

---

## Requisitos de instalación

Antes de comenzar, instalar en el equipo nuevo:

### 1. Node.js
- Ir a: https://nodejs.org
- Descargar el botón verde **"LTS"** (versión estable)
- Instalar con todas las opciones por defecto
- Verificar: abrir CMD y escribir `node --version` → debe mostrar un número (ej. v20.x.x)

### 2. Python 3
- Ir a: https://www.python.org/downloads/
- Descargar **"Download Python 3.13.x"**
- Durante la instalación: marcar la casilla **"Add Python to PATH"** ✅
- Después de instalar, abrir CMD y ejecutar:
  ```
  pip install openpyxl
  ```
- Verificar: `python --version` → debe mostrar Python 3.x.x

---

## Alta del sistema con Docker (VPS Linux)

Este método reemplaza toda la sección de instalación local por equipo (Node.js, Python, copia
maestra en OneDrive, `iniciar-erp.bat`, `instalar-tarea.ps1`): en vez de eso, se levanta **una sola
vez** en un servidor VPS y todos los usuarios acceden por navegador. El detalle técnico completo
(arquitectura de contenedores, qué hace cada servicio, cómo activar HTTPS cuando haya dominio
propio) está en el `README.md`, sección **"Despliegue en VPS con Docker"** — aquí va el checklist
de alta paso a paso.

### Qué se necesita antes de empezar

- Un VPS Linux (Debian/Ubuntu) con acceso SSH.
- El `.env` real con las credenciales corporativas (Azure, SharePoint, Gemini) — el mismo que ya
  usa el equipo central, no se crea uno nuevo.
- El archivo `data/local.db` del equipo central (caché SQLite con usuarios y consecutivos). Es
  importante llevarlo también, no solo el `.env` — más abajo se explica por qué.

### Paso 1 — Instalar Docker en el VPS

Por SSH, en el VPS:
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # cerrar sesión y volver a entrar para que aplique
docker compose version          # debe mostrar una versión, confirma que quedó instalado
```
Abrir los puertos **80 y 443** en el firewall del VPS (y en el panel del proveedor si aplica) —
por ahí sirve la consola el reverse proxy compartido.

### Paso 2 — Crear el reverse proxy compartido (`edge-proxy`)

El reverse proxy (Caddy) no vive dentro del proyecto de oc-automation — es un mini-proyecto aparte
en el VPS, `~/edge-proxy/`, pensado para ser compartido por **cualquier** app que se despliegue en
ese servidor más adelante, no solo esta. Si ya existe en el VPS (porque ya se desplegó otra app ahí
antes), saltar este paso. Si es la primera vez:

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
:80 {
	reverse_proxy oc-automation-app:3001
}
EOF

docker compose up -d
```

Detalle completo (incluyendo cómo activar HTTPS con dominio propio y cómo agregar un proyecto
nuevo más adelante) en `README.md`, sección **"Reverse proxy compartido (`edge-proxy`)"**.

### Paso 3 — Llevar el código y la configuración al VPS

```bash
# Clonar el repositorio en el VPS
git clone https://github.com/KaosFactorDev/oc-automation.git oc-automation
cd oc-automation

# Desde el equipo que sí tiene el .env y el local.db reales, copiarlos al VPS:
scp .env           usuario@vps:/ruta/oc-automation/.env
scp data/local.db  usuario@vps:/ruta/oc-automation/data/local.db
```

Ya en el VPS, dar permisos de escritura al usuario del contenedor (corre con UID/GID fijo `10001`,
no como root):
```bash
sudo chown -R 10001:10001 data
```

> **Por qué copiar también `data/local.db` y ajustar permisos:** el código decide si un usuario ya
> existe (para no crear un admin duplicado al primer arranque) consultando el **caché SQLite
> local**, no la lista `UsuariosERP` de SharePoint directamente. La carpeta `data/` se monta
> directo desde el proyecto (`./data:/app/data`) — no es un volumen aparte — así que si arranca sin
> `local.db`, o el contenedor no puede escribir ahí por permisos, el primer arranque del servidor
> —o el primer login— puede crear un usuario/admin **duplicado** en SharePoint. Llevar el
> `local.db` ya poblado y darle el `chown` correcto evita ese arranque en frío.

### Paso 4 — Levantar los servicios

```bash
docker compose build
docker compose up -d
```

Esto levanta dos servicios (ver detalle en `README.md`):
- `app` — la consola web (equivalente a `iniciar-erp.bat`, pero centralizada para todos). Se une
  a la red `edge` creada en el Paso 2 para que el reverse proxy compartido la pueda alcanzar.
- `mailer` — el procesamiento automático de correos (equivalente a la Tarea Programada de
  Windows / `instalar-tarea.ps1`), mismo horario laboral (L-V, 6:00am–6:55pm).

### Paso 5 — Verificar

```bash
docker compose ps                # los 2 servicios deben verse "Up"
docker compose logs -f app       # confirma que conectó con SharePoint sin errores
docker compose logs -f mailer    # confirma que el cron quedó programado
```

Abrir `http://<IP-del-VPS>/` en el navegador — debe cargar la consola.

> **Login por internet:** Microsoft OAuth exige `https://` en la URL de redirect para dominios
> públicos (solo permite `http://localhost`), así que el login completo no queda operativo hasta
> tener un dominio propio apuntando al VPS. Mientras tanto se puede probar por túnel SSH
> (`ssh -L 3001:localhost:3001 usuario@vps`) o Tailscale. El procedimiento para activar el dominio
> y HTTPS está documentado en el `README.md`.

### Qué ya NO aplica en este modelo

- Instalar Node.js o Python en el servidor — quedan dentro de la imagen de Docker.
- La copia maestra en OneDrive, `iniciar-erp.bat`, `actualizar.bat`, `instalar-tarea.ps1` — son
  del modelo de instalación local por equipo Windows.
- Que cada usuario tenga su propia instancia — ahora todos comparten la misma consola en el VPS.

### Actualizar el sistema (modelo Docker)

```bash
git pull
docker compose build
docker compose up -d
```

El `.env` y el volumen de datos (`data/`) no se tocan durante la actualización.

---

## Preparación de la copia maestra en OneDrive
*(Solo lo hace el administrador una vez — los demás usuarios saltan al Paso 1)*

La carpeta maestra es la fuente de instalación para todos los equipos. Se ubica en:
```
OneDrive - Civiltech IC\Software\oc-automation-master\
```

Para crearla o actualizarla:

1. Ir a `C:\Users\brayan\oc-automation\` en el equipo central
2. Copiar **la carpeta completa** `oc-automation` y pegarla en `OneDrive - Civiltech IC\Software\`
3. Renombrarla de `oc-automation` a `oc-automation-master`
4. Dentro de la carpeta ya copiada, **eliminar** los siguientes elementos:

   - [ ] Carpeta `node_modules\` — muy pesada (~50 MB), cada equipo la genera con `npm install`
   - [ ] Carpeta `logs\` — registros locales del equipo central, no son relevantes para otros
   - [ ] Carpeta `temp\` — archivos temporales del equipo central

Lo que **sí debe quedar** en la copia maestra:

   - [x] Carpeta `src\` — código del servidor
   - [x] Carpeta `ui\` — interfaz web
   - [x] Carpeta `data\` — plantillas Excel (`plantilla_oc.xlsx`, formato requerimiento) y CSVs de emergencia
     > Los precios, proveedores e insumos ya están en SharePoint — los CSV son fallback automático si SP no responde.
   - [x] `package.json` — lista de dependencias
   - [x] `index.js` — punto de entrada
   - [x] `.env` — configuración con credenciales corporativas ya completas (ver nota abajo)
   - [x] `.env.example` — plantilla de referencia
   - [x] `INSTALACION.md` — esta guía
   - [x] `iniciar-erp.bat` — acceso directo para abrir la consola (verifica Node.js e instala dependencias automáticamente si faltan)
   - [x] `actualizar.bat` — script de actualización
   - [x] `excluir-actualizar.txt` — archivo de soporte para las actualizaciones

> **Nota sobre el `.env`:** Las credenciales de Azure, SharePoint y Gemini son las mismas
> para todos los equipos. El nuevo usuario solo debe editar estos dos campos personales:
> `USUARIO_EMAIL` y `OUTPUT_DIR` (ruta de salida local). El nombre del firmante sale
> automáticamente del login de Microsoft, y el cargo se edita luego en el panel de
> usuarios (`/usuarios`) dentro de la consola.
> `PYTHON_PATH` solo si la verificación del Paso 4 lo indica.

---

## Pasos de instalación en un equipo nuevo

### Paso 1 — Copiar el software

Desde el Explorador de archivos, ir a:
```
OneDrive - Civiltech IC\Software\oc-automation-master\
```
Copiar la carpeta completa `oc-automation-master` y pegarla en el equipo local.
Se recomienda ubicarla en la raíz del disco para evitar problemas con rutas largas:
```
C:\OC-Automation\
```

### Paso 2 — Instalar dependencias

Abrir CMD en la carpeta donde se copió el software:
1. Presionar `Win + R`, escribir `cmd`, Enter
2. Escribir: `cd C:\OC-Automation` y presionar Enter
3. Escribir: `npm install` y presionar Enter
4. Esperar a que finalice (puede tomar 1-2 minutos)

### Paso 3 — Personalizar el archivo .env

El archivo `.env` ya viene incluido en la copia maestra con todas las credenciales
corporativas completas. Solo es necesario editar los campos personales:

1. Abrir el archivo `.env` con el Bloc de notas
2. Buscar y actualizar únicamente estas líneas:

```
USUARIO_EMAIL=correo@civiltechic.com     ← reemplazar con el correo propio
OUTPUT_DIR=C:\OC-Automation\output\      ← ajustar si la carpeta es diferente
```

El resto de valores (credenciales Azure, SharePoint, Gemini) ya están correctos
y no deben modificarse.

El nombre que aparece como firmante en OCs, OSs y remisiones se toma
automáticamente del login de Microsoft (no requiere configuración). El cargo
se edita luego, dentro de la consola, en el panel de usuarios (`/usuarios`) —
solo un admin puede hacerlo.

### Paso 4 — Verificar la instalación

En CMD, desde la carpeta del software, ejecutar:
```
node index.js --test
```

- Si aparece **"OK"** o similar → la instalación está correcta, continuar.
- Si dice **"Python no encontrado"**:
  1. Abrir CMD y escribir: `where python`
  2. Copiar la ruta que aparece (ej. `C:\Python313\python.exe`)
  3. Abrir `.env` y agregar: `PYTHON_PATH=C:\Python313\python.exe`
  4. Volver a correr `node index.js --test`

### Paso 5 — Iniciar la consola de gestión

Opción A — Doble clic en el archivo `iniciar-erp.bat`

Opción B — Desde CMD:
```
node src\servidor-cotizaciones.js
```

En ambos casos, abrir el navegador en: **http://localhost:3001**

La consola mostrará todos los requerimientos, OCs y OS que ya están en SharePoint.

---

## Uso diario

Para abrir la consola cada día:
- Doble clic en `iniciar-erp.bat`
- Abrir el navegador en http://localhost:3001

La ventana de CMD que se abre debe permanecer abierta mientras se use la consola.
Si se cierra, la página deja de responder.

---

## Recibir actualizaciones del software

Cuando el administrador avise de una nueva versión:
1. Cerrar la consola si está abierta (cerrar la ventana CMD)
2. Doble clic en `actualizar.bat`
3. Esperar a que finalice y volver a abrir la consola

El archivo `.env` y los datos locales **no se modifican** durante la actualización.

---

## Solución de problemas frecuentes

| Problema | Causa probable | Solución |
|---|---|---|
| "Puerto 3001 en uso" | Otra aplicación usa ese puerto | Cambiar `PUERTO_COTIZACIONES=3002` en `.env` y reabrir la consola |
| "Error de autenticación" | El CLIENT_SECRET expiró | Pedir al administrador el nuevo valor y actualizar `.env` |
| "Python no encontrado" | Python no está en el PATH | Agregar `PYTHON_PATH=ruta\a\python.exe` en `.env` |
| La página no carga | La consola CMD se cerró | Volver a ejecutar `iniciar-erp.bat` |
| Los datos no aparecen | Sin conexión a internet | Verificar conectividad; los datos están en SharePoint |
| El Buscador de Precios no muestra resultados | Sin conexión a SP o lista vacía | Verificar conectividad; el historial está en la lista `HistorialPrecios` de SharePoint |
| Los precios sugeridos en una OC están desactualizados | Cache de 60 seg activo | Esperar 1 minuto y recargar; o reiniciar la consola |

---

## Notas importantes

- **NO instalar la tarea automática** (`instalar-tarea.ps1`) en equipos adicionales.
  El procesamiento de correos de requerimiento corre únicamente en el equipo central.
  Los demás equipos solo acceden a la información ya procesada.

- El software **no instala nada en el sistema** más allá de su propia carpeta y Node.js/Python.
  Para desinstalarlo, simplemente eliminar la carpeta.

- **Scripts de migración** (`src\scripts\migrarCSV.js`, `src\scripts\migrarOC.js`): se ejecutaron
  una vez en el equipo central para poblar la lista `HistorialPrecios` con el historial histórico.
  **No ejecutar en equipos adicionales** — los datos ya están en SharePoint y se comparten
  automáticamente con todos los equipos conectados a la misma cuenta corporativa.

---

*Documento elaborado: Mayo 2026 — Civiltech Ingeniería y Construcción S.A.S.*
