'use strict';
/**
 * repo/historial.js — La bitácora de las órdenes (erp.documentos_historial).
 *
 * Solo dos operaciones, porque la tabla es de solo agregar: registrar una fila y
 * leer las de un documento. Qué se registra y cómo se arma la foto del documento
 * lo decide src/bitacora.js; acá solo se escribe y se lee.
 */

const pg = require('../pg');

const TIPOS = ['orden_compra', 'orden_servicio'];

/**
 * Agrega una fila. `c` es opcional: con él, la fila entra en la transacción del
 * llamador y se pierde si esa transacción se deshace.
 */
async function registrar(e, c = null) {
  if (!TIPOS.includes(e.tipo)) throw new Error(`Tipo de documento desconocido: ${e.tipo}`);
  const sql = `
    INSERT INTO erp.documentos_historial
      (documento_tipo, documento_id, numero, accion, usuario, usuario_nombre,
       origen, motivo, antes, despues)
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'consola'), $8, $9, $10)
    RETURNING id`;
  const vals = [
    e.tipo, Number(e.id), e.numero || null, e.accion,
    String(e.usuario || '').trim() || 'sistema', e.usuarioNombre || null,
    e.origen || null, e.motivo || null,
    e.antes == null ? null : JSON.stringify(e.antes),
    e.despues == null ? null : JSON.stringify(e.despues),
  ];
  const r = c ? await c.query(sql, vals) : await pg.query(sql, vals);
  return String(r.rows[0].id);
}

/** Las filas de un documento, de la más vieja a la más nueva. */
async function deDocumento(tipo, id) {
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo de documento desconocido: ${tipo}`);
  return pg.rows(
    `SELECT id, accion, numero, usuario, usuario_nombre, origen, motivo,
            antes, despues, creado_en
       FROM erp.documentos_historial
      WHERE documento_tipo = $1 AND documento_id = $2
      ORDER BY creado_en, id`, [tipo, Number(id)]);
}

module.exports = { registrar, deDocumento, TIPOS };
