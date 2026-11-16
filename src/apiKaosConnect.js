'use strict';
/**
 * apiKaosConnect.js — La API de lectura del ERP para KAOS Connect, bajo
 * /api/kaos-connect/* (T-255).
 *
 * KAOS Connect es el conector de Claude de KAOS: una persona de la empresa
 * pregunta en Claude y el orquestador de KAOS lee el ERP por esta API. El
 * contrato completo está en docs/contrato-api-kaos-connect.md. Lo que hay que
 * tener presente al tocar este archivo:
 *
 *  1. Quien llama es un servidor (el orquestador de KAOS) con la llave
 *     KAOS_CONNECT_API_KEY. La llave se valida en servidor-cotizaciones.js,
 *     antes de llegar acá. Sin la variable, /api/kaos-connect/* no existe (404).
 *  2. Cada llamada trae el correo de la persona en la cabecera
 *     x-kaos-connect-correo. Tiene que ser una cuenta ACTIVA de erp.usuarios,
 *     igual que para entrar a la consola; si no, 403 sin datos. En la consola
 *     cualquier cuenta activa lee todos los documentos, así que acá también.
 *  3. Solo GET. Ninguna ruta crea, modifica, aprueba ni anula nada. NO agregar
 *     escrituras: KAOS Connect es de solo lectura por decisión del líder.
 *  4. Nada bancario: los proveedores salen sin banco ni cuenta.
 *  5. El correo no va en la URL ni en el log.
 */

const repoCatalogos = require('./repo/catalogos');
const repoProyecto  = require('./repo/_proyecto');
const repo          = require('./repo/kaosConnect');

const LIMIT_DEFECTO = 50;
const LIMIT_MAXIMO  = 200;
const PREFIJO       = '/api/kaos-connect/';

const UUID  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Recurso → nombre de la lectura en repo/kaosConnect.js. Por nombre y no por
 * referencia, para que las pruebas puedan reemplazarla con t.mock.method.
 * `porProyecto: false`: el recurso no se filtra por obra.
 */
const RECURSOS = {
  'requerimientos':   { leer: 'requerimientos' },
  'ordenes-compra':   { leer: 'ordenesCompra' },
  'ordenes-servicio': { leer: 'ordenesServicio' },
  'remisiones':       { leer: 'remisiones' },
  'inventario':       { leer: 'inventario' },
  'proveedores':      { leer: 'proveedores', porProyecto: false },
};

// ── Paginación (mismo contrato que el resto de KAOS Connect) ────────────────

function codificarCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function leerCursor(valor) {
  if (valor == null || valor === '') return 0;
  if (valor.length > 200) return null;
  try {
    const o = JSON.parse(Buffer.from(valor, 'base64url').toString('utf8')).o;
    if (Number.isInteger(o) && o >= 0 && o <= 1_000_000) return o;
  } catch { /* inválido abajo */ }
  return null;
}

/** Los parámetros de la query, o los problemas encontrados. */
function leerParametros(qs, recurso) {
  const detalles = [];

  let limit = LIMIT_DEFECTO;
  if (qs.has('limit')) {
    const n = Number(qs.get('limit'));
    if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAXIMO) {
      detalles.push(`"limit" debe ser un entero entre 1 y ${LIMIT_MAXIMO}.`);
    } else {
      limit = n;
    }
  }

  const offset = leerCursor(qs.get('cursor'));
  if (offset === null) detalles.push('"cursor" no es válido.');

  const proyecto = String(qs.get('proyecto') || '').trim().toLowerCase();
  if (proyecto && !UUID.test(proyecto)) detalles.push('"proyecto" debe ser el uuid del proyecto en KAOS.');
  if (proyecto && recurso.porProyecto === false) detalles.push('Este recurso no se filtra por proyecto.');

  const estado = String(qs.get('estado') || '').trim();
  if (estado.length > 40) detalles.push('"estado" pasa de 40 caracteres.');

  const fechas = {};
  for (const campo of ['desde', 'hasta']) {
    const v = String(qs.get(campo) || '').trim();
    if (v && !FECHA.test(v)) detalles.push(`"${campo}" debe ser AAAA-MM-DD.`);
    fechas[campo] = v || null;
  }

  return { detalles, limit, offset: offset ?? 0, proyecto: proyecto || null, estado: estado || null, ...fechas };
}

async function atender(req, res, url) {
  const t0 = Date.now();
  const responder = (status, body, log = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    // Sin el correo: el log dice qué se leyó, no quién.
    console.log('[api-kaos-connect]', JSON.stringify({
      metodo: req.method, ruta: url, status, ms: Date.now() - t0, ...log,
    }));
  };

  const nombre  = url.startsWith(PREFIJO) ? url.slice(PREFIJO.length) : '';
  const recurso = Object.hasOwn(RECURSOS, nombre) ? RECURSOS[nombre] : null;
  if (!recurso) return responder(404, { error: 'not_found' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return responder(405, { error: 'method_not_allowed' });
  }

  try {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const p = leerParametros(qs, recurso);

    const correo = String(req.headers['x-kaos-connect-correo'] || '').trim().toLowerCase();
    if (!correo || correo.length > 254 || !correo.includes('@')) {
      p.detalles.unshift('Falta el correo de la persona en la cabecera "x-kaos-connect-correo".');
    }
    if (p.detalles.length) return responder(422, { error: 'payload_invalido', detalles: p.detalles });

    // La persona: cuenta activa, como para entrar a la consola.
    const usuario = await repoCatalogos.getUsuarioByEmail(correo);
    if (!usuario || !usuario.activo) {
      return responder(403, { error: 'forbidden' }, { motivo: usuario ? 'inactivo' : 'sin_cuenta' });
    }

    // El proyecto de KAOS → la obra del ERP. Si no está ligado, no hay nada que leer.
    let proyectoId = null;
    if (p.proyecto) {
      const obra = await repoProyecto.porKaosId(p.proyecto);
      if (!obra) return responder(200, { rows: [], next_cursor: null }, { filas: 0, proyecto: 'no_ligado' });
      proyectoId = obra.id;
    }

    const filas = await repo[recurso.leer]({
      proyectoId, estado: p.estado, desde: p.desde, hasta: p.hasta, limit: p.limit, offset: p.offset,
    });
    const hayMas = filas.length > p.limit;
    const rows = hayMas ? filas.slice(0, p.limit) : filas;
    return responder(200, {
      rows, next_cursor: hayMas ? codificarCursor(p.offset + p.limit) : null,
    }, { filas: rows.length });
  } catch (err) {
    console.error(`[api-kaos-connect] ${req.method} ${url}:`, err);
    return responder(500, { error: 'error_interno' });
  }
}

module.exports = { atender, codificarCursor, leerCursor, LIMIT_MAXIMO };
