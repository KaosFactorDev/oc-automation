'use strict';
/**
 * claudeClient.js
 * Transporte contra la API de Claude (Anthropic) con el SDK oficial. Es la pareja de
 * geminiClient.js: quien elige cual de los dos usar es iaClient.js, segun IA_PROVEEDOR.
 * Ver docs/migracion-gemini-claude.md (Fase 2).
 *
 * Lo que conserva de geminiClient
 * -------------------------------
 * El mismo contrato de tiempo: `timeoutMs` por intento y `presupuestoMs` total, y
 * presupuesto omitido = un solo intento (la razon esta en geminiClient.js: hay
 * llamadas que se hacen N veces por request y degradan a coincidencia por palabras).
 *
 * En un stream el timeout es de silencio, pero aca se reinicia con CUALQUIER evento
 * SSE y no solo con texto: mientras Claude razona no llega texto visible, y sin esto
 * un razonamiento largo se cortaria como si el modelo no respondiera. Por lo mismo,
 * en stream se pide el resumen del razonamiento (display "summarized"): no cambia lo
 * que se cobra y hace que lleguen eventos mientras piensa.
 *
 * Lo que no trae
 * --------------
 * Catalogo de modelos ni castigos: los IDs de Claude son fijos y los elige la
 * configuracion (ANTHROPIC_MODEL), no hay alias que el proveedor mueva o retire. Los
 * reintentos del SDK se apagan (maxRetries: 0) porque no conocen el presupuesto; los
 * hace este modulo.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Igual que en geminiClient: espera entre reintentos y margen minimo para que
// despues de dormir quede tiempo para otro intento.
const BACKOFF_MS = [2000, 5000];
const MARGEN_INTENTO_MS = 2000;

// Modelos que aceptan `fallbacks: 'default'`: si el modelo rechaza la peticion
// (stop_reason "refusal"), el servidor la repite en otro modelo dentro de la misma
// llamada. En los demas el parametro da 400, asi que solo se manda a estos.
const CON_RESPALDO = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/;

const IMAGENES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const clave = () => process.env.ANTHROPIC_API_KEY || '';

let _cliente = null;
function cliente() {
  if (!_cliente) _cliente = new Anthropic({ apiKey: clave(), maxRetries: 0 });
  return _cliente;
}

/** Bloque de contenido para un archivo en base64: PDF o imagen. */
function bloqueAdjunto(mimeType, base64) {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } };
  }
  const tipo = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
  if (IMAGENES.has(tipo)) {
    return { type: 'image', source: { type: 'base64', media_type: tipo, data: base64 } };
  }
  throw new Error(`Claude no lee archivos ${mimeType}. Sube un PDF, una imagen (JPG, PNG, GIF o WebP) o un Excel/CSV.`);
}

function peticion({ modelo, contenido, maxTokens, esfuerzo }, stream) {
  const p = {
    model: modelo,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: contenido }],
  };
  if (esfuerzo) p.output_config = { effort: esfuerzo };
  if (stream) p.thinking = { type: 'adaptive', display: 'summarized' };
  if (CON_RESPALDO.test(modelo)) {
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

/**
 * Texto final de la respuesta. Se toman solo los bloques `text`: con razonamiento
 * activo la respuesta empieza con bloques `thinking`. Si el servidor paso a otro
 * modelo por un rechazo, vale lo que vino despues del ultimo bloque `fallback`.
 */
function resultado(msg) {
  if (msg.stop_reason === 'refusal') {
    const motivo = msg.stop_details?.category ? ` (motivo: ${msg.stop_details.category})` : '';
    const e = new Error(`Claude se negó a procesar la petición${motivo}.`);
    e.rechazo = true;
    throw e;
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('Claude cortó la respuesta por límite de tokens (max_tokens). Sube maxTokens o reduce el documento.');
  }
  const bloques = msg.content.slice(msg.content.map(b => b.type).lastIndexOf('fallback') + 1);
  return {
    texto:   bloques.filter(b => b.type === 'text').map(b => b.text).join(''),
    modelo:  msg.model,
    entrada: msg.usage?.input_tokens,
    salida:  msg.usage?.output_tokens,
    stop:    msg.stop_reason,
  };
}

/** 'reintentar' | 'abortar'. Con un solo modelo no hay a donde saltar. */
function decidir(err) {
  // El stream ya entrego texto: repetirlo lo duplicaria en pantalla.
  if (err.huboDatos) return 'abortar';
  // Timeout: la generacion probablemente se cobro y repetirla dobla la espera.
  if (err.generacionEnVuelo) return 'abortar';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'abortar';
  if (err instanceof Anthropic.APIConnectionError) return 'reintentar';
  if (err instanceof Anthropic.APIError) {
    // 429 limite de tasa, 529 saturado y otros 5xx: el mismo modelo puede contestar
    // en el proximo intento. 400, 401, 402, 403 y 404 no se arreglan insistiendo.
    if (err.status === 429 || err.status >= 500) return 'reintentar';
  }
  return 'abortar';
}

/** Espera antes de reintentar: la que pida la API en retry-after, si la pide. */
function esperaDe(err, intento) {
  const pedida = Number(err.headers?.get?.('retry-after'));
  if (pedida > 0) return pedida * 1000;
  return BACKOFF_MS[intento] + Math.floor(Math.random() * 500); // jitter
}

/** Error con un mensaje que se pueda mostrar tal cual en la consola. */
function legible(err) {
  if (!(err instanceof Anthropic.APIError) || !err.status) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      const e = new Error('Claude no respondió a tiempo.');
      e.generacionEnVuelo = true;
      return e;
    }
    if (err instanceof Anthropic.APIConnectionError) return new Error(`No se pudo conectar con la API de Claude: ${err.message}`);
    return err;
  }
  let mensaje;
  switch (err.type) {
    case 'billing_error':
      // Es el caso que mas importa avisar: sin saldo fallan todas las funciones a la vez.
      console.error('[claudeClient] SALDO AGOTADO en la cuenta de Anthropic: recargar créditos en la Consola.');
      mensaje = 'Se agotó el saldo de la cuenta de Claude (Anthropic). Avisa a Tecnología para recargar créditos.';
      break;
    case 'authentication_error':
      mensaje = 'ANTHROPIC_API_KEY inválida o revocada.';
      break;
    case 'permission_error':
      mensaje = 'La ANTHROPIC_API_KEY no tiene permiso para este modelo o esta función.';
      break;
    case 'not_found_error':
      mensaje = `Claude no reconoce el modelo configurado: ${err.message}`;
      break;
    case 'rate_limit_error':
      mensaje = 'Claude: se alcanzó el límite de peticiones por minuto de la cuenta. Intenta de nuevo en un momento.';
      break;
    case 'overloaded_error':
      mensaje = 'Claude está saturado en este momento. Intenta de nuevo en unos minutos.';
      break;
    default:
      mensaje = `Claude error (HTTP ${err.status}): ${err.message}`;
  }
  const e = new Error(mensaje);
  e.httpStatus = err.status;
  e.apiStatus  = err.type || '';
  return e;
}

/** Repite `correr(ms)` dentro del presupuesto mientras el error sea transitorio. */
async function ejecutar(correr, { timeoutMs, presupuestoMs, etiqueta }) {
  const t0 = Date.now();
  const restante = () => presupuestoMs - (Date.now() - t0);
  const permiteReintentos = presupuestoMs > timeoutMs;

  for (let intento = 0; ; intento++) {
    try {
      return await correr(intento === 0 ? timeoutMs : Math.min(timeoutMs, restante()));
    } catch (e) {
      if (decidir(e) === 'reintentar' && permiteReintentos && intento < BACKOFF_MS.length) {
        const espera = esperaDe(e, intento);
        if (restante() > espera + MARGEN_INTENTO_MS) {
          console.warn(`[claudeClient] ${etiqueta}: ${e.message} — reintento ${intento + 1} en ${espera}ms`);
          await new Promise(r => setTimeout(r, espera));
          continue;
        }
      }
      throw legible(e);
    }
  }
}

async function intentoJson(params, timeoutMs) {
  const msg = await cliente().beta.messages.create(peticion(params, false), { timeout: timeoutMs });
  return resultado(msg);
}

async function intentoStream(params, timeoutMs, onTexto) {
  const ctrl = new AbortController();
  let reloj;
  let porSilencio = false;
  let huboDatos   = false;
  let texto       = '';
  const rearmar = () => {
    clearTimeout(reloj);
    reloj = setTimeout(() => { porSilencio = true; ctrl.abort(); }, timeoutMs);
  };

  rearmar();
  const stream = cliente().beta.messages.stream(peticion(params, true), { signal: ctrl.signal });
  stream.on('streamEvent', rearmar);
  stream.on('text', (delta) => {
    huboDatos = true;
    texto += delta;
    if (onTexto) { try { onTexto(texto); } catch {} }
  });

  try {
    return resultado(await stream.finalMessage());
  } catch (e) {
    let err = e;
    if (porSilencio) {
      err = new Error(`Claude timeout tras ${Math.round(timeoutMs / 1000)}s sin datos`);
      err.generacionEnVuelo = true;
    }
    if (huboDatos) err.huboDatos = true;
    throw err;
  } finally {
    clearTimeout(reloj);
  }
}

function exigirClave() {
  if (!clave()) throw new Error('ANTHROPIC_API_KEY no configurada en .env');
}

/**
 * Una peticion sin streaming. `params`: { modelo, contenido, maxTokens, esfuerzo }.
 * Devuelve { texto, modelo, entrada, salida, stop }.
 */
async function pedir(params, { timeoutMs = 60000, presupuestoMs, etiqueta = 'claude' } = {}) {
  exigirClave();
  return ejecutar(
    (ms) => intentoJson(params, ms),
    { timeoutMs, presupuestoMs: presupuestoMs ?? timeoutMs, etiqueta },
  );
}

/** Igual que pedir(), en streaming. onTexto(acumulado) se llama con cada trozo de texto. */
async function pedirStream(params, { timeoutMs = 120000, presupuestoMs, onTexto, etiqueta = 'claude' } = {}) {
  exigirClave();
  return ejecutar(
    (ms) => intentoStream(params, ms, onTexto),
    { timeoutMs, presupuestoMs: presupuestoMs ?? timeoutMs, etiqueta },
  );
}

module.exports = { pedir, pedirStream, bloqueAdjunto, decidir };
