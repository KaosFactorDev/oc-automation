'use strict';
/**
 * kaos-ligar.js — Ata una fila del catálogo del ERP a su proyecto en KAOS.
 *
 *   npm run kaos:ligar           muestra qué haría, sin tocar nada
 *   npm run kaos:ligar -- --si   lo aplica
 *
 * Qué problema resuelve. Una obra que está viva en los dos sistemas existe dos
 * veces: la fila del ERP con su histórico, y el proyecto de KAOS. Si el espejo
 * escribe sin que nadie diga que son la misma, crea una fila nueva y la obra
 * queda partida — el histórico de un lado y las órdenes nuevas del otro, y el
 * comprador viendo dos entradas idénticas en el desplegable.
 *
 * Ligar es escribir `kaos_id` y `kaos_code` AL LADO de lo que ya había.
 * **`codigo` no se toca**: los proyectos antiguos siguen imprimiendo su código
 * de siempre en los PDF y en el control de costos. La columna nueva es solo la
 * llave de cruce.
 *
 * ── La regla, y por qué es estrecha ──────────────────────────────────────────
 * Solo liga cuando el nombre es IGUAL salvo mayúsculas y tildes, y ambos lados
 * están activos.
 *
 * Nada difuso: `erp.norm` no toca espacios ni caracteres, así que "230KV" nunca
 * casa con "230 KW" ni "CT25-134" con "CT 25-134". Si el nombre difiere en una
 * letra son dos proyectos distintos, y cuál es el correcto lo decide quien los
 * escribió, en KAOS. El ERP no adivina.
 *
 * Y ambos activos porque una obra terminada no necesita ligarse: su fila vieja
 * es histórico cerrado, nadie va a cargarle nada más, y el proyecto de KAOS
 * entra como nuevo sin competir con ella.
 */

require('dotenv').config();

const pg = require('../pg');

const APLICAR = process.argv.includes('--si');

// Un proyecto de KAOS no puede quedar atado a dos filas del ERP, ni al revés.
// Si el nombre normalizado aparece más de una vez de algún lado, se salta: eso
// es una ambigüedad real y elegir una sería adivinar.
const CANDIDATOS = `
  WITH unicos_erp AS (
    SELECT erp.norm(codigo) AS clave FROM erp.proyectos
     WHERE kaos_id IS NULL AND activo
     GROUP BY 1 HAVING count(*) = 1
  ), unicos_kaos AS (
    SELECT erp.norm(nombre) AS clave FROM erp.proyectos_kaos
     GROUP BY 1 HAVING count(*) = 1
  )
  SELECT p.id, p.codigo, p.activo,
         k.kaos_id, k.project_code, k.nombre AS kaos_nombre, k.zona
    FROM erp.proyectos p
    JOIN erp.proyectos_kaos k ON erp.norm(k.nombre) = erp.norm(p.codigo)
    JOIN unicos_erp  ue ON ue.clave = erp.norm(p.codigo)
    JOIN unicos_kaos uk ON uk.clave = erp.norm(k.nombre)
   WHERE p.kaos_id IS NULL
     AND p.activo
     AND NOT EXISTS (SELECT 1 FROM erp.proyectos q WHERE q.kaos_id = k.kaos_id)
   ORDER BY p.codigo`;

(async () => {
  try {
    const hay = await pg.one('SELECT count(*)::int AS n FROM erp.proyectos_kaos');
    if (!hay || !hay.n) {
      console.error('El espejo está vacío. Corré primero: npm run kaos:sync');
      process.exit(1);
    }

    const candidatos = await pg.rows(CANDIDATOS);

    // Los que coinciden por nombre pero tienen la fila del ERP inactiva: se
    // informan para que se vea que fue una decisión, no un olvido.
    const inactivos = await pg.rows(
      `SELECT p.codigo, k.project_code
         FROM erp.proyectos p
         JOIN erp.proyectos_kaos k ON erp.norm(k.nombre) = erp.norm(p.codigo)
        WHERE p.kaos_id IS NULL AND NOT p.activo
        ORDER BY p.codigo`);

    if (!candidatos.length) {
      console.log('No hay nada que ligar.');
    } else {
      console.log(APLICAR ? 'Ligando:' : 'Se ligaría (nada aplicado todavía):');
      for (const c of candidatos) {
        console.log(`  ${c.codigo}`);
        console.log(`    → ${c.project_code}  ${c.kaos_nombre}${c.zona ? `  [${c.zona}]` : '  [sin zona]'}`);
      }
    }

    if (inactivos.length) {
      console.log('\nCoinciden por nombre pero la fila del ERP está inactiva — no se ligan:');
      for (const r of inactivos) console.log(`  ${r.codigo}  (${r.project_code})`);
      console.log('  Son histórico cerrado. El proyecto de KAOS entrará como nuevo.');
    }

    if (APLICAR && candidatos.length) {
      await pg.tx(async (c) => {
        for (const cand of candidatos) {
          await c.query(
            // `codigo` NO se toca: es lo que imprimen los documentos.
            `UPDATE erp.proyectos
                SET kaos_id = $1, kaos_code = $2, origen = 'kaos'
              WHERE id = $3`,
            [cand.kaos_id, cand.project_code, cand.id]);
        }
      });
      console.log(`\nLigados ${candidatos.length}. El código de cada uno quedó intacto.`);
    } else if (!APLICAR && candidatos.length) {
      console.log('\nNada aplicado. Para hacerlo: npm run kaos:ligar -- --si');
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pg.cerrar();
  }
})();
