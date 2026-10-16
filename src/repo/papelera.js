'use strict';
/**
 * repo/papelera.js — Mandar una orden a la papelera y restaurarla.
 *
 * Cada operación es UNA transacción: la orden y todo lo que la papelera deshace
 * en otros documentos cambian juntos, o no cambia nada. Cada cambio en otro
 * documento queda en erp.papelera_efectos con el valor anterior, y restaurar lo
 * devuelve tal cual. Las reglas de cuándo se puede (admin, motivo, pagos,
 * tesorería) viven en el servidor; acá solo se escribe.
 */

const pg = require('../pg');
const { EstadoInvalido } = require('./_estado');

const TABLA = { orden_compra: 'ordenes_compra', orden_servicio: 'ordenes_servicio' };

// Las columnas que la papelera toca en cada tabla, y que restaurar devuelve.
const COLUMNAS_REVERTIBLES = {
  movimientos_inventario: ['estado', 'estado_doc'],
  remisiones:             ['estado', 'motivo_anulacion', 'alertas'],
  historial_precios:      ['estado_compra'],
};

async function anotarEfecto(c, tipo, id, tabla, filaId, antes) {
  await c.query(
    `INSERT INTO erp.papelera_efectos (documento_tipo, documento_id, tabla, fila_id, antes)
     VALUES ($1, $2, $3, $4, $5)`, [tipo, Number(id), tabla, Number(filaId), JSON.stringify(antes)]);
}

/**
 * Manda la orden a la papelera y deshace lo que dejó en otros documentos.
 * @returns {Promise<{movimientos: string[], remisiones: Array, precios: number}>}
 */
async function enviar(tipo, id, { usuario, motivo }) {
  const tabla = TABLA[tipo];
  if (!tabla) throw new Error(`Tipo de documento desconocido: ${tipo}`);

  return pg.tx(async (c) => {
    const doc = await c.query(
      `SELECT id, papelera_en, ${tipo === 'orden_compra' ? 'numero_oc' : 'numero_os'} AS numero
         FROM erp.${tabla} WHERE id = $1 FOR UPDATE`, [id]);
    if (!doc.rowCount) throw Object.assign(new Error('Orden no encontrada'), { status: 404 });
    if (doc.rows[0].papelera_en) throw new EstadoInvalido('La orden ya está en la papelera.');
    const numero = doc.rows[0].numero || `id ${id}`;

    await c.query(
      `UPDATE erp.${tabla} SET papelera_en = now(), papelera_por = $2, papelera_motivo = $3 WHERE id = $1`,
      [id, usuario, motivo]);

    const efectos = { movimientos: [], remisiones: [], precios: 0 };
    if (tipo !== 'orden_compra') return efectos;

    // Almacén: los movimientos vigentes que salieron de esta orden.
    const movs = await c.query(
      `SELECT id, estado, estado_doc, documento_ref FROM erp.movimientos_inventario
        WHERE orden_compra_id = $1 AND estado <> 'anulado' FOR UPDATE`, [id]);
    for (const m of movs.rows) {
      await anotarEfecto(c, tipo, id, 'movimientos_inventario', m.id, { estado: m.estado, estado_doc: m.estado_doc });
      await c.query(
        `UPDATE erp.movimientos_inventario SET estado = 'anulado', estado_doc = 'anulado' WHERE id = $1`, [m.id]);
    }
    efectos.movimientos = [...new Set(movs.rows.map(m => m.documento_ref).filter(Boolean))];

    // Remisiones: si la orden es la única, se anula; si tiene otras, queda para
    // reemplazo. Igual que cuando se anula una orden.
    const rems = await c.query(
      `SELECT r.id, r.numero, r.estado, r.motivo_anulacion, r.alertas,
              (SELECT count(*) FROM erp.remision_ordenes ro2
                 JOIN erp.ordenes_compra o2 ON o2.id = ro2.orden_compra_id
                WHERE ro2.remision_id = r.id AND o2.id <> $1
                  AND o2.estado <> 'anulada' AND o2.papelera_en IS NULL) AS otras
         FROM erp.remisiones r
         JOIN erp.remision_ordenes ro ON ro.remision_id = r.id
        WHERE ro.orden_compra_id = $1 AND r.estado <> 'anulada'
        FOR UPDATE OF r`, [id]);
    const hoy = new Date().toLocaleDateString('es-CO');
    for (const r of rems.rows) {
      await anotarEfecto(c, tipo, id, 'remisiones', r.id,
        { estado: r.estado, motivo_anulacion: r.motivo_anulacion, alertas: r.alertas });
      if (Number(r.otras) === 0) {
        await c.query(
          `UPDATE erp.remisiones SET estado = 'anulada', motivo_anulacion = $2 WHERE id = $1`,
          [r.id, `OC ${numero} enviada a la papelera por ${usuario} el ${hoy}: ${motivo}`]);
        efectos.remisiones.push({ numero: r.numero, accion: 'anulada' });
      } else {
        const alerta = `⚠ OC ${numero} se envió a la papelera el ${hoy}. Hay que generar una remisión nueva para las otras órdenes.`;
        await c.query(
          `UPDATE erp.remisiones SET estado = 'requiere-reemplazo',
                  alertas = concat_ws(E'\\n', nullif(alertas, ''), $2::text) WHERE id = $1`, [r.id, alerta]);
        efectos.remisiones.push({ numero: r.numero, accion: 'requiere-reemplazo' });
      }
    }

    // Precios: los que dejó esta orden dejan de sugerirse.
    if (doc.rows[0].numero) {
      const precios = await c.query(
        `SELECT id, estado_compra FROM erp.historial_precios
          WHERE numero_compra = $1 AND COALESCE(estado_compra, '') NOT IN ('Corregida', 'Papelera')
          FOR UPDATE`, [doc.rows[0].numero]);
      for (const p of precios.rows) {
        await anotarEfecto(c, tipo, id, 'historial_precios', p.id, { estado_compra: p.estado_compra });
        await c.query(`UPDATE erp.historial_precios SET estado_compra = 'Papelera' WHERE id = $1`, [p.id]);
      }
      efectos.precios = precios.rowCount;
    }
    return efectos;
  });
}

/**
 * Saca la orden de la papelera y devuelve cada efecto a su valor anterior.
 * @returns {Promise<{revertidos: number}>}
 */
async function restaurar(tipo, id) {
  const tabla = TABLA[tipo];
  if (!tabla) throw new Error(`Tipo de documento desconocido: ${tipo}`);

  return pg.tx(async (c) => {
    const doc = await c.query(`SELECT papelera_en FROM erp.${tabla} WHERE id = $1 FOR UPDATE`, [id]);
    if (!doc.rowCount) throw Object.assign(new Error('Orden no encontrada'), { status: 404 });
    if (!doc.rows[0].papelera_en) throw new EstadoInvalido('La orden no está en la papelera.');

    const efectos = await c.query(
      `SELECT id, tabla, fila_id, antes FROM erp.papelera_efectos
        WHERE documento_tipo = $1 AND documento_id = $2 AND revertido_en IS NULL
        ORDER BY id DESC FOR UPDATE`, [tipo, Number(id)]);
    for (const e of efectos.rows) {
      const permitidas = COLUMNAS_REVERTIBLES[e.tabla] || [];
      const cols = Object.keys(e.antes).filter(k => permitidas.includes(k));
      if (!cols.length) continue;
      const sets = cols.map((k, i) => `${k} = $${i + 2}`);
      await c.query(`UPDATE erp.${e.tabla} SET ${sets.join(', ')} WHERE id = $1`,
        [e.fila_id, ...cols.map(k => e.antes[k])]);
      await c.query('UPDATE erp.papelera_efectos SET revertido_en = now() WHERE id = $1', [e.id]);
    }

    await c.query(
      `UPDATE erp.${tabla} SET papelera_en = NULL, papelera_por = NULL, papelera_motivo = NULL WHERE id = $1`, [id]);
    return { revertidos: efectos.rowCount };
  });
}

/** Lo que está en la papelera, de los dos tipos, lo más reciente primero. */
async function listar() {
  return pg.rows(
    `SELECT 'orden_compra' AS tipo, o.id, o.numero_oc AS numero, o.estado, o.total,
            p.codigo AS proyecto, pr.razon_social AS proveedor,
            o.papelera_en, o.papelera_por, o.papelera_motivo
       FROM erp.ordenes_compra o
       LEFT JOIN erp.proyectos p    ON p.id = o.proyecto_id
       LEFT JOIN erp.proveedores pr ON pr.nit = o.proveedor_nit
      WHERE o.papelera_en IS NOT NULL
     UNION ALL
     SELECT 'orden_servicio', s.id, s.numero_os, s.estado, s.total,
            p.codigo, pr.razon_social, s.papelera_en, s.papelera_por, s.papelera_motivo
       FROM erp.ordenes_servicio s
       LEFT JOIN erp.proyectos p    ON p.id = s.proyecto_id
       LEFT JOIN erp.proveedores pr ON pr.nit = s.proveedor_nit
      WHERE s.papelera_en IS NOT NULL
     ORDER BY papelera_en DESC`);
}

module.exports = { enviar, restaurar, listar };
