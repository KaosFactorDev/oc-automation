'use strict';
/**
 * geminiModelos.js
 * Qué modelos de Gemini se usan y en qué orden. La lista la da Google, no el .env.
 *
 * Por que existe este archivo
 * ---------------------------
 * Antes el modelo se elegía a mano en el .env (GEMINI_MODEL y GEMINI_MODEL_FALLBACK).
 * Cada vez que Google saturaba, retiraba o renombraba un modelo, alguien tenía que
 * entrar por SSH al VPS, cambiar el nombre y reiniciar: pasó el 25-08, el 15-09 y el
 * 22-09-2026. Y un typo en esa línea tumbaba la extracción sin avisar.
 *
 * Ahora:
 *
 *  · El catálogo se pide a ListModels, que NO consume la cuota de generateContent,
 *    al primer uso y cada 30 minutos. Un modelo que Google publique entra solo; uno
 *    que retire sale solo.
 *  · Se queda con los «gemini-X.Y-flash» y «gemini-X.Y-flash-lite» estables que
 *    soportan generateContent: nada de preview, exp, latest, imagen, voz ni
 *    embeddings. Los flash van del más nuevo al más viejo; los lite al final.
 *  · Desde la versión 3: los cuerpos que arma el ERP usan thinkingConfig.thinkingLevel,
 *    que la línea 2.x no entiende (y Google ya la retiró para keys nuevas: 404 «no
 *    longer available to new users», 22-09-2026).
 *
 * El orden
 * --------
 * Va primero el modelo MÁS NUEVO QUE YA RESPONDIÓ BIEN aquí; detrás, el resto por
 * versión. Un modelo recién publicado no arranca de primero: entra de segundo, como
 * respaldo, y sube al frente la primera vez que responde bien. Es lo que faltó el
 * 25-08-2026, cuando Google movió el alias al modelo nuevo y la extracción se cayó.
 * Sin ningún modelo probado (primer arranque), el orden es solo por versión.
 *
 * Encima de eso, un modelo que falla —o que responde pero tarda más de la mitad
 * de su timeout— queda castigado un rato al final de la fila, y las peticiones
 * siguientes arrancan con uno sano. Si vuelve a responder bien, se perdona.
 *
 * Qué se guarda
 * -------------
 * En data/gemini-modelos.json —volumen que sobrevive a los deploys y comparten el
 * servidor web y el lector de correos— la última lista buena (para arrancar aunque
 * Google no conteste ListModels) y qué modelos ya respondieron bien. Los castigos
 * viven en memoria de cada proceso: duran minutos y no vale la pena compartirlos.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const VIGENCIA_MS    = 30 * 60 * 1000;
const VERSION_MINIMA = 3;
// Cuántos modelos se prueban como mucho en una petición. Más no ayuda: si cuatro
// modelos distintos fallan a la vez, el problema no es el modelo.
const MAX_CANDIDATOS = 4;
// Una respuesta que se come más de esta fracción de su timeout cuenta como lenta.
const FRACCION_LENTA = 0.5;
const ARCHIVO = process.env.GEMINI_MODELOS_PATH || path.join(__dirname, '../data', 'gemini-modelos.json');

// Cuánto queda castigado un modelo según cómo falló.
const CASTIGO_MS = {
  retirado:  24 * 60 * 60 * 1000, // 404: Google lo quitó
  rechazo:   24 * 60 * 60 * 1000, // 400: no acepta lo que le mandamos
  cuota:     15 * 60 * 1000,      // 429: cupo agotado (por minuto o del día)
  saturado:  10 * 60 * 1000,      // 503 / 5xx / red, tras los reintentos
  lento:     10 * 60 * 1000,      // timeout, o respuesta que casi lo alcanza
};

let catalogo   = [];   // nombres, ordenados por versión
let cargadoEn  = 0;    // cuándo toca releer (se adelanta si la lectura falló)
let leidoEn    = 0;    // última lectura buena de Google
let cargando   = null;
let probados   = null; // modelo -> ISO de la última respuesta buena (se carga del archivo)
const castigos = new Map();   // modelo -> { hasta, motivo }
const guardadoEn = new Map(); // modelo -> ms de la última escritura de su respuesta buena

const clave = () => process.env.GEMINI_API_KEY || '';

// «gemini-3.8-flash» -> { mayor: 3, menor: 8, lite: false }
function versionDe(nombre) {
  const m = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/.exec(nombre);
  if (!m) return null;
  return { mayor: Number(m[1]), menor: Number(m[2] || 0), lite: Boolean(m[3]) };
}

/** Filtra y ordena la respuesta cruda de ListModels. Pura: se puede probar sin red. */
function elegir(modelos) {
  return modelos
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .map(nombre => ({ nombre, v: versionDe(nombre) }))
    .filter(x => x.v && x.v.mayor >= VERSION_MINIMA)
    .sort((a, b) => (a.v.lite - b.v.lite) || (b.v.mayor - a.v.mayor) || (b.v.menor - a.v.menor))
    .map(x => x.nombre)
    .filter((n, i, arr) => arr.indexOf(n) === i);
}

/**
 * El orden de una petición. Pura: se puede probar sin red.
 *   lista      nombres por versión (salida de elegir)
 *   conocidos  Map/Set de los que ya respondieron bien
 *   penas      Map modelo -> { hasta }
 */
function ordenar(lista, conocidos, penas, ahora = Date.now()) {
  const penado = m => (penas.get(m)?.hasta || 0) > ahora;
  const sanos  = lista.filter(m => !penado(m));
  const malos  = lista.filter(penado).sort((a, b) => penas.get(a).hasta - penas.get(b).hasta);
  const lider  = sanos.find(m => conocidos.has(m));
  const fila   = lider ? [lider, ...sanos.filter(m => m !== lider)] : sanos;
  return [...fila, ...malos];
}

// ── Archivo ─────────────────────────────────────────────────────────────────

function leerArchivo() {
  try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf-8')) || {}; }
  catch { return {}; }
}

/** Mezcla `cambios` en el archivo. Relee antes para no pisar lo que escribió el otro proceso. */
function escribirArchivo(cambios) {
  try {
    const actual = leerArchivo();
    const nuevo  = { ...actual, ...cambios, probados: { ...(actual.probados || {}), ...(cambios.probados || {}) } };
    fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
    const tmp = `${ARCHIVO}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nuevo, null, 2));
    fs.renameSync(tmp, ARCHIVO);
  } catch (e) {
    console.warn(`[geminiModelos] No se pudo guardar ${ARCHIVO}: ${e.message}`);
  }
}

function cargarProbados() {
  if (probados) return probados;
  const guardados = leerArchivo().probados;
  probados = new Map(Object.entries(guardados && typeof guardados === 'object' ? guardados : {}));
  return probados;
}

// ── Catálogo de Google ──────────────────────────────────────────────────────

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const trozos = [];
      res.on('data', c => trozos.push(c));
      res.on('end', () => {
        try {
          const cuerpo = JSON.parse(Buffer.concat(trozos).toString());
          if (cuerpo.error) return reject(new Error(`HTTP ${cuerpo.error.code}: ${cuerpo.error.message}`));
          resolve(cuerpo);
        } catch (e) { reject(new Error(`respuesta ilegible (HTTP ${res.statusCode})`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout tras ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
  });
}

async function pedirCatalogo() {
  const todos = [];
  let token = '';
  // ListModels pagina; con pageSize alto suele venir en una sola página.
  for (let pagina = 0; pagina < 10; pagina++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models'
      + `?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}&key=${clave()}`;
    const cuerpo = await getJson(url, 8000);
    todos.push(...(cuerpo.models || []));
    token = cuerpo.nextPageToken;
    if (!token) break;
  }
  return elegir(todos);
}

/**
 * Refresca el catálogo. Nunca lanza: si Google no contesta, se sigue con la última
 * lista conocida (en memoria o en el archivo).
 */
async function refrescar() {
  if (cargando) return cargando;
  cargando = (async () => {
    try {
      if (!clave()) throw new Error('GEMINI_API_KEY no configurada');
      const lista = await pedirCatalogo();
      if (!lista.length) throw new Error('Google no devolvió ningún modelo flash ≥ 3 con generateContent');
      if (lista.join() !== catalogo.join()) {
        console.log(`[geminiModelos] Modelos disponibles: ${lista.join(', ')}`);
      }
      catalogo  = lista;
      cargadoEn = leidoEn = Date.now();
      escribirArchivo({ actualizado: new Date().toISOString(), modelos: lista });
    } catch (e) {
      if (!catalogo.length) {
        const guardada = leerArchivo().modelos;
        catalogo = Array.isArray(guardada) ? guardada.filter(n => versionDe(n)) : [];
      }
      // Se reintenta en 5 minutos, no en 30: la lista es lo que permite cambiar de modelo.
      cargadoEn = Date.now() - VIGENCIA_MS + 5 * 60 * 1000;
      console.warn(`[geminiModelos] No se pudo leer la lista de modelos de Google (${e.message}). `
        + (catalogo.length ? `Se sigue con la última conocida: ${catalogo.join(', ')}` : 'No hay lista guardada.'));
    } finally {
      cargando = null;
    }
    return catalogo;
  })();
  return cargando;
}

// ── Lo que usa geminiClient ─────────────────────────────────────────────────

/**
 * Los modelos a probar para UNA petición, en orden (ver «El orden» arriba). Un
 * castigado no se descarta: si todos fallaron hace poco, igual vale la pena
 * intentarlo.
 */
async function candidatos() {
  const vencido = Date.now() - cargadoEn >= VIGENCIA_MS;
  if (!catalogo.length) await refrescar();
  else if (vencido) refrescar();   // en segundo plano: no se hace esperar a nadie

  if (!catalogo.length) {
    throw new Error('Gemini: no se pudo obtener la lista de modelos de Google y no hay una guardada. Revisa GEMINI_API_KEY y la conexión del servidor.');
  }
  return ordenar(catalogo, cargarProbados(), castigos).slice(0, MAX_CANDIDATOS);
}

/** Registra un fallo. `motivo` es una clave de CASTIGO_MS. */
function fallo(modelo, motivo) {
  const ms = CASTIGO_MS[motivo] || CASTIGO_MS.saturado;
  castigos.set(modelo, { hasta: Date.now() + ms, motivo });
  // Un 404 casi siempre significa que Google cambió el catálogo: se relee ya.
  if (motivo === 'retirado') refrescar();
}

/**
 * Registra una respuesta buena. `ms` y `timeoutMs` son opcionales: si se pasan y la
 * respuesta tardó más de la mitad del timeout, el modelo sigue probado pero queda
 * castigado como lento. En un stream no se pasan: ahí el timeout es de silencio y
 * una respuesta larga puede durar más que él sin ser lenta.
 */
function exito(modelo, { ms, timeoutMs } = {}) {
  castigos.delete(modelo);

  const conocidos = cargarProbados();
  const nuevo = !conocidos.has(modelo);
  const ahora = new Date().toISOString();
  conocidos.set(modelo, ahora);
  // Se escribe la primera vez (es lo que cambia el orden) y después como mucho una
  // vez por hora, para no tocar el disco en cada petición.
  if (nuevo || Date.now() - (guardadoEn.get(modelo) || 0) > 60 * 60 * 1000) {
    guardadoEn.set(modelo, Date.now());
    escribirArchivo({ probados: { [modelo]: ahora } });
    if (nuevo) console.log(`[geminiModelos] "${modelo}" respondió bien por primera vez: pasa a ser elegible como principal`);
  }

  if (ms && timeoutMs && ms > timeoutMs * FRACCION_LENTA) {
    castigos.set(modelo, { hasta: Date.now() + CASTIGO_MS.lento, motivo: 'lento' });
    console.warn(`[geminiModelos] "${modelo}" respondió pero tardó ${Math.round(ms / 1000)}s de ${Math.round(timeoutMs / 1000)}s: pasa al final de la fila un rato`);
  }
}

/** Para el log y para diagnosticar: el catálogo, el orden y quién está castigado. */
function estado() {
  const ahora = Date.now();
  const conocidos = cargarProbados();
  return {
    leidoDeGoogle: leidoEn ? new Date(leidoEn).toISOString() : null,
    orden: ordenar(catalogo, conocidos, castigos, ahora).slice(0, MAX_CANDIDATOS),
    modelos: catalogo.map(m => {
      const c = castigos.get(m);
      return {
        modelo: m,
        ...(conocidos.has(m) ? { ultimaRespuestaBuena: conocidos.get(m) } : { sinProbar: true }),
        ...(c && c.hasta > ahora ? { castigado: c.motivo, hasta: new Date(c.hasta).toISOString() } : {}),
      };
    }),
  };
}

/**
 * Se llama al arrancar el servidor. Carga la lista y avisa si el .env todavía trae
 * GEMINI_MODEL / GEMINI_MODEL_FALLBACK, que ya no se usan.
 */
async function iniciar() {
  for (const v of ['GEMINI_MODEL', 'GEMINI_MODEL_FALLBACK']) {
    if (process.env[v]) console.warn(`[geminiModelos] ${v} está en el .env pero ya no se usa: el modelo se elige de la lista de Google. Se puede borrar.`);
  }
  const lista = await refrescar();
  if (lista.length) console.log(`[geminiModelos] Orden de uso: ${estado().orden.join(' → ')}`);
  return lista;
}

module.exports = { candidatos, fallo, exito, estado, iniciar, refrescar, elegir, ordenar, CASTIGO_MS };
