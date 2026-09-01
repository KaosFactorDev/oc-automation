'use strict';
/**
 * repo/remisiones.js — Remisiones, sus ítems y las OC que respaldan.
 *
 * ── El número ──────────────────────────────────────────────────────────────
 * Antes salía de (cantidad de remisiones + 1). Con eso, borrar una remisión
 * hacía que la siguiente repitiera un número, y dos creadas en el mismo segundo
 * obtenían el mismo — las dos cosas pasaron: REM-00011 existía dos veces, con
 * un segundo de diferencia, por un doble clic en el formulario.
 *
 * Acá lo emite erp.siguiente_numero_remision() dentro de la transacción que
 * inserta la remisión.
 *
 * ── ocIds y ocsAsociadas ───────────────────────────────────────────────────
 * En SharePoint eran dos columnas de texto: un array JSON de ids y los números
 * en texto para mostrar. Ahora las OC se relacionan por erp.remision_ordenes y
 * las dos columnas se derivan de ahí con un join, así que no pueden discrepar
 * entre sí ni con la realidad.
 */

const pg = require('../pg');

const CAMPOS = `
  r.id, r.numero, r.fecha, r.proyecto_id, r.observaciones,
  r.responsable_entrega, r.responsable_recepcion, r.lugar_entrega,
  r.estado, r.motivo_anulacion, r.alertas, r.creado_por, r.fecha_creacion, r.sp_id,
  p.codigo AS proyecto`;

const DESDE = `FROM erp.remisiones r
  LEFT JOIN erp.proyectos p ON p.id = r.proyecto_id`;

const iso = (d) => (d ? d.toISOString() : null);

function mapear(r, items = [], ocs = []) {
  return {
    id:                   String(r.id),
    numero:               r.numero,
    fecha:                iso(r.fecha),
    proyecto:             r.proyecto || '',
    proyectoId:           r.proyecto_id,
    // Las dos formas que tenía SharePoint, ahora derivadas del join.
    ocIds:                JSON.stringify(ocs.map(o => String(o.id))),
    ocsAsociadas:         ocs.map(o => o.numero_oc).filter(Boolean).join(', '),
    itemsJson:            JSON.stringify(items),
    observaciones:        r.observaciones || '',
    responsableEntrega:   r.responsable_entrega || '',
    responsableRecepcion: r.responsable_recepcion || '',
    lugarEntrega:         r.lugar_entrega || '',
    estado:               r.estado,
    motivoAnulacion:      r.motivo_anulacion || '',
    alertas:              r.alertas || '',
    creadoPor:            r.creado_por || '',
    fechaCreacion:        iso(r.fecha_creacion),
    sp_id:                r.sp_id,
  };
}

const mapearItem = (i) => ({
  descripcion: i.descripcion,
  unidad:      i.unidad,
  cantidad:    Number(i.cantidad),
  observacion: i.observacion || '',
});

async function detallesDe(ids) {
  if (!ids.length) return { items: new Map(), ocs: new Map() };

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

  const items = new Map();
  for (const f of filasItems) {
    const k = String(f.remision_id);
    if (!items.has(k)) items.set(k, []);
    items.get(k).push(mapearItem(f));
  }
  const ocs = new Map();
  for (const f of filasOcs) {
    const k = String(f.remision_id);
    if (!ocs.has(k)) ocs.set(k, []);
    ocs.get(k).push({ id: f.id, numero_oc: f.numero_oc });
  }
  return { items, ocs };
}

async function armar(cabeceras) {
  const { items, ocs } = await detallesDe(cabeceras.map(c => c.id));
  return cabeceras.map(c =>
    mapear(c, items.get(String(c.id)) || [], ocs.get(String(c.id)) || []));
}

async function listar({ estado = null, proyectoId = null } = {}) {
  const cond = [];
  const vals = [];
  if (estado)     { vals.push(estado);     cond.push(`r.estado = $${vals.length}`); }
  if (proyectoId) { vals.push(proyectoId); cond.push(`r.proyecto_id = $${vals.length}`); }

  return armar(await pg.rows(
    `SELECT ${CAMPOS} ${DESDE}
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY r.fecha DESC NULLS LAST, r.id DESC`, vals));
}

async function obtener(id) {
  const r = await pg.one(`SELECT ${CAMPOS} ${DESDE} WHERE r.id = $1`, [id]);
  if (!r) return null;
  return (await armar([r]))[0];
}

/** Las remisiones que respaldan una OC. Antes era recorrer todas y parsear ocIds. */
async function porOrdenCompra(ocId) {
  return armar(await pg.rows(
    `SELECT ${CAMPOS} ${DESDE}
       JOIN erp.remision_ordenes ro ON ro.remision_id = r.id
      WHERE ro.orden_compra_id = $1
      ORDER BY r.id`, [Number(ocId)]));
}

// ── Escritura ───────────────────────────────────────────────────────────────

const COLUMNAS = {
  fecha: 'fecha', observaciones: 'observaciones',
  responsableEntrega: 'responsable_entrega',
  responsableRecepcion: 'responsable_recepcion',
  lugarEntrega: 'lugar_entrega', estado: 'estado',
  motivoAnulacion: 'motivo_anulacion', alertas: 'alertas',
  creadoPor: 'creado_por', fechaCreacion: 'fecha_creacion',
};

/**
 * Crea la remisión con su número, sus ítems y su vínculo con las OC, todo en
 * una transacción. Devuelve { id, numero }.
 */
async function crear(datos, items = [], ocIds = []) {
  return pg.tx(async (c) => {
    const numero = datos.numero
      || (await c.query('SELECT erp.siguiente_numero_remision() AS n')).rows[0].n;

    const proyectoId = await resolverProyecto(c, datos.proyecto);

    const cab = await c.query(
      `INSERT INTO erp.remisiones
         (numero, fecha, proyecto_id, observaciones, responsable_entrega,
          responsable_recepcion, lugar_entrega, estado, alertas, creado_por, fecha_creacion)
       VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, COALESCE($8,'activa'),
               $9, $10, COALESCE($11, now()))
       RETURNING id`,
      [
        numero, datos.fecha || null, proyectoId, datos.observaciones || null,
        datos.responsableEntrega || null, datos.responsableRecepcion || null,
        datos.lugarEntrega || null, datos.estado || null, datos.alertas || null,
        datos.creadoPor || null, datos.fechaCreacion || null,
      ]);
    const id = cab.rows[0].id;

    let linea = 0;
    for (const it of items || []) {
      const desc = String(it.descripcion ?? it.insumo ?? '').trim();
      if (!desc) continue;
      await c.query(
        `INSERT INTO erp.remision_items
           (remision_id, linea, descripcion, cantidad, unidad, observacion)
         VALUES ($1,$2,$3,$4,COALESCE($5,'UND'),$6)`,
        [id, ++linea, desc, Number(it.cantidad) || 0,
         String(it.unidad || '').trim() || null, it.observacion || null]);
    }

    // La PK compuesta no admite repetidos, así que se deduplica antes.
    for (const ocId of [...new Set((ocIds || []).map(Number).filter(Boolean))]) {
      await c.query(
        `INSERT INTO erp.remision_ordenes (remision_id, orden_compra_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, ocId]);
    }

    return { id: String(id), numero };
  });
}

async function actualizar(id, cambios) {
  const sets = [];
  const vals = [];
  for (const [clave, valor] of Object.entries(cambios || {})) {
    const col = COLUMNAS[clave];
    if (!col) continue;
    vals.push(valor);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return obtener(id);
  vals.push(id);
  await pg.query(
    `UPDATE erp.remisiones SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  return obtener(id);
}

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

module.exports = { listar, obtener, porOrdenCompra, crear, actualizar };
