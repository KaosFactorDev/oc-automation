'use strict';
/**
 * tesoreriaClient.js
 * Cliente del módulo de tesorería (Cash_Flow / Pagos Diarios) para crear
 * solicitudes de pago a partir de OC aprobadas.
 *
 * Contrato: Cash_Flow/docs/integracion-oc-automation.md
 *
 * Este es el ÚNICO módulo que conoce las credenciales de tesorería. El JWT y la
 * contraseña no deben salir del servidor: el front habla con las rutas
 * /tesoreria/* de servidor-cotizaciones.js, nunca con Supabase directamente.
 *
 * Requiere en .env (si falta cualquiera, habilitado() → false y la integración
 * queda oculta en la UI en vez de dar errores):
 *   TESORERIA_URL, TESORERIA_ANON_KEY, TESORERIA_EMAIL, TESORERIA_PASSWORD
 *
 * Uso:
 *   const tes = require('./tesoreriaClient');
 *   if (tes.habilitado()) await tes.crearSolicitud({ ... });
 */

const fetch = require('node-fetch');

const MARGEN_TOKEN_MS = 60 * 1000; // renovar 1 min antes de expirar

// ── Configuración ─────────────────────────────────────────────────────────────

function cfg() {
  return {
    url:      (process.env.TESORERIA_URL || '').replace(/\/+$/, ''),
    anonKey:  process.env.TESORERIA_ANON_KEY || '',
    email:    process.env.TESORERIA_EMAIL    || '',
    password: process.env.TESORERIA_PASSWORD || '',
  };
}

/** true solo si las 4 variables están presentes. */
function habilitado() {
  const c = cfg();
  return !!(c.url && c.anonKey && c.email && c.password);
}

function exigirConfig() {
  if (!habilitado()) {
    throw new Error('Integración con tesorería no configurada (faltan TESORERIA_* en .env)');
  }
  return cfg();
}

// ── Auth: password grant + refresh, token en memoria ──────────────────────────

let _token   = null;
let _refresh = null;
let _expira  = 0;

async function login() {
  const c = exigirConfig();
  const res = await fetch(`${c.url}/auth/v1/token?grant_type=password`, {
    method:  'POST',
    headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: c.email, password: c.password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // error_description trae cosas útiles como "email_not_confirmed"
    const det = data.error_description || data.msg || data.error || `HTTP ${res.status}`;
    throw new Error(`Login en tesorería falló: ${det}`);
  }
  _token   = data.access_token;
  _refresh = data.refresh_token || null;
  _expira  = Date.now() + ((data.expires_in || 3600) * 1000) - MARGEN_TOKEN_MS;
  return _token;
}

async function refrescar() {
  const c = exigirConfig();
  if (!_refresh) return login();
  const res = await fetch(`${c.url}/auth/v1/token?grant_type=refresh_token`, {
    method:  'POST',
    headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ refresh_token: _refresh }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Refresh vencido o revocado → volver a usuario y contraseña
    _refresh = null;
    return login();
  }
  _token  = data.access_token;
  if (data.refresh_token) _refresh = data.refresh_token;
  _expira = Date.now() + ((data.expires_in || 3600) * 1000) - MARGEN_TOKEN_MS;
  return _token;
}

/** Token válido, renovándolo solo si hace falta. */
async function getToken() {
  if (_token && Date.now() < _expira) return _token;
  if (_token && _refresh) return refrescar();
  return login();
}

/** Invalida el token en memoria (tras un 401 inesperado). */
function invalidarToken() {
  _token  = null;
  _expira = 0;
}

// ── HTTP con reintento único ante 401 ─────────────────────────────────────────

/**
 * Hace la petición con Bearer. Si responde 401 (token expirado o revocado antes
 * de lo previsto), renueva el token y reintenta UNA vez.
 */
async function pedir(ruta, { method = 'GET', body } = {}) {
  const c = exigirConfig();

  const ejecutar = async (token) => fetch(`${c.url}${ruta}`, {
    method,
    headers: {
      apikey:         c.anonKey,
      Authorization:  `Bearer ${token}`,
      Accept:         'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let res = await ejecutar(await getToken());
  if (res.status === 401) {
    invalidarToken();
    res = await ejecutar(await getToken());
  }
  return res;
}

// ── Comprobar el login ────────────────────────────────────────────────────────
//
// Antes esto era §2, la lista de proyectos de tesorería para el desplegable.
// Cash_Flow ya no tiene catálogo propio: el proyecto_id que espera es el UUID de
// KAOS, y el desplegable sale del espejo local (repo/proyectosKaos.paraTesoreria).

/** Inicia sesión en tesorería. Lanza si las credenciales no sirven. */
async function probarLogin() {
  await getToken();
  return true;
}

// ── §1 Crear la solicitud ─────────────────────────────────────────────────────

/**
 * Crea la solicitud de pago. Idempotente por `orden_compra`: reintentar es
 * seguro y devuelve la solicitud existente con duplicado: true.
 *
 * El NIT se manda tal como está en la OC — la Edge Function lo normaliza
 * (quita puntos/espacios y descarta el dígito de verificación).
 *
 * @param {object} payload {proyecto_id, nombre, nit, concepto, total, orden_compra, solicitado_por}
 * @returns {Promise<{id, egreso_id, estado, duplicado, mes?, orden_compra?}>}
 * @throws {Error} con .status y, en 422, .detalles
 */
/**
 * Tesorería es producción incluso desde desarrollo: una solicitud de pago creada
 * o retirada al probar es real. Con MODO_PRUEBA solo se habla con un Cash_Flow
 * LOCAL (localhost), que es como se prueba la integración.
 */
function exigirNoProduccionEnPrueba(que) {
  const prueba = require('./modoPrueba');
  if (!prueba.activo) return;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cfg().url);
  if (local) return;
  console.log(`[MODO_PRUEBA] ${que} NO enviado a tesorería`);
  const err = new Error('MODO_PRUEBA activo: no se envían cambios a tesorería.');
  err.status = 503;
  throw err;
}

async function crearSolicitud(payload) {
  exigirNoProduccionEnPrueba(`solicitud de ${payload?.orden_compra || 'sin OC'}`);
  const res  = await pedir('/functions/v1/solicitudes-externas', { method: 'POST', body: payload });
  const data = await res.json().catch(() => ({}));

  // 201 = creada, 200 = ya existía. Las dos son éxito, no reintentar el 200.
  if (res.status === 201 || res.status === 200) {
    return { duplicado: false, ...data };
  }

  const err = new Error(data.error || `Tesorería respondió HTTP ${res.status}`);
  err.status = res.status;
  if (Array.isArray(data.detalles)) err.detalles = data.detalles;
  throw err;
}

// ── §3 Saber si una OC ya se envió (best-effort) ───────────────────────────────

/**
 * Consulta en lote qué OC ya tienen solicitud. Best-effort por diseño: si algo
 * falla devuelve {} y no rompe nada — la protección real contra duplicados es
 * el unique en la base de datos de tesorería.
 *
 * @param {string[]} numerosOC
 * @returns {Promise<Object<string, {egreso_id: string, estado: string}>>}
 */
async function consultarEnviadas(numerosOC) {
  const ocs = [...new Set((numerosOC || []).map(n => String(n || '').trim()).filter(Boolean))];
  if (!ocs.length || !habilitado()) return {};

  try {
    const lista = ocs.map(oc => `"${oc}"`).join(',');
    const res = await pedir(
      '/rest/v1/solicitudes_pago?select=orden_compra,egreso_id,estado' +
      '&origen_externo=eq.oc-automation' +
      `&orden_compra=in.(${encodeURIComponent(lista)})`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const filas = await res.json();
    const mapa = {};
    for (const f of Array.isArray(filas) ? filas : []) {
      if (f.orden_compra) mapa[f.orden_compra] = { egreso_id: f.egreso_id, estado: f.estado };
    }
    return mapa;
  } catch (e) {
    console.warn('[tesoreria] No se pudo consultar solicitudes existentes:', e.message);
    return {};
  }
}

// ── §4 Una sola solicitud, actualizarla y retirarla ───────────────────────────
//
// Las usan corregir, anular y la papelera de una OC ya enviada. A diferencia de
// consultarEnviadas, estas NO son best-effort: si tesorería no responde, lanzan,
// y quien llama bloquea el cambio en vez de dejar una solicitud con datos viejos.

/**
 * El estado vivo de la solicitud de una OC, o null si no tiene.
 * @returns {Promise<{egreso_id, estado, retirada: boolean}|null>}
 */
async function solicitudDe(numeroOC) {
  const oc = String(numeroOC || '').trim();
  if (!oc) return null;
  const res = await pedir(
    '/rest/v1/solicitudes_pago?select=orden_compra,egreso_id,estado,retirada_en' +
    `&origen_externo=eq.oc-automation&orden_compra=eq.${encodeURIComponent(oc)}`);
  if (!res.ok) {
    const err = new Error(`Tesorería respondió HTTP ${res.status} al consultar ${oc}`);
    err.status = 502;
    throw err;
  }
  const [f] = await res.json();
  return f ? { egreso_id: f.egreso_id, estado: f.estado, retirada: !!f.retirada_en } : null;
}

async function operacion(method, body, que) {
  exigirNoProduccionEnPrueba(que);
  const res  = await pedir('/functions/v1/solicitudes-externas', { method, body });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const err = new Error(data.error || `Tesorería respondió HTTP ${res.status}`);
  err.status = res.status;
  if (Array.isArray(data.detalles)) err.detalles = data.detalles;
  throw err;
}

/**
 * Actualiza una solicitud no pagada (total, NIT, proveedor, proyecto). Si estaba
 * aprobada, vuelve a SOLICITUD y tesorería la aprueba otra vez.
 * @throws {Error} .status 409 si ya está pagada o retirada
 */
function actualizarSolicitud(payload) {
  return operacion('PATCH', payload, `actualización de ${payload?.orden_compra}`);
}

/**
 * Retira la solicitud (queda RECHAZADA con el motivo). Reenviar la OC después la
 * reactiva: la misma solicitud, con su mismo egreso_id.
 * @throws {Error} .status 409 si ya está pagada
 */
function retirarSolicitud({ orden_compra, motivo, solicitado_por }) {
  return operacion('POST', { accion: 'retirar', orden_compra, motivo, solicitado_por },
    `retiro de ${orden_compra}`);
}

module.exports = {
  solicitudDe, actualizarSolicitud, retirarSolicitud,
  habilitado,
  probarLogin,
  crearSolicitud,
  consultarEnviadas,
};
