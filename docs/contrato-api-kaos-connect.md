# Contrato — API de lectura del ERP para KAOS Connect

KAOS Connect es el conector de Claude de KAOS: un solo conector, **de solo lectura**, para todas las empresas (ADR-009 de kaos-webapp, tarea T-255). Cuando una persona de CivilTech pregunta en Claude por compras, el orquestador de KAOS lee el ERP por esta API. Las herramientas del lado de KAOS son la tarea T-256.

## 1. Qué es, y qué no

- **Solo lee.** Ninguna ruta crea, modifica, aprueba, anula ni paga nada. Agregar una escritura acá es una decisión del líder, no un cambio de código.
- **Solo personas con cuenta activa en el ERP.** Cada llamada trae el correo de quien pregunta. Si no es una cuenta activa de `erp.usuarios`, 403 sin datos, como pasa al entrar a la consola.
- **Lo mismo que ve en la consola.** En la consola, cualquier cuenta activa lee todos los documentos, así que acá también; los roles solo cambian lo que se puede **hacer**, y esta API no hace nada.
- **Nada bancario.** Los proveedores salen sin banco, tipo de cuenta ni número de cuenta.
- **Lo que no existe en los listados de la consola, tampoco existe acá:**
  - las órdenes de compra y de servicio en la papelera;
  - los movimientos de inventario anulados.

## 2. Autenticación

| Cabecera | Valor |
| --- | --- |
| `x-api-key` | `KAOS_CONNECT_API_KEY` de este servidor |
| `x-kaos-connect-correo` | El correo de la persona que pregunta en Claude |

- **Validación de la llave:** `src/servidor-cotizaciones.js` la valida en tiempo constante antes de llegar a `src/apiKaosConnect.js`.
- **Sin la variable:** `/api/kaos-connect/*` no existe y responde 404. Es el interruptor.
- **Una llave por API:** la llave es distinta de `RRHH_API_KEY`. La de RRHH no abre esta API, y esta no abre `/api/*` de RRHH.
- **El correo** va en una cabecera y no en la URL, para que no quede en logs de acceso ni de proxies. El log de la API (`[api-kaos-connect]`) registra método, ruta, estado, filas y milisegundos, nunca el correo.

## 3. Recursos

Todos son `GET /api/kaos-connect/<recurso>` y responden `{ "rows": [...], "next_cursor": "<cursor>" | null }`.

| Recurso | Qué devuelve | Fecha de `desde`/`hasta` |
| --- | --- | --- |
| `requerimientos` | Requerimientos con sus ítems | `fecha_solicitud` |
| `ordenes-compra` | Órdenes de compra con sus ítems y el proveedor | `fecha_creacion` |
| `ordenes-servicio` | Órdenes de servicio con sus ítems y el proveedor | `fecha_creacion` |
| `remisiones` | Remisiones con sus ítems y las órdenes de compra que respaldan | `fecha` |
| `inventario` | Movimientos de inventario (entradas y salidas) | `fecha` |
| `proveedores` | Proveedores: NIT, razón social, nombre comercial, régimen, municipio, zona, dirección, teléfono, correo y si está activo | — |

Cada documento trae `proyecto` (código de la obra en el ERP) y `proyectoKaosId` (el UUID del proyecto en KAOS), si la obra está ligada a KAOS.

### Parámetros de la query

| Parámetro | Para qué | Reglas |
| --- | --- | --- |
| `proyecto` | Solo los documentos de ese proyecto de KAOS | UUID. Si el proyecto no está ligado a ninguna obra del ERP: `200` con `rows: []`. No aplica a `proveedores` |
| `estado` | Solo ese estado | Texto exacto del ERP, hasta 40 caracteres. En `proveedores`: `activo` o `inactivo` |
| `desde`, `hasta` | Rango de fechas, ambos incluidos | `AAAA-MM-DD` |
| `limit` | Filas por página | 1 a 200; 50 por defecto |
| `cursor` | La página siguiente | El `next_cursor` de la respuesta anterior |

## 4. Respuestas

| Estado | Cuándo |
| --- | --- |
| `200` | `{ rows, next_cursor }`. Sin resultados: `rows: []`, nunca 404 |
| `401` | Sin `x-api-key`, o no coincide |
| `403` | El correo no tiene cuenta en el ERP o está inactiva. Sin datos |
| `404` | Recurso desconocido, o `KAOS_CONNECT_API_KEY` sin configurar |
| `405` | Método distinto de `GET` (cabecera `Allow: GET`) |
| `422` | `payload_invalido` con `detalles[]`: falta el correo, `limit` fuera de rango, cursor inválido, proyecto que no es UUID, fecha con otro formato, o `proyecto` en `proveedores` |
| `500` | `error_interno`: error al leer; se puede reintentar |

Todas las respuestas llevan `Cache-Control: no-store`.

## 5. Verificación

- `npm test`: `test/api-kaos-connect.test.js`, sin base. Cubre:
  - la persona, rutas y método;
  - los parámetros;
  - la paginación;
  - el 500;
  - que el log no lleve el correo.
- `npm run test:humo`: `test/humo/api-kaos-connect.test.js`, contra el Postgres desechable del workflow, en su propio puerto (`PUERTO_COTIZACIONES + 1`). Cubre:
  - la llave, y que cada llave abra solo su API;
  - una persona activa, una inactiva y un correo desconocido;
  - órdenes de compra del proyecto con sus ítems;
  - dos páginas sin repetir;
  - un proyecto no ligado;
  - proveedores sin datos bancarios;
  - los demás recursos.

## 6. Despliegue

1. Generar la llave: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Ponerla como `KAOS_CONNECT_API_KEY` en el `.env` del servidor de producción.
3. Ponerla del lado de KAOS, en el orquestador, junto con la URL pública del ERP. El nombre de esas variables lo fija T-256 de kaos-webapp, y su carga es parte de T-258.

Sin la variable en el servidor, nada cambia: la API sigue respondiendo 404.

## 7. Fuera de alcance

- Escrituras de cualquier tipo.
- Documentos adjuntos y PDF: solo los datos.
- Control de Costos y tesorería: Cash Flow tiene su propia lectura para KAOS Connect (T-254, en el repo Cash_Flow).
