'use strict';
/**
 * repo/ordenesServicio.js — Órdenes de servicio y sus ítems.
 *
 * Misma estructura que repo/ordenesCompra.js: las lecturas devuelven la forma
 * del item de SharePoint, con itemsJson como string, para que las plantillas de
 * OS y la consola no cambien.
 *
 * Lo propio de las OS frente a las OC son el tipo de contrato y el AIU
 * (administración, imprevistos y utilidad), que aplica cuando el contrato no
 * lleva IVA pleno, y el par cumplido/fechaCumplido en vez de entregado.
 *
 * El número se emite con erp.siguiente_numero_os() dentro de la transacción que
 * aprueba, por la misma razón que en las OC: contador.js lo calculaba con un
 * MAX() que excluía los estados anulados, y eso dejó 5 números de OS repetidos.
 */

const pg = require('../pg');

const CABECERA = `
  o.id, o.numero_os, o.requerimiento_id, o.proyecto_id, o.proveedor_nit,
  o.tipo_servicio, o.clausulas, o.oferta_economica_ref, o.oferta_economica_condiciones,
  o.valor, o.iva, o.total, o.tipo_contrato, o.aiu_a, o.aiu_i, o.aiu_u,
  o.estado, o.tipo_gasto, o.lugar_prestacion, o.fecha_inicio, o.fecha_fin,
  o.condiciones_comerciales, o.observaciones, o.creado_por, o.fecha_creacion,
  o.aprobado_por, o.fecha_aprobacion, o.anulado_por, o.fecha_anulacion,
  o.motivo_anulacion, o.pagado, o.pagado_por, o.fecha_pago,
  o.cumplido, o.cumplido_por, o.fecha_cumplido, o.pdf_url, o.sp_id,
  p.codigo AS proyecto,
  pr.razon_social AS proveedor_nombre`;

const iso = (d) => (d ? d.toISOString() : null);

function mapear(o, items = []) {
  return {
    id:                          String(o.id),
    numeroOS:                    o.numero_os || '',
    requerimientoId:             o.requerimiento_id ? String(o.requerimiento_id) : '',
    proyecto:                    o.proyecto || '',
    proyectoId:                  o.proyecto_id,
    proveedorNit:                o.proveedor_nit || '',
    proveedorNombre:             o.proveedor_nombre || '',
    tipoServicio:                o.tipo_servicio || '',
    clausulas:                   o.clausulas || '',
    ofertaEconomicaRef:          o.oferta_economica_ref || '',
    ofertaEconomicaCondiciones:  o.oferta_economica_condiciones || '',
    valor:                       Number(o.valor),
    iva:                         Number(o.iva),
    total:                       Number(o.total),
    tipoContrato:                o.tipo_contrato,
    aiuA:                        Number(o.aiu_a),
    aiuI:                        Number(o.aiu_i),
    aiuU:                        Number(o.aiu_u),
    estado:                      o.estado,
    tipoGasto:                   o.tipo_gasto || '',
    lugarPrestacion:             o.lugar_prestacion || '',
    fechaInicio:                 iso(o.fecha_inicio),
    fechaFin:                    iso(o.fecha_fin),
    condicionesComerciales:      o.condiciones_comerciales || '',
    observaciones:               o.observaciones || '',
    creadoPor:                   o.creado_por || '',
    fechaCreacion:               iso(o.fecha_creacion),
    aprobadoPor:                 o.aprobado_por || '',
    fechaAprobacion:             iso(o.fecha_aprobacion),
    anuladoPor:                  o.anulado_por || '',
    fechaAnulacion:              iso(o.fecha_anulacion),
    motivoAnulacion:             o.motivo_anulacion || '',
    pagado:                      o.pagado,
    pagadoPor:                   o.pagado_por || '',
    fechaPago:                   iso(o.fecha_pago),
    cumplido:                    o.cumplido,
    cumplidoPor:                 o.cumplido_por || '',
    fechaCumplido:               iso(o.fecha_cumplido),
    pdfUrl:                      o.pdf_url || '',
    itemsJson:                   JSON.stringify(items),
    sp_id:                       o.sp_id,
  };
}

const mapearItem = (i) => ({
  descripcion:    i.descripcion,
  unidad:         i.unidad,
  cantidad:       Number(i.cantidad),
  precioUnitario: Number(i.precio_unitario),
  ivaPct:         Number(i.iva_pct),
});

async function itemsDe(ids) {
  if (!ids.length) return new Map();
  const filas = await pg.rows(
    `SELECT orden_servicio_id, linea, descripcion, cantidad, unidad, precio_unitario, iva_pct
       FROM erp.orden_servicio_items
      WHERE orden_servicio_id = ANY($1::bigint[])
      ORDER BY orden_servicio_id, linea`, [ids]);
  const m = new Map();
  for (const f of filas) {
    const k = String(f.orden_servicio_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(mapearItem(f));
  }
  return m;
}

const DESDE = `FROM erp.ordenes_servicio o
  LEFT JOIN erp.proyectos p    ON p.id  = o.proyecto_id
  LEFT JOIN erp.proveedores pr ON pr.nit = o.proveedor_nit`;

async function armar(cabeceras) {
  const items = await itemsDe(cabeceras.map(c => c.id));
  return cabeceras.map(c => mapear(c, items.get(String(c.id)) || []));
}

async function listar({ estado = null, proyectoId = null } = {}) {
  const cond = [];
  const vals = [];
  if (estado)     { vals.push(estado);     cond.push(`o.estado = $${vals.length}`); }
  if (proyectoId) { vals.push(proyectoId); cond.push(`o.proyecto_id = $${vals.length}`); }

  return armar(await pg.rows(
    `SELECT ${CABECERA} ${DESDE}
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY o.fecha_creacion DESC, o.id DESC`, vals));
}

async function obtener(id) {
  const r = await pg.one(`SELECT ${CABECERA} ${DESDE} WHERE o.id = $1`, [id]);
  if (!r) return null;
  return (await armar([r]))[0];
}

// ── Escritura ───────────────────────────────────────────────────────────────

const COLUMNAS = {
  numeroOS: 'numero_os', requerimientoId: 'requerimiento_id',
  tipoServicio: 'tipo_servicio', clausulas: 'clausulas',
  ofertaEconomicaRef: 'oferta_economica_ref',
  ofertaEconomicaCondiciones: 'oferta_economica_condiciones',
  valor: 'valor', iva: 'iva', total: 'total',
  tipoContrato: 'tipo_contrato', aiuA: 'aiu_a', aiuI: 'aiu_i', aiuU: 'aiu_u',
  estado: 'estado', tipoGasto: 'tipo_gasto', lugarPrestacion: 'lugar_prestacion',
  fechaInicio: 'fecha_inicio', fechaFin: 'fecha_fin',
  condicionesComerciales: 'condiciones_comerciales', observaciones: 'observaciones',
  aprobadoPor: 'aprobado_por', fechaAprobacion: 'fecha_aprobacion',
  anuladoPor: 'anulado_por', fechaAnulacion: 'fecha_anulacion',
  motivoAnulacion: 'motivo_anulacion',
  pagado: 'pagado', pagadoPor: 'pagado_por', fechaPago: 'fecha_pago',
  cumplido: 'cumplido', cumplidoPor: 'cumplido_por', fechaCumplido: 'fecha_cumplido',
  pdfUrl: 'pdf_url',
};

async function crear(datos, items = []) {
  return pg.tx(async (c) => {
    const proyectoId = await resolverProyecto(c, datos.proyecto);
    const nit        = await resolverProveedor(c, datos.proveedorNit, datos.proveedorNombre);

    const cab = await c.query(
      `INSERT INTO erp.ordenes_servicio
         (numero_os, requerimiento_id, proyecto_id, proveedor_nit, tipo_servicio,
          clausulas, oferta_economica_ref, oferta_economica_condiciones,
          valor, iva, total, tipo_contrato, aiu_a, aiu_i, aiu_u,
          estado, tipo_gasto, lugar_prestacion, fecha_inicio, fecha_fin,
          condiciones_comerciales, observaciones, creado_por, fecha_creacion)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               COALESCE($11,'IVA_PLENO'), $12, $13, $14,
               COALESCE($15,'borrador'), $16, $17, $18, $19, $20, $21, $22,
               COALESCE($23, now()))
       RETURNING id`,
      [
        datos.requerimientoId || null, proyectoId, nit,
        datos.tipoServicio || null, datos.clausulas || null,
        datos.ofertaEconomicaRef || null, datos.ofertaEconomicaCondiciones || null,
        Number(datos.valor) || 0, Number(datos.iva) || 0, Number(datos.total) || 0,
        ['IVA_PLENO', 'AIU'].includes(datos.tipoContrato) ? datos.tipoContrato : null,
        Number(datos.aiuA) || 0, Number(datos.aiuI) || 0, Number(datos.aiuU) || 0,
        datos.estado || null, datos.tipoGasto || null, datos.lugarPrestacion || null,
        datos.fechaInicio || null, datos.fechaFin || null,
        datos.condicionesComerciales || null, datos.observaciones || null,
        datos.creadoPor || null, datos.fechaCreacion || null,
      ]);
    const id = cab.rows[0].id;
    await insertarItems(c, id, items);
    return String(id);
  });
}

/** Aprueba y asigna el número, en una sola transacción. */
async function aprobar(id, { usuario, formatear, cambios = {} }) {
  return pg.tx(async (c) => {
    const n = await c.query('SELECT erp.siguiente_numero_os() AS n');
    const numero = formatear(Number(n.rows[0].n));

    const sets = ['numero_os = $1', "estado = 'aprobada'", 'aprobado_por = $2',
                  'fecha_aprobacion = now()'];
    const vals = [numero, usuario || null];
    for (const [clave, valor] of Object.entries(cambios)) {
      const col = COLUMNAS[clave];
      if (!col) continue;
      vals.push(valor);
      sets.push(`${col} = $${vals.length}`);
    }
    vals.push(id);
    const r = await c.query(
      `UPDATE erp.ordenes_servicio SET ${sets.join(', ')}
        WHERE id = $${vals.length} RETURNING id`, vals);
    if (!r.rowCount) throw new Error(`Orden de servicio ${id} no existe`);
    return numero;
  });
}

async function actualizar(id, cambios) {
  const { itemsJson, ...resto } = cambios || {};

  if (itemsJson !== undefined) {
    let items = [];
    try { items = JSON.parse(itemsJson || '[]'); } catch {}
    await pg.tx(async (c) => {
      await c.query('DELETE FROM erp.orden_servicio_items WHERE orden_servicio_id = $1', [id]);
      await insertarItems(c, id, items);
    });
  }

  const sets = [];
  const vals = [];
  for (const [clave, valor] of Object.entries(resto)) {
    const col = COLUMNAS[clave];
    if (!col) continue;
    vals.push(valor);
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length) {
    vals.push(id);
    await pg.query(
      `UPDATE erp.ordenes_servicio SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  return obtener(id);
}

async function insertarItems(c, id, items) {
  let linea = 0;
  for (const it of items || []) {
    const desc = String(it.descripcion ?? it.insumo ?? '').trim();
    if (!desc) continue;
    await c.query(
      `INSERT INTO erp.orden_servicio_items
         (orden_servicio_id, linea, descripcion, cantidad, unidad, precio_unitario, iva_pct)
       VALUES ($1,$2,$3,$4,COALESCE($5,'GLB'),$6,$7)`,
      [
        id, ++linea, desc,
        Number(it.cantidad) || 0, String(it.unidad || '').trim() || null,
        Number(it.precioUnitario) || 0,
        Math.min(100, Math.max(0, Number(it.ivaPct) || 0)),
      ]);
  }
}

// Mismos resolvedores que en las OC: si el proyecto o el proveedor no están en
// su catálogo se crean marcados para revisión, antes que rechazar el documento.

async function resolverProyecto(c, texto) {
  const s = String(texto || '').trim();
  if (!s) return null;
  const hallado = await c.query(
    'SELECT id FROM erp.proyectos WHERE erp.norm(codigo) = erp.norm($1)', [s]);
  if (hallado.rowCount) return hallado.rows[0].id;
  const creado = await c.query(
    `INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
     VALUES ($1, $1, false, true) RETURNING id`, [s]);
  return creado.rows[0].id;
}

async function resolverProveedor(c, nit, nombre) {
  const s = String(nit || '').trim();
  if (!s) return null;
  const clave = (await c.query('SELECT erp.norm_nit($1) AS n', [s])).rows[0].n;
  if (!clave) return null;
  const hallado = await c.query('SELECT nit FROM erp.proveedores WHERE nit = $1', [clave]);
  if (hallado.rowCount) return clave;
  await c.query(
    `INSERT INTO erp.proveedores (nit, nit_original, razon_social, activo, requiere_revision)
     VALUES ($1, $2, $3, false, true) ON CONFLICT (nit) DO NOTHING`,
    [clave, s, String(nombre || '').trim() || '(sin nombre)']);
  return clave;
}

module.exports = { listar, obtener, crear, aprobar, actualizar };
