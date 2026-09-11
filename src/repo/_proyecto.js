'use strict';
/**
 * _proyecto.js — Resolución del proyecto de un documento, en un solo sitio.
 *
 * Los seis módulos de documentos —requerimientos, órdenes de compra y de
 * servicio, remisiones, inventario e historial de precios— reciben el proyecto
 * como texto y tienen que convertirlo en la llave foránea `proyecto_id`.
 *
 * Antes cada uno resolvía por su cuenta y, si no encontraba el proyecto, lo
 * creaba:
 *
 *   INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
 *   VALUES ($1, $1, false, true)
 *
 * Nacía inactivo, así que no aparecía en los desplegables, pero el catálogo
 * crecía con una fila por cada variante mal escrita que entrara por correo.
 * Así aparecieron los 23 proyectos señalados durante la migración.
 *
 * Ahora no se crea nada. Si el texto no resuelve, el documento se guarda
 * igual con `proyecto_id` en NULL y el texto queda en `proyecto_texto`, para
 * que una persona le asigne el proyecto desde la bandeja de pendientes
 * (`erp.vw_documentos_sin_proyecto`).
 *
 * **Por qué el documento no falla.** El proyecto llega en el asunto de un
 * correo que escribe alguien de obra, a mano y abreviado. Rechazar el
 * requerimiento por un código mal tecleado perdería trabajo real; dejarlo sin
 * asignar lo hace visible y reparable en un clic.
 */

const pg = require('../pg');

/**
 * Resuelve el texto del proyecto contra el catálogo. No crea nada.
 *
 * @param {object} c        cliente dentro de la transacción del llamador
 * @param {string} texto    el proyecto tal como llegó
 * @returns {Promise<{proyectoId: number|null, proyectoTexto: string|null}>}
 *          `proyectoTexto` solo viene cuando NO se pudo resolver: es lo que se
 *          guarda en el documento como pista para quien lo asigne.
 */
async function resolver(c, texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) return { proyectoId: null, proyectoTexto: null };

  const hallado = await c.query(
    'SELECT id FROM erp.proyectos WHERE erp.norm(codigo) = erp.norm($1)',
    [limpio],
  );

  if (hallado.rowCount) {
    return { proyectoId: hallado.rows[0].id, proyectoTexto: null };
  }

  return { proyectoId: null, proyectoTexto: limpio };
}

/**
 * Los documentos que quedaron sin proyecto, de los seis tipos, en una sola
 * lista. Sale de `erp.vw_documentos_sin_proyecto`.
 *
 * `proyecto_texto` es lo que hace útil la bandeja: sin él, quien la abre ve un
 * requerimiento sin proyecto y no tiene con qué decidir cuál asignarle.
 */
async function pendientes({ limite = 200 } = {}) {
  const filas = await pg.rows(
    `SELECT tipo, id, numero, proyecto_texto, created_at
       FROM erp.vw_documentos_sin_proyecto
      ORDER BY created_at DESC
      LIMIT $1`, [limite]);
  return filas.map((f) => ({
    tipo:          f.tipo,
    id:            String(f.id),
    numero:        f.numero || '',
    proyectoTexto: f.proyecto_texto || '',
    createdAt:     f.created_at,
  }));
}

/** Cuántos hay pendientes, para el contador del menú. */
async function contarPendientes() {
  const r = await pg.one('SELECT count(*)::int AS n FROM erp.vw_documentos_sin_proyecto');
  return r ? r.n : 0;
}

module.exports = { resolver, pendientes, contarPendientes };
