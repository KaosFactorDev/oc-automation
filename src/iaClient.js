'use strict';
/**
 * iaClient.js
 * Punto unico por el que las funciones con IA del ERP llegan a un proveedor. Cada
 * funcion se identifica con un nombre corto y aca se decide, por configuracion y sin
 * redeploy, si va a Gemini (geminiClient.js) o a Claude (claudeClient.js).
 * Es la Fase 2 de docs/migracion-gemini-claude.md: Gemini sigue intacto detras del
 * selector hasta que la Fase 5 lo retire.
 *
 * Configuracion (.env)
 * --------------------
 *   IA_PROVEEDOR=gemini|claude            para todas las funciones (por defecto gemini)
 *   IA_PROVEEDOR_<FUNCION>=gemini|claude  pisa al anterior en una sola funcion
 *   ANTHROPIC_MODEL=claude-opus-5-5       modelo de Claude (por defecto claude-opus-5-5)
 *   ANTHROPIC_MODEL_<FUNCION>=...         pisa al anterior en una sola funcion
 * <FUNCION> es el nombre de FUNCIONES en mayusculas y con _ (p. ej. OS_CLAUSULAS).
 *
 * Lo que entra y sale es neutro: el llamador da un prompt, un adjunto opcional y
 * cuanto debe razonar el modelo, y recibe texto. Cada proveedor traduce eso a su
 * propio cuerpo de peticion, asi que los prompts y el parseo de cada funcion no
 * cambian de un proveedor a otro.
 */

const geminiClient = require('./geminiClient');
const geminiModelos = require('./geminiModelos');
const claudeClient = require('./claudeClient');

// Las 7 funciones con IA, con su ruta (la tabla esta en docs/migracion-gemini-claude.md).
const FUNCIONES = {
  'cotizacion':        'POST /extraer',
  'os-extraer':        'POST /os/extraer',
  'os-clausulas':      'POST /os/generar-clausulas',
  'requerimiento-pdf': 'leerRequerimientoPDF',
  'homologacion':      'comparativa de proveedores',
  'precios':           'GET /precios/buscar',
  'inventario':        'POST /inventario/analisis-ia',
};

const MODELO_CLAUDE = 'claude-opus-5-5';

// Claude cuenta el razonamiento dentro de max_tokens y no se puede apagar en los
// modelos actuales. Los topes de cada llamada se calibraron con Gemini, a veces con
// el razonamiento apagado (las clausulas: 2.048), asi que en Claude se usa al menos
// este piso. Es un techo, no un objetivo: no cuesta nada si no se usa. No se sube mas
// porque sin streaming el SDK rechaza topes que podrian pasar de 10 minutos.
const PISO_MAX_TOKENS_CLAUDE = 16000;

const sufijo = (funcion) => funcion.toUpperCase().replace(/-/g, '_');

function validarFuncion(funcion) {
  if (!FUNCIONES[funcion]) throw new Error(`Función de IA desconocida: "${funcion}"`);
}

/** 'gemini' | 'claude' para esta funcion. Lanza si la configuracion es invalida. */
function proveedor(funcion) {
  validarFuncion(funcion);
  const valor = (process.env[`IA_PROVEEDOR_${sufijo(funcion)}`] || process.env.IA_PROVEEDOR || 'gemini')
    .trim().toLowerCase();
  if (valor !== 'gemini' && valor !== 'claude') {
    throw new Error(`IA_PROVEEDOR inválido para "${funcion}": "${valor}". Usa gemini o claude.`);
  }
  return valor;
}

function modeloClaude(funcion) {
  return process.env[`ANTHROPIC_MODEL_${sufijo(funcion)}`] || process.env.ANTHROPIC_MODEL || MODELO_CLAUDE;
}

/** ¿Hay clave para el proveedor de esta funcion? Para los llamadores que degradan sin IA. */
function disponible(funcion) {
  try {
    return proveedor(funcion) === 'claude'
      ? !!process.env.ANTHROPIC_API_KEY
      : !!process.env.GEMINI_API_KEY;
  } catch {
    return false;
  }
}

// ── Traduccion a cada proveedor ───────────────────────────────────────────────

// razonamiento: 'minimo' | 'bajo' | undefined (lo que traiga el modelo por defecto).
//   Gemini: 'minimo' apaga el razonamiento y 'bajo' es thinkingLevel low.
//   Claude: no se puede apagar en los modelos actuales; los dos van a effort low.
function razonamientoGemini(razonamiento) {
  if (razonamiento === 'minimo') return { thinkingConfig: { thinkingBudget: 0 } };
  if (razonamiento === 'bajo')   return { thinkingConfig: { thinkingLevel: 'low' } };
  return {};
}

function esfuerzoClaude(razonamiento) {
  return razonamiento ? 'low' : undefined;
}

// Temperaturas de siempre con Gemini: 0 para extraer datos, 0.3 para texto libre.
// Claude no las recibe: los modelos actuales responden 400 a valores distintos del
// predeterminado.
function cuerpoGemini({ prompt, adjunto, razonamiento, maxTokens }, temperatura) {
  const partes = adjunto
    ? [{ inline_data: { mime_type: adjunto.mimeType, data: adjunto.base64 } }, { text: prompt }]
    : [{ text: prompt }];
  return JSON.stringify({
    contents: [{ parts: partes }],
    generationConfig: { temperature: temperatura, maxOutputTokens: maxTokens, ...razonamientoGemini(razonamiento) },
  });
}

function paramsClaude(funcion, { prompt, adjunto, razonamiento, maxTokens }, stream) {
  return {
    modelo:    modeloClaude(funcion),
    contenido: adjunto
      ? [claudeClient.bloqueAdjunto(adjunto.mimeType, adjunto.base64), { type: 'text', text: prompt }]
      : prompt,
    maxTokens: stream ? maxTokens : Math.max(maxTokens, PISO_MAX_TOKENS_CLAUDE),
    esfuerzo:  esfuerzoClaude(razonamiento),
  };
}

// ── Registro por llamada ──────────────────────────────────────────────────────

function registrar(funcion, prov, t0, r, err) {
  const partes = [`[ia] ${funcion}`, r.modelo ? `${prov} ${r.modelo}` : prov, `${Date.now() - t0}ms`];
  if (r.entrada != null) partes.push(`${r.entrada}→${r.salida} tokens`);
  if (r.stop) partes.push(r.stop);
  if (err) partes.push(`ERROR ${err.message}`);
  (err ? console.warn : console.log)(partes.join(' · '));
}

/**
 * Hace la llamada con el proveedor de la funcion y deja el registro. `p` lleva
 * { prompt, adjunto?, razonamiento?, maxTokens, timeoutMs, presupuestoMs?, onTexto? }.
 */
async function llamar(funcion, p, { stream, temperatura }) {
  const prov = proveedor(funcion);
  const etiqueta = FUNCIONES[funcion];
  const tiempo = { timeoutMs: p.timeoutMs, presupuestoMs: p.presupuestoMs, etiqueta };
  const t0 = Date.now();
  let r = {};
  try {
    if (prov === 'claude') {
      const params = paramsClaude(funcion, p, stream);
      r = stream
        ? await claudeClient.pedirStream(params, { ...tiempo, onTexto: p.onTexto })
        : await claudeClient.pedir(params, tiempo);
    } else if (stream) {
      r = { texto: await geminiClient.pedirStream(cuerpoGemini(p, temperatura), { ...tiempo, onTexto: p.onTexto }) };
    } else {
      const resp = await geminiClient.pedir(cuerpoGemini(p, temperatura), tiempo);
      r = {
        texto:   resp.candidates?.[0]?.content?.parts?.[0]?.text || '',
        modelo:  resp.modelVersion,
        entrada: resp.usageMetadata?.promptTokenCount,
        salida:  resp.usageMetadata?.candidatesTokenCount,
        stop:    resp.candidates?.[0]?.finishReason,
      };
    }
    registrar(funcion, prov, t0, r);
    return r.texto;
  } catch (e) {
    registrar(funcion, prov, t0, r, e);
    throw e;
  }
}

/**
 * Prompt de texto → texto. Para homologacion, busqueda de precios, clausulas e
 * inventario. Opciones: { timeoutMs, presupuestoMs, razonamiento, maxTokens }.
 */
async function texto(funcion, prompt, { timeoutMs = 5000, presupuestoMs, razonamiento, maxTokens = 4096 } = {}) {
  const r = await llamar(funcion, { prompt, timeoutMs, presupuestoMs, razonamiento, maxTokens }, { stream: false, temperatura: 0.3 });
  return r.trim();
}

/**
 * Documento (adjunto en base64, o ya convertido a texto dentro del prompt) → texto
 * de la respuesta, que el llamador parsea. Con `onTexto` va en streaming y recibe el
 * texto acumulado a medida que llega.
 * Opciones: { prompt, adjunto: { mimeType, base64 }, onTexto, timeoutMs,
 * presupuestoMs, razonamiento, maxTokens }.
 */
async function extraer(funcion, { onTexto, stream = !!onTexto, ...p }) {
  return llamar(funcion, { ...p, onTexto }, { stream, temperatura: 0 });
}

/**
 * Al arrancar: dice en el log que proveedor usa cada funcion y, si alguna sigue en
 * Gemini, carga la lista de modelos de Google. No bloquea el arranque y nunca lanza.
 */
async function iniciar() {
  const resumen = [];
  let algunaGemini = false;
  for (const funcion of Object.keys(FUNCIONES)) {
    let prov;
    try { prov = proveedor(funcion); }
    catch (e) { console.warn(`[ia] ${e.message}`); continue; }
    if (prov === 'gemini') algunaGemini = true;
    resumen.push(`${funcion}=${prov === 'claude' ? `claude (${modeloClaude(funcion)})` : 'gemini'}`);
  }
  console.log(`[ia] Proveedores: ${resumen.join(', ')}`);
  if (!algunaGemini) return;
  try { await geminiModelos.iniciar(); }
  catch (e) { console.warn('[geminiModelos] No se pudo cargar la lista:', e.message); }
}

module.exports = { texto, extraer, disponible, proveedor, iniciar, FUNCIONES };
