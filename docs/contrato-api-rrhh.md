# Contrato — API de órdenes del ERP para RRHH

> **Para quien construya el lado de `oc-automation`.** Especifica lo que el ERP tiene que exponer para que la plataforma de RRHH (KAOS) registre en el ERP los dos gastos de una contratación: los **exámenes médicos**, como orden de servicio, y la **dotación**, como requerimiento.
>
> **Implementado** en `src/apiRrhh.js`, con el middleware de llave en `src/servidor-cotizaciones.js` y la migración `20261009120000_origen_rrhh_ordenes_servicio.sql`. Precedente de forma: `Cash_Flow/docs/integracion-oc-automation.md`.
>
> **Versión 4 — 09/10/2026.** La v3 la decidió compras (Carolina) el 09/10/2026, verificada contra `main @ 8ccad97`. La v4 recoge lo que se cerró al implementarla: el IVA sale de la cotización, el tipo de gasto es Opex, la IPS nueva queda por revisar, y el formato real del consecutivo. La sección siguiente resume los cambios.
>
> El diseño completo del lado de KAOS está en `docs/plan_ordenes_rrhh_erp.md`, en el repositorio de RRHH. **No hace falta leerlo para entender esto.**

---

## Qué cambió desde la versión 1

| Cambio | Desde | Por qué |
|---|---|---|
| **El IVA lo digita RRHH desde la cotización de la IPS.** Sigue siendo obligatorio y sin default. La cotización no viaja al ERP ni pasa por Gemini | v4 | Una orden que se aprueba sola no puede llevar un IVA que nadie revisó, y el PDF de la IPS suele traer datos del candidato |
| La orden de servicio lleva `tipo_gasto = 'Opex'`, fijado por el ERP | v4 | Decidido el 09/10/2026. Con esa grafía, la más usada en producción |
| La IPS nueva se crea **inactiva y por revisar**, como cualquier proveedor nuevo | v4 | Compras tiene que completar sus datos bancarios antes de pagar, y la marca es lo que se lo avisa |
| `consecutivo` del requerimiento es el **número por obra** (`"0021"`), no `"CT25-202-0016"` | v4 | Es el formato real de `consecutivo_sistema`. KAOS muestra obra y número juntos |
| Nuevo `motivo: "tope_no_configurado"`, y los códigos `405` y `413` | v4 | Ver §3 |
| **Los exámenes entran como orden de servicio**, no como orden de compra | v3 | Lo decidió compras: RRHH ya eligió y contactó a la IPS, así que es una contratación de servicio |
| **La orden de servicio entra aprobada** si su total no supera un tope configurable (500.000 COP) | v3 | Lo decidió compras. El tope lo hace cumplir el ERP. Ver §6 |
| **La dotación entra como requerimiento**, no como orden de compra sin precio | v3 | Una orden de compra sin precio ni proveedor no es una orden. El requerimiento ya existe en el ERP y es justo eso: una solicitud que compras convierte en órdenes de compra |
| El gasto se carga siempre a **la obra destino de la persona** | v3 | Lo pidió compras para el control de costos |
| Además del correo, viaja **el nombre de quien pidió** la orden en RRHH | v3 | Para saber a quién llamar si un precio se ve raro |
| **Se retira `GET /api/proyectos`**, y el proyecto viaja como **`proyectoKaosId`** | v2 | El catálogo del ERP ya viene de KAOS: `erp.proyectos.kaos_id` es el id que KAOS conoce |
| **No viajan nombre ni cédula del candidato** | v2 | Al ERP le interesa el gasto, no la persona. Ver §7 |
| Las columnas de procedencia son **una migración**, no columnas de SharePoint | v2 | El ERP vive en Postgres |
| La idempotencia se apoya en **índices únicos** | v2 | En Postgres se puede; en SharePoint no se podía |
| `ivaPct` es obligatorio; una obra inactiva responde `409`; el NIT lo vuelve a normalizar el ERP; las pruebas se hacen contra Postgres local | v2 | Ver §3, §8 y §10 |

---

## 1. Qué se está construyendo, y por qué

La plataforma de RRHH lleva el pipeline de contratación de CivilTech: un candidato pasa a `APROBADO` y arranca un checklist de fases. Dos de sus subpasos generan un gasto: **los exámenes médicos de ingreso** y **la dotación**. Hoy esos gastos se gestionan por fuera del sistema, o con un Excel que RRHH manda por correo.

La idea es que RRHH los registre **directamente en el ERP**, que sigue siendo el dueño de los documentos, de sus consecutivos y de su ciclo de estados. No queremos un generador de documentos paralelo dentro de RRHH.

**Las dos ramas son distintas a propósito**, y la diferencia la marca quién decide el proveedor y el precio:

| | Exámenes médicos | Dotación |
|---|---|---|
| Quién elige proveedor y precio | **RRHH**: busca la IPS, le pide cotización y tiene el precio | **Compras**, con su historial de precios |
| Documento en el ERP | **Orden de servicio** | **Requerimiento** |
| Estado en que llega | **Aprobada**, si el total no supera el tope; si lo supera, borrador | `pendiente`, como cualquier requerimiento |
| Qué hace compras después | Nada, salvo que haya quedado en borrador | Lo convierte en una o varias órdenes de compra, como hace con los de obra |

### El flujo de exámenes

```
1. El candidato queda APROBADO en RRHH, con su obra destino (activa en KAOS) y su cargo
2. RRHH elige una IPS y le pide cotización por correo (sale del tenant de CivilTech)
3. La IPS responde con el costo; RRHH lo captura en su sistema
4. RRHH aprieta «crear orden»
      ← POST /api/ordenes-servicio
5. El ERP crea la orden de servicio y, si total ≤ tope, la aprueba en la misma
   transacción: le asigna su número y queda cargada a la obra
```

### El flujo de dotación

```
1. El candidato queda APROBADO, con su obra destino y su cargo; sus tallas ya están en RRHH
2. RRHH aprieta «solicitar dotación»
      ← POST /api/requerimientos
3. El ERP crea el requerimiento, con su consecutivo de obra y con la consulta de
   proveedor y precio sugeridos para cada ítem, igual que con uno que llega por correo
4. Compras lo gestiona como cualquier otro: compara y genera las órdenes de compra
```

**El requerimiento de dotación reemplaza un correo que hoy existe.** Hoy alguien de RRHH arma el Excel del requerimiento y lo manda a `abastecimiento@`, y el lector de correo del ERP lo sube. Esta API crea el mismo requerimiento sin el correo de por medio. Del lado del ERP ya existe casi todo: `procesarRequerimientoManual()` y `requerimientos.crearDesdeCorreo()`.

### Cinco cosas que conviene tener claras antes de escribir código

**a) Quien llama es un servidor, no un navegador.** Es una Edge Function de Supabase, del lado de KAOS. Ella tiene la llave de API; el navegador nunca la ve.

**b) La aprobación automática tiene un tope, y lo hace cumplir el ERP.** Una regla en KAOS no protegería de quien tenga la llave. Ver §6.

**c) No viajan datos personales del candidato.** El nombre y la cédula se quedan en KAOS y en el correo a la IPS. Para saber de quién es un documento, se consulta KAOS con `origenSolicitudId`. Ver §7.

**d) El proyecto es un id que los dos sistemas comparten.** KAOS manda su uuid, y el ERP lo encuentra en `erp.proyectos.kaos_id`. No hay emparejamiento por nombre en ningún punto.

**e) El gasto se carga a la obra destino de la persona**, en las dos ramas. KAOS manda esa obra; el ERP no la decide.

---

## 2. Autenticación

**Una API key**, no un usuario y contraseña. No hay sesión que mantener ni token que refrescar, y el ERP no tiene un modelo de usuarios de servicio.

| Dónde | Variable |
|---|---|
| `.env` del ERP en el VPS (no viaja en el rsync del CD) | `RRHH_API_KEY` |
| Secrets de Supabase del proyecto de **CivilTech**, del lado de KAOS | `ERP_API_KEY` |

**Generarla así** (o con algo equivalente), y que sea larga:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Cómo se manda y cómo se valida

Va en el header `x-api-key`. La validación entra en el middleware que ya existe —`RUTAS_PUBLICAS` en `src/servidor-cotizaciones.js:536`, el chequeo de sesión en `:1006-1011`—, **antes** del chequeo de sesión:

```js
// Rutas de máquina: llave en vez de cookie de sesión.
// Si RRHH_API_KEY no está en el .env, /api/* simplemente no existe (interruptor).
if (url.startsWith('/api/')) {
  const esperada = process.env.RRHH_API_KEY || '';
  if (!esperada) return json({ error: 'not_found' }, 404);

  const recibida = String(req.headers['x-api-key'] || '');
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return json({ error: 'unauthorized' }, 401);

  // Sigue al enrutamiento de /api/*, sin exigir sesión.
} else {
  // ...el chequeo de sesión existente, sin tocar
}
```

Cuatro detalles que importan:

- **`crypto.timingSafeEqual`, no `===`.** Comparar strings con `===` filtra información por el tiempo de respuesta.
- **Comparar las longitudes primero.** `timingSafeEqual` lanza una excepción si los buffers tienen tamaños distintos.
- **Sin la variable, `/api/*` responde `404`, no `401`.** Es el interruptor: si la integración no está configurada, la superficie no existe. Es el mismo criterio de `tesoreriaClient.habilitado()`.
- **`RUTAS_PUBLICAS` no se toca.** `/api/*` no es pública: exige llave. Es un tercer camino, no una excepción al que ya existe.

### Registro de llamadas

**Registra cada llamada a `/api/*`:** método, ruta, resultado y `origenSolicitudId`, y en la orden de servicio también si quedó aprobada o en borrador. Sin eso, un uso indebido de la llave no deja rastro en ninguna parte. El cuerpo completo no hace falta para diagnosticar.

Implementado como una línea por llamada en la salida del contenedor, con el prefijo `[api]`:

```
[api] {"metodo":"POST","ruta":"/api/ordenes-servicio","status":201,"ms":64,"origenSolicitudId":"8f2c…","estado":"aprobada"}
```

Se consulta con `docker logs oc-automation-app 2>&1 | grep '\[api\]'`. Las llamadas con llave incorrecta también quedan, con `status: 401`.

---

## 3. Exámenes: `POST /api/ordenes-servicio`

Crea la orden de servicio y, si su total no supera el tope, la aprueba.

### Petición

```
POST /api/ordenes-servicio
x-api-key: <RRHH_API_KEY>
Content-Type: application/json
```

```json
{
  "origenSistema": "rrhh-app",
  "origenSolicitudId": "8f2c1a44-9e33-4b70-b1cd-6a2e5f9d0c11",
  "origenSolicitadoPor": "seleccion@thekaosfaktor.com",
  "origenSolicitadoPorNombre": "Ana Pérez",

  "proyectoKaosId": "3b9e0c52-6f1d-4a8e-9c71-2d4f8a6b1e03",
  "proveedorNit": "900123456",
  "proveedorNombre": "COLMEDICOS IPS SAS",
  "cotizacionReferencia": "COT-2026-4471",
  "tipoServicio": "Exámenes médicos ocupacionales de ingreso",
  "lugarPrestacion": "Bogotá",

  "items": [
    {
      "descripcion": "Exámenes médicos de ingreso — Auxiliar de obra",
      "cantidad": 1,
      "unidad": "UND",
      "precioUnitario": 180000,
      "ivaPct": 0
    }
  ],

  "observaciones": "[RRHH:8f2c1a44] Exámenes médicos de ingreso · Auxiliar de obra · cot. COT-2026-4471 · solicitó Ana Pérez (seleccion@thekaosfaktor.com)"
}
```

### Campos

| Campo | Tipo | Oblig. | Va a | Notas |
|---|---|---|---|---|
| `origenSistema` | string | sí | `origen_sistema` | Siempre `"rrhh-app"`. **Rechaza cualquier otro valor** con `422` |
| `origenSolicitudId` | uuid | sí | `origen_solicitud_id` | **Llave de idempotencia y de reconciliación.** Ver §5 |
| `origenSolicitadoPor` | string ≤200 | sí | `creado_por`, `aprobado_por`, `origen_solicitado_por` | Correo de la persona de RRHH que pidió la orden. Ver §6.4 |
| `origenSolicitadoPorNombre` | string ≤200 | sí | `origen_solicitado_por_nombre` | Su nombre, para saber a quién llamar |
| `proyectoKaosId` | uuid | sí | `proyecto_id` | Se busca en `erp.proyectos.kaos_id`. Si no está, `422`; si la obra está inactiva, `409`. **Nunca se resuelve por nombre** |
| `proveedorNit` | string, solo dígitos | sí | `proveedor_nit` | KAOS lo manda normalizado; el ERP lo vuelve a pasar por `erp.norm_nit` (§8) |
| `proveedorNombre` | string ≤255 | sí | — | Solo se usa si el proveedor no existe en el ERP |
| `cotizacionReferencia` | string ≤100 | sí | `oferta_economica_ref` | Cómo llamó la IPS a su cotización |
| `tipoServicio` | string ≤200 | sí | `tipo_servicio` | |
| `lugarPrestacion` | string ≤200 | no | `lugar_prestacion` | La ciudad de la IPS, si RRHH la tiene |
| `items[]` | array | sí | `erp.orden_servicio_items` | No vacío. Normalmente, uno solo |
| `observaciones` | string | no | `observaciones` | Prefijo de procedencia. **Sin datos del candidato** (§7) |

**Cada ítem:**

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `descripcion` | string | sí | No vacío. **Sin datos del candidato** |
| `cantidad` | number | sí | `> 0` |
| `unidad` | string | no | Default `"UND"` |
| `precioUnitario` | number | **sí** | `> 0`. Lo cotizó la IPS |
| `ivaPct` | number | **sí** | `0` a `100`. **Sin default.** RRHH lo toma de la cotización de la IPS al capturar el precio. Un 19 % puesto por omisión se propagaría en silencio |

> **Por qué esta ruta no debe reusar `/os/crear` tal cual.** Ese handler no valida nada, **acepta del cliente los totales** (`valor`, `iva`, `total`) y escribe `creadoPor: process.env.USUARIO_EMAIL || 'sistema'`. Lo que sí conviene reusar es el repositorio, `repoOrdenesServicio`, que ya resuelve proyecto y proveedor dentro de una transacción.

### Lo que el ERP fija por su cuenta y **no** acepta del payload

| Campo | Valor | Por qué |
|---|---|---|
| `valor` / `iva` / `total` | **Calculados por el ERP** desde los ítems | Ver abajo |
| `estado` | `'aprobada'` si `total ≤ tope`; si no, `'borrador'` | Ver §6. **Nunca se lee del payload** |
| `numero_os` | Emitido con `erp.siguiente_numero_os()` **si se aprueba**; si no, `NULL` | Igual que en `repoOrdenesServicio.aprobar()` |
| `aprobado_por` / `fecha_aprobacion` | `origenSolicitadoPor` / `now()`, **solo si se aprueba** | Ver §6.4 |
| `tipo_contrato` | `'IVA_PLENO'`, sin AIU | Un examen no lleva administración, imprevistos ni utilidad |
| `tipo_gasto` | `'Opex'` | Decidido el 09/10/2026. En producción conviven «Opex», «OPEX» y «opex», y `erp.vw_gastos` agrupa por el texto exacto: se usa la grafía más común |
| `clausulas` | Vacío | **No invocar `/os/generar-clausulas`.** Su prompt es de subcontratación de obra, y aplicado a unos exámenes daría un documento absurdo. Si compras quiere un texto fijo para estas órdenes, se acuerda aparte |
| `fecha_inicio` / `fecha_fin` | `NULL` | La fecha de la cita no se registra: se coordina en el hilo de correo con la IPS |
| `pagado` / `cumplido` | `false` | |

> **Sobre los totales: calcúlalos, no los aceptes.**
>
> ```
> base  = cantidad × precioUnitario
> iva   = base × ivaPct/100
> total = Σbase + Σiva
> ```
>
> Devuelve en la respuesta los valores que quedaron guardados. KAOS los compara con los suyos y, si difieren, lo muestra; no los sobrescribe.

> **Crear y aprobar van en una sola transacción.** Si algo falla, no queda nada: ni un borrador huérfano ni un número consumido. Hoy `repoOrdenesServicio.crear()` y `.aprobar()` abren cada una su propia transacción, así que hace falta una función que haga las dos cosas juntas. La aprobación tiene que pasar por las mismas verificaciones de siempre, incluida `exigirObraActiva`.

### Respuestas

**`201` — creada y aprobada:**

```json
{
  "creada": true,
  "erpItemId": "412",
  "erpTipoDocumento": "OS",
  "estado": "aprobada",
  "aprobadaAutomaticamente": true,
  "numeroOS": "OS-0157",
  "tope": 500000,
  "proyecto": "CT25-202 Micropilotes IZZI 96",
  "valor": 180000,
  "iva": 0,
  "total": 180000
}
```

**`201` — creada en borrador, porque supera el tope:** la misma forma, con `"estado": "borrador"`, `"aprobadaAutomaticamente": false`, `"numeroOS": null` y `"motivo": "supera_tope"`. KAOS le muestra a la persona que compras tiene que aprobarla. Si la clave del tope falta o no es un número, el motivo es `"tope_no_configurado"` y `"tope": null`.

**`200` — ya existía** (mismo `origenSolicitudId`). Ver §5:

```json
{ "creada": false, "duplicada": true, "erpItemId": "412", "erpTipoDocumento": "OS", "estado": "aprobada", "numeroOS": "OS-0157",
  "proyecto": "CT25-202 Micropilotes IZZI 96", "valor": 180000, "iva": 0, "total": 180000 }
```

| Código | Cuándo | Qué hace KAOS |
|---|---|---|
| `201` | Creada (aprobada o en borrador) | Guarda `erpItemId` y `numeroOS`, y pasa a `CREADA` |
| `200` | Ya existía | **Éxito, no error.** Adopta la existente y no reintenta |
| `401` | Sin llave, o con una llave incorrecta | Error de configuración. Avisa y **no reintenta** |
| `404` | `RRHH_API_KEY` no está configurada | La integración está apagada |
| `409` | La obra está inactiva en KAOS | Muestra el mensaje y **no reintenta**: hay que reactivar la obra en KAOS o cambiar el destino |
| `422` | Payload inválido → `{ error, detalles: [...] }` | Muestra `detalles`. **No reintenta** |
| `405` | Método distinto de `GET` o `POST` | Error de programación. No reintenta |
| `413` | Cuerpo de más de 256 KB | Error de programación. No reintenta |
| `500` | Error inesperado | Reintenta. Es seguro por §5 |

**Los `422` traen `detalles` como un array de strings**, uno por problema, legibles para una persona. Por ejemplo: `"El proyecto 3b9e0c52-… no está en el catálogo del ERP. Si se creó en KAOS hace poco, la sincronización tarda hasta 15 minutos."`, y no `"validation failed"`.

---

## 4. Dotación: `POST /api/requerimientos`

Crea un requerimiento en estado `pendiente`, igual al que hoy entra por correo o por captura manual.

### Petición

```
POST /api/requerimientos
x-api-key: <RRHH_API_KEY>
Content-Type: application/json
```

```json
{
  "origenSistema": "rrhh-app",
  "origenSolicitudId": "5d1e7b20-3a44-4c9f-8e12-0b7f6a2d9c55",
  "origenSolicitadoPor": "seleccion@thekaosfaktor.com",
  "origenSolicitadoPorNombre": "Ana Pérez",

  "proyectoKaosId": "3b9e0c52-6f1d-4a8e-9c71-2d4f8a6b1e03",

  "items": [
    { "insumo": "BOTA DE SEGURIDAD PUNTA DE ACERO TALLA 42", "cantidad": 1, "unidad": "UND" },
    { "insumo": "PANTALON DE JEAN CON REFLECTIVOS TALLA 32",  "cantidad": 2, "unidad": "UND" },
    { "insumo": "CASCO DIELECTRICO BLANCO CON BARBUQUEJO",    "cantidad": 1, "unidad": "UND" }
  ],

  "observaciones": "[RRHH:5d1e7b20] Dotación de ingreso · Auxiliar de obra · solicitó Ana Pérez (seleccion@thekaosfaktor.com)"
}
```

**Sin precio y sin proveedor.** Los decide compras al generar las órdenes de compra, con la consulta de proveedor y precio que el ERP ya hace al crear un requerimiento.

### Campos

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `origenSistema` | string | sí | Siempre `"rrhh-app"` |
| `origenSolicitudId` | uuid | sí | **Llave de idempotencia.** Va a `origen_correo_id` como `"rrhh:<origenSolicitudId>"`, donde ya hay un índice único (§5) |
| `origenSolicitadoPor` | string ≤200 | sí | Correo de quien la pidió. Va en `notas` |
| `origenSolicitadoPorNombre` | string ≤200 | sí | Va a `solicitante`, que es lo que la consola y el PDF muestran |
| `proyectoKaosId` | uuid | sí | Igual que en §3: `422` si no está, `409` si la obra está inactiva |
| `items[]` | array | sí | No vacío, sin pasar del máximo que ya aplica la captura manual (`MAX_ITEMS_REQ_MANUAL`) |
| `observaciones` | string | no | Prefijo de procedencia, para `notas`. Si el ERP agrega alertas de la consulta de precios, van después |

**Cada ítem:**

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `insumo` | string | sí | No vacío. **La talla va al final del nombre**, como en el histórico del ERP («… TALLA 42»). KAOS intenta usar los nombres del catálogo de insumos del ERP, para que la consulta de proveedor y precio encuentre historial; si no coincide, compras lo homologa como hace con los requerimientos de obra |
| `cantidad` | number | sí | `> 0` |
| `unidad` | string | no | Default `"UND"` |

> **Dos validaciones que esta ruta tiene que hacer antes de llamar a `procesarRequerimientoManual()`**, porque esa función es tolerante a propósito (pensada para una persona que digita):
>
> - **Descarta en silencio los ítems sin `insumo`** (`.filter(it => it.insumo)`). Acá, un ítem sin nombre es un `422`, no un ítem que desaparece.
> - **Convierte en 1 una cantidad inválida.** Acá, una cantidad `<= 0` es un `422`, no un 1 inventado.

### Cómo se arma, reusando lo que ya existe

1. Resolver `proyectoKaosId` → `erp.proyectos.codigo`, y validar ítems y cantidades.
2. Llamar a `procesarRequerimientoManual({ proyecto: <codigo>, fecha: <hoy>, responsable: origenSolicitadoPorNombre, items })`. Esa función ya verifica que la obra esté activa y hace la consulta de proveedor y precio por ítem.
3. Llamar a `requerimientos.crearDesdeCorreo(resultado, { messageId: 'rrhh:' + origenSolicitudId, adjuntoUrl: '' })`. Con un `messageId` que no empieza por `manual:`, esa función **ya consulta si existe** y devuelve `{ duplicado: true }`. Emite el consecutivo de la obra en la misma transacción, y genera el PDF de respaldo en `/RequerimientosPDF/`.

### Respuestas

**`201` — creado:**

```json
{
  "creado": true,
  "erpItemId": "245",
  "erpTipoDocumento": "REQ",
  "consecutivo": "0016",
  "estado": "pendiente",
  "proyecto": "CT25-202 Micropilotes IZZI 96",
  "itemsSinHistorial": 1
}
```

`itemsSinHistorial` es informativo: los ítems para los que el ERP no encontró proveedor ni precio previos.

`consecutivo` es el número del requerimiento **dentro de su obra** (`consecutivo_sistema`), con cuatro dígitos. Para mostrarlo, KAOS lo acompaña de `proyecto`.

El `POST` tarda unos segundos, porque genera el PDF de respaldo antes de responder: KAOS debe esperar al menos 30 s antes de tratarlo como timeout.

**`200` — ya existía:** `{ "creado": false, "duplicado": true, "erpItemId": "245", "erpTipoDocumento": "REQ", "consecutivo": "0016", "estado": "pendiente" }`.

Los códigos de error son los mismos de §3.

---

## 5. Reconciliación: `GET` de cada recurso

**Estas dos rutas son las que hacen segura la integración, y las más fáciles de subestimar.**

```
GET /api/ordenes-servicio?origenSolicitudId=<uuid>
GET /api/requerimientos?origenSolicitudId=<uuid>
x-api-key: <RRHH_API_KEY>
```

**Orden de servicio** — `200`:

```json
{
  "ordenesServicio": [
    { "erpItemId": "412", "numeroOS": "OS-0157", "estado": "aprobada",
      "pagado": false, "cumplido": false,
      "proyecto": "CT25-202 Micropilotes IZZI 96", "total": 180000,
      "fechaCreacion": "2026-10-09T16:04:00Z" }
  ]
}
```

**Requerimiento** — `200`. Trae las órdenes de compra que compras generó desde él, que es lo que RRHH necesita para saber cómo va su dotación:

```json
{
  "requerimientos": [
    { "erpItemId": "245", "consecutivo": "0016", "estado": "parcial",
      "proyecto": "CT25-202 Micropilotes IZZI 96",
      "fechaCreacion": "2026-10-09T16:10:00Z",
      "ordenesCompra": [
        { "erpItemId": "1190", "numeroOC": "OC-0301", "estado": "aprobada",
          "proveedor": "DISTRIBUCIONES TOOLS MED", "total": 245000 }
      ] }
  ]
}
```

**Una orden de servicio en la papelera** del ERP (un admin la retiró por error o duplicada) aparece con `"estado": "papelera"`. Sigue existiendo: un `POST` con el mismo `origenSolicitudId` devuelve esa misma orden como duplicada, y no crea otra. Si compras la restaura, vuelve a su estado anterior. KAOS debe mostrarla como retirada en el ERP.

**Si no hay ninguno: `200` con la lista vacía, nunca `404`.** KAOS necesita distinguir «el ERP dice que no existe» de «falló la consulta». Un `404` mezcla las dos cosas y rompe la reconciliación.

### Por qué existen: el problema del timeout

Supón que KAOS llama, el ERP crea el documento y **la respuesta se pierde en el camino** (timeout, contenedor reiniciado, red). KAOS no sabe si se creó, y reintentar a ciegas podría duplicar un gasto.

El protocolo, del lado de KAOS:

```
1. Marca la solicitud como CREANDO       ← antes de llamar
2. POST
3a. Responde        → CREADA, con erpItemId
3b. Falla limpio    → vuelve al estado anterior, con el mensaje de error
3c. Timeout / corte → se queda en CREANDO, que significa «no sé qué pasó allá»

4. El siguiente intento NO crea: primero PREGUNTA con el GET
     → hay uno  → lo adopta y pasa a CREADA. No crea nada
     → no hay   → ahora sí crea
```

### Lo que se pide del lado del ERP

1. Que los dos `GET` funcionen y devuelvan la lista vacía cuando no hay nada.
2. **Que los dos `POST` sean idempotentes por sí solos.** Si ya existe un documento con ese `origenSolicitudId`, devuelven `200 duplicado` con el existente, en vez de crear otro. Si dos POST llegan en paralelo, el segundo `INSERT` falla con `23505` sobre el índice único; atrápalo, lee el existente y responde `200`.
   - **Orden de servicio:** índice único nuevo sobre `origen_solicitud_id` (§9).
   - **Requerimiento:** ya existe `requerimientos_origen_correo_key`, sobre `origen_correo_id`. No hace falta nada nuevo.

---

## 6. Restricciones de seguridad

Esto no es una lista de buenas prácticas: son las condiciones bajo las cuales se decidió abrir el ERP a internet.

### 6.1 Lo único que se puede hacer con la llave

- **Crear una orden de servicio**, que se aprueba sola **solo si su total no supera el tope.**
- **Crear un requerimiento**, que nunca aprueba nada.
- **Consultar** esos dos documentos por su `origenSolicitudId`.

**Ninguna ruta paga, anula, modifica ni aprueba otra cosa.** El `estado` se fija en el servidor y **no se lee del payload**, ni siquiera para validarlo.

**Lo peor que consigue una llave filtrada** son órdenes de servicio aprobadas, cada una por debajo del tope, cargadas a obras activas. **No mueve plata:** pagar sigue siendo un paso manual en el ERP. Y el registro de llamadas (§2) permite encontrarlas y anularlas.

**Y no agregues operaciones destructivas a `/api/*` después.** Si en el futuro hace falta anular desde KAOS, es una decisión aparte que hay que discutir: anular una orden aprobada quema un consecutivo, y eso merece un humano identificable de este lado.

### 6.2 El tope

| | |
|---|---|
| Dónde vive | `erp.configuracion`, clave **`rrhhTopeAprobacionOS`**, sembrada por la migración con `500000` |
| Contra qué se compara | El **total con IVA** calculado por el ERP |
| Cómo se cambia | **Sin desplegar código.** Recomendado: agregar la clave a la lista de `/config/:clave` y un campo en la pantalla de Configuración, junto al IVA por omisión |
| Si falta o no es un número | **No se aprueba nada automáticamente:** todo entra en borrador. Falla cerrado |

El valor lo estimó RRHH y puede cambiar; por eso es configuración y no código. Que cualquier sesión del ERP pueda editar la configuración no agrega riesgo: cualquier sesión ya puede aprobar una orden directamente. El tope existe para lo que **no** tiene sesión en el ERP: la llave de la API y un precio mal digitado en RRHH.

### 6.3 Las rutas que aceptan la llave

`POST` y `GET` de `/api/ordenes-servicio`, y `POST` y `GET` de `/api/requerimientos`. El resto del ERP sigue exigiendo la cookie de sesión de Microsoft, sin cambios.

### 6.4 Queda registrado el humano real

Hoy el ERP escribe `process.env.USUARIO_EMAIL || 'sistema'` en los campos de auditoría (por ejemplo, en `/os/crear` y al aprobar), y en los datos reales se ven órdenes con `'sistema'`.

**Estas rutas no deben heredar eso.** `creado_por` y `aprobado_por` llevan `origenSolicitadoPor`, que viene de la sesión real de la persona en RRHH. Su nombre va en `origen_solicitado_por_nombre` y en `observaciones`. Así, si un precio se ve raro, compras sabe a quién llamar.

> No hace falta arreglar los demás sitios en este trabajo. Pero el código nuevo ya viene haciéndolo bien: `solicitudTesoreriaPor` usa `req._sesion?.email` (`:2497`).

---

## 7. Datos personales — los documentos no los llevan

**Decidido el 08/10/2026 y confirmado con compras el 09/10/2026:** ni la orden de servicio ni el requerimiento llevan nombre ni cédula del candidato. Al ERP le interesa el gasto: valor, concepto, obra y proveedor. Para quién fue se rastrea en KAOS con `origenSolicitudId`, y esa consulta pasa por los permisos de RRHH.

**Lo que esto le ahorra a este lado es concreto.** Si los documentos llevaran datos del candidato, la base del ERP, sus respaldos diarios de 30 días, las copias que deja `db:clonar` en los equipos de desarrollo y los PDF en SharePoint quedarían como sitios con datos personales bajo la Ley 1581. Habría además que borrarlos o anonimizarlos a los seis meses.

> **Compras querría el nombre en la dotación**, en la orden de compra y en la remisión, para que en la obra sepan de quién es cada prenda. Dijo que sería ideal pero no esencial: hoy se manda a la obra y allá reparten. **No va por ahora.** Si más adelante se quiere, no es un campo más: es una decisión con consulta legal, por lo de arriba. Avísanos antes de agregarlo.

Lo que se pide de este lado:

**a) No agregar campos del candidato, ni guardarlos si llegan.** Los campos no previstos se ignoran: no se guardan en ninguna columna, ni en `observaciones`, ni en `notas`.

**b) `descripcion`, `insumo` y `observaciones` son texto libre.** KAOS los compone en su servidor, sin datos del candidato. El ERP no puede verificarlo y no tiene que intentarlo.

**c) No pasar estos documentos por Gemini.** La orden de servicio llega con sus ítems resueltos y sin clausulado. El requerimiento pasa por `procesarRequerimientoManual()`, que no usa IA.

---

## 8. Normalizaciones — quién normaliza qué

| Dato | Quién lo normaliza | Nota |
|---|---|---|
| **NIT** (solo en la orden de servicio) | KAOS (`rrhh.limpiar_nit`) y **también el ERP** (`erp.norm_nit`, en `resolverProveedor`) | Hoy hacen lo mismo: quitan puntos y espacios, y quitan el dígito de verificación **solo si viene separado por guion** |
| `unidad` | KAOS | Llega en mayúsculas |
| Nombre del insumo | KAOS | En mayúsculas y con la talla al final, como el histórico del ERP |

> **Ojo con el NIT: son dos normalizadores, y tienen que seguir siendo equivalentes.** Si divergen, el mismo proveedor queda escrito distinto en cada lado y su historial se parte en dos, sin error a la vista. **Si cambias `erp.norm_nit`, avísanos.** Un NIT de 10 dígitos escrito sin guion no lo recorta ninguno de los dos, y KAOS le muestra a quien lo digita el NIT ya normalizado para que lo vea antes de guardarlo.

---

## 9. La migración

Una migración en `supabase/migrations/`, con el timestamp de la convención del repo:

```sql
-- Procedencia de las órdenes de servicio que crea RRHH.
ALTER TABLE erp.ordenes_servicio
  ADD COLUMN IF NOT EXISTS origen_sistema               text,
  ADD COLUMN IF NOT EXISTS origen_solicitud_id          uuid,
  ADD COLUMN IF NOT EXISTS origen_solicitado_por        text,
  ADD COLUMN IF NOT EXISTS origen_solicitado_por_nombre text;

-- La llave de §5: un origenSolicitudId, una orden.
CREATE UNIQUE INDEX IF NOT EXISTS ordenes_servicio_origen_solicitud_key
  ON erp.ordenes_servicio (origen_solicitud_id)
  WHERE origen_solicitud_id IS NOT NULL;

-- El tope de §6.2. ON CONFLICT: si ya lo cambiaron, no se pisa.
INSERT INTO erp.configuracion (clave, valor, descripcion)
VALUES ('rrhhTopeAprobacionOS', '500000',
        'Tope en COP (total con IVA) hasta el cual una orden de servicio creada por RRHH vía API entra aprobada. Por encima entra en borrador.')
ON CONFLICT (clave) DO NOTHING;
```

Cuatro notas:

- **Las columnas son anulables a propósito.** Las órdenes que no vienen de RRHH las dejan en `NULL`, y el índice es parcial justamente para que esas no choquen entre sí.
- **Los requerimientos no necesitan columnas nuevas.** La procedencia y la idempotencia van en `origen_correo_id` (`rrhh:<uuid>`), que ya tiene su índice único.
- **Nada en `erp.ordenes_compra`.** Esta API no crea órdenes de compra: las de dotación las genera compras desde el requerimiento, por el camino de siempre.
- **El SQL va en `src/repo/`**, según la regla de la capa de repositorio.

---

## 10. Verificación

Todo con `curl` contra el ERP en local, **con Postgres local y `MODO_PRUEBA=1`**:

```bash
npm run db:reset            # base local con el esquema, incluida la migración nueva
npm run db:clonar -- --si   # trae los datos del VPS
# en .env: MODO_PRUEBA=1 y RRHH_API_KEY=<una de prueba>
npm run dev                 # http://localhost:3001
```

**Ninguna de estas pruebas necesita que KAOS exista.** Para `proyectoKaosId`, toma un `kaos_id` de `erp.proyectos` con `activo = true`, y otro con `activo = false`.

**Comunes a las dos rutas:**

| Prueba | Esperado |
|---|---|
| Cualquier `/api/*` **sin** el header `x-api-key` | `401` |
| Con una llave **incorrecta de la misma longitud** | `401` |
| Con `RRHH_API_KEY` ausente del `.env` | **`404`**, no `401`: es el interruptor |
| Una ruta normal (`/ordenes`) sin cookie de sesión | `401 no_session`. **El cambio no debe haber alterado el camino existente** |
| **Repetir el mismo POST tal cual** | **`200 duplicado`, con el mismo `erpItemId`. Un solo documento** |
| **Dos POST iguales en paralelo** | **Un solo documento.** Uno responde `201` y el otro `200` |
| `proyectoKaosId` de una obra inactiva | `409` |
| `proyectoKaosId` que no está en `erp.proyectos` | `422` con `detalles` |
| Colar `"estado"`, `"creadoPor"`, `"candidatoNombre"` o `"cedula"` | Se ignoran. No aparecen en ninguna columna |
| `GET` con un `origenSolicitudId` inventado | **`200` con la lista vacía, no `404`** |

**Orden de servicio:**

| Prueba | Esperado |
|---|---|
| Total de 180.000 | `201`, **`aprobada`**, con `numeroOS`, `aprobado_por` = `origenSolicitadoPor` y la orden en `erp.vw_gastos` de esa obra |
| Total de 600.000 | `201`, **`borrador`**, `numeroOS` en `NULL` y `motivo: "supera_tope"` |
| Cambiar el tope a 700.000 en Configuración y repetir con 600.000 (y otro `origenSolicitudId`) | `aprobada`. **Sin reiniciar nada** |
| Borrar la clave del tope y crear una de 1.000 | **`borrador`**: falla cerrado |
| Ítem sin `precioUnitario`, o con precio `0` | `422` |
| Ítem sin `ivaPct` | **`422`, no 19** |
| Mandar `"total": 1` en el payload | Se ignora: el total es el calculado |
| Revisar `clausulas` | Vacías: no se llamó al generador |

**Requerimiento:**

| Prueba | Esperado |
|---|---|
| POST válido | `201`, `pendiente`, con consecutivo de obra, el PDF en `/RequerimientosPDF/` (en local, según `MODO_PRUEBA`) y la consulta de proveedor por ítem |
| Ítem sin `insumo` | **`422`**; no se descarta en silencio |
| Ítem con `cantidad: 0` | **`422`**; no se convierte en 1 |
| Ítem con precio colado | Se ignora: el requerimiento no lleva precio |
| Generar una OC desde el requerimiento en la consola y consultar el `GET` | La OC aparece en `ordenesCompra` y el estado pasa a `parcial` o `gestionado` |

---

## 11. Despliegue

**a) La migración va primero.** Desde el 16/10/2026 el deploy la aplica solo, antes de reconstruir los contenedores (`deploy/aplicar-migraciones.sh`). Las columnas anulables, el índice y la clave de configuración no le cambian nada al código que ya está desplegado.

**b) Llegar apagado.** Mergea a `main` **sin** `RRHH_API_KEY` en el `.env` del VPS. La superficie llega inerte (`404`) y se enciende poniendo la variable. **Eso separa «desplegar» de «activar».**

**c) Verificar que el push no borró nada.** El deploy usa `rsync -az -c --delete`. Después de desplegar, confirma que `/tesoreria/*` sigue respondiendo.

**d) Solo CivilTech.** `ERP_API_KEY` se pone solo en el proyecto de Supabase de CivilTech. Los otros tenants de KAOS no ven los botones, y es correcto que así sea.

---

## 12. Fuera de alcance

| No | Por qué |
|---|---|
| Crear órdenes de compra por API | Las de dotación las genera compras desde el requerimiento |
| Aprobar por encima del tope, pagar, anular o cumplir por API | Ver §6.1 |
| **Solicitud de pago automática** de la orden de servicio | Compras la querría, por el proceso de pagos del ERP y sin cargarle trabajo a su equipo. Hoy el ERP solo tiene solicitud a tesorería para órdenes de compra. Es una fase posterior, por decidir con compras y tesorería |
| Nombre del candidato en la dotación | Ver §7 |
| `GET /api/proyectos`, o cualquier mapeo de proyectos | El catálogo ya viene de KAOS |
| Leer datos de RRHH desde el ERP | KAOS manda lo que el ERP necesita |
| Clausulado por IA | Ver §3 |
| UI nueva, salvo el campo del tope en Configuración | Los documentos aparecen en los registros normales de OS y de requerimientos |
| Arreglar los demás `USUARIO_EMAIL` | Deuda preexistente. Estas rutas solo se abstienen de sumarle |
| Avisar a KAOS cuando cambie un estado | **Opcional, y para después.** KAOS consulta bajo demanda con §5. Si algún día se quiere, sería con una llave de integración que emita KAOS, no con usuario y contraseña |

---

## 13. Preguntas abiertas

Las que se cerraron al implementar quedan marcadas **Resuelta**.

1. **Resuelta: entra inactiva y por revisar**, como cualquier proveedor nuevo. La orden se crea y se aprueba igual; compras completa los datos bancarios antes de pagar. — **¿Cómo entra una IPS nueva?** `resolverProveedor` la crea inactiva y con `requiere_revision`. Con la orden de servicio aprobada, quedaría una orden aprobada a nombre de un proveedor «por revisar». ¿Así está bien, o la API la crea activa, porque RRHH ya verificó su NIT con la cotización?

2. **Resuelta para la orden de servicio: `Opex`.** El de las OC de dotación lo pone compras al generarlas. — **¿Qué `tipo_gasto` deben llevar?** `erp.vw_gastos` agrupa por tipo de gasto. Si los exámenes tienen un tipo propio en Control de Costos, la API lo fija al crear la orden de servicio. Y en dotación, ¿las órdenes de compra que salen del requerimiento llevan alguno en particular?

3. **Resuelta: sí.** Verificado el 09/10/2026: la migración de empalme está aplicada y 42 de los 43 proyectos tienen `kaos_id`. — **¿El corte del catálogo de KAOS ya se ejecutó en el VPS?** Esta API depende de que `erp.proyectos.kaos_id` esté poblado. El código está en `main` desde el 06/10, pero el corte es manual y no encontré constancia escrita de que ya se hizo.

4. **¿Qué se pone en `necesidad` de cada ítem del requerimiento?** El formato de obra lo trae. Si es una fecha requerida o una justificación, KAOS puede llenarlo; si no se usa, va vacío.

5. **Resuelta: en `erp.configuracion`**, editable en Configuración junto al IVA por omisión. — **¿El tope en `erp.configuracion` te sirve?** Es lo recomendado, porque compras puede cambiarlo sin ayuda técnica. Si prefieres una variable del `.env`, también cumple, siempre que cambiarla no exija desplegar código.

6. **Resuelta: en la salida del contenedor**, una línea `[api]` por llamada (§2). — **¿El registro de llamadas va en archivo o en una tabla de `erp`?** El proyecto ya rota logs (`src/rotar-logs.js`). Usa lo que sea más natural.

---

## Resumen de lo que hay que construir

1. Middleware de llave para `/api/*`, con `timingSafeEqual` y el interruptor por variable ausente.
2. Una migración, **aplicada en el VPS antes del deploy**, con:
   - las cuatro columnas de procedencia en `erp.ordenes_servicio`;
   - su índice único;
   - la clave `rrhhTopeAprobacionOS` en `500000`.
3. El campo del tope en la pantalla de Configuración, o la alternativa de la pregunta 5.
4. `POST /api/ordenes-servicio`, que:
   - crea la orden de servicio y la aprueba en la misma transacción si `total ≤ tope`;
   - si no, la deja en borrador;
   - resuelve el proyecto por `kaos_id`, con `422` o `409` según el caso;
   - calcula los totales del lado del ERP;
   - exige precio e IVA;
   - escribe `creado_por` y `aprobado_por` con el humano real;
   - no invoca el clausulado;
   - es idempotente.
5. `POST /api/requerimientos`, que:
   - valida ítems y cantidades;
   - reusa `procesarRequerimientoManual()` y `crearDesdeCorreo()`, con `messageId = rrhh:<uuid>`;
   - es idempotente por el índice que ya existe.
6. Los dos `GET` de reconciliación, con la lista vacía cuando no hay nada y nunca `404`. El del requerimiento trae las OC generadas desde él.
7. Un registro de las llamadas.
8. Llegar apagado a `main`.
