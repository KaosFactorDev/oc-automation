'use strict';
/**
 * configApp.js
 * Lectura/escritura de configuración persistente en erp.configuracion (Postgres).
 * Claves soportadas:
 *   - logo        : data-URL (image/png;base64,...) del logo de la OC
 *   - emisor      : JSON con { razonSocial, nit, direccion, ciudad, telefono, correo, web }
 *   - firmante    : JSON con { nombre, cargo }
 *   - observacionesDefault : texto con observaciones por defecto (antes condicionesDefault)
 *
 * Esquema de la fila: { clave, valor, descripcion }
 *   - valor guarda string plano (ej. el data-url del logo) o JSON.stringify(obj)
 *
 * El acceso a la base vive en repo/configuracion.js; acá solo quedan los
 * valores por defecto, el ensamblado y el caché.
 */

const repoConfig = require('./repo/configuracion');

const EMISOR_DEFAULT = {
  razonSocial: 'CIVILTECH INGENIERÍA Y CONSTRUCCIÓN S.A.S.',
  nit:         '900.807.426-3',
  direccion:   'Cra 52A No 123-50',
  ciudad:      'Bogotá D.C., Colombia',
  telefono:    '',
  correo:      '',
  web:         '',
};
const FIRMANTE_DEFAULT = {
  nombre: 'ING. BRAYAN ALEXANDER OSPINA VASQUEZ',
  cargo:  'COORDINADOR DE PROYECTOS',
};
const CONDICIONES_DEFAULT = 'Documento No: CT-ADMIN-FO-006. ' +
  'Al recibir esta orden el proveedor acepta los términos comerciales aquí descritos.';
const IVA_DEFAULT = 19;

let _cfgCache = null;
let _cfgCacheAt = 0;
const CFG_TTL_MS = 5 * 60 * 1000;

/**
 * El valor puede ser JSON serializado (emisor, firmante) o texto plano (el
 * logo es un data-URL). Se intenta parsear y, si no es JSON, se devuelve
 * crudo — el mismo contrato que había con la columna valorJson de SharePoint.
 */
function interpretar(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function get(clave, fallback = null) {
  try {
    return interpretar(await repoConfig.obtener(clave), fallback);
  } catch {
    // Igual que antes: si la lectura falla, la aplicación sigue con el valor
    // por defecto en vez de romper la pantalla.
    return fallback;
  }
}

async function set(clave, valor, descripcion = '') {
  _cfgCache = null; // invalidar cache al guardar
  const str = typeof valor === 'string' ? valor : JSON.stringify(valor);
  return repoConfig.guardar(clave, str, descripcion);
}

async function getConfig() {
  if (_cfgCache && Date.now() - _cfgCacheAt < CFG_TTL_MS) return _cfgCache;

  // Una sola consulta para las seis claves. Contra SharePoint esto eran seis
  // viajes de red, uno por clave, porque no había forma de pedirlas juntas.
  let valores = new Map();
  try {
    valores = await repoConfig.obtenerVarias([
      'logo', 'emisor', 'firmante', 'observacionesDefault', 'condicionesDefault', 'ivaDefault',
    ]);
  } catch (e) {
    console.warn('[configApp] No se pudo leer la configuración, se usan los valores por defecto:', e.message);
  }

  const logo          = interpretar(valores.get('logo'), null);
  const emisor        = interpretar(valores.get('emisor'), EMISOR_DEFAULT);
  const firmante      = interpretar(valores.get('firmante'), FIRMANTE_DEFAULT);
  const observaciones = interpretar(valores.get('observacionesDefault'), null);
  // Clave legacy: sirve de respaldo mientras haya instalaciones que aún no
  // guardaron con el nombre nuevo.
  const observacionesLegacy = interpretar(valores.get('condicionesDefault'), null);
  const ivaDef        = interpretar(valores.get('ivaDefault'), IVA_DEFAULT);

  const iva = Number(ivaDef);
  _cfgCache = {
    logo: logo || null,
    emisor:   { ...EMISOR_DEFAULT,   ...(emisor   || {}) },
    firmante: { ...FIRMANTE_DEFAULT, ...(firmante || {}) },
    observacionesDefault: observaciones || observacionesLegacy || CONDICIONES_DEFAULT,
    ivaDefault: Number.isFinite(iva) ? iva : IVA_DEFAULT,
  };
  _cfgCacheAt = Date.now();
  return _cfgCache;
}

module.exports = {
  get, set, getConfig,
  EMISOR_DEFAULT, FIRMANTE_DEFAULT, CONDICIONES_DEFAULT, IVA_DEFAULT,
};
