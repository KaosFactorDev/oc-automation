# Migración de Gemini a Claude API

> **Documento vivo:** [Migración de Gemini a Claude API — exploración y plan inicial](https://claude.ai/artifact/Q8spvLokwK5ceST2Etq3jL).
> Tiene los diagramas, las tareas para ir marcando y los comentarios. Es la fuente de
> verdad; este archivo es una copia del 2026-10-29 para tenerla junto al código.

Responsable de implementar: Julian (Tecnología). Estado: Fase 2 en código (rama
`feature/anthropic-ai-provider`). Desde 2026-10-29 Claude es el proveedor por defecto, porque Gemini se quedó sin saldo; Gemini sigue disponible con `IA_PROVEEDOR=gemini`.

## Resumen

La migración es acotada: las 7 funciones con IA del ERP llegan a Gemini por un solo
módulo, [`src/geminiClient.js`](../src/geminiClient.js). El trabajo es reemplazar ese
cliente y adaptar cómo cada función arma su petición y lee la respuesta. El riesgo
real no está en el código sino en la calidad de los datos extraídos, y se controla con
un set de pruebas con documentos reales antes de tocar producción.

Los incidentes con Gemini fueron de disponibilidad, no de calidad: Google retiró,
renombró o saturó modelos (25-08, 15-09 y 22-09-2026), la cuota del nivel gratuito
(20 peticiones por día por modelo) se agotaba rápido, y el último fallo fue el saldo
prepagado agotado (HTTP 402). Hoy el ERP tiene unas 630 líneas
(`geminiClient.js` y `geminiModelos.js`) dedicadas solo a sobrevivir a eso.

## Decisiones tomadas

| Qué | Decisión | Por qué |
|---|---|---|
| Proveedor | API de Claude (Anthropic) | IDs de modelo fijos, sin alias que Google mueva o retire |
| Modelo | Claude Opus 5.5 (`claude-opus-5-5`) por defecto para las 7 funciones (cambio del 2026-10-29; antes era Haiku 5.5) | Decisión de Julian al implementar la Fase 2. Es configurable por función (`ANTHROPIC_MODEL_<FUNCION>`), así que la Fase 1 puede bajar a Sonnet 5.5 o Haiku 5.5 la función que no necesite Opus, en especial las de 5 y 10 s |
| Cuenta | La administra Tecnología; responsable Julian | |
| Volumen | Bajo: como máximo unas 70 peticiones en un día, entre 5 y 45 en días normales | Según el panel de uso de AI Studio (90 días, octubre de 2026), con reintentos y fallas incluidos. Con Haiku son centavos de dólar al día |

## Funciones que usan IA

Las líneas son de `src/servidor-cotizaciones.js` en `develop` al 2026-10-29, salvo que se
indique otro archivo.

| # | Función | Dónde | Entrada → salida | Cómo se llama hoy |
|---|---|---|---|---|
| 1 | Extraer ítems de cotizaciones (OC) | `POST /extraer`, línea 823 | PDF, imagen o Excel/CSV → array JSON de ítems con precio unitario sin IVA e `ivaPct` | Stream con progreso en vivo; razonamiento bajo; 75 s sin datos o 150 s en total |
| 2 | Extraer oferta y redactar clausulado (OS) | `POST /os/extraer`, línea 3318 | PDF, imagen o Excel/CSV → objeto JSON con proveedor, ítems, condiciones y 9 cláusulas | Stream con progreso en vivo; razonamiento completo; 75 s / 150 s |
| 3 | Generar cláusulas de OS | `POST /os/generar-clausulas`, línea 3476 | Objeto del servicio y condiciones → texto de 8 cláusulas | 30 s por intento, 90 s en total; tope de 2.048 tokens de salida |
| 4 | Leer requerimientos en PDF | [`src/leerRequerimientoPDF.js:49`](../src/leerRequerimientoPDF.js), vía `src/procesarCorreo.js:24` (correo y carga manual) | PDF del formato CT-ADMIN-FO-002 → `{cabecera, items}` | 120 s por intento, 300 s en total; si falla, el solicitante recibe «PDF sin ítems» |
| 5 | Homologar insumos sin historial | Comparativa de proveedores, línea 1068 (llamada en 1818) | Insumo y 10 candidatos → los mismos, reordenados | 5 s, un intento; una llamada por ítem, todas en paralelo; si falla, orden por palabras |
| 6 | Búsqueda semántica de precios | `GET /precios/buscar`, línea 1501 | Término y todos los nombres únicos del historial → nombres que coinciden | 10 s, un intento; si falla, coincidencia por palabras |
| 7 | Análisis IA de inventario vs. APU | `POST /inventario/analisis-ia`, línea 4381 | Stock, movimientos, APU y conversación previa → respuesta en texto | 15 s por intento, 45 s en total |

La API de RRHH (`src/apiRrhh.js`) no pasa por IA, por diseño.

## Cómo está integrado hoy

```
Consola web (ui/consola.html)            Lector de correos (index.js, cron)
        │                                          │
        ▼                                          ▼
servidor-cotizaciones.js ── carga manual ──► leerRequerimientoPDF.js
        │                                          │
        └─────────────────────┬────────────────────┘
                              ▼
   ┌── se reemplaza ──────────────────────────────────────────┐
   │  geminiClient.js ── candidatos ──► geminiModelos.js      │
   │  (POST y SSE a mano,               (catálogo de Google,  │
   │   reintentos, salto de modelo)      castigos por modelo) │
   └──────────────────────────────────────────────────────────┘
                              ▼
                   API de Gemini (Google)
```

Lo que también cambia alrededor de esos dos archivos:

- Cada función arma su propio cuerpo de petición (`contents`, `inline_data`,
  `generationConfig`) y lee `candidates[0].content.parts[0].text`. Esos dos puntos
  se tocan en las 7.
- Los prompts están en línea dentro de cada ruta, en español; no hay archivo de prompts.
- Excel y CSV se convierten a texto con `xlsx` antes de enviarse (líneas 3074 y 3339);
  eso no cambia.
- Configuración: solo `GEMINI_API_KEY`. `data/gemini-modelos.json` vive en el volumen
  que comparten el servidor y el mailer.
- Textos visibles con «Gemini» en `ui/consola.html`: líneas 3520 y 3626.
- Documentación que lo menciona: `README.md`, `INSTALACION.md`, `.env.example`,
  `CONTRIBUTING.md`, `docs/contrato-api-rrhh.md` y el comentario del mailer en
  `docker-compose.yml`.

## Requisitos

La regla de fondo: la UI, los llamadores y la forma de los datos no cambian; solo
cambia quién los produce.

**Funcionales**

- Las 7 funciones devuelven la misma estructura que hoy, campo por campo.
- `/extraer` y `/os/extraer` conservan el progreso en vivo (NDJSON con fase, latidos y
  conteo de ítems).
- Homologación y búsqueda de precios siguen cayendo a coincidencia por palabras si la
  IA falla o tarda.
- Entradas soportadas: PDF, PNG, JPG/JPEG (lo que acepta hoy la consola) y Excel/CSV
  convertido a texto.
- Un fallo de IA en un requerimiento por correo no debe responder «PDF sin ítems» al
  solicitante: hay que distinguir «la IA falló» de «el PDF está vacío».

**No funcionales**

- Calidad: Claude iguala o supera a Gemini en precio, cantidad, unidad e IVA sobre el
  set de pruebas de la Fase 1.
- Latencia: `/extraer` y `/os/extraer` terminan antes de 150 s, porque la consola
  corta a los 180 s. Homologación y búsqueda responden dentro de sus 5 s y 10 s, o se
  recalibran esos límites.
- Costo y saldo: tope de gasto, alerta de saldo bajo y, si la cuenta lo permite,
  recarga automática de créditos en la Consola de Anthropic. Si aun así el saldo se
  agota, el usuario ve un mensaje claro y Tecnología recibe aviso, en vez del error
  crudo del proveedor que muestra hoy la consola.
- Secretos: `ANTHROPIC_API_KEY` solo en el `.env` del VPS, para el servidor web y el
  mailer. El repo es público, así que nunca en código ni en ejemplos.
- Observabilidad: por cada llamada, registrar función, modelo, tokens de entrada y
  salida, latencia y `stop_reason`.
- Datos: confirmar que enviar cotizaciones y requerimientos (NIT, precios, nombres) a
  Anthropic es aceptable para la empresa.

## Equivalencias Gemini → Claude

| Concepto | Hoy con Gemini | Con Claude |
|---|---|---|
| Cliente | `https` a mano en `geminiClient.js`, key en la URL | SDK oficial `@anthropic-ai/sdk`, que funciona con `require`. Trae reintentos (2 por defecto ante 429, 5xx y red), timeouts, streaming y errores tipados |
| Endpoint | `generateContent` y `streamGenerateContent?alt=sse` | `POST /v1/messages`, con `stream: true` para SSE |
| Modelo | Catálogo de Google cada 30 min, con castigos por modelo (`geminiModelos.js`) | Un ID fijo por configuración: `claude-haiku-5-5`. Sin alias móviles; los retiros se anuncian con anticipación |
| PDF | `inline_data` con `application/pdf` | Bloque `document` en base64; hasta 32 MB por petición y 600 páginas |
| Imagen | `inline_data` con `image/*` | Bloque `image` en base64: JPEG, PNG, GIF o WebP |
| JSON | Prompt «devuelve SOLO JSON», limpiar `` ```json `` y rescatar ítems con regex (`parsearJSONGemini`) | Salidas estructuradas (`output_config.format` con JSON Schema): JSON válido garantizado, también en streaming |
| Leer la respuesta | `candidates[0].content.parts[0].text` | Recorrer `content` y tomar los bloques `text`: con razonamiento activo, la respuesta puede empezar con un bloque `thinking` |
| Razonamiento | `thinkingLevel: 'low'` o `thinkingBudget: 0` | `output_config.effort`: `low` a `max`. En Haiku 5.5 viene activo por defecto con `medium`; se puede apagar con `thinking: {type: "disabled"}` hasta `high` |
| Temperatura | `temperature: 0` y `0.3` | Se elimina: Haiku 5.5 responde 400 a valores distintos del predeterminado |
| Tope de salida | `maxOutputTokens` (incluye razonamiento) | `max_tokens` (también lo incluye); hasta 128K con streaming |
| Respuesta cortada | `finishReason: MAX_TOKENS` | `stop_reason: "max_tokens"`; además existe `"refusal"`, que hay que manejar |
| Errores | 503 saturado, 429 cuota, 404 modelo retirado, 402 sin saldo | 529 saturado, 429 límite de tasa (con `retry-after`), 500; sin saldo, la API también rechaza las peticiones |
| Cuota y pago | Nivel gratuito y luego créditos prepagados | Límites por minuto según el nivel de gasto de la cuenta; créditos prepagados o facturación |
| Caché | No se usa | Caché de prompt: las lecturas cuestan una décima parte de la entrada normal |

**Modelos y precios** (US$ por millón de tokens, según la referencia de la API al
2026-10-06; confirmar en la [página de precios](https://platform.claude.com/docs/en/about-claude/pricing))

| Modelo | ID | Entrada | Salida | Rol en este plan |
|---|---|---:|---:|---|
| Claude Haiku 5.5 | `claude-haiku-5-5` | 0,10 | 0,50 | Elegido para las 7 funciones. Precio válido hasta 100K tokens de entrada; por encima, 0,50 y 2,50 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2,00 | 10,00 | Escalón solo para la función que no alcance la calidad con Haiku; el candidato es el clausulado |
| Claude Opus 5.5 | `claude-opus-5-5` | 4,00 | 20,00 | Descartado: modelo frontera, innecesario para extraer datos de formatos digitales |

Con supuestos gruesos (una cotización de 3 páginas, unos 8K tokens de entrada y 5K de
salida con razonamiento), una extracción en Haiku 5.5 cuesta del orden de US$0,003. Con
el volumen actual el costo no es un problema; pesan más los límites de tasa. La Fase 1
mide el valor real con los tokens que reporta cada respuesta.

Referencias: [PDF](https://platform.claude.com/docs/en/build-with-claude/pdf-support) ·
[salidas estructuradas](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) ·
[streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) ·
[caché de prompt](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ·
[límites de tasa](https://platform.claude.com/docs/en/api/rate-limits) ·
[modelos](https://platform.claude.com/docs/en/about-claude/models/overview)

## Riesgos

El más caro es el silencioso: una extracción que «funciona» pero trae un precio con IVA
o una cantidad mal leída, y llega a la OC y al historial de precios. Ordenados de mayor
a menor impacto:

| Riesgo | Por qué importa aquí | Mitigación |
|---|---|---|
| Calidad distinta en la extracción | Precio sin IVA, `ivaPct`, cantidades y tildes alimentan OC e historial; un error no lanza excepción. Haiku es el modelo más pequeño: escaneos y fotos de cotizaciones son el caso a vigilar | Set de 20 a 30 documentos reales con resultado esperado validado por compras; comparar campo a campo contra Gemini. La función que no alcance sube a Sonnet 5.5, solo esa |
| Saldo agotado | Ya pasó con Gemini (HTTP 402) y la consola mostró el error crudo de Google. Con Claude también se paga con créditos | Tope de gasto, alerta de saldo bajo y recarga automática si la cuenta la ofrece; mensaje claro al usuario y aviso a Tecnología |
| Proyecto de Google compartido | La key del ERP vive en un proyecto de AI Studio junto con otras 7 apps de KAOS, y todas comparten el saldo. El mayor consumo de tokens es de Gemini 3.1 Pro, que el ERP no usa: solo llama modelos Flash | Migrar el ERP no restablece las demás apps: recargar Gemini es una decisión aparte. En la Fase 5 se revoca solo la key del ERP; el proyecto y su facturación no se tocan |
| No hay pruebas automatizadas | `npm test` no existe; una regresión solo se ve en producción | El script de la Fase 1 queda en el repo y se corre en cada cambio de prompt o modelo |
| Latencia en llamadas cortas | Homologación tiene 5 s y búsqueda 10 s; Haiku 5.5 razona por defecto. Si no llega a tiempo, la función cae a palabras sin que nadie lo note | Medir el p95 con razonamiento apagado y con `effort: low`; recalibrar límites si hace falta |
| Ráfagas de peticiones | La comparativa lanza una llamada por ítem sin historial, todas a la vez (`Promise.all`, línea 1788); una cuenta nueva arranca con límites bajos y responde 429 | Limitar la concurrencia o mandar todos los ítems en una sola llamada |
| Prompt grande en cada búsqueda | La búsqueda de precios envía el catálogo entero en cada consulta: solo el archivo 2026 tiene 1.042 nombres únicos, unos 34.000 caracteres | Caché de prompt con la lista en orden estable; baja latencia y costo |
| Prompts escritos para Gemini | Sin `temperature`, con razonamiento por defecto y con JSON por esquema, frases como «SOLO JSON, sin markdown» sobran y la limpieza con regex también | Reescribir cada prompt al migrar su función; quitar la limpieza de `` ``` `` y conservar el rescate de ítems solo como red de seguridad |
| Timeout de silencio del stream | Hoy son 75 s sin datos. Mientras el modelo razona puede no llegar texto visible, y el conteo de ítems y los latidos dependen del texto | Contar como actividad cualquier evento SSE, no solo texto; medir con documentos largos |
| Clausulado de OS | Es redacción jurídica, no extracción: la función donde un modelo sencillo tiene más riesgo | Comparar lado a lado; quien aprueba hoy el clausulado firma el nuevo; Sonnet 5.5 si Haiku no alcanza |
| Correo sin nadie mirando | Un fallo de IA en un requerimiento PDF termina en respuesta automática al solicitante | Separar «falló la IA» de «PDF vacío» en la misma PR que migra esa función |
| Datos de terceros | Cotizaciones con NIT, precios y nombres de proveedores salen a un proveedor externo | Validar con quien corresponda antes de la Fase 4 |
| Rechazos del modelo | Claude puede devolver `stop_reason: "refusal"`, y Haiku 5.5 no tiene respaldo automático del servidor; improbable en compras | Tratarlo en el cliente como un error claro |

## Preguntas abiertas

- [x] ¿Qué inconvenientes hubo con Gemini? Disponibilidad, no calidad (ver Resumen).
  Decisión: probar Claude.
- [x] ¿Quién administra la cuenta y la facturación en Anthropic? Tecnología, con
  Julian como responsable.
- [x] ¿Qué modelo? Opus 5.5 por defecto (2026-10-29; antes se había decidido Haiku
  5.5), configurable por función y validado en la Fase 1.
- [x] ¿Cuántas veces al día se usa cada función? Poco (ver Decisiones tomadas).
- [ ] ¿Qué tope de gasto mensual se fija en la Consola? Con Haiku el costo esperado es
  bajo; el tope protege de un error que dispare llamadas.
- [ ] ¿Se recargan créditos de Gemini para que la IA siga funcionando mientras dura la
  migración y sirva de respaldo en la Fase 4, o se hace corte directo? El mismo saldo
  lo usan otras 7 apps de KAOS, así que esa recarga no depende solo del ERP.
- [ ] ¿Hay alguna restricción contractual o legal para enviar cotizaciones y
  requerimientos de proveedores a un proveedor externo?
- [ ] ¿Quién de compras valida el resultado esperado del set de pruebas?
- [ ] ¿Quién aprueba hoy el clausulado de OS, y debe revisar el que redacte Claude
  antes de salir a producción?
- [ ] ¿Hay fecha objetivo o ventana de despliegue?

## Plan por fases

Seis fases con una compuerta entre cada una. La que decide todo es la Fase 1: ninguna
función cambia de proveedor sin un set de pruebas que lo justifique, y Gemini sigue
disponible detrás de un selector hasta el final. El esfuerzo grande está en las fases 1
y 3; las demás son configuración y limpieza.

| Fase | Qué | Compuerta para pasar a la siguiente |
|---|---|---|
| 0 | Decisiones y cuenta | Presupuesto y modelo aprobados |
| 1 | Set de pruebas y medición | Claude ≥ Gemini en precio, cantidad e IVA; p95 dentro de los timeouts |
| 2 | Cliente de IA con selector de proveedor | Las 7 funciones corren en desarrollo con ambos proveedores |
| 3 | Migrar función por función, una PR cada una | Set de pruebas en verde para cada función migrada |
| 4 | Producción con Gemini de respaldo | 2 semanas sin incidentes atribuibles a la IA (propuesta) |
| 5 | Retirar Gemini del ERP | — |

### Fase 0 · Decisiones y cuenta

- [ ] Responder las preguntas pendientes de este documento
- [ ] Crear o confirmar la organización en la Consola de Anthropic, cargar créditos,
  fijar el tope de gasto y activar la alerta de saldo
- [ ] Generar una `ANTHROPIC_API_KEY` para producción y otra para desarrollo

### Fase 1 · Set de pruebas y medición

- [ ] Reunir 20 a 30 documentos reales: cotizaciones en PDF, imagen y Excel, ofertas de
  OS y requerimientos en PDF, con escaneos o fotos si llegan en el día a día. Guardarlos
  fuera del repo, que es público
- [ ] Registrar con compras el resultado esperado de cada documento
- [ ] Escribir `src/scripts/evaluar-ia.js`: corre cada documento con ambos proveedores,
  compara campo a campo y reporta exactitud, latencia p50 y p95, y tokens
- [ ] Correr las 7 funciones con Haiku 5.5, con razonamiento apagado y con
  `effort: low`; la que no alcance se prueba con Sonnet 5.5

### Fase 2 · Cliente de IA

- [x] Agregar `@anthropic-ai/sdk` a `package.json` (0.134.0, versión fija)
- [x] Crear `src/iaClient.js` con dos operaciones: extraer (documento y prompt → texto,
  con `onTexto` para el progreso) y texto (prompt → texto). El transporte de Claude
  vive en `src/claudeClient.js`. El esquema JSON queda para la Fase 3, función por
  función, junto con la reescritura de cada prompt
- [x] Leer la respuesta por tipo de bloque: puede empezar con un bloque `thinking` antes
  del texto
- [x] Variable `IA_PROVEEDOR` (y `IA_PROVEEDOR_<FUNCION>`) y modelo por función en
  configuración (`ANTHROPIC_MODEL`, `claude-opus-5-5` por defecto), no en el código
- [x] Tratar `stop_reason` `max_tokens` y `refusal` como errores claros, y el saldo
  agotado con un mensaje para el usuario
- [ ] Aviso a Tecnología cuando se agota el saldo: hoy solo queda `SALDO AGOTADO` en el
  log; el ERP no tiene un canal de alertas
- [x] Log por llamada: función, modelo, tokens, latencia y `stop_reason`
- [x] Dejar `geminiClient.js` intacto detrás del selector

### Fase 3 · Migración por función

Una PR cada una, en este orden:

- [ ] Requerimiento PDF, separando «falló la IA» de «PDF vacío»
- [ ] `/extraer`, con esquema JSON y el contador de ítems funcionando
- [ ] `/os/extraer`, con revisión del clausulado por quien lo aprueba hoy
- [ ] `/os/generar-clausulas`
- [ ] `/inventario/analisis-ia`
- [ ] Homologación y búsqueda de precios, con caché de prompt y concurrencia limitada
- [ ] Quitar «Gemini» de los textos de `ui/consola.html`

### Fase 4 · Producción con respaldo

- [ ] `ANTHROPIC_API_KEY` e `IA_PROVEEDOR=claude` en el `.env` del VPS
- [ ] Revisar costo, latencia y errores cada semana durante 2 semanas

### Fase 5 · Retirar Gemini del ERP

- [ ] Borrar `geminiClient.js`, `geminiModelos.js`, `GEMINI_API_KEY` y
  `data/gemini-modelos.json`, con sus entradas en `.gitignore` y `.dockerignore`
- [ ] Revocar en AI Studio solo la key del ERP; el proyecto de Google y su saldo siguen
  en uso por otras apps
- [ ] Actualizar `README.md`, `INSTALACION.md`, `.env.example`, `CONTRIBUTING.md`,
  `docs/contrato-api-rrhh.md` y el comentario de `docker-compose.yml`
