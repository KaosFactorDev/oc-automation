'use strict';
/**
 * consultaProveedor.js
 * Dado un insumo y un proyecto, busca el proveedor óptimo.
 *
 * El historial y los proveedores llegan precargados desde Postgres. El camino
 * alternativo que leía tres CSV del disco se retiró junto con los archivos.
 *
 *   1. Filtrar historial de precios por insumo
 *   2. Priorizar proveedores de la misma zona del proyecto
 *   3. De los candidatos, tomar las 3 compras más recientes
 *   4. Elegir la de menor precio entre esas 3
 */

// ── Utilidades ────────────────────────────────────────────────────────────────

function parseMoney(val) {
  if (!val && val !== 0) return 0;
  return parseFloat(String(val).replace(/[^0-9.]/g, '')) || 0;
}

function parseDate(val) {
  if (!val) return null;
  const meses = {
    enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
    julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
  };
  const txt = String(val).trim().toLowerCase();
  const m = txt.match(/^(\w+)\s+(\d+),?\s+(\d{4})$/);
  if (m) return new Date(+m[3], (meses[m[1]] || 1) - 1, +m[2]);
  // Formato es-CO usado al aprobar OCs: "23 de junio de 2026"
  const mEs = txt.match(/^(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})$/);
  if (mEs) return new Date(+mEs[3], (meses[mEs[2]] || 1) - 1, +mEs[1]);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(val))) return new Date(String(val).slice(0, 10));
  const d = new Date(val);
  return isNaN(d) ? null : d;
}

function normalizar(txt) {
  return String(txt || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Normalizar datos SP al mismo formato interno ──────────────────────────────

function normalizarHistorialSP(historialSP, proveedoresSP) {
  const provPorNit = {};
  for (const p of (proveedoresSP || [])) {
    if (p.nit) provPorNit[p.nit] = p;
  }

  const comprasParsed = (historialSP || []).map(h => {
    // Acepta los dos juegos de nombres: los que traía SharePoint
    // (nitProveedor, precioUnitario, numeroCompra) y los del repo
    // (nit, precio, documento).
    const nit = String(h.nitProveedor || h.nit || '').trim();
    return {
      insumo:    normalizar(h.insumo),
      insumoRaw: String(h.insumo || '').trim(),
      precio:    parseMoney(h.precioUnitario || h.precio),
      nit,
      fecha:     parseDate(h.fecha),
      fechaRaw:  String(h.fecha || '').trim(),
      cantidad:  parseMoney(h.cantidad),
      compra:    String(h.numeroCompra || h.documento || '').trim(),
      proyecto:  String(h.proyecto || '').trim(),
      prov:      provPorNit[nit] || null,
    };
  });

  return { comprasParsed, provPorNit };
}

// ── Consulta principal ────────────────────────────────────────────────────────
// opts.historialSP   → filas de erp.historial_precios
// opts.proveedoresSP → proveedores {nit, nombre, zona, ...}
// opts.zonaProyecto  → zona del proyecto

/**
 * El historial y los proveedores llegan siempre precargados por el llamador,
 * que los lee de Postgres. Antes había un camino alternativo que cargaba tres
 * CSV del disco cuando no venían; se retiró junto con los archivos.
 *
 * Sin historial no hay nada que comparar, así que se devuelve el mismo
 * resultado que daba un insumo sin registros previos.
 */
function consultarProveedor(insumo, codigoProyecto, opts = {}) {
  if (!opts.historialSP || !opts.historialSP.length) {
    return sinHistorial(insumo);
  }

  const { comprasParsed } = normalizarHistorialSP(opts.historialSP, opts.proveedoresSP || []);
  const zonaProyecto = opts.zonaProyecto || '';

  return ejecutarConsulta(insumo, codigoProyecto, comprasParsed, zonaProyecto);
}

/** El resultado de un insumo sin registros previos. */
function sinHistorial(insumo, codigoProyecto = '') {
  return {
    insumo, codigoProyecto,
    encontrado:   false,
    sinHistorial: true,
    mensaje:      `Sin historial para "${insumo}". Incluido en OC sin precio.`,
    proveedor:    null,
    precio:       null,
    historial:    [],
    alertas:      [`🔍 Ítem nuevo: "${insumo}" — complete el precio antes de aprobar la OC.`],
  };
}

function ejecutarConsulta(insumo, codigoProyecto, comprasParsed, zonaProyecto) {
  const insumoNorm = normalizar(insumo);

  let registros    = comprasParsed.filter(c => c.insumo === insumoNorm);
  let matchParcial = false;
  if (registros.length === 0) {
    registros    = comprasParsed.filter(c => c.insumo.includes(insumoNorm) || insumoNorm.includes(c.insumo));
    matchParcial = registros.length > 0;
  }

  if (registros.length === 0) {
    return sinHistorial(insumo, codigoProyecto);
  }

  const enriquecidos = registros
    .filter(c => c.nit && c.prov && c.precio > 0)
    .map(c => ({ ...c, zonaProveedor: normalizar(c.prov.zona || '') }));

  if (enriquecidos.length === 0) {
    return {
      insumo, codigoProyecto,
      encontrado: false, sinHistorial: false,
      mensaje:    'Proveedores históricos no están en la base activa.',
      proveedor:  null, precio: null,
      historial:  registros.slice(0, 5).map(fmtHistorial),
      alertas:    ['⚠️ Proveedores no encontrados en base depurada. Verificar manualmente.'],
    };
  }

  let candidatos       = enriquecidos;
  let aplicoFiltroZona = false;
  const zonaNorm       = normalizar(zonaProyecto);
  if (zonaNorm) {
    const enZona = enriquecidos.filter(c => c.zonaProveedor === zonaNorm);
    if (enZona.length > 0) { candidatos = enZona; aplicoFiltroZona = true; }
  }

  candidatos.sort((a, b) => (b.fecha || 0) - (a.fecha || 0));
  const top3    = candidatos.slice(0, 3);
  const elegido = [...top3].sort((a, b) => a.precio - b.precio)[0];

  const historial = enriquecidos
    .sort((a, b) => (b.fecha || 0) - (a.fecha || 0))
    .slice(0, 10)
    .map(fmtHistorial);

  const alertas = [];
  if (matchParcial)
    alertas.push(`ℹ️ Coincidencia aproximada: se usó "${elegido.insumoRaw}" para "${insumo}".`);
  if (!aplicoFiltroZona && zonaNorm)
    alertas.push(`⚠️ Sin proveedores en zona "${zonaProyecto}". Se usó historial nacional.`);
  if (top3.length === 1)
    alertas.push('ℹ️ Solo un proveedor histórico. Considere cotizar alternativas.');
  if (top3.length > 1) {
    const variacion = (Math.max(...top3.map(c => c.precio)) - Math.min(...top3.map(c => c.precio)))
                    /  Math.min(...top3.map(c => c.precio));
    if (variacion > 0.2)
      alertas.push(`📊 Variación de ${(variacion * 100).toFixed(0)}% entre proveedores recientes. Verifique antes de aprobar.`);
  }

  return {
    insumo, codigoProyecto,
    encontrado: true, sinHistorial: false,
    coincidenciaUsada: matchParcial ? elegido.insumoRaw : null,
    aplicoFiltroZona,
    zonaProyecto: zonaProyecto || 'No definida',
    proveedor: {
      nit:       elegido.nit,
      nombre:    elegido.prov?.nombre || '',
      municipio: elegido.prov?.municipio || '',
      zona:      elegido.prov?.zona || '',
      telefono:  elegido.prov?.telefono || '',
      correo:    elegido.prov?.correo || '',
    },
    precio:              elegido.precio,
    fechaUltimaCompra:   elegido.fechaRaw,
    documentoReferencia: elegido.compra,
    historial,
    alertas,
  };
}

function fmtHistorial(c) {
  return {
    nit:       c.nit || '',
    proveedor: c.prov?.nombre || c.nit || '',
    fecha:     c.fechaRaw,
    precio:    c.precio,
    cantidad:  c.cantidad,
    proyecto:  c.proyecto,
    compra:    c.compra,
  };
}

function invalidarCache() { /* no-op — cache en servidor-cotizaciones.js */ }

module.exports = { consultarProveedor, invalidarCache };
