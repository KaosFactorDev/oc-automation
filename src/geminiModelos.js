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
 *    embeddings. Los flash van primero, del más nuevo al más viejo; los lite al final.
 *  · Desde la versión 3: los cuerpos que arma el ERP usan thinkingConfig.thinkingLevel,
 *    que la línea 2.x no entiende (y Google ya la retiró para keys nuevas: 404 «no
 *    longer available to new users», 22-09-2026).
 *  · Un modelo que falla queda castigado un rato: pasa al final de la fila y las
 *    peticiones siguientes arrancan directo con uno sano. Si responde, se perdona.
 *  · La última lista buena se guarda en temp/, para arrancar aunque Google no
 *    conteste ListModels en ese momento.
 *
 * El estado vive en memoria de cada proceso (servidor web y lector de correos): cada
 * uno aprende de sus propios fallos.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const VIGENCIA_MS   = 30 * 60 * 1000;
const VERSION_MINIMA = 3;
// Cuántos modelos se prueban como mucho en una petición. Más no ayuda: si cuatro
// modelos distintos fallan a la vez, el problema no es el modelo.
const MAX_CANDIDATOS = 4;
const RESPALDO = path.join(__dirname, '../temp', 'gemini-modelos.json');

// Cuánto queda castigado un modelo según cómo falló.
const CASTIGO_MS = {
  retirado:  24 * 60 * 60 * 1000, // 404: Google lo quitó
  rechazo:   24 * 60 * 60 * 1000, // 400: no acepta lo que le mandamos
  cuota:     15 * 60 * 1000,      // 429: cupo agotado (por minuto o del día)
  saturado:  10 * 60 * 1000,      // 503 / 5xx / red, tras los reintentos
  lento:     10 * 60 * 1000,      // timeout
};

let catalogo   = [];   // nombres, ya ordenados
let cargadoEn  = 0;   // cuándo toca releer (se adelanta si la lectura falló)
let leidoEn    = 0;   // última lectura buena de Google
let cargando   = null;
const castigos = new Map();   // modelo -> { hasta, motivo }

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

function leerRespaldo() {
  try {
    const lista = JSON.parse(fs.readFileSync(RESPALDO, 'utf-8')).modelos;
    return Array.isArray(lista) ? lista.filter(n => versionDe(n)) : [];
  } catch { return []; }
}

function guardarRespaldo(lista) {
  try {
    fs.mkdirSync(path.dirname(RESPALDO), { recursive: true });
    fs.writeFileSync(RESPALDO, JSON.stringify({ actualizado: new Date().toISOString(), modelos: lista }, null, 2));
  } catch (e) {
    console.warn(`[geminiModelos] No se pudo guardar la lista en ${RESPALDO}: ${e.message}`);
  }
}

/**
 * Refresca el catálogo. Nunca lanza: si Google no contesta, se sigue con la última
 * lista conocida (en memoria o en temp/).
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
      guardarRespaldo(lista);
    } catch (e) {
      if (!catalogo.length) catalogo = leerRespaldo();
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

function castigado(modelo, ahora = Date.now()) {
  const c = castigos.get(modelo);
  if (c && c.hasta <= ahora) { castigos.delete(modelo); return null; }
  return c || null;
}

/**
 * Los modelos a probar para UNA petición, en orden: primero los sanos (más nuevo
 * primero), después los castigados (el que antes se libera primero). Un castigado no
 * se descarta: si todos fallaron hace poco, igual vale la pena intentarlo.
 */
async function candidatos() {
  const vencido = Date.now() - cargadoEn >= VIGENCIA_MS;
  if (!catalogo.length) await refrescar();
  else if (vencido) refrescar();   // en segundo plano: no se hace esperar a nadie

  if (!catalogo.length) {
    throw new Error('Gemini: no se pudo obtener la lista de modelos de Google y no hay una guardada. Revisa GEMINI_API_KEY y la conexión del servidor.');
  }
  const ahora  = Date.now();
  const sanos  = catalogo.filter(m => !castigado(m, ahora));
  const malos  = catalogo.filter(m => castigado(m, ahora)).sort((a, b) => castigos.get(a).hasta - castigos.get(b).hasta);
  return [...sanos, ...malos].slice(0, MAX_CANDIDATOS);
}

/** Registra un fallo. `motivo` es una clave de CASTIGO_MS. */
function fallo(modelo, motivo) {
  const ms = CASTIGO_MS[motivo] || CASTIGO_MS.saturado;
  castigos.set(modelo, { hasta: Date.now() + ms, motivo });
  // Un 404 casi siempre significa que Google cambió el catálogo: se relee ya.
  if (motivo === 'retirado') refrescar();
}

function exito(modelo) {
  castigos.delete(modelo);
}

/** Para el log y para diagnosticar: el catálogo y quién está castigado. */
function estado() {
  const ahora = Date.now();
  return {
    leidoDeGoogle: leidoEn ? new Date(leidoEn).toISOString() : null,
    modelos: catalogo.map(m => {
      const c = castigado(m, ahora);
      return c ? { modelo: m, castigado: c.motivo, hasta: new Date(c.hasta).toISOString() } : { modelo: m };
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
  if (lista.length) console.log(`[geminiModelos] Orden de uso: ${lista.slice(0, MAX_CANDIDATOS).join(' → ')}`);
  return lista;
}

module.exports = { candidatos, fallo, exito, estado, iniciar, refrescar, elegir, CASTIGO_MS };
