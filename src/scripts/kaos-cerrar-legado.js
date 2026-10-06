'use strict';
/**
 * kaos-cerrar-legado.js — Cierra los proyectos que no vienen de KAOS.
 *
 *   npm run kaos:cerrar-legado           muestra qué haría, sin tocar nada
 *   npm run kaos:cerrar-legado -- --si   lo aplica
 *
 * KAOS administra el catálogo. Todo lo que quedó del ERP —obras anteriores a la
 * conexión, centros de costo, huérfanos que creó un documento— pasa a ser
 * histórico: se conserva con sus documentos, pero deja de ofrecerse para
 * documentos nuevos.
 *
 * Esto NO borra nada. Solo pone `activo = false`, que es lo que saca la fila de
 * los selectores de creación. El histórico, los informes por obra y el control
 * de costos siguen viéndolos igual.
 *
 * ── Lo que pasa con lo que quede en el aire ─────────────────────────────────
 * Un requerimiento pendiente sobre una de estas obras queda bloqueado: aparece
 * en la bandeja como "obra cerrada" y no se le puede generar la orden de compra
 * hasta que se reasigne o hasta que la obra se dé de alta en KAOS.
 *
 * Eso es deliberado. Es la presión que empuja a registrar en KAOS lo que siga
 * en uso, en vez de seguir trabajando sobre un catálogo que nadie administra.
 */

require('dotenv').config();

const pg = require('../pg');

const APLICAR = process.argv.includes('--si');

const CANDIDATOS = `
  SELECT p.id, p.codigo, p.origen,
         (SELECT count(*) FROM erp.ordenes_compra o WHERE o.proyecto_id = p.id) AS ocs,
         (SELECT count(*) FROM erp.requerimientos r
           WHERE r.proyecto_id = p.id AND r.estado IN ('pendiente','parcial')) AS reqs_abiertos
    FROM erp.proyectos p
   WHERE p.activo AND p.origen <> 'kaos'
   ORDER BY ocs DESC`;

(async () => {
  try {
    // La guarda que evita el peor error posible de este repositorio.
    //
    // Este comando inactiva todo lo que no venga de KAOS. Corrido ANTES de
    // `kaos:aplicar` —cuando ninguna fila tiene todavía `origen = 'kaos'`— eso
    // es el catálogo entero: los compradores se quedan sin un solo proyecto
    // seleccionable y no hay manera de crear un documento.
    //
    // El documento del corte dice el orden, pero un orden que solo vive en la
    // documentación es un orden que alguien se salta a las 7 de la tarde.
    const deKaos = await pg.one(
      `SELECT count(*)::int AS n FROM erp.proyectos WHERE origen = 'kaos' AND activo`);
    if (!deKaos || !deKaos.n) {
      console.error(
        'No hay ningún proyecto activo de KAOS en el catálogo, así que cerrar el\n' +
        'legado dejaría el ERP sin proyectos seleccionables.\n\n' +
        'Corré primero:  npm run kaos:sync  →  npm run kaos:ligar  →  npm run kaos:aplicar');
      process.exit(1);
    }

    const filas = await pg.rows(CANDIDATOS);

    if (!filas.length) {
      console.log('No queda ningún proyecto activo fuera de KAOS.');
      return;
    }

    console.log(APLICAR ? 'Cerrando:' : 'Se cerrarían (nada aplicado todavía):');
    let reqsBloqueados = 0;
    for (const f of filas) {
      reqsBloqueados += Number(f.reqs_abiertos);
      const aviso = Number(f.reqs_abiertos)
        ? `  ⚠ ${f.reqs_abiertos} requerimiento(s) abierto(s) quedarían bloqueados`
        : '';
      console.log(`  ${String(f.ocs).padStart(4)} OC  ${f.codigo}  (${f.origen})${aviso}`);
    }

    if (reqsBloqueados) {
      console.log(`\n${reqsBloqueados} requerimiento(s) pendientes pasarían a la bandeja como`);
      console.log('"obra cerrada". Se desbloquean reasignándolos, o dando de alta esa obra');
      console.log('en KAOS y ligándola con npm run kaos:ligar.');
    }

    if (APLICAR) {
      const r = await pg.query(
        `UPDATE erp.proyectos SET activo = false, updated_at = now()
          WHERE activo AND origen <> 'kaos'`);
      console.log(`\nCerrados ${r.rowCount}. Siguen en el catálogo con todo su histórico.`);
    } else {
      console.log('\nNada aplicado. Para hacerlo: npm run kaos:cerrar-legado -- --si');
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pg.cerrar();
  }
})();
