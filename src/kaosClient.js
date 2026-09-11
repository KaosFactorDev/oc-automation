'use strict';
/**
 * kaosClient.js — Cliente de la API de integración de KAOS.
 *
 * Contrato: kaos-webapp/docs/kaos-api.md
 *
 * KAOS es el dueño del catálogo de proyectos; el ERP solo lo consume. Este es
 * el ÚNICO módulo que conoce la clave de integración: el resto del ERP pide
 * proyectos a `src/repo/`, que lee del espejo local, no de la red.
 *
 * Requiere en .env (si falta alguna, habilitado() → false y la sincronización
 * se salta con un aviso, en vez de romper el arranque):
 *   KAOS_API_URL   https://<ref>.supabase.co/functions/v1/kaos-api
 *   KAOS_API_KEY   kaos_...
 *
 * SIN prefijo VITE_ ni NEXT_PUBLIC_: cualquiera de esos mandaría la clave al
 * navegador, donde es pública. Esta API se llama servidor a servidor.
 *
 * Uso:
 *   const kaos = require('./kaosClient');
 *   if (kaos.habilitado()) {
 *     const proyectos = await kaos.listarProyectos({ desde: ultimaMarca });
 *   }
 */

const fetch = require('node-fetch');

// El máximo que admite la API. Con ~40 proyectos hoy cabe todo en una página,
// pero el bucle pagina igual: el catálogo crece y un límite que "por ahora
// alcanza" es el que se descubre tarde y en silencio.
const PAGINA = 200;

const TIMEOUT_MS = 30 * 1000;

// Un 503 es "la base de KAOS falló, reintentá". Cualquier 4xx no se arregla
// repitiéndolo, así que no se reintenta: ver §7 del contrato.
const REINTENTOS = 3;

function cfg() {
  return {
    url: (process.env.KAOS_API_URL || '').replace(/\/+$/, ''),
    key: process.env.KAOS_API_KEY || '',
  };
}

/** true solo si las dos variables están presentes. */
function habilitado() {
  const c = cfg();
  return !!(c.url && c.key);
}

function exigirConfig() {
  if (!habilitado()) {
    throw new Error(
      'Falta KAOS_API_URL o KAOS_API_KEY en el .env. La URL es ' +
      'https://<project-ref>.supabase.co/functions/v1/kaos-api y la clave se emite ' +
      'en ese mismo proyecto con mint_integration_api_key(); una clave de otro ' +
      'proyecto da 401.',
    );
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Una petición GET a la API, con reintento solo donde tiene sentido.
 *
 * El contrato pide programar contra `error` y no contra `message`: los textos
 * pueden cambiar, los códigos no.
 */
async function pedir(ruta, params = {}) {
  exigirConfig();
  const { url, key } = cfg();

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const destino = `${url}${ruta}${qs.toString() ? `?${qs}` : ''}`;

  let ultimoError;
  for (let intento = 1; intento <= REINTENTOS; intento++) {
    let res;
    try {
      res = await fetch(destino, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: TIMEOUT_MS,
      });
    } catch (err) {
      // Fallo de red: sí se reintenta.
      ultimoError = new Error(`kaos-api inalcanzable: ${err.message}`);
      if (intento < REINTENTOS) { await dormir(intento * 1000); continue; }
      throw ultimoError;
    }

    if (res.ok) return res.json();

    const cuerpo = await res.json().catch(() => ({}));

    // Un 404 con `code` en vez de `error` no viene de la API: es el gateway de
    // Supabase diciendo que la función no está desplegada en ese proyecto. Es
    // un error de configuración y conviene que lo diga, porque el síntoma
    // —"404"— se confunde con un recurso inexistente.
    if (res.status === 404 && cuerpo.code) {
      throw new Error(
        `kaos-api no está desplegada en ${url}. Revisá KAOS_API_URL, o el ` +
        'despliegue de ese tenant en GitHub Actions.',
      );
    }

    if (res.status === 503 && intento < REINTENTOS) {
      await dormir(intento * 1000);
      continue;
    }

    const pista = {
      missing_key: 'no se envió la cabecera Authorization',
      invalid_key: 'la clave no existe EN ESE PROYECTO, está revocada o venció',
      insufficient_scope: 'la clave existe pero no tiene el alcance projects:read',
    }[cuerpo.error];

    throw new Error(
      `kaos-api ${res.status} ${cuerpo.error || 'error'}` +
      (pista ? ` — ${pista}` : '') +
      (cuerpo.message ? `: ${cuerpo.message}` : ''),
    );
  }
  throw ultimoError;
}

/**
 * Todos los proyectos, paginando hasta agotarlos.
 *
 * @param {string} [opts.desde]  ISO 8601. Solo lo modificado DESPUÉS de esa
 *   marca. El filtro es estricto (`>`), así que guardar el `updated_at` más
 *   alto procesado y volver a pedir desde ahí no repite la última fila.
 * @param {string} [opts.estado]  Filtra por estado exacto. La comparación es
 *   literal y sensible a mayúsculas: 'Activo' no es 'activo'.
 *
 * OJO con los borrados: la API no los emite. Un proyecto borrado en KAOS
 * simplemente deja de aparecer, así que un incremental nunca se entera. Por eso
 * la reconciliación completa —sin `desde`— es la que puede marcar bajas.
 */
async function listarProyectos({ desde = null, estado = null } = {}) {
  const out = [];
  let offset = 0;

  for (;;) {
    const pagina = await pedir('/projects', {
      limit: PAGINA,
      offset,
      updated_since: desde,
      estado,
    });

    const filas = pagina.data || [];
    out.push(...filas);
    offset += filas.length;

    // Corta por `count` Y por página vacía: si `data` viene vacío, seguir
    // avanzando el offset sería un bucle infinito.
    if (out.length >= (pagina.count || 0) || filas.length === 0) return out;
  }
}

module.exports = { habilitado, listarProyectos };
