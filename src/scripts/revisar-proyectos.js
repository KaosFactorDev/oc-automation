'use strict';
/**
 * revisar-proyectos.js — Proyectos marcados para revisión y su candidato.
 *
 *   npm run revisar-proyectos
 *
 * El import marca requiere_revision cuando un documento nombra un proyecto que
 * no está en el catálogo: crea la fila para satisfacer la llave foránea y la
 * deja señalada. Este informe agrupa esas filas por qué tan confiable es el
 * candidato, porque no todas se pueden unir igual.
 *
 * Grupo A: un solo proyecto del catálogo contiene el nombre escrito.
 * Grupo B: varios candidatos, o solo comparten una palabra. NO se unen solos.
 * Grupo C: sin candidato. Suelen ser proyectos reales que nunca se dieron de alta.
 *
 * La distinción importa: "EQUIPOS GT" está contenido en "EQUIPOS GT 2025" y en
 * "EQUIPOS GT 2026", así que elegir el primero sería arbitrario. Y unir por una
 * palabra suelta manda un proyecto de Zipaquirá a uno de Palmira porque ambos
 * dicen "JAIMES".
 *
 * Solo lee. No modifica nada.
 */

require('dotenv').config({ quiet: true });
const pg = require('../pg');

const norm = (s) => String(s || '').trim().toUpperCase();

(async () => {
  // Catálogo limpio: los que venían de SharePoint y no están marcados.
  const cat = (await pg.query(
    `SELECT codigo, zona FROM erp.proyectos
      WHERE sp_id IS NOT NULL AND NOT requiere_revision ORDER BY codigo`)).rows;

  // Marcados, con su gasto.
  const marcados = (await pg.query(
    `SELECT p.codigo, p.zona,
            COALESCE(g.docs,0) docs, COALESCE(g.total,0) total
       FROM erp.proyectos p
       LEFT JOIN (SELECT proyecto, count(*) docs, sum(total) total
                    FROM erp.vw_gastos GROUP BY proyecto) g ON g.proyecto = p.codigo
      WHERE p.requiere_revision
      ORDER BY COALESCE(g.total,0) DESC, p.codigo`)).rows;

  function candidato(frag) {
    const n = norm(frag);
    for (const c of cat) if (norm(c.codigo) === n) return ['exacta', c];
    // Contenido: si más de un proyecto del catálogo lo contiene, NO hay
    // candidato claro. Devolver el primero sería arbitrario — es justo el error
    // que hace "EQUIPOS GT" parecer resuelto cuando existen 2025 y 2026.
    const dentro = cat.filter(c => norm(c.codigo).includes(n));
    if (dentro.length === 1) return ['contenido', dentro[0]];
    if (dentro.length > 1)   return ['varios', dentro[0], dentro.map(c => c.codigo), ['contenido en ' + dentro.length]];
    // Estrategia laxa: cualquier palabra >3 en común. Se reporta pero no se confía.
    const hits = [];
    for (const c of cat) {
      const pal = norm(c.codigo).split(/[\s\-]+/).filter(x => x.length > 3);
      const comunes = pal.filter(x => n.includes(x));
      if (comunes.length) hits.push({ c, comunes });
    }
    if (hits.length) {
      hits.sort((a, b) => b.comunes.length - a.comunes.length);
      return ['palabra', hits[0].c, hits.map(h => h.c.codigo), hits[0].comunes];
    }
    return ['ninguno', null];
  }

  const money = (n) => '$' + Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });

  const seguros = [], ambiguos = [], huerfanos = [];
  for (const m of marcados) {
    const [est, c, todos, comunes] = candidato(m.codigo);
    const fila = { ...m, est, cand: c, todos, comunes };
    if (est === 'exacta' || est === 'contenido') seguros.push(fila);
    else if (est === 'palabra' || est === 'varios') ambiguos.push(fila);
    else huerfanos.push(fila);
  }

  console.log('\n' + '='.repeat(78));
  console.log(' PROYECTOS MARCADOS PARA REVISIÓN — ' + marcados.length + ' en total');
  console.log(' Catálogo limpio de referencia: ' + cat.length + ' proyectos de SharePoint');
  console.log('='.repeat(78));

  console.log('\n\n### GRUPO A — el candidato es claro (' + seguros.length + ')');
  console.log('    El nombre escrito está contenido en el del catálogo.\n');
  for (const f of seguros) {
    console.log('  ' + f.codigo);
    console.log('     ' + String(f.docs).padStart(3) + ' docs   ' + money(f.total).padStart(14) +
                '   zona: ' + (f.zona || '—'));
    console.log('     ⇒ ¿es el mismo que "' + f.cand.codigo + '"?  [' + f.est + ']');
    console.log('');
  }

  console.log('\n### GRUPO B — ambiguos, NO los uno sin que me confirmes (' + ambiguos.length + ')');
  console.log('    Solo comparten alguna palabra. Es donde el código actual se equivoca.\n');
  for (const f of ambiguos) {
    console.log('  ' + f.codigo);
    console.log('     ' + String(f.docs).padStart(3) + ' docs   ' + money(f.total).padStart(14) +
                '   zona: ' + (f.zona || '—'));
    console.log('     por qué es ambiguo: ' + f.comunes.join(', '));
    console.log('     candidatos posibles:');
    for (const t of f.todos.slice(0, 4)) console.log('        · ' + t);
    console.log('');
  }

  console.log('\n### GRUPO C — sin candidato en el catálogo (' + huerfanos.length + ')');
  console.log('    Probablemente proyectos reales que nunca se dieron de alta.\n');
  for (const f of huerfanos) {
    console.log('  ' + f.codigo.padEnd(46) + String(f.docs).padStart(3) + ' docs   ' +
                money(f.total).padStart(14));
  }

  const t = (a) => a.reduce((s, f) => s + Number(f.total), 0);
  console.log('\n' + '='.repeat(78));
  console.log('  Grupo A (candidato claro)  ' + String(seguros.length).padStart(3) + ' proyectos   ' + money(t(seguros)).padStart(14));
  console.log('  Grupo B (ambiguos)         ' + String(ambiguos.length).padStart(3) + ' proyectos   ' + money(t(ambiguos)).padStart(14));
  console.log('  Grupo C (sin candidato)    ' + String(huerfanos.length).padStart(3) + ' proyectos   ' + money(t(huerfanos)).padStart(14));
  console.log('='.repeat(78) + '\n');

  await pg.cerrar();
})().catch(e => { console.error(e.message); process.exit(1); });
