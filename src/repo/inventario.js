'use strict';
/**
 * repo/inventario.js — Movimientos de almacén y stock.
 *
 * ── Dos cosas que dejan de calcularse en JavaScript ────────────────────────
 *
 * El stock. db.getStock() bajaba todos los movimientos y los agrupaba en
 * memoria. Acá es una agregación SQL, y devuelve los mismos campos —insumo,
 * unidad, entradas, salidas, stock, valorInventario, valorGastado— con el mismo
 * orden, para que la consola no cambie.
 *
 * El consecutivo del documento de almacén. db.getNextDocRef() lo sacaba de un
 * MAX() sobre documentoRef, con la misma condición de carrera que tenía el
 * contador de OC. Acá lo emite erp.siguiente_documento_almacen(), atómico
 * dentro de la transacción del llamador.
 *
 * ── Sobre el signo ─────────────────────────────────────────────────────────
 * La cantidad se guarda siempre positiva: el sentido lo lleva la columna `tipo`
 * (entrada / salida) y hay un CHECK que lo hace cumplir. Una cantidad negativa
 * sería una entrada que resta, y eso es un error, no un dato.
 */

const pg = require('../pg');

const CAMPOS = `
  m.id, m.tipo, m.fecha, m.proyecto_id, m.orden_compra_id, m.insumo, m.unidad,
  m.cantidad, m.precio_unitario, m.valor_total, m.responsable, m.notas,
  m.estado, m.documento_ref, m.estado_doc, m.batch_id, m.creado_por,
  m.fecha_creacion, m.sp_id,
  p.codigo  AS proyecto,
  o.numero_oc AS numero_oc`;

const DESDE = `FROM erp.movimientos_inventario m
  LEFT JOIN erp.proyectos p      ON p.id = m.proyecto_id
  LEFT JOIN erp.ordenes_compra o ON o.id = m.orden_compra_id`;

const iso = (d) => (d ? d.toISOString() : null);

function mapear(m) {
  return {
    id:             String(m.id),
    tipo:           m.tipo,
    fecha:          iso(m.fecha),
    proyecto:       m.proyecto || '',
    proyectoId:     m.proyecto_id,
    ocId:           m.orden_compra_id ? String(m.orden_compra_id) : '',
    numeroOC:       m.numero_oc || '',
    insumo:         m.insumo,
    unidad:         m.unidad || '',
    cantidad:       Number(m.cantidad),
    precioUnitario: Number(m.precio_unitario),
    valorTotal:     Number(m.valor_total),
    responsable:    m.responsable || '',
    notas:          m.notas || '',
    estado:         m.estado,
    documentoRef:   m.documento_ref || '',
    estadoDoc:      m.estado_doc,
    batchId:        m.batch_id || '',
    creadoPor:      m.creado_por || '',
    fechaCreacion:  iso(m.fecha_creacion),
    sp_id:          m.sp_id,
  };
}

/**
 * Los movimientos vigentes. Excluye los anulados —por movimiento o por
 * documento— igual que hacía el caché.
 */
async function listar({ proyecto = null, incluirAnulados = false } = {}) {
  const cond = [];
  const vals = [];
  if (!incluirAnulados) {
    cond.push(`m.estado <> 'anulado'`, `m.estado_doc <> 'anulado'`);
  }
  if (proyecto) {
    vals.push(proyecto);
    cond.push(`erp.norm(p.codigo) = erp.norm($${vals.length})`);
  }
  return (await pg.rows(
    `SELECT ${CAMPOS} ${DESDE}
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY m.fecha DESC, m.id DESC`, vals)).map(mapear);
}

async function obtener(id) {
  const r = await pg.one(`SELECT ${CAMPOS} ${DESDE} WHERE m.id = $1`, [id]);
  return r ? mapear(r) : null;
}

/**
 * Stock por insumo. El precio unitario que se reporta es el de la última
 * entrada, que es el criterio que ya usaba db.getStock().
 */
async function stock(proyecto = null) {
  const vals = [];
  let filtroProyecto = '';
  if (proyecto) {
    vals.push(proyecto);
    filtroProyecto = `AND erp.norm(p.codigo) = erp.norm($${vals.length})`;
  }

  const filas = await pg.rows(
    `WITH movs AS (
       SELECT m.insumo, COALESCE(m.unidad,'') AS unidad, m.tipo, m.cantidad,
              m.precio_unitario, m.fecha, m.id
         FROM erp.movimientos_inventario m
         LEFT JOIN erp.proyectos p ON p.id = m.proyecto_id
        WHERE m.estado <> 'anulado' AND m.estado_doc <> 'anulado'
          ${filtroProyecto}
     ),
     agregado AS (
       SELECT insumo, unidad,
              COALESCE(sum(cantidad) FILTER (WHERE tipo = 'entrada'), 0) AS entradas,
              COALESCE(sum(cantidad) FILTER (WHERE tipo = 'salida'),  0) AS salidas
         FROM movs GROUP BY insumo, unidad
     ),
     ultimo_precio AS (
       SELECT DISTINCT ON (insumo, unidad) insumo, unidad, precio_unitario
         FROM movs WHERE tipo = 'entrada'
        ORDER BY insumo, unidad, fecha DESC, id DESC
     )
     SELECT a.insumo, a.unidad, a.entradas, a.salidas,
            COALESCE(u.precio_unitario, 0) AS precio_unitario,
            (a.entradas - a.salidas) AS stock,
            round((a.entradas - a.salidas) * COALESCE(u.precio_unitario, 0), 2) AS valor_inventario,
            round(a.salidas * COALESCE(u.precio_unitario, 0), 2) AS valor_gastado
       FROM agregado a
       LEFT JOIN ultimo_precio u ON u.insumo = a.insumo AND u.unidad = a.unidad
      -- Mismo orden que db.getStock(): primero lo que tiene stock, después por
      -- valor de inventario y por valor gastado.
      ORDER BY ((a.entradas - a.salidas) > 0) DESC,
               valor_inventario DESC, valor_gastado DESC`, vals);

  return filas.map(f => ({
    insumo:          f.insumo,
    unidad:          f.unidad,
    precioUnitario:  Number(f.precio_unitario),
    entradas:        Number(f.entradas),
    salidas:         Number(f.salidas),
    stock:           Number(f.stock),
    valorInventario: Number(f.valor_inventario),
    valorGastado:    Number(f.valor_gastado),
  }));
}

/** Las OC que ya tienen al menos una entrada vigente. */
async function ocIdsConEntrada() {
  const filas = await pg.rows(
    `SELECT DISTINCT orden_compra_id FROM erp.movimientos_inventario
      WHERE tipo = 'entrada' AND estado <> 'anulado' AND orden_compra_id IS NOT NULL`);
  return new Set(filas.map(f => String(f.orden_compra_id)));
}

/**
 * Emite el consecutivo del documento de almacén. Atómico: el MAX() anterior
 * podía dar el mismo número a dos registros simultáneos.
 */
async function siguienteDocumentoRef(tipo) {
  const r = await pg.one('SELECT erp.siguiente_documento_almacen($1) AS ref', [tipo]);
  return r.ref;
}

// ── Escritura ───────────────────────────────────────────────────────────────

const COLUMNAS = {
  tipo: 'tipo', fecha: 'fecha', insumo: 'insumo', unidad: 'unidad',
  cantidad: 'cantidad', precioUnitario: 'precio_unitario',
  responsable: 'responsable', notas: 'notas', estado: 'estado',
  documentoRef: 'documento_ref', estadoDoc: 'estado_doc', batchId: 'batch_id',
  creadoPor: 'creado_por', fechaCreacion: 'fecha_creacion',
};

/**
 * Inserta un lote de movimientos en una sola transacción y, si se pide, les
 * asigna el consecutivo del documento. Antes esto eran N llamadas a Graph
 * seguidas de un MAX() para el número: si fallaba a la mitad quedaban
 * movimientos sin documento.
 */
async function crearLote(movimientos, { emitirDocumento = false } = {}) {
  if (!movimientos.length) return { ids: [], documentoRef: null };

  return pg.tx(async (c) => {
    let documentoRef = null;
    if (emitirDocumento) {
      const r = await c.query('SELECT erp.siguiente_documento_almacen($1) AS ref',
                              [movimientos[0].tipo]);
      documentoRef = r.rows[0].ref;
    }

    const ids = [];
    for (const m of movimientos) {
      const proyectoId = await resolverProyecto(c, m.proyecto);
      const r = await c.query(
        `INSERT INTO erp.movimientos_inventario
           (tipo, fecha, proyecto_id, orden_compra_id, insumo, unidad, cantidad,
            precio_unitario, responsable, notas, estado, documento_ref,
            estado_doc, batch_id, creado_por, fecha_creacion)
         VALUES ($1, COALESCE($2, now()), $3, $4, $5, COALESCE($6,'UND'), $7, $8,
                 $9, $10, COALESCE($11,'activo'), $12, COALESCE($13,'borrador'),
                 $14, $15, COALESCE($16, now()))
         RETURNING id`,
        [
          m.tipo, m.fecha || null, proyectoId,
          m.ocId ? Number(m.ocId) : null,
          String(m.insumo || '').trim(), String(m.unidad || '').trim() || null,
          // El signo lo lleva `tipo`; el CHECK rechaza negativos.
          Math.abs(Number(m.cantidad) || 0),
          Number(m.precioUnitario) || 0,
          m.responsable || null, m.notas || null, m.estado || null,
          documentoRef || m.documentoRef || null,
          documentoRef ? 'aprobado' : (m.estadoDoc || null),
          m.batchId || null, m.creadoPor || null, m.fechaCreacion || null,
        ]);
      ids.push(String(r.rows[0].id));
    }
    return { ids, documentoRef };
  });
}

async function crear(datos) {
  const { ids } = await crearLote([datos]);
  return ids[0];
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
    `UPDATE erp.movimientos_inventario SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  return obtener(id);
}

/** Marca un lote como aprobado bajo un mismo documento, en una transacción. */
async function aprobarLote(ids, documentoRef) {
  if (!ids.length) return 0;
  const r = await pg.query(
    `UPDATE erp.movimientos_inventario
        SET documento_ref = $1, estado_doc = 'aprobado'
      WHERE id = ANY($2::bigint[])`, [documentoRef, ids.map(Number)]);
  return r.rowCount;
}

/** Anula por lote (batch_id) o por ids. */
async function anular(ids) {
  if (!ids.length) return 0;
  const r = await pg.query(
    `UPDATE erp.movimientos_inventario
        SET estado = 'anulado', estado_doc = 'anulado'
      WHERE id = ANY($1::bigint[])`, [ids.map(Number)]);
  return r.rowCount;
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

module.exports = {
  listar, obtener, stock, ocIdsConEntrada, siguienteDocumentoRef,
  crear, crearLote, actualizar, aprobarLote, anular,
};
