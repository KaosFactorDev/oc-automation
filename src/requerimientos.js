'use strict';
/**
 * requerimientos.js
 * Lógica de requerimientos. Los correos entrantes no generan OC
 * automáticamente: crean un requerimiento en estado 'pendiente' para que
 * alguien lo gestione desde la consola.
 *
 * El acceso a datos vive en repo/requerimientos.js. Acá quedan el mapeo desde
 * lo que extrae procesarCorreo, la generación del PDF de respaldo y las
 * operaciones de negocio (gestionar, bloquear, liberar).
 *
 * API:
 *   crearDesdeCorreo(resultado, { messageId, adjuntoUrl })  → { item, duplicado, consecutivoSistema }
 *   listar(filtro?)                                          → requerimientos
 *   actualizar(id, cambios)                                  → requerimiento
 *   marcarGestionado(id, ocsGeneradas)                       → estado gestionado
 *   bloquear(id, usuario, minutos = 15)                      → soft-lock
 *   liberar(id)                                              → quita el lock
 *   regenerarPdf(id)                                         → rehace el PDF
 */

const g    = require('./graphStorage');
const repo = require('./repo/requerimientos');
const { generarHTML } = require('./requerimientoTemplate');
const { htmlAPdf }    = require('./pdfGenerator');

// El PDF de respaldo se sigue subiendo al Drive del sitio: por decisión de
// alcance, los archivos se quedan en SharePoint y solo los datos migran.
let _siteId = null;
async function siteId() {
  if (_siteId) return _siteId;
  const site = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);
  _siteId = site.id;
  return _siteId;
}

// ── Mapeo del resultado de procesarCorreo → fields del item ──────────────────

function mapearFields(resultado, { messageId = '', adjuntoUrl = '', consecutivoSistema = '' } = {}) {
  const s = resultado.solicitud || {};
  const items = (resultado.items || []).map(it => ({
    insumo:    it.insumo,
    cantidad:  it.cantidad,
    unidad:    it.unidad,
    necesidad: it.necesidad || '',
    posibleProveedor: it.posibleProveedor || '',
    consulta: it.consulta ? {
      encontrado: !!it.consulta.encontrado,
      precio:     it.consulta.precio || 0,
      proveedor:  it.consulta.proveedor || null,
      alertas:    it.consulta.alertas || [],
      sinHistorial: !!it.consulta.sinHistorial,
    } : null,
  }));

  return {
    consecutivo:         s.consecutivo || '',
    consecutivoSistema:  consecutivoSistema,
    proyecto:            s.proyecto || '',
    fechaSolicitud:      s.fechaSolicitud ? fechaISO(s.fechaSolicitud) : new Date().toISOString(),
    solicitante:         s.responsable || '',
    estado:              'pendiente',
    origenCorreoId:      messageId,
    adjuntoUrl:          adjuntoUrl,
    itemsJson:           JSON.stringify(items),
    notas:               (resultado.alertasGlobales || []).join(' | '),
    ocsGeneradas:        '',
  };
}

function fechaISO(f) {
  // Acepta "DD/MM/YYYY" o Date o ISO
  if (f instanceof Date) return f.toISOString();
  if (typeof f !== 'string') return new Date().toISOString();
  const m = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T00:00:00Z`).toISOString();
  const d = new Date(f);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Crea el requerimiento a partir de lo que extrajo procesarCorreo.
 *
 * La deduplicación ya no consulta una columna sin indexar de SharePoint —lo que
 * obligaba a mandar el header HonorNonIndexedQueriesWarningMayFailRandomly, cuyo
 * nombre anticipaba el resultado—: es un índice único sobre origen_correo_id.
 *
 * El consecutivo por proyecto se emite dentro de la misma transacción que
 * inserta el requerimiento, así que un fallo no consume un número. Antes era
 * concurrencia optimista con ETag y reintento en 412, más un contador de
 * respaldo en SQLite que terminó desalineado.
 */
async function crearDesdeCorreo(resultado, meta = {}) {
  // Los messageId manuales incluyen timestamp y son siempre únicos, así que no
  // hace falta consultarlos.
  if (meta.messageId && !meta.messageId.startsWith('manual:')) {
    const existente = await repo.porOrigenCorreo(meta.messageId);
    if (existente) return { item: existente, duplicado: true };
  }

  const fields = mapearFields(resultado, meta);
  let items = [];
  try { items = JSON.parse(fields.itemsJson || '[]'); } catch {}

  const { id, consecutivoSistema } = await repo.crear(fields, items);
  const item = await repo.obtener(id);

  // Best-effort: un fallo generando o subiendo el PDF no debe impedir que el
  // requerimiento quede registrado.
  await guardarPdf(item, resultado)
    .catch(e => console.error('  ⚠ No se pudo generar/subir el PDF del requerimiento:', e.message));

  return { item, duplicado: false, consecutivoSistema };
}

/** Genera el PDF y lo sube a /RequerimientosPDF/ del sitio. Lanza si falla. */
async function guardarPdf(item, resultado) {
  const html   = generarHTML(item, resultado.items || []);
  const buffer = await htmlAPdf(html);

  const nombre = `${item.consecutivoSistema || item.id}_${item.proyecto || 'SIN-PROYECTO'}`
    .replace(/[\/:*?"<>|]/g, '-');
  const driveItem = await g.uploadFileToSite(
    await siteId(), `/RequerimientosPDF/${nombre}.pdf`, buffer, 'application/pdf');

  await repo.actualizar(item.id, { adjuntoUrl: driveItem.webUrl });
}

/** Rehace el PDF de un requerimiento existente (backfill o reintento manual). */
async function regenerarPdf(id) {
  const item = await repo.obtener(id);
  if (!item) throw new Error(`Requerimiento ${id} no existe`);
  let items = [];
  try { items = JSON.parse(item.itemsJson || '[]'); } catch {}
  await guardarPdf(item, { items });
}

/**
 * `filtro` acepta { estado, proyectoId }. Antes era una cadena de filtro OData
 * que se pasaba tal cual a Graph; ningún llamador la usaba con valor.
 */
async function listar(filtro) {
  return repo.listar(typeof filtro === 'object' && filtro ? filtro : {});
}

async function actualizar(id, cambios) {
  return repo.actualizar(id, cambios);
}

/**
 * ocsGeneradas ya no se guarda: se deriva de ordenes_compra.requerimiento_id.
 * El parámetro se acepta para no romper a los llamadores, y se ignora.
 */
async function marcarGestionado(id, _ocsGeneradas = []) {
  return actualizar(id, { estado: 'gestionado' });
}

async function bloquear(id, usuario, minutos = 15) {
  const hasta = new Date(Date.now() + minutos * 60 * 1000).toISOString();
  return actualizar(id, { bloqueadoPor: usuario, bloqueadoHasta: hasta });
}

async function liberar(id) {
  return actualizar(id, { bloqueadoPor: null, bloqueadoHasta: null });
}

module.exports = {
  crearDesdeCorreo, listar, actualizar,
  marcarGestionado, bloquear, liberar,
  mapearFields, regenerarPdf,
  reemplazarItems: repo.reemplazarItems,
  obtener: repo.obtener,
};
