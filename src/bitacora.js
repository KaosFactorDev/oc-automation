'use strict';
/**
 * bitacora.js — Quién hizo qué sobre una orden, con el antes y el después.
 *
 * Cada acción sobre una orden de compra o de servicio pasa por conHistorial():
 * toma la foto completa del documento (cabecera e ítems) antes y después de la
 * acción, y deja una fila en erp.documentos_historial con la persona real.
 *
 * ── Quién ─────────────────────────────────────────────────────────────────
 * La persona es la de la SESIÓN (req._sesion.email). Antes, las acciones se
 * grababan con process.env.USUARIO_EMAIL, que es la misma cuenta del servidor para
 * todos: el registro decía «sistema» o un único correo, hiciera quien hiciera la
 * acción. quien() existe para que ese error no se repita ruta por ruta.
 *
 * ── Si la bitácora falla ──────────────────────────────────────────────────
 * La acción ya ocurrió; no se deshace porque no se pudo anotar. Se registra el
 * fallo en el log de errores con todo lo necesario para reconstruir la fila.
 */

const repoHistorial = require('./repo/historial');
const repoOrdenesCompra = require('./repo/ordenesCompra');
const repoOrdenesServicio = require('./repo/ordenesServicio');

/** La persona que hace la acción. Sin sesión (procesos internos) queda 'sistema'. */
function quien(req) {
  const s = req && req._sesion;
  if (s && s.email) return { usuario: String(s.email).trim().toLowerCase(), nombre: s.nombre || null, origen: 'consola' };
  return { usuario: 'sistema', nombre: null, origen: 'sistema' };
}

// Lo que se excluye de la foto: identificadores técnicos que no son el documento.
const FUERA_DE_LA_FOTO = ['sp_id', 'itemsJson'];

/** La foto completa del documento, con los ítems como lista. null si no existe. */
async function foto(tipo, id) {
  const doc = tipo === 'orden_compra'
    ? await repoOrdenesCompra.obtener(id)
    : await repoOrdenesServicio.obtener(id);
  if (!doc) return null;
  let items = [];
  try { items = JSON.parse(doc.itemsJson || '[]'); } catch {}
  const f = { ...doc, items };
  for (const k of FUERA_DE_LA_FOTO) delete f[k];
  return f;
}

const numeroDe = (tipo, f) => (f ? (tipo === 'orden_compra' ? f.numeroOC : f.numeroOS) : '') || null;

/** Escribe la fila. Nunca lanza: la acción ya ocurrió. */
async function anotar(e) {
  try {
    await repoHistorial.registrar(e);
  } catch (err) {
    console.error('[bitácora] No se pudo registrar:', err.message,
      JSON.stringify({ tipo: e.tipo, id: e.id, accion: e.accion, usuario: e.usuario }));
  }
}

/**
 * Ejecuta `fn` y deja la fila con el antes y el después.
 *
 * @param {object} o
 * @param {'orden_compra'|'orden_servicio'} o.tipo
 * @param {string} o.id        id del documento. Para una creación, null: el id sale
 *                             de lo que devuelva fn (ver o.idDe).
 * @param {string} o.accion
 * @param {object} o.req       para saber quién (o o.quien, si no hay petición)
 * @param {string} [o.motivo]
 * @param {Function} [o.idDe]  extrae el id del resultado de fn (creaciones)
 */
async function conHistorial(o, fn) {
  const q = o.quien || quien(o.req);
  const antes = o.id ? await foto(o.tipo, o.id) : null;
  const resultado = await fn();
  const id = o.id || (o.idDe ? o.idDe(resultado) : null);
  if (id) {
    const despues = await foto(o.tipo, id).catch(() => null);
    await anotar({
      tipo: o.tipo, id, accion: o.accion,
      numero: numeroDe(o.tipo, despues || antes),
      usuario: q.usuario, usuarioNombre: q.nombre, origen: q.origen,
      motivo: o.motivo || null, antes, despues,
    });
  }
  return resultado;
}

// ── Lectura: qué cambió ─────────────────────────────────────────────────────

const ETIQUETAS = {
  estado: 'Estado', numeroOC: 'Número', numeroOS: 'Número', proyecto: 'Proyecto',
  proveedorNit: 'NIT proveedor', proveedorNombre: 'Proveedor',
  subtotal: 'Subtotal', valor: 'Valor', iva: 'IVA', total: 'Total',
  condicionesComerciales: 'Condiciones comerciales', observaciones: 'Observaciones',
  lugarEntrega: 'Lugar de entrega', fechaEntregaPrevista: 'Entrega prevista',
  tipoServicio: 'Tipo de servicio', lugarPrestacion: 'Lugar de prestación',
  tipoGasto: 'Tipo de gasto', clausulas: 'Cláusulas',
  ofertaEconomicaRef: 'Referencia de la oferta', fechaInicio: 'Inicio', fechaFin: 'Fin',
  pagado: 'Pagada', entregado: 'Entregada', cumplido: 'Cumplida',
  motivoAnulacion: 'Motivo de anulación', requerimientoId: 'Requerimiento',
  solicitudTesoreriaId: 'Solicitud de tesorería',
};

// Columnas que acompañan a otra y no dicen nada por sí solas en el resumen.
const RUIDO = new Set([
  'updatedAt', 'fechaAprobacion', 'aprobadoPor', 'fechaAnulacion', 'anuladoPor',
  'fechaPago', 'pagadoPor', 'fechaEntrega', 'entregadoPor', 'fechaCumplido', 'cumplidoPor',
  'pdfUrl', 'xlsxUrl', 'solicitudTesoreriaPor', 'fechaSolicitudTesoreria',
  'fechaCreacion', 'creadoPor', 'id', 'proyectoId', 'items',
]);

const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Los campos de cabecera que cambiaron, y un resumen de los ítems. */
function cambiosEntre(antes, despues) {
  if (!antes || !despues) return { campos: [], items: null };
  const campos = [];
  const claves = new Set([...Object.keys(antes), ...Object.keys(despues)]);
  for (const k of claves) {
    if (RUIDO.has(k) || igual(antes[k], despues[k])) continue;
    campos.push({ campo: k, etiqueta: ETIQUETAS[k] || k, antes: antes[k] ?? null, despues: despues[k] ?? null });
  }

  const ia = antes.items || [];
  const id = despues.items || [];
  const lineas = [];
  for (let i = 0; i < Math.max(ia.length, id.length); i++) {
    const a = ia[i], d = id[i];
    if (igual(a, d)) continue;
    lineas.push({ linea: i + 1, tipo: !a ? 'agregada' : !d ? 'quitada' : 'cambiada', antes: a || null, despues: d || null });
  }
  return { campos, items: lineas.length ? lineas : null };
}

/**
 * Lo que pasó ANTES de que existiera la bitácora, reconstruido de las columnas
 * *_por / fecha_* del documento. Va marcado como `previo`: el «quién» de esas
 * columnas muchas veces es la cuenta del servidor, no la persona.
 */
function eventosPrevios(tipo, doc, desde) {
  if (!doc) return [];
  const ev = [
    ['crear', doc.fechaCreacion, doc.creadoPor],
    ['aprobar', doc.fechaAprobacion, doc.aprobadoPor],
    ['anular', doc.fechaAnulacion, doc.anuladoPor, doc.motivoAnulacion],
    ['pagar', doc.fechaPago, doc.pagadoPor],
    tipo === 'orden_compra'
      ? ['entregar', doc.fechaEntrega, doc.entregadoPor]
      : ['cumplir', doc.fechaCumplido, doc.cumplidoPor],
  ];
  return ev
    .filter(([, fecha]) => fecha && (!desde || new Date(fecha) < new Date(desde)))
    .map(([accion, fecha, usuario, motivo]) => ({
      accion, fecha, usuario: usuario || 'sistema', motivo: motivo || null, previo: true,
    }));
}

/** Todo el historial de un documento, listo para la consola, de lo más viejo a lo más nuevo. */
async function historialDe(tipo, id) {
  const [filas, actual] = await Promise.all([repoHistorial.deDocumento(tipo, id), foto(tipo, id)]);
  const primera = filas.length ? filas[0].creado_en : null;
  const registrados = filas.map(f => ({
    id: String(f.id),
    accion: f.accion,
    fecha: f.creado_en,
    usuario: f.usuario,
    usuarioNombre: f.usuario_nombre,
    origen: f.origen,
    motivo: f.motivo,
    numero: f.numero,
    cambios: cambiosEntre(f.antes, f.despues),
    previo: false,
  }));
  // Un evento previo sobra si la bitácora ya registró esa acción: la orden se
  // creó (o se aprobó) estando la bitácora activa, y las columnas solo repiten
  // lo mismo con una hora un poco anterior.
  const registradas = new Set(registrados.map(e => e.accion));
  const previos = eventosPrevios(tipo, actual, primera).filter(e => !registradas.has(e.accion));
  return [...previos, ...registrados]
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
}

module.exports = { quien, foto, conHistorial, anotar, cambiosEntre, historialDe, numeroDe };
