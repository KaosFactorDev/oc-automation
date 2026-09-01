'use strict';
/**
 * repo/requerimientos.js — Requerimientos y sus ítems.
 *
 * Primer documento que baja a Postgres, y el primero donde los ítems dejan de
 * ser un string itemsJson: viven en erp.requerimiento_items. Para que la
 * consola y las plantillas no cambien, las funciones de lectura vuelven a
 * armar `itemsJson` con la forma exacta que tenían en SharePoint.
 *
 * ── Lo que gana estando acá ────────────────────────────────────────────────
 *  · La deduplicación por correo es un índice único, no una consulta filtrada
 *    sobre una columna que SharePoint no tenía indexada y que obligaba a mandar
 *    el header "HonorNonIndexedQueriesWarningMayFailRandomly" — cuyo nombre ya
 *    dice lo que uno podía esperar.
 *  · El consecutivo por proyecto es atómico. Antes era concurrencia optimista
 *    con ETag y reintento en 412, con un contador de respaldo en SQLite que se
 *    desalineaba: SharePoint decía 9 para EQUIPOS GT 2026 cuando los
 *    requerimientos ya iban en 0012.
 *  · Crear el requerimiento y emitir su consecutivo ocurren en la misma
 *    transacción, así que un fallo no consume un número.
 */

const pg = require('../pg');

// ── Lectura ─────────────────────────────────────────────────────────────────

const CABECERA = `
  r.id, r.consecutivo, r.consecutivo_sistema, r.proyecto_id, r.fecha_solicitud,
  r.solicitante, r.estado, r.origen_correo_id, r.adjunto_url, r.bloqueado_por,
  r.bloqueado_hasta, r.notas, r.sp_id, r.created_at, r.updated_at,
  p.codigo AS proyecto`;

/**
 * Devuelve el requerimiento con la forma que espera el resto del sistema: los
 * mismos nombres de campo que traía el item de SharePoint, incluido itemsJson
 * como string. Los consumidores (plantillas, consola, cálculo de cobertura)
 * quedan sin tocar.
 */
function mapear(r, items = []) {
  return {
    id:                 String(r.id),
    consecutivo:        r.consecutivo || '',
    consecutivoSistema: r.consecutivo_sistema || '',
    proyecto:           r.proyecto || '',
    proyectoId:         r.proyecto_id,
    fechaSolicitud:     r.fecha_solicitud ? r.fecha_solicitud.toISOString() : '',
    solicitante:        r.solicitante || '',
    estado:             r.estado,
    origenCorreoId:     r.origen_correo_id || '',
    adjuntoUrl:         r.adjunto_url || '',
    bloqueadoPor:       r.bloqueado_por || '',
    bloqueadoHasta:     r.bloqueado_hasta ? r.bloqueado_hasta.toISOString() : null,
    notas:              r.notas || '',
    itemsJson:          JSON.stringify(items),
    // ocsGeneradas ya no se guarda: se deriva de ordenes_compra.requerimiento_id.
    ocsGeneradas:       (r.ocs_generadas || []).join(', '),
    sp_id:              r.sp_id,
  };
}

/** Ítems con la misma forma que tenían dentro de itemsJson. */
function mapearItem(i) {
  const item = {
    insumo:           i.insumo,
    cantidad:         Number(i.cantidad),
    unidad:           i.unidad,
    necesidad:        i.necesidad || '',
    posibleProveedor: i.posible_proveedor || '',
    consulta:         i.consulta || null,
  };
  // Solo se incluyen si tienen valor, igual que en SharePoint: el cálculo de
  // cobertura distingue entre ausente y falso.
  if (i.homologado_con) item.homologadoCon = i.homologado_con;
  if (i.descartado)     item.descartado    = true;
  return item;
}

async function itemsDe(ids) {
  if (!ids.length) return new Map();
  const filas = await pg.rows(
    `SELECT requerimiento_id, linea, insumo, cantidad, unidad, necesidad,
            posible_proveedor, homologado_con, descartado, consulta
       FROM erp.requerimiento_items
      WHERE requerimiento_id = ANY($1::bigint[])
      ORDER BY requerimiento_id, linea`, [ids]);
  const porDoc = new Map();
  for (const f of filas) {
    const k = String(f.requerimiento_id);
    if (!porDoc.has(k)) porDoc.set(k, []);
    porDoc.get(k).push(mapearItem(f));
  }
  return porDoc;
}

/** Las OC generadas por cada requerimiento, derivadas de la llave foránea. */
async function ocsDe(ids) {
  if (!ids.length) return new Map();
  const filas = await pg.rows(
    `SELECT requerimiento_id, id FROM erp.ordenes_compra
      WHERE requerimiento_id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  const porDoc = new Map();
  for (const f of filas) {
    const k = String(f.requerimiento_id);
    if (!porDoc.has(k)) porDoc.set(k, []);
    porDoc.get(k).push(String(f.id));
  }
  return porDoc;
}

async function listar({ estado = null, proyectoId = null } = {}) {
  const cond = [];
  const vals = [];
  if (estado)     { vals.push(estado);     cond.push(`r.estado = $${vals.length}`); }
  if (proyectoId) { vals.push(proyectoId); cond.push(`r.proyecto_id = $${vals.length}`); }

  const cabeceras = await pg.rows(
    `SELECT ${CABECERA} FROM erp.requerimientos r
       LEFT JOIN erp.proyectos p ON p.id = r.proyecto_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY r.fecha_solicitud DESC NULLS LAST, r.id DESC`, vals);

  const ids = cabeceras.map(c => c.id);
  const [items, ocs] = await Promise.all([itemsDe(ids), ocsDe(ids)]);
  return cabeceras.map(c =>
    mapear({ ...c, ocs_generadas: ocs.get(String(c.id)) || [] }, items.get(String(c.id)) || []));
}

async function obtener(id) {
  const r = await pg.one(
    `SELECT ${CABECERA} FROM erp.requerimientos r
       LEFT JOIN erp.proyectos p ON p.id = r.proyecto_id
      WHERE r.id = $1`, [id]);
  if (!r) return null;
  const [items, ocs] = await Promise.all([itemsDe([r.id]), ocsDe([r.id])]);
  return mapear({ ...r, ocs_generadas: ocs.get(String(r.id)) || [] }, items.get(String(r.id)) || []);
}

/** Para deduplicar un correo ya procesado. */
async function porOrigenCorreo(messageId) {
  const r = await pg.one(
    'SELECT id FROM erp.requerimientos WHERE origen_correo_id = $1', [String(messageId || '')]);
  return r ? obtener(r.id) : null;
}

// ── Escritura ───────────────────────────────────────────────────────────────

/**
 * Crea el requerimiento con sus ítems y emite su consecutivo de proyecto, todo
 * en una transacción. Si algo falla, el consecutivo no se consume — que es lo
 * que el esquema de contadores promete y la variante con ETag no podía dar.
 *
 * `datos` usa los nombres de SharePoint, para que mapearFields() en
 * requerimientos.js siga sirviendo sin traducción.
 */
async function crear(datos, items = []) {
  return pg.tx(async (c) => {
    // El proyecto llega como texto; se resuelve al catálogo y, si no existe, se
    // crea marcado para revisión — igual que hace el import.
    let proyectoId = null;
    const proyectoTxt = String(datos.proyecto || '').trim();
    if (proyectoTxt) {
      const hallado = await c.query(
        'SELECT id FROM erp.proyectos WHERE erp.norm(codigo) = erp.norm($1)', [proyectoTxt]);
      if (hallado.rowCount) {
        proyectoId = hallado.rows[0].id;
      } else {
        const creado = await c.query(
          `INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
           VALUES ($1, $1, false, true) RETURNING id`, [proyectoTxt]);
        proyectoId = creado.rows[0].id;
      }
    }

    // Si el llamador ya trae un consecutivo, se respeta; si no, se emite.
    const consecutivoSistema = String(datos.consecutivoSistema || '').trim()
      || (await c.query('SELECT erp.siguiente_consecutivo_req($1) AS n', [proyectoId])).rows[0].n;

    const cab = await c.query(
      `INSERT INTO erp.requerimientos
         (consecutivo, consecutivo_sistema, proyecto_id, fecha_solicitud, solicitante,
          estado, origen_correo_id, adjunto_url, notas)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6,'pendiente'), $7, $8, $9)
       RETURNING id`,
      [
        String(datos.consecutivo || ''), consecutivoSistema, proyectoId,
        datos.fechaSolicitud || null, datos.solicitante || null,
        datos.estado || null,
        String(datos.origenCorreoId || '').trim() || null,
        datos.adjuntoUrl || null, datos.notas || null,
      ]);
    const id = cab.rows[0].id;

    await insertarItems(c, id, items);
    return { id: String(id), consecutivoSistema };
  });
}

/** Reemplaza los ítems del requerimiento. Se usa al homologar insumos. */
async function reemplazarItems(id, items) {
  return pg.tx(async (c) => {
    await c.query('DELETE FROM erp.requerimiento_items WHERE requerimiento_id = $1', [id]);
    await insertarItems(c, id, items);
  });
}

async function insertarItems(c, id, items) {
  let linea = 0;
  for (const it of items || []) {
    const insumo = String(it.insumo ?? it.descripcion ?? '').trim();
    if (!insumo) continue;   // el CHECK lo rechazaría; se omite en silencio como antes
    await c.query(
      `INSERT INTO erp.requerimiento_items
         (requerimiento_id, linea, insumo, cantidad, unidad, necesidad,
          posible_proveedor, homologado_con, descartado, consulta)
       VALUES ($1,$2,$3,$4,COALESCE($5,'UND'),$6,$7,$8,$9,$10)`,
      [
        id, ++linea, insumo,
        Number(it.cantidad) || 0, String(it.unidad || '').trim() || null,
        it.necesidad || null, it.posibleProveedor || null,
        it.homologadoCon || null, !!it.descartado,
        it.consulta ? JSON.stringify(it.consulta) : null,
      ]);
  }
}

/** Actualización parcial de la cabecera, con los nombres de SharePoint. */
async function actualizar(id, cambios) {
  const MAPA = {
    consecutivo: 'consecutivo', consecutivoSistema: 'consecutivo_sistema',
    fechaSolicitud: 'fecha_solicitud', solicitante: 'solicitante', estado: 'estado',
    adjuntoUrl: 'adjunto_url', bloqueadoPor: 'bloqueado_por',
    bloqueadoHasta: 'bloqueado_hasta', notas: 'notas',
  };
  const sets = [];
  const vals = [];
  for (const [clave, valor] of Object.entries(cambios || {})) {
    const col = MAPA[clave];
    if (!col) continue;   // ocsGeneradas y itemsJson se manejan aparte
    vals.push(valor === '' && (col === 'bloqueado_por') ? null : valor);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return obtener(id);

  vals.push(id);
  await pg.query(
    `UPDATE erp.requerimientos SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  return obtener(id);
}

module.exports = {
  listar, obtener, porOrigenCorreo,
  crear, actualizar, reemplazarItems,
};
