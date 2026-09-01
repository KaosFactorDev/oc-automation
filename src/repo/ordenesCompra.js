'use strict';
/**
 * repo/ordenesCompra.js — Órdenes de compra y sus ítems.
 *
 * Como en requerimientos, las lecturas devuelven la forma que tenía el item de
 * SharePoint —incluido itemsJson como string— para que la consola y las
 * plantillas de OC no cambien.
 *
 * ── Lo que se arregla al pasar por acá ─────────────────────────────────────
 *
 * El consecutivo. contador.js lo calculaba como MAX(numeroOC) excluyendo los
 * estados anulados, así que anular la orden más alta dejaba que la siguiente
 * reutilizara su número. Ya pasó 16 veces en producción. Acá el número se emite
 * con erp.siguiente_numero_oc() DENTRO de la transacción que escribe el
 * documento: dos aprobaciones simultáneas se serializan, y si la escritura
 * falla el número se devuelve en vez de quedar consumido.
 *
 * La cobertura del requerimiento. Antes se consultaba con un filtro OData sobre
 * fields/requerimientoId; ahora es una llave foránea con índice.
 *
 * Los ítems venían con dos formas —unos con la clave "descripcion", otros con
 * "insumo"— según por dónde se hubiera creado la orden. Acá hay una sola
 * columna, y al leer se expone también como `insumo` porque hay código de la
 * consola que todavía lo busca con ese nombre.
 */

const pg = require('../pg');

const CABECERA = `
  o.id, o.numero_oc, o.requerimiento_id, o.requerimiento_origen, o.cotizacion_id,
  o.proveedor_nit, o.proyecto_id, o.subtotal, o.iva, o.total, o.estado,
  o.tipo_gasto, o.lugar_entrega, o.fecha_entrega_prevista,
  o.condiciones_comerciales, o.observaciones, o.creado_por, o.fecha_creacion,
  o.aprobado_por, o.fecha_aprobacion, o.anulado_por, o.fecha_anulacion,
  o.motivo_anulacion, o.pagado, o.pagado_por, o.fecha_pago,
  o.entregado, o.entregado_por, o.fecha_entrega, o.pdf_url, o.xlsx_url,
  o.solicitud_tesoreria_id, o.solicitud_tesoreria_por, o.fecha_solicitud_tesoreria,
  o.sp_id,
  p.codigo AS proyecto,
  pr.razon_social AS proveedor_nombre`;

const iso = (d) => (d ? d.toISOString() : null);

function mapear(o, items = []) {
  return {
    id:                      String(o.id),
    // Vacío y no null: la consola y las plantillas comparan contra ''.
    numeroOC:                o.numero_oc || '',
    requerimientoId:         o.requerimiento_id ? String(o.requerimiento_id) : '',
    requerimientoOrigen:     o.requerimiento_origen || '',
    cotizacionId:            o.cotizacion_id || '',
    proveedorNit:            o.proveedor_nit || '',
    proveedorNombre:         o.proveedor_nombre || '',
    proyecto:                o.proyecto || '',
    proyectoId:              o.proyecto_id,
    itemsJson:               JSON.stringify(items),
    subtotal:                Number(o.subtotal),
    iva:                     Number(o.iva),
    total:                   Number(o.total),
    estado:                  o.estado,
    tipoGasto:               o.tipo_gasto || '',
    lugarEntrega:            o.lugar_entrega || '',
    fechaEntregaPrevista:    iso(o.fecha_entrega_prevista),
    condicionesComerciales:  o.condiciones_comerciales || '',
    observaciones:           o.observaciones || '',
    creadoPor:               o.creado_por || '',
    fechaCreacion:           iso(o.fecha_creacion),
    aprobadoPor:             o.aprobado_por || '',
    fechaAprobacion:         iso(o.fecha_aprobacion),
    anuladoPor:              o.anulado_por || '',
    fechaAnulacion:          iso(o.fecha_anulacion),
    motivoAnulacion:         o.motivo_anulacion || '',
    pagado:                  o.pagado,
    pagadoPor:               o.pagado_por || '',
    fechaPago:               iso(o.fecha_pago),
    entregado:               o.entregado,
    entregadoPor:            o.entregado_por || '',
    fechaEntrega:            iso(o.fecha_entrega),
    pdfUrl:                  o.pdf_url || '',
    xlsxUrl:                 o.xlsx_url || '',
    solicitudTesoreriaId:      o.solicitud_tesoreria_id || '',
    solicitudTesoreriaPor:     o.solicitud_tesoreria_por || '',
    fechaSolicitudTesoreria:   iso(o.fecha_solicitud_tesoreria),
    sp_id:                   o.sp_id,
  };
}

function mapearItem(i) {
  return {
    descripcion:    i.descripcion,
    // Mismo valor bajo el nombre viejo: parte de la consola lee it.insumo.
    insumo:         i.descripcion,
    unidad:         i.unidad,
    cantidad:       Number(i.cantidad),
    precioUnitario: Number(i.precio_unitario),
    descuentoPct:   Number(i.descuento_pct),
    ivaPct:         Number(i.iva_pct),
    ...(i.insumo_original ? { insumoOriginal: i.insumo_original } : {}),
  };
}

async function itemsDe(ids) {
  if (!ids.length) return new Map();
  const filas = await pg.rows(
    `SELECT orden_compra_id, linea, descripcion, insumo_original, cantidad, unidad,
            precio_unitario, descuento_pct, iva_pct
       FROM erp.orden_compra_items
      WHERE orden_compra_id = ANY($1::bigint[])
      ORDER BY orden_compra_id, linea`, [ids]);
  const m = new Map();
  for (const f of filas) {
    const k = String(f.orden_compra_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(mapearItem(f));
  }
  return m;
}

const DESDE = `FROM erp.ordenes_compra o
  LEFT JOIN erp.proyectos p   ON p.id  = o.proyecto_id
  LEFT JOIN erp.proveedores pr ON pr.nit = o.proveedor_nit`;

async function armar(cabeceras) {
  const items = await itemsDe(cabeceras.map(c => c.id));
  return cabeceras.map(c => mapear(c, items.get(String(c.id)) || []));
}

async function listar({ estado = null, requerimientoId = null, proyectoId = null } = {}) {
  const cond = [];
  const vals = [];
  if (estado)          { vals.push(estado);          cond.push(`o.estado = $${vals.length}`); }
  if (requerimientoId) { vals.push(requerimientoId); cond.push(`o.requerimiento_id = $${vals.length}`); }
  if (proyectoId)      { vals.push(proyectoId);      cond.push(`o.proyecto_id = $${vals.length}`); }

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

/** Varias por id, en una sola consulta. Se usa al armar una remisión. */
async function obtenerVarias(ids) {
  if (!ids.length) return [];
  return armar(await pg.rows(
    `SELECT ${CABECERA} ${DESDE} WHERE o.id = ANY($1::bigint[]) ORDER BY o.id`,
    [ids.map(Number)]));
}

// ── Escritura ───────────────────────────────────────────────────────────────

/**
 * Crea la orden en estado borrador, sin número: el consecutivo se emite recién
 * al aprobar, igual que antes.
 */
async function crear(datos, items = []) {
  return pg.tx(async (c) => {
    const proyectoId = await resolverProyecto(c, datos.proyecto);
    const nit        = await resolverProveedor(c, datos.proveedorNit, datos.proveedorNombre);

    const cab = await c.query(
      `INSERT INTO erp.ordenes_compra
         (numero_oc, requerimiento_id, requerimiento_origen, cotizacion_id,
          proveedor_nit, proyecto_id, subtotal, iva, total, estado,
          creado_por, fecha_creacion)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9,'borrador'), $10,
               COALESCE($11, now()))
       RETURNING id`,
      [
        datos.requerimientoId || null, datos.requerimientoOrigen || null,
        datos.cotizacionId || null, nit, proyectoId,
        Number(datos.subtotal) || 0, Number(datos.iva) || 0, Number(datos.total) || 0,
        datos.estado || null, datos.creadoPor || null, datos.fechaCreacion || null,
      ]);
    const id = cab.rows[0].id;
    await insertarItems(c, id, items);
    return String(id);
  });
}

/**
 * Aprueba la orden y le asigna el número, en una sola transacción.
 *
 * `formatear` recibe el entero y devuelve el texto ("0042"), porque el prefijo y
 * el relleno son configuración de la aplicación (OC_PREFIX, OC_PAD) y no tienen
 * por qué vivir en la base.
 */
async function aprobar(id, { usuario, formatear, cambios = {} }) {
  return pg.tx(async (c) => {
    const n = await c.query('SELECT erp.siguiente_numero_oc() AS n');
    const numero = formatear(Number(n.rows[0].n));

    const sets = ['numero_oc = $1', "estado = 'aprobada'", 'aprobado_por = $2',
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
      `UPDATE erp.ordenes_compra SET ${sets.join(', ')}
        WHERE id = $${vals.length} RETURNING id`, vals);
    if (!r.rowCount) throw new Error(`Orden de compra ${id} no existe`);
    return numero;
  });
}

const COLUMNAS = {
  numeroOC: 'numero_oc', estado: 'estado', tipoGasto: 'tipo_gasto',
  lugarEntrega: 'lugar_entrega', fechaEntregaPrevista: 'fecha_entrega_prevista',
  condicionesComerciales: 'condiciones_comerciales', observaciones: 'observaciones',
  aprobadoPor: 'aprobado_por', fechaAprobacion: 'fecha_aprobacion',
  anuladoPor: 'anulado_por', fechaAnulacion: 'fecha_anulacion',
  motivoAnulacion: 'motivo_anulacion',
  pagado: 'pagado', pagadoPor: 'pagado_por', fechaPago: 'fecha_pago',
  entregado: 'entregado', entregadoPor: 'entregado_por', fechaEntrega: 'fecha_entrega',
  pdfUrl: 'pdf_url', xlsxUrl: 'xlsx_url',
  subtotal: 'subtotal', iva: 'iva', total: 'total',
  requerimientoId: 'requerimiento_id', requerimientoOrigen: 'requerimiento_origen',
  cotizacionId: 'cotizacion_id',
  solicitudTesoreriaId: 'solicitud_tesoreria_id',
  solicitudTesoreriaPor: 'solicitud_tesoreria_por',
  fechaSolicitudTesoreria: 'fecha_solicitud_tesoreria',
};

/** Actualización parcial con los nombres de SharePoint. itemsJson aparte. */
async function actualizar(id, cambios) {
  const { itemsJson, ...resto } = cambios || {};

  if (itemsJson !== undefined) {
    let items = [];
    try { items = JSON.parse(itemsJson || '[]'); } catch {}
    await pg.tx(async (c) => {
      await c.query('DELETE FROM erp.orden_compra_items WHERE orden_compra_id = $1', [id]);
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
      `UPDATE erp.ordenes_compra SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  return obtener(id);
}

async function insertarItems(c, id, items) {
  let linea = 0;
  for (const it of items || []) {
    const desc = String(it.descripcion ?? it.insumo ?? '').trim();
    if (!desc) continue;
    const pct = (v) => Math.min(100, Math.max(0, Number(v) || 0));
    await c.query(
      `INSERT INTO erp.orden_compra_items
         (orden_compra_id, linea, descripcion, insumo_original, cantidad, unidad,
          precio_unitario, descuento_pct, iva_pct)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'UND'),$7,$8,$9)`,
      [
        id, ++linea, desc.toUpperCase(), it.insumoOriginal || null,
        Number(it.cantidad) || 0, String(it.unidad || '').trim() || null,
        Number(it.precioUnitario) || 0, pct(it.descuentoPct), pct(it.ivaPct),
      ]);
  }
}

// ── Resolución de catálogos ─────────────────────────────────────────────────
// Crea la fila marcada para revisión si el proyecto o el proveedor no están,
// igual que hace el import: se prefiere no perder la referencia del documento
// antes que rechazarlo.

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
  const norm = await c.query('SELECT erp.norm_nit($1) AS n', [s]);
  const clave = norm.rows[0].n;
  if (!clave) return null;
  const hallado = await c.query('SELECT nit FROM erp.proveedores WHERE nit = $1', [clave]);
  if (hallado.rowCount) return clave;
  await c.query(
    `INSERT INTO erp.proveedores (nit, nit_original, razon_social, activo, requiere_revision)
     VALUES ($1, $2, $3, false, true) ON CONFLICT (nit) DO NOTHING`,
    [clave, s, String(nombre || '').trim() || '(sin nombre)']);
  return clave;
}

module.exports = {
  listar, obtener, obtenerVarias,
  crear, aprobar, actualizar,
};
