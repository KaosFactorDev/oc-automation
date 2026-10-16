'use strict';
/**
 * correcciones.js — Corregir una orden ya emitida (aprobada o finalizada).
 *
 * Solo un admin, con motivo, y todo queda en la bitácora. Lo que se corrige:
 * cabecera (observaciones, condiciones, lugar, fechas, tipo de gasto), obra,
 * proveedor, ítems, y desmarcar un pago marcado por error.
 *
 * Este módulo no escribe nada: arma el PLAN —qué cambia, qué efectos tiene y qué
 * lo impide— a partir de la orden actual y lo pedido. El servidor usa el mismo
 * plan para la vista previa (simular) y para aplicarlo, así lo que el admin
 * confirma es lo que pasa.
 *
 * ── Los efectos, y por qué cada uno ────────────────────────────────────────
 *  · ALMACÉN. Una orden entregada tiene su entrada (EA) y casi siempre su salida
 *    directa a obra (SA), por la cantidad completa. Si cambian los ítems o la
 *    obra, esos documentos se ANULAN y se emiten otros con lo corregido: nunca se
 *    reescribe un movimiento, y el viejo queda con la nota de qué lo reemplazó.
 *    Si los movimientos no cuadran con la orden (entregas parciales, cargas a
 *    mano), no se adivina: se bloquea y se corrige el almacén a mano.
 *  · REMISIÓN. Copia los ítems al generarse; si cambian, queda «requiere
 *    reemplazo», como cuando se anula una de sus órdenes.
 *  · PRECIOS. Los que la orden dejó en el historial se marcan «Corregida» y
 *    dejan de sugerirse; entran los corregidos.
 *  · TESORERÍA. Si la orden se envió a Cash_Flow y cambian total, proveedor u
 *    obra, la solicitud de pago se actualiza (vuelve a aprobación y se avisa a
 *    los pagadores). Si tesorería ya la pagó, o no se puede consultar, se
 *    bloquea: lo que salió de la caja se arregla con tesorería.
 */

const repoCatalogos = require('./repo/catalogos');

const normNit = (s) => String(s || '').replace(/\D/g, '');
const normTexto = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
const redondear = (n) => Math.round(n * 100) / 100;
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** ¿La persona de la sesión es admin activo? Se lee de la base en cada llamada. */
async function esAdmin(req) {
  const email = req && req._sesion && req._sesion.email;
  if (!email) return false;
  const u = await repoCatalogos.getUsuarioByEmail(email);
  return !!(u && u.activo && u.rol === 'admin');
}

const error = (status, message) => Object.assign(new Error(message), { status });

// ── Ítems ───────────────────────────────────────────────────────────────────

function itemsOC(lista) {
  return (lista || []).map(it => ({
    // En mayúsculas, como las guarda la base: si no, una orden sin cambios
    // parecería distinta.
    descripcion:    String(it.descripcion || it.insumo || '').trim().toUpperCase(),
    cantidad:       Number(it.cantidad || 0),
    unidad:         String(it.unidad || 'UND').trim() || 'UND',
    precioUnitario: Number(it.precioUnitario || 0),
    descuentoPct:   Number(it.descuentoPct || 0),
    ivaPct:         Number(it.ivaPct ?? 0),
    // La homologación con el requerimiento: sin ella se descuadra su cobertura.
    ...(it.insumoOriginal ? { insumoOriginal: it.insumoOriginal } : {}),
  }));
}

function itemsOS(lista) {
  return (lista || []).map(it => ({
    descripcion:    String(it.descripcion || '').trim(),
    cantidad:       Number(it.cantidad || 0),
    unidad:         String(it.unidad || 'UND').trim() || 'UND',
    precioUnitario: Number(it.precioUnitario || 0),
    ivaPct:         Number(it.ivaPct ?? 0),
  }));
}

function validarItems(items) {
  const errores = [];
  if (!items.length) errores.push('La orden necesita al menos un ítem.');
  items.forEach((it, i) => {
    if (!it.descripcion) errores.push(`Ítem ${i + 1}: falta la descripción.`);
    if (!(it.cantidad > 0)) errores.push(`Ítem ${i + 1}: la cantidad debe ser mayor que 0.`);
    if (!(it.precioUnitario > 0)) errores.push(`Ítem ${i + 1}: el precio debe ser mayor que 0.`);
    if (!(it.ivaPct >= 0 && it.ivaPct <= 100)) errores.push(`Ítem ${i + 1}: el IVA debe estar entre 0 y 100.`);
  });
  return errores;
}

/** Los mismos totales que calcula la edición de borradores. */
function totalesOC(items) {
  let subtotal = 0, iva = 0;
  for (const it of items) {
    const base = it.cantidad * it.precioUnitario * (1 - it.descuentoPct / 100);
    subtotal += base;
    iva += base * it.ivaPct / 100;
  }
  return { subtotal: redondear(subtotal), iva: redondear(iva), total: redondear(subtotal + iva) };
}

function totalesOS(items) {
  let valor = 0, iva = 0;
  for (const it of items) {
    const base = redondear(it.cantidad * it.precioUnitario);
    valor += base;
    iva += redondear(base * it.ivaPct / 100);
  }
  return { valor: redondear(valor), iva: redondear(iva), total: redondear(valor + iva) };
}

// ── Cabecera ────────────────────────────────────────────────────────────────

const CABECERA_OC = ['observaciones', 'condicionesComerciales', 'lugarEntrega', 'fechaEntregaPrevista', 'tipoGasto'];
const CABECERA_OS = ['observaciones', 'condicionesComerciales', 'tipoServicio', 'lugarPrestacion',
                     'ofertaEconomicaRef', 'tipoGasto', 'fechaInicio', 'fechaFin'];
const FECHAS = new Set(['fechaEntregaPrevista', 'fechaInicio', 'fechaFin']);

/** Solo los campos de cabecera que de verdad cambian. */
function cabeceraCambiada(campos, previa, pedida = {}) {
  const cambios = {};
  for (const k of campos) {
    if (!(k in pedida)) continue;
    let v = pedida[k] == null ? '' : String(pedida[k]).trim();
    let antes = previa[k] == null ? '' : String(previa[k]);
    if (FECHAS.has(k)) {
      v = v ? new Date(v).toISOString().slice(0, 10) : '';
      antes = antes ? new Date(antes).toISOString().slice(0, 10) : '';
      if (v !== antes) cambios[k] = v || null;
    } else if (v !== antes.trim()) {
      cambios[k] = v;
    }
  }
  return cambios;
}

// ── Plan ────────────────────────────────────────────────────────────────────

/**
 * El plan de corrección de una orden de COMPRA.
 *
 * @param {object} previa       la orden como la devuelve repoOrdenesCompra.obtener
 * @param {object} pedido       { motivo, cabecera, proyecto, proveedorNit, proveedorNombre, items, desmarcarPago }
 * @param {object} contexto     { movimientos (vigentes de la OC), remisiones (activas de la OC),
 *                               tesoreria: { solicitud: {egreso_id, estado, retirada}|null, error } }
 * @returns {{ escritura, efectos, bloqueos, resumen }}
 */
function planOC(previa, pedido, { movimientos = [], remisiones = [], tesoreria = null } = {}) {
  const motivo = String(pedido.motivo || '').trim();
  if (!motivo) throw error(400, 'Corregir exige un motivo.');
  if (!['aprobada', 'finalizada'].includes(previa.estado)) {
    throw error(409, `Solo se corrige una orden aprobada o finalizada; esta está ${previa.estado}. ` +
      (previa.estado === 'borrador' ? 'Un borrador se edita con «Editar borrador».' : ''));
  }

  const escritura = { cambios: cabeceraCambiada(CABECERA_OC, previa, pedido.cabecera) };
  const resumen = Object.keys(escritura.cambios).map(k => `cabecera: ${k}`);
  const bloqueos = [];

  // Obra
  const proyectoCambia = !!pedido.proyecto && normTexto(pedido.proyecto) !== normTexto(previa.proyecto);
  if (proyectoCambia) { escritura.proyecto = String(pedido.proyecto).trim(); resumen.push(`obra: ${previa.proyecto || '—'} → ${escritura.proyecto}`); }

  // Proveedor
  const proveedorCambia = !!normNit(pedido.proveedorNit) && normNit(pedido.proveedorNit) !== normNit(previa.proveedorNit);
  if (proveedorCambia) {
    escritura.proveedorNit = normNit(pedido.proveedorNit);
    escritura.proveedorNombre = String(pedido.proveedorNombre || '').trim();
    resumen.push(`proveedor: ${previa.proveedorNit || '—'} → ${escritura.proveedorNit}`);
  }

  // Ítems
  let previos = [];
  try { previos = itemsOC(JSON.parse(previa.itemsJson || '[]')); } catch {}
  let itemsCambian = false;
  let totales = { subtotal: Number(previa.subtotal), iva: Number(previa.iva), total: Number(previa.total) };
  if (Array.isArray(pedido.items)) {
    const nuevos = itemsOC(pedido.items);
    const errores = validarItems(nuevos);
    if (errores.length) throw Object.assign(error(422, 'Hay ítems inválidos.'), { detalles: errores });
    if (!igual(nuevos, previos)) {
      itemsCambian = true;
      escritura.items = nuevos;
      totales = totalesOC(nuevos);
      Object.assign(escritura.cambios, totales);
      resumen.push(`ítems: ${previos.length} → ${nuevos.length}, total ${Number(previa.total)} → ${totales.total}`);
    }
  }
  const totalCambia = itemsCambian && totales.total !== Number(previa.total);

  // Pago marcado por error
  if (pedido.desmarcarPago && previa.pagado) {
    Object.assign(escritura.cambios, { pagado: false, pagadoPor: null, fechaPago: null });
    if (previa.estado === 'finalizada') escritura.cambios.estado = 'aprobada';
    resumen.push('pago desmarcado' + (previa.estado === 'finalizada' ? ' (vuelve a aprobada)' : ''));
  }

  if (!resumen.length) throw error(400, 'No hay nada que corregir: lo pedido es igual a la orden.');

  // ── Efectos ──
  const efectos = {};

  // Tesorería: la solicitud de pago lleva total, proveedor y obra. Si no está
  // pagada se actualiza con la orden; si ya se pagó, lo que salió de la caja no
  // se reescribe desde acá.
  if (previa.solicitudTesoreriaId && (totalCambia || proveedorCambia || proyectoCambia)) {
    const t = tesoreria || {};
    if (t.error) {
      bloqueos.push(`No se pudo consultar la solicitud de tesorería (${previa.solicitudTesoreriaId}): ${t.error}. ` +
        'Sin saber si está pagada, no se cambian total, proveedor ni obra.');
    } else if (t.solicitud && t.solicitud.estado === 'PAGADO') {
      bloqueos.push(`Tesorería ya pagó la solicitud ${t.solicitud.egreso_id}. Cambiar total, proveedor u obra ` +
        'se arregla con tesorería (un ajuste o un reintegro), no corrigiendo la orden.');
    } else if (t.solicitud && !t.solicitud.retirada && t.solicitud.estado !== 'RECHAZADA') {
      efectos.tesoreria = { accion: 'actualizar', egresoId: t.solicitud.egreso_id, estado: t.solicitud.estado };
    }
  }

  if (movimientos.length && (itemsCambian || proyectoCambia)) {
    const cuadra = cuadraConLaOrden(movimientos, previos);
    if (!cuadra.ok) {
      bloqueos.push(`El almacén de esta orden no cuadra con sus ítems (${cuadra.motivo}). ` +
        'Hay que corregir los movimientos de almacén a mano antes de cambiar ítems u obra.');
    } else {
      efectos.almacen = {
        anular: [...new Set(movimientos.map(m => m.documentoRef).filter(Boolean))],
        tipos: cuadra.tipos,
        fecha: cuadra.fecha,
      };
    }
  }

  if (itemsCambian && remisiones.length) {
    efectos.remisiones = remisiones.map(r => r.numero || r.id);
  }
  if (itemsCambian && previa.numeroOC) efectos.precios = true;
  if (itemsCambian && previa.requerimientoId) efectos.requerimiento = previa.requerimientoId;
  if (previa.pdfUrl) efectos.pdf = true;

  return { motivo, escritura, efectos, bloqueos, resumen, itemsCambian, proyectoCambia };
}

/**
 * ¿Los movimientos vigentes de la OC son exactamente su entrega completa? Por
 * tipo (entrada / salida), la suma por insumo tiene que ser la de los ítems.
 */
function cuadraConLaOrden(movimientos, items) {
  const porInsumo = (lista, k = 'descripcion') => {
    const m = new Map();
    for (const x of lista) {
      const clave = normTexto(x[k] || x.insumo);
      m.set(clave, redondear((m.get(clave) || 0) + Number(x.cantidad || 0)));
    }
    return m;
  };
  const esperado = porInsumo(items);
  const tipos = [...new Set(movimientos.map(m => m.tipo))];
  for (const tipo of tipos) {
    const movs = movimientos.filter(m => m.tipo === tipo);
    const docs = new Set(movs.map(m => m.documentoRef || m.batchId || m.id));
    if (docs.size > 1) return { ok: false, motivo: `${docs.size} documentos de ${tipo}` };
    const real = porInsumo(movs, 'insumo');
    if (real.size !== esperado.size || [...esperado].some(([k, v]) => real.get(k) !== v)) {
      return { ok: false, motivo: `las cantidades de la ${tipo} no son las de la orden` };
    }
  }
  const fecha = movimientos.map(m => m.fecha).filter(Boolean).sort()[0] || null;
  return { ok: true, tipos, fecha };
}

/** Los movimientos que reemplazan a los anulados: los mismos tipos, con lo corregido. */
function movimientosNuevos(oc, efectoAlmacen, usuario) {
  let items = [];
  try { items = JSON.parse(oc.itemsJson || '[]'); } catch {}
  const nuevos = {};
  for (const tipo of efectoAlmacen.tipos) {
    nuevos[tipo] = items
      .filter(it => Number(it.cantidad) > 0)
      .map(it => ({
        tipo,
        proyecto:       oc.proyecto || '',
        ocId:           String(oc.id),
        insumo:         it.descripcion || it.insumo || '',
        unidad:         it.unidad || 'UND',
        cantidad:       Number(it.cantidad),
        // Como al entregar: el almacén valora con IVA.
        precioUnitario: Number(it.precioUnitario || 0) * (1 - Number(it.descuentoPct || 0) / 100) * (1 + Number(it.ivaPct || 0) / 100),
        responsable:    usuario,
        creadoPor:      usuario,
        fecha:          efectoAlmacen.fecha,
        estado:         'activo',
      }));
  }
  return nuevos;
}

/** El plan de corrección de una orden de SERVICIO. Sin almacén ni remisiones. */
function planOS(previa, pedido) {
  const motivo = String(pedido.motivo || '').trim();
  if (!motivo) throw error(400, 'Corregir exige un motivo.');
  if (!['aprobada', 'finalizada'].includes(previa.estado)) {
    throw error(409, `Solo se corrige una orden aprobada o finalizada; esta está ${previa.estado}. ` +
      (previa.estado === 'borrador' ? 'Un borrador se edita con «Editar borrador».' : ''));
  }

  const escritura = { cambios: cabeceraCambiada(CABECERA_OS, previa, pedido.cabecera) };
  const resumen = Object.keys(escritura.cambios).map(k => `cabecera: ${k}`);

  if (pedido.proyecto && normTexto(pedido.proyecto) !== normTexto(previa.proyecto)) {
    escritura.proyecto = String(pedido.proyecto).trim();
    resumen.push(`obra: ${previa.proyecto || '—'} → ${escritura.proyecto}`);
  }
  if (normNit(pedido.proveedorNit) && normNit(pedido.proveedorNit) !== normNit(previa.proveedorNit)) {
    escritura.proveedorNit = normNit(pedido.proveedorNit);
    escritura.proveedorNombre = String(pedido.proveedorNombre || '').trim();
    resumen.push(`proveedor: ${previa.proveedorNit || '—'} → ${escritura.proveedorNit}`);
  }

  let itemsCambian = false;
  if (Array.isArray(pedido.items)) {
    let previos = [];
    try { previos = itemsOS(JSON.parse(previa.itemsJson || '[]')); } catch {}
    const nuevos = itemsOS(pedido.items);
    if (!igual(nuevos, previos)) {
      // Los totales de un contrato AIU los arma la consola con su propia fórmula
      // (administración, imprevistos y utilidad); recalcularlos acá podría no
      // coincidir. En esas solo se corrige la cabecera.
      if (previa.tipoContrato === 'AIU') {
        throw error(409, 'Los ítems de una orden de servicio con contrato AIU no se corrigen desde acá; solo la cabecera.');
      }
      const errores = validarItems(nuevos);
      if (errores.length) throw Object.assign(error(422, 'Hay ítems inválidos.'), { detalles: errores });
      itemsCambian = true;
      escritura.items = nuevos;
      const t = totalesOS(nuevos);
      Object.assign(escritura.cambios, t);
      resumen.push(`ítems: ${previos.length} → ${nuevos.length}, total ${Number(previa.total)} → ${t.total}`);
    }
  }

  if (pedido.desmarcarPago && previa.pagado) {
    Object.assign(escritura.cambios, { pagado: false, pagadoPor: null, fechaPago: null });
    if (previa.estado === 'finalizada') escritura.cambios.estado = 'aprobada';
    resumen.push('pago desmarcado' + (previa.estado === 'finalizada' ? ' (vuelve a aprobada)' : ''));
  }

  if (!resumen.length) throw error(400, 'No hay nada que corregir: lo pedido es igual a la orden.');

  const efectos = {};
  if (previa.pdfUrl) efectos.pdf = true;
  return { motivo, escritura, efectos, bloqueos: [], resumen, itemsCambian };
}

module.exports = { esAdmin, planOC, planOS, movimientosNuevos, cuadraConLaOrden, totalesOC, totalesOS };
