'use strict';
/**
 * geminiClient.js
 * Transporte unico contra la API de Gemini: arma la URL, reintenta y, si el modelo
 * principal no responde, pasa al de respaldo.
 *
 * Por que existe este archivo
 * ---------------------------
 * Habia dos copias del mismo POST —una en servidor-cotizaciones.js y otra en
 * leerRequerimientoPDF.js, que ya discrepaban en el default de `reintentos`— y en
 * las cuatro llamadas el nombre del modelo se interpolaba en la URL ANTES de entrar
 * al helper. Eso significaba que el helper no podia saber ni cambiar contra que
 * modelo estaba hablando: no habia donde enganchar un fallback.
 *
 * El 15-09-2026 Gemini devolvio 503 UNAVAILABLE ("high demand") de forma sostenida
 * sobre gemini-3.5-flash y la extraccion se cayo en produccion. La respuesta
 * historica fue editar GEMINI_MODEL a mano en el .env del VPS: estrena capacidad y
 * aguanta unos dias. Este modulo existe para que eso lo haga el sistema solo.
 *
 * Presupuesto de tiempo, no numero de reintentos
 * ----------------------------------------------
 * Mas reintentos NO es mejor: la consola aborta la peticion a los 180s
 * (postConProgreso en ui/consola.html), asi que un servidor que se pase de ese
 * techo le muestra al usuario un timeout generico en vez del error real. Por eso el
 * limite es un presupuesto total de reloj y no una cuenta de intentos: antes de
 * abrir cada intento se comprueba cuanto queda, y el timeout del intento se recorta
 * a lo que reste.
 *
 * `presupuestoMs` por defecto vale lo mismo que `timeoutMs`, y eso APAGA los
 * reintentos: un intento por modelo, sin esperas. Es deliberado: hay llamadas
 * (autocompletado de precios, homologacion de insumos) que se hacen N veces por
 * request y degradan a coincidencia por tokens, asi que alargarlas seria peor que
 * fallar. Quien quiera reintentos pide un presupuesto mayor que el timeout.
 *
 * Lo que NUNCA se apaga es el salto al modelo de respaldo, porque es barato y es la
 * unica salida cuando al principal se le acaba la cuota del dia.
 */

const https = require('https');
const { MODELOS } = require('./geminiConfig');

// Espera entre reintentos contra el MISMO modelo. Tres reintentos y se pasa al
// siguiente modelo: un 503 que sobrevive a ~19s de espera no es un pico, es una
// saturacion, y ahi lo que sirve es cambiar de modelo, no seguir insistiendo.
const BACKOFF_MS = [2000, 5000, 12000];

// Margen que se reserva para el intento siguiente antes de dormir un backoff: sin
// esto se gasta el presupuesto esperando y no queda tiempo para usarlo.
const MARGEN_INTENTO_MS = 2000;

const clave = () => process.env.GEMINI_API_KEY || '';

function urlDe(modelo, operacion, sse) {
  const qs = sse ? 'alt=sse&' : '';
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:${operacion}?${qs}key=${clave()}`;
}

/** Error con el codigo HTTP y el status de la API pegados, para poder clasificarlo. */
function errorApi(status, apiErr) {
  const e = new Error(`Gemini error (HTTP ${apiErr?.code || status}): ${apiErr?.message || 'sin detalle'}`);
  e.httpStatus = apiErr?.code || status;
  e.apiStatus  = apiErr?.status || '';
  return e;
}

/**
 * Que hacer ante un error concreto. Es el corazon del modulo.
 *
 * Antes solo se reconocia 503/UNAVAILABLE como transitorio, asi que un modelo
 * retirado por Google (404) reventaba sin un solo reintento — justo el escenario
 * que un modelo de respaldo resuelve.
 */
function decidir(err) {
  // Nunca se repite: la generacion ya ocurrio del lado de Google y ya se cobro
  // cuota, o el stream ya entrego texto que un reintento tiraria a la basura.
  // Vale igual para el salto de modelo, que tambien paga una generacion entera.
  if (err.generacionEnVuelo || err.huboDatos) return 'abortar';

  const http = err.httpStatus || 0;
  const api  = err.apiStatus  || '';

  // Transitorio de verdad: el mismo modelo puede contestar en el proximo intento.
  if (http === 503 || api === 'UNAVAILABLE') return 'reintentar';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up/i.test(err.message)) return 'reintentar';

  // La cuota del free tier se cuenta POR MODELO, asi que el respaldo llega con su
  // propio cupo diario. Insistir contra este modelo no sirve de nada.
  if (http === 429 || api === 'RESOURCE_EXHAUSTED') return 'siguiente-modelo';

  // Modelo retirado o renombrado. Paso el 25-08-2026 con un alias movil.
  if (http === 404 || api === 'NOT_FOUND') return 'siguiente-modelo';

  // 400 (prompt mal armado), 403 (key invalida) y cualquier otra cosa: cambiar de
  // modelo no arregla nada y solo retrasa el mensaje de error.
  return 'abortar';
}

/**
 * Recorre los modelos y los reintentos dentro del presupuesto. `correr(modelo, ms)`
 * hace UN intento y lanza si falla.
 */
async function ejecutar(correr, { timeoutMs, presupuestoMs, etiqueta }) {
  const t0 = Date.now();
  const restante = () => presupuestoMs - (Date.now() - t0);
  let ultimoError;

  // El presupuesto gobierna los REINTENTOS —que son los que hacen esperar—, no el
  // salto al modelo de respaldo. Un failover solo ocurre ante errores que vuelven
  // rapido (429 de cuota, 404 de modelo retirado, o un 503 con los reintentos ya
  // agotados); un intento que expira marca generacionEnVuelo y aborta sin failover,
  // asi que esto nunca puede encadenar dos timeouts completos.
  //
  // Por eso cada modelo tiene derecho a su primer intento aunque el presupuesto este
  // justo: si el principal se queda sin cuota, negarle el turno al respaldo seria
  // dejar caer la peticion teniendo a mano un modelo con cupo propio.
  const permiteReintentos = presupuestoMs > timeoutMs;

  for (let m = 0; m < MODELOS.length; m++) {
    const modelo    = MODELOS[m];
    const quedaOtro = m < MODELOS.length - 1;

    for (let intento = 0; ; intento++) {
      try {
        const resultado = await correr(modelo, timeoutMs);
        if (m > 0) console.warn(`[geminiClient] ${etiqueta}: respondio el modelo de respaldo "${modelo}"`);
        return resultado;
      } catch (e) {
        ultimoError = e;
        const accion = decidir(e);

        if (accion === 'abortar') throw e;

        if (accion === 'reintentar' && permiteReintentos && intento < BACKOFF_MS.length) {
          const espera = BACKOFF_MS[intento] + Math.floor(Math.random() * 500); // jitter
          // Solo se duerme si despues de la espera queda margen para otro intento.
          if (restante() > espera + MARGEN_INTENTO_MS) {
            console.warn(`[geminiClient] ${etiqueta}: ${e.message} — reintento ${intento + 1} con "${modelo}" en ${espera}ms`);
            await new Promise(r => setTimeout(r, espera));
            continue;
          }
        }

        // Se agotaron los reintentos de este modelo (o el error pide saltar ya).
        if (quedaOtro) {
          console.warn(`[geminiClient] ${etiqueta}: "${modelo}" no sirve (${e.message}) — pasando a "${MODELOS[m + 1]}"`);
        }
        break;
      }
    }

    // Presupuesto gastado: mejor devolver el error real que arrastrar la espera.
    if (restante() <= 0) break;
  }

  throw ultimoError || new Error('Gemini: fallo desconocido');
}

/** Un POST JSON contra un modelo. Devuelve el cuerpo ya parseado. */
function intentoJson(modelo, operacion, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(urlDe(modelo, operacion, false), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let cuerpo;
        try { cuerpo = JSON.parse(Buffer.concat(chunks).toString()); }
        catch {
          const e = new Error(`Respuesta de Gemini ilegible (HTTP ${res.statusCode})`);
          e.httpStatus = res.statusCode;
          return reject(e);
        }
        if (cuerpo.error)          return reject(errorApi(res.statusCode, cuerpo.error));
        if (res.statusCode !== 200) return reject(errorApi(res.statusCode, null));
        resolve(cuerpo);
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      // generateContent no hace streaming: Gemini no manda un byte hasta terminar de
      // generar, asi que toda la fase de razonamiento cuenta como socket inactivo y
      // este timeout es en realidad un techo al tiempo total de generacion.
      const e = new Error(`Gemini timeout tras ${Math.round(timeoutMs / 1000)}s`);
      e.generacionEnVuelo = true;
      reject(e);
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/** Un POST SSE contra un modelo. Devuelve el texto completo; onTexto recibe el acumulado. */
function intentoStream(modelo, bodyStr, timeoutMs, onTexto) {
  return new Promise((resolve, reject) => {
    let huboDatos = false;
    // Marca el error para que decidir() sepa que ya llego texto y no lo repita.
    const fallar = (e) => { if (huboDatos) e.huboDatos = true; reject(e); };

    const req = https.request(urlDe(modelo, 'streamGenerateContent', true), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      // Los errores de la API no vienen como SSE: llegan con status != 200 y un
      // cuerpo JSON normal. Se acumula completo y se lanza legible.
      if (res.statusCode !== 200) {
        const trozos = [];
        res.on('data', c => trozos.push(c));
        res.on('end', () => {
          let apiErr;
          try { apiErr = JSON.parse(Buffer.concat(trozos).toString())?.error; } catch {}
          fallar(errorApi(res.statusCode, apiErr));
        });
        return;
      }

      let pendiente = '';   // linea SSE partida entre dos chunks TCP
      let texto     = '';
      let finish;

      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        huboDatos = true;
        pendiente += chunk;
        const lineas = pendiente.split('\n');
        pendiente = lineas.pop();   // la ultima puede estar incompleta

        for (const linea of lineas) {
          if (!linea.startsWith('data:')) continue;
          let payload;
          try { payload = JSON.parse(linea.slice(5)); } catch { continue; }

          if (payload.error) {
            fallar(errorApi(200, payload.error));
            req.destroy();
            return;
          }

          const cand = payload.candidates?.[0];
          if (cand?.finishReason) finish = cand.finishReason;

          // Se saltan las partes de razonamiento. Con includeThoughts apagado no
          // aparecen, pero no quiero que el conteo dependa de ese default.
          for (const parte of cand?.content?.parts || []) {
            if (parte.thought) continue;
            if (parte.text) texto += parte.text;
          }
          if (onTexto) { try { onTexto(texto); } catch {} }
        }
      });

      res.on('end', () => {
        // MAX_TOKENS devuelve HTTP 200 con el texto cortado a la mitad. Si se deja
        // pasar, falla mas abajo en el parseo con un mensaje que no dice nada.
        if (finish === 'MAX_TOKENS') {
          return fallar(new Error('Gemini corto la respuesta por limite de tokens (MAX_TOKENS). Sube maxOutputTokens o reduce el documento.'));
        }
        resolve(texto);
      });
      res.on('error', fallar);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const e = new Error(`Gemini timeout tras ${Math.round(timeoutMs / 1000)}s sin datos`);
      e.generacionEnVuelo = true;
      fallar(e);
    });
    req.on('error', fallar);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * POST a generateContent. Devuelve el cuerpo parseado.
 * `presupuestoMs` omitido = un solo intento (ver la nota de arriba).
 */
async function pedir(bodyStr, { timeoutMs = 60000, presupuestoMs, etiqueta = 'gemini' } = {}) {
  if (!clave()) throw new Error('GEMINI_API_KEY no configurada en .env');
  return ejecutar(
    (modelo, ms) => intentoJson(modelo, 'generateContent', bodyStr, ms),
    { timeoutMs, presupuestoMs: presupuestoMs ?? timeoutMs, etiqueta },
  );
}

/**
 * POST a streamGenerateContent (SSE), entregando el texto a medida que llega.
 * onTexto(acumulado) se llama en cada trozo. Devuelve el texto completo.
 */
async function pedirStream(bodyStr, { timeoutMs = 120000, presupuestoMs, onTexto, etiqueta = 'gemini' } = {}) {
  if (!clave()) throw new Error('GEMINI_API_KEY no configurada en .env');
  return ejecutar(
    (modelo, ms) => intentoStream(modelo, bodyStr, ms, onTexto),
    { timeoutMs, presupuestoMs: presupuestoMs ?? timeoutMs, etiqueta },
  );
}

module.exports = { pedir, pedirStream, decidir };
