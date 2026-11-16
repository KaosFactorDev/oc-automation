'use strict';
/**
 * repo/kaosConnect.js — Lecturas paginadas para KAOS Connect (T-255).
 *
 * Solo SELECT. Cada función recibe `{ proyectoId, estado, desde, hasta, limit,
 * offset }` y devuelve hasta `limit + 1` filas: la de más le dice a la API si
 * hay otra página. El orden siempre termina en el id, para que la paginación por
 * offset sea estable.
 *
 * Las columnas son explícitas y con nombres pensados para quien lee desde Claude:
 * nada de itemsJson como texto, nada de rutas internas (sp_id, pdf_url) y, en
 * proveedores, nada bancario (banco, tipo de cuenta, número de cuenta).
 *
 * Igual que los listados de la consola: las órdenes en la papelera no existen, y
 * los movimientos de inventario anulados tampoco.
 *
 * El contrato está en docs/contrato-api-kaos-connect.md.
 */

const pg = require('../pg');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (v) => (v == null ? null : Number(v));

/** WHERE con los filtros comunes. `col` dice qué columna es cada filtro. */
function filtros(f, col, base = []) {
  const cond = [...base];
  const vals = [];
  if (f.proyectoId && col.proyecto) { vals.push(f.proyectoId); cond.push(`${col.proyecto} = $${vals.length}`); }
  if (f.estado && col.estado)       { vals.push(f.estado);     cond.push(`${col.estado} = $${vals.length}`); }
  if (f.desde && col.fecha)         { vals.push(f.desde);      cond.push(`${col.fecha} >= $${vals.length}::date`); }
  // `hasta` incluye todo ese día.
  if (f.hasta && col.fecha)         { vals.push(f.hasta);      cond.push(`${col.fecha} < ($${vals.length}::date + 1)`); }
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', vals };
}

/** LIMIT/OFFSET al final de la lista de valores: trae `limit + 1` filas. */
function pagina(vals, f) {
  const v = [...vals, f.limit + 1, f.offset];
  return { sql: `LIMIT $${v.length - 1} OFFSET $${v.length}`, vals: v };
}

/** Agrupa filas hijas por la llave del padre. */
function agrupar(filas, llave, mapear) {
  const m = new Map();
  for (const f of filas) {
    const k = String(f[llave]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(mapear(f));
  }
  return m;
}

// ── Requerimientos ──────────────────────────────────────────────────────────

async function requerimientos(f) {
  const { where, vals } = filtros(f, {
    proyecto: 'r.proyecto_id', estado: 'r.estado', fecha: 'r.fecha_solicitud',
  });
  const p = pagina(vals, f);
  const cabeceras = await pg.rows(
    `SELECT r.id, r.consecutivo, r.consecutivo_sistema, r.fecha_solicitud, r.solicitante,
            r.estado, r.notas, r.proyecto_texto, p.codigo AS proyecto, p.kaos_id AS proyecto_kaos_id
       FROM erp.requerimientos r
       LEFT JOIN erp.proyectos p ON p.id = r.proyecto_id
      ${where}
      ORDER BY r.fecha_solicitud DESC NULLS LAST, r.id DESC
      ${p.sql}`, p.vals);

  const ids = cabeceras.map((c) => c.id);
  const items = ids.length
    ? agrupar(await pg.rows(
      `SELECT requerimiento_id, linea, insumo, cantidad, unidad, necesidad, descartado
         FROM erp.requerimiento_items
        WHERE requerimiento_id = ANY($1::bigint[])
        ORDER BY requerimiento_id, linea`, [ids]), 'requerimiento_id', (i) => ({
      linea: i.linea, insumo: i.insumo, cantidad: num(i.cantidad), unidad: i.unidad || '',
      necesidad: i.necesidad || '', descartado: !!i.descartado,
    }))
    : new Map();

  return cabeceras.map((r) => ({
    id: String(r.id),
    consecutivo: r.consecutivo_sistema || r.consecutivo || '',
    fechaSolicitud: iso(r.fecha_solicitud),
    solicitante: r.solicitante || '',
    estado: r.estado,
    proyecto: r.proyecto || r.proyecto_texto || '',
    proyectoKaosId: r.proyecto_kaos_id || null,
    notas: r.notas || '',
    items: items.get(String(r.id)) || [],
  }));
}

// ── Órdenes de compra ───────────────────────────────────────────────────────

async function ordenesCompra(f) {
  const { where, vals } = filtros(f, {
    proyecto: 'o.proyecto_id', estado: 'o.estado', fecha: 'o.fecha_creacion',
  }, ['o.papelera_en IS NULL']);
  const p = pagina(vals, f);
  const cabeceras = await pg.rows(
    `SELECT o.id, o.numero_oc, o.requerimiento_id, o.proveedor_nit, pr.razon_social AS proveedor_nombre,
            o.subtotal, o.iva, o.total, o.estado, o.tipo_gasto, o.lugar_entrega,
            o.fecha_entrega_prevista, o.fecha_creacion, o.fecha_aprobacion, o.fecha_anulacion,
            o.pagado, o.fecha_pago, o.entregado, o.fecha_entrega,
            p.codigo AS proyecto, p.kaos_id AS proyecto_kaos_id
       FROM erp.ordenes_compra o
       LEFT JOIN erp.proyectos p    ON p.id  = o.proyecto_id
       LEFT JOIN erp.proveedores pr ON pr.nit = o.proveedor_nit
      ${where}
      ORDER BY o.fecha_creacion DESC, o.id DESC
      ${p.sql}`, p.vals);

  const ids = cabeceras.map((c) => c.id);
  const items = ids.length
    ? agrupar(await pg.rows(
      `SELECT orden_compra_id, linea, descripcion, cantidad, unidad, precio_unitario, descuento_pct, iva_pct
         FROM erp.orden_compra_items
        WHERE orden_compra_id = ANY($1::bigint[])
        ORDER BY orden_compra_id, linea`, [ids]), 'orden_compra_id', (i) => ({
      linea: i.linea, descripcion: i.descripcion, cantidad: num(i.cantidad), unidad: i.unidad || '',
      precioUnitario: num(i.precio_unitario), descuentoPct: num(i.descuento_pct), ivaPct: num(i.iva_pct),
    }))
    : new Map();

  return cabeceras.map((o) => ({
    id: String(o.id),
    numero: o.numero_oc || '',
    requerimientoId: o.requerimiento_id ? String(o.requerimiento_id) : null,
    proveedorNit: o.proveedor_nit || '',
    proveedorNombre: o.proveedor_nombre || '',
    proyecto: o.proyecto || '',
    proyectoKaosId: o.proyecto_kaos_id || null,
    subtotal: num(o.subtotal),
    iva: num(o.iva),
    total: num(o.total),
    estado: o.estado,
    tipoGasto: o.tipo_gasto || '',
    lugarEntrega: o.lugar_entrega || '',
    fechaEntregaPrevista: iso(o.fecha_entrega_prevista),
    fechaCreacion: iso(o.fecha_creacion),
    fechaAprobacion: iso(o.fecha_aprobacion),
    fechaAnulacion: iso(o.fecha_anulacion),
    pagado: !!o.pagado,
    fechaPago: iso(o.fecha_pago),
    entregado: !!o.entregado,
    fechaEntrega: iso(o.fecha_entrega),
    items: items.get(String(o.id)) || [],
  }));
}

// ── Órdenes de servicio ─────────────────────────────────────────────────────

async function ordenesServicio(f) {
  const { where, vals } = filtros(f, {
    proyecto: 'o.proyecto_id', estado: 'o.estado', fecha: 'o.fecha_creacion',
  }, ['o.papelera_en IS NULL']);
  const p = pagina(vals, f);
  const cabeceras = await pg.rows(
    `SELECT o.id, o.numero_os, o.requerimiento_id, o.proveedor_nit, pr.razon_social AS proveedor_nombre,
            o.tipo_servicio, o.valor, o.iva, o.total, o.tipo_contrato, o.estado, o.tipo_gasto,
            o.lugar_prestacion, o.fecha_inicio, o.fecha_fin, o.fecha_creacion, o.fecha_aprobacion,
            o.fecha_anulacion, o.pagado, o.fecha_pago, o.cumplido, o.fecha_cumplido,
            p.codigo AS proyecto, p.kaos_id AS proyecto_kaos_id
       FROM erp.ordenes_servicio o
       LEFT JOIN erp.proyectos p    ON p.id  = o.proyecto_id
       LEFT JOIN erp.proveedores pr ON pr.nit = o.proveedor_nit
      ${where}
      ORDER BY o.fecha_creacion DESC, o.id DESC
      ${p.sql}`, p.vals);

  const ids = cabeceras.map((c) => c.id);
  const items = ids.length
    ? agrupar(await pg.rows(
      `SELECT orden_servicio_id, linea, descripcion, cantidad, unidad, precio_unitario, iva_pct
         FROM erp.orden_servicio_items
        WHERE orden_servicio_id = ANY($1::bigint[])
        ORDER BY orden_servicio_id, linea`, [ids]), 'orden_servicio_id', (i) => ({
      linea: i.linea, descripcion: i.descripcion, cantidad: num(i.cantidad), unidad: i.unidad || '',
      precioUnitario: num(i.precio_unitario), ivaPct: num(i.iva_pct),
    }))
    : new Map();

  return cabeceras.map((o) => ({
    id: String(o.id),
    numero: o.numero_os || '',
    requerimientoId: o.requerimiento_id ? String(o.requerimiento_id) : null,
    proveedorNit: o.proveedor_nit || '',
    proveedorNombre: o.proveedor_nombre || '',
    proyecto: o.proyecto || '',
    proyectoKaosId: o.proyecto_kaos_id || null,
    tipoServicio: o.tipo_servicio || '',
    valor: num(o.valor),
    iva: num(o.iva),
    total: num(o.total),
    tipoContrato: o.tipo_contrato || '',
    estado: o.estado,
    tipoGasto: o.tipo_gasto || '',
    lugarPrestacion: o.lugar_prestacion || '',
    fechaInicio: iso(o.fecha_inicio),
    fechaFin: iso(o.fecha_fin),
    fechaCreacion: iso(o.fecha_creacion),
    fechaAprobacion: iso(o.fecha_aprobacion),
    fechaAnulacion: iso(o.fecha_anulacion),
    pagado: !!o.pagado,
    fechaPago: iso(o.fecha_pago),
    cumplido: !!o.cumplido,
    fechaCumplido: iso(o.fecha_cumplido),
    items: items.get(String(o.id)) || [],
  }));
}

// ── Remisiones ──────────────────────────────────────────────────────────────

async function remisiones(f) {
  const { where, vals } = filtros(f, { proyecto: 'r.proyecto_id', estado: 'r.estado', fecha: 'r.fecha' });
  const p = pagina(vals, f);
  const cabeceras = await pg.rows(
    `SELECT r.id, r.numero, r.fecha, r.estado, r.lugar_entrega, r.responsable_entrega,
            r.responsable_recepcion, r.observaciones, r.motivo_anulacion, r.fecha_creacion,
            p.codigo AS proyecto, p.kaos_id AS proyecto_kaos_id
       FROM erp.remisiones r
       LEFT JOIN erp.proyectos p ON p.id = r.proyecto_id
      ${where}
      ORDER BY r.fecha DESC NULLS LAST, r.id DESC
      ${p.sql}`, p.vals);

  const ids = cabeceras.map((c) => c.id);
  let items = new Map();
  let ocs = new Map();
  if (ids.length) {
    const [filasItems, filasOcs] = await Promise.all([
      pg.rows(`SELECT remision_id, linea, descripcion, cantidad, unidad, observacion
                 FROM erp.remision_items WHERE remision_id = ANY($1::bigint[])
                ORDER BY remision_id, linea`, [ids]),
      pg.rows(`SELECT ro.remision_id, o.id, o.numero_oc
                 FROM erp.remision_ordenes ro
                 JOIN erp.ordenes_compra o ON o.id = ro.orden_compra_id
                WHERE ro.remision_id = ANY($1::bigint[])
                ORDER BY ro.remision_id, o.id`, [ids]),
    ]);
    items = agrupar(filasItems, 'remision_id', (i) => ({
      linea: i.linea, descripcion: i.descripcion, cantidad: num(i.cantidad),
      unidad: i.unidad || '', observacion: i.observacion || '',
    }));
    ocs = agrupar(filasOcs, 'remision_id', (o) => ({ id: String(o.id), numero: o.numero_oc || '' }));
  }

  return cabeceras.map((r) => ({
    id: String(r.id),
    numero: r.numero,
    fecha: iso(r.fecha),
    estado: r.estado,
    proyecto: r.proyecto || '',
    proyectoKaosId: r.proyecto_kaos_id || null,
    lugarEntrega: r.lugar_entrega || '',
    responsableEntrega: r.responsable_entrega || '',
    responsableRecepcion: r.responsable_recepcion || '',
    observaciones: r.observaciones || '',
    motivoAnulacion: r.motivo_anulacion || '',
    fechaCreacion: iso(r.fecha_creacion),
    ordenesCompra: ocs.get(String(r.id)) || [],
    items: items.get(String(r.id)) || [],
  }));
}

// ── Inventario ──────────────────────────────────────────────────────────────

async function inventario(f) {
  const { where, vals } = filtros(f, { proyecto: 'm.proyecto_id', fecha: 'm.fecha' },
    [`m.estado <> 'anulado'`, `m.estado_doc <> 'anulado'`]);
  const p = pagina(vals, f);
  const filas = await pg.rows(
    `SELECT m.id, m.tipo, m.fecha, m.insumo, m.unidad, m.cantidad, m.precio_unitario, m.valor_total,
            m.responsable, m.notas, m.documento_ref, o.numero_oc,
            p.codigo AS proyecto, p.kaos_id AS proyecto_kaos_id
       FROM erp.movimientos_inventario m
       LEFT JOIN erp.proyectos p      ON p.id = m.proyecto_id
       LEFT JOIN erp.ordenes_compra o ON o.id = m.orden_compra_id
      ${where}
      ORDER BY m.fecha DESC, m.id DESC
      ${p.sql}`, p.vals);

  return filas.map((m) => ({
    id: String(m.id),
    tipo: m.tipo,
    fecha: iso(m.fecha),
    proyecto: m.proyecto || '',
    proyectoKaosId: m.proyecto_kaos_id || null,
    insumo: m.insumo,
    unidad: m.unidad || '',
    cantidad: num(m.cantidad),
    precioUnitario: num(m.precio_unitario),
    valorTotal: num(m.valor_total),
    numeroOC: m.numero_oc || '',
    documentoRef: m.documento_ref || '',
    responsable: m.responsable || '',
    notas: m.notas || '',
  }));
}

// ── Proveedores ─────────────────────────────────────────────────────────────

/** Sin datos bancarios: banco, tipo de cuenta y número de cuenta no salen. */
async function proveedores(f) {
  const vals = [];
  const cond = [];
  if (f.estado === 'activo') cond.push('activo');
  if (f.estado === 'inactivo') cond.push('NOT activo');
  const p = pagina(vals, f);
  const filas = await pg.rows(
    `SELECT nit, razon_social, nombre_comercial, regimen, municipio, zona, direccion, telefono, correo, activo
       FROM erp.proveedores
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
      ORDER BY razon_social, nit
      ${p.sql}`, p.vals);

  return filas.map((r) => ({
    nit: r.nit,
    razonSocial: r.razon_social || '',
    nombreComercial: r.nombre_comercial || '',
    regimen: r.regimen || '',
    municipio: r.municipio || '',
    zona: r.zona || '',
    direccion: r.direccion || '',
    telefono: r.telefono || '',
    correo: r.correo || '',
    activo: !!r.activo,
  }));
}

module.exports = {
  requerimientos, ordenesCompra, ordenesServicio, remisiones, inventario, proveedores,
};
