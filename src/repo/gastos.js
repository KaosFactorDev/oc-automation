'use strict';
/**
 * repo/gastos.js — Control de Costos, leído de erp.vw_gastos.
 *
 * No hay escritura. Los gastos se derivan de las órdenes aprobadas y de las
 * salidas de almacén aprobadas, así que no existe una fila que registrar ni que
 * corregir. Eso es lo que elimina el problema que tenía el libro de Excel: una
 * copia que podía quedar desincronizada de lo que decían las órdenes.
 *
 * Las columnas son las mismas 14 que tenía la tabla tblGastos, para que el
 * reporte que la gente ya conoce salga igual.
 */

const pg = require('../pg');

const iso = (d) => (d ? d.toISOString().slice(0, 10) : '');

const mapear = (g) => ({
  origen:          g.origen,
  origenId:        String(g.origen_id),
  numero:          g.numero || '',
  fechaOC:         iso(g.fecha_documento),
  proyecto:        g.proyecto || '',
  proveedorNit:    g.proveedor_nit || '',
  proveedorNombre: g.proveedor_nombre || '',
  tipoGasto:       g.tipo_gasto,
  subtotal:        Number(g.subtotal),
  iva:             Number(g.iva),
  total:           Number(g.total),
  estado:          g.estado,
  fechaAprobacion: iso(g.fecha_aprobacion),
  fechaPago:       iso(g.fecha_pago),
  fechaEntrega:    iso(g.fecha_entrega),
  creadoPor:       g.creado_por || '',
});

/**
 * Los gastos, del más reciente al más antiguo. Filtrar por proyecto o por rango
 * de fechas era una búsqueda lineal sobre el libro; acá es una consulta.
 */
async function listar({ proyecto = null, desde = null, hasta = null, origen = null } = {}) {
  const cond = [];
  const vals = [];
  if (proyecto) { vals.push(proyecto); cond.push(`erp.norm(proyecto) = erp.norm($${vals.length})`); }
  if (desde)    { vals.push(desde);    cond.push(`fecha_documento >= $${vals.length}::date`); }
  if (hasta)    { vals.push(hasta);    cond.push(`fecha_documento <= $${vals.length}::date`); }
  if (origen)   { vals.push(origen);   cond.push(`origen = $${vals.length}`); }

  return (await pg.rows(
    `SELECT * FROM erp.vw_gastos
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY fecha_documento DESC NULLS LAST, numero DESC`, vals)).map(mapear);
}

/** Los tres resúmenes que el libro tenía como hojas con fórmulas. */
async function porProyecto() {
  return (await pg.rows('SELECT * FROM erp.vw_gastos_por_proyecto')).map(r => ({
    proyecto: r.proyecto, documentos: Number(r.documentos),
    subtotal: Number(r.subtotal), iva: Number(r.iva), total: Number(r.total),
  }));
}

async function porProveedor() {
  return (await pg.rows('SELECT * FROM erp.vw_gastos_por_proveedor')).map(r => ({
    proveedor: r.proveedor, proveedorNit: r.proveedor_nit || '',
    documentos: Number(r.documentos), total: Number(r.total),
  }));
}

async function porTipo() {
  return (await pg.rows('SELECT * FROM erp.vw_gastos_por_tipo')).map(r => ({
    tipoGasto: r.tipo_gasto, documentos: Number(r.documentos), total: Number(r.total),
  }));
}

/** Totales globales, para el encabezado del reporte. */
async function totales() {
  const r = await pg.one(`
    SELECT count(*)::int AS documentos,
           COALESCE(sum(subtotal),0) AS subtotal,
           COALESCE(sum(iva),0)      AS iva,
           COALESCE(sum(total),0)    AS total
      FROM erp.vw_gastos`);
  return {
    documentos: r.documentos,
    subtotal: Number(r.subtotal), iva: Number(r.iva), total: Number(r.total),
  };
}

module.exports = { listar, porProyecto, porProveedor, porTipo, totales };
