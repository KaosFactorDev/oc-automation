'use strict';
/**
 * kaos-aplicar.js — Vuelca el espejo de KAOS sobre el catálogo del ERP.
 *
 *   npm run kaos:aplicar           muestra qué haría, sin tocar nada
 *   npm run kaos:aplicar -- --si   lo aplica
 *
 * Este es el paso en que KAOS pasa a ser el dueño del catálogo. Hasta acá el
 * espejo solo medía; desde acá manda.
 *
 * Lo que hace:
 *   · Filas ya ligadas → toman nombre, ciudad, departamento, zona y estado de
 *     KAOS. `codigo` NO se toca: es lo que imprimen los PDF y lo que el control
 *     de costos muestra por JOIN, así que pisarlo reescribiría el pasado.
 *   · Proyectos de KAOS que no están → entran como nuevos, con `origen='kaos'`.
 *   · Filas `origen='local'` (centros de costo) y `'huerfano'` → no se tocan.
 *
 * Correr `npm run kaos:sync` antes: esto lee del espejo, no de la API.
 */

require('dotenv').config();

const repo = require('../repo/proyectosKaos');
const pg   = require('../pg');

const APLICAR = process.argv.includes('--si');

function seccion(t) { console.log(`\n${t}\n${'─'.repeat(t.length)}`); }

(async () => {
  try {
    const espejo = await pg.one('SELECT count(*)::int AS n FROM erp.proyectos_kaos');
    if (!espejo || !espejo.n) {
      console.error('El espejo está vacío. Corré primero: npm run kaos:sync');
      process.exit(1);
    }

    let r;
    try {
      r = await repo.aplicar({ aplicar: APLICAR });
    } catch (err) {
      // El ensayo aborta la transacción a propósito y se trae el resumen.
      if (err instanceof repo.SimulacionTerminada) r = err.resumen;
      else throw err;
    }

    console.log(APLICAR ? 'Aplicado sobre el catálogo:' : 'Se haría (nada aplicado todavía):');
    console.log(`  ${r.actualizados} proyectos ya ligados se actualizarían desde KAOS`);
    console.log(`  ${r.insertados.length} proyectos de KAOS entrarían como nuevos`);

    if (r.insertados.length) {
      seccion('Entrarían como nuevos');
      for (const x of r.insertados) console.log(`  ${x.kaos_code}  ${x.codigo}`);
    }

    if (r.choques.length) {
      seccion('No entran: el nombre ya existe en el catálogo');
      for (const x of r.choques) {
        console.log(`  ${x.project_code}  "${x.nombre}"`);
        console.log(`     ya hay una fila ${x.activo ? 'ACTIVA' : 'inactiva'}: ${x.fila_erp}`);
      }
      console.log('\n  Son la misma obra escrita dos veces. Si la fila del ERP está activa,');
      console.log('  `npm run kaos:ligar` las une; si está inactiva, es histórico cerrado y');
      console.log('  hay que decidir: reactivarla y ligar, o renombrar en KAOS.');
    }

    if (!APLICAR) console.log('\nNada aplicado. Para hacerlo: npm run kaos:aplicar -- --si');
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pg.cerrar();
  }
})();
