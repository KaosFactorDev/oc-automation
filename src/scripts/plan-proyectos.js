'use strict';
/**
 * plan-proyectos.js — Propuesta de qué hacer con cada proyecto marcado.
 *
 *   npm run plan-proyectos
 *
 * El import marcó 23 proyectos con requiere_revision: nombres que aparecían en
 * documentos pero no en el catálogo. No son todos el mismo caso, y meterlos en
 * un solo cubo fue el error inicial del análisis.
 *
 *   SEPARADO   Nunca fue duplicado de nada. Es un centro de costo o una obra
 *              real que jamás se dio de alta. Se queda como proyecto propio.
 *   UNIFICAR   Es la misma obra escrita distinto. Se repunta al canónico.
 *   CRITERIO   No se puede decidir con los datos. Necesita a alguien que
 *              conozca la obra.
 *
 * Por qué hay tantos en CRITERIO: el catálogo usa sufijos para distinguir cosas
 * de verdad — "CT25-034 ANCLAJES SOLEI" y "CT25-034 ANCLAJES SOLEI V2" son dos
 * entradas con el mismo código. Así que un sufijo no es prueba de errata, y
 * "EQUIPOS GT" puede ser 2025 o 2026. Adivinar el año movería plata de un
 * ejercicio a otro.
 *
 * Solo lee. No modifica nada.
 */

require('dotenv').config({ quiet: true });
const pg = require('../pg');

// Decisión por proyecto. El motivo se imprime: si no se sostiene, se cambia acá.
const PLAN = {
  // ── Centros de costo y obras propias: nunca fueron duplicados ────────────
  'BODEGA CIVILTECH':                      ['SEPARADO', null, 'centro de costo con 1.709 compras propias'],
  'BODEGA AUXILIAR':                       ['SEPARADO', null, 'centro de costo, 46 compras'],
  'SST':                                   ['SEPARADO', null, 'centro de costo, 175 compras'],
  'CAMPAMENTO':                            ['SEPARADO', null, 'centro de costo, 4 compras'],
  'REACTIVACION DE CLIENTES COLPREVENCIO': ['SEPARADO', null, 'nombre propio, no se parece a ninguno'],
  'SIN_PROYECTO':                          ['SEPARADO', null, 'marcador del parseo de correo, no una obra: dejarlo visible sirve de alerta'],

  // ── Variantes de escritura de una obra que ya existe ─────────────────────
  'CT26-034LT ZIPAQUIRA Norte 230KV - JE Jaimes':
    ['UNIFICAR', 'CT26-034 LT Norte 230KV - JE Jaimes', 'trae el código CT26-034 explícito'],
  'CT26-034 LT Norte 230 KV-JE Jaimes':
    ['UNIFICAR', 'CT26-034 LT Norte 230KV - JE Jaimes', 'mismo código, solo cambia un espacio en "230 KV"'],
  'LT NORTE 230KV':
    ['UNIFICAR', 'CT26-034 LT Norte 230KV - JE Jaimes', 'el nombre está contenido en el canónico, sin otro candidato'],
  'RSO PALMIRA':
    ['UNIFICAR', 'CT25-200 Micropilotes RSO Palmira', 'contenido en el canónico, único candidato'],
  'CONCONCRETO':
    ['UNIFICAR', 'CT25-076 Micropilotes Red Matriz - CONCONCRETO', 'contenido, único candidato'],
  'mistral':
    ['UNIFICAR', 'CT25-134 ANCLAJES MISTRAL', 'el mismo nombre en minúsculas'],
  'MISTRA':
    ['UNIFICAR', 'CT25-134 ANCLAJES MISTRAL', 'MISTRAL truncado; no existe ningún "MISTRA"'],

  // ── Necesitan criterio humano ───────────────────────────────────────────
  'LT RSO - JE JAIMES':
    ['CRITERIO', null, '¿Micropilotes RSO (Sur) o LT Norte 230KV (Centro)? Comparten solo el cliente'],
  'EQUIPOS GT':
    ['CRITERIO', null, '¿2025 o 2026? Ambos existen; el año decide a qué ejercicio va la plata'],
  'EQUIPOS GT 20026':
    ['CRITERIO', null, 'año de 5 dígitos: ¿2025 o 2026?'],
  'CT26-041 Micropilotes IZZI96-COALA':
    ['CRITERIO', null, 'el catálogo solo tiene "COALA 2". ¿Es la fase 1 sin registrar, o una errata del 2?'],
  'IZZI96':
    ['CRITERIO', null, 'depende de lo anterior: ¿a COALA o a COALA 2?'],
  'IZZY 96':
    ['CRITERIO', null, 'IZZI96 con Y; el destino depende de la decisión sobre COALA'],
  'IZZY 96 2':
    ['CRITERIO', null, 'IZZI96 con Y y sufijo 2; mismo caso'],
  'MPLT NORTE':
    ['CRITERIO', null, '¿es "LT Norte 230KV" con prefijo MP, u otra obra?'],
  'Solei':
    ['CRITERIO', null, '¿SOLEI o SOLEI V2? Ambos existen con el mismo código CT25-034'],
  'ADMINISTRATIVO':
    ['CRITERIO', null, '¿"ADMINISTRATIVO 2025" o "ADMINISTRACION CT 2026"? Distinto año y distinto nombre'],
};

const money = (n) => '$' + Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 });

(async () => {
  const { rows } = await pg.query(`
    SELECT p.codigo,
           (SELECT count(*) FROM erp.requerimientos          WHERE proyecto_id=p.id) req,
           (SELECT count(*) FROM erp.ordenes_compra          WHERE proyecto_id=p.id) oc,
           (SELECT count(*) FROM erp.ordenes_servicio        WHERE proyecto_id=p.id) os,
           (SELECT count(*) FROM erp.movimientos_inventario  WHERE proyecto_id=p.id) mov,
           (SELECT count(*) FROM erp.historial_precios       WHERE proyecto_id=p.id) hp,
           COALESCE((SELECT sum(total) FROM erp.vw_gastos WHERE proyecto=p.codigo),0) gasto
      FROM erp.proyectos p WHERE p.requiere_revision
     ORDER BY 7 DESC, 1`);

  const grupos = { SEPARADO: [], UNIFICAR: [], CRITERIO: [] };
  const sinPlan = [];
  for (const r of rows) {
    const p = PLAN[r.codigo];
    if (!p) { sinPlan.push(r.codigo); continue; }
    grupos[p[0]].push({ ...r, destino: p[1], motivo: p[2] });
  }

  const titulos = {
    UNIFICAR: 'UNIFICAR — misma obra escrita distinto',
    SEPARADO: 'SEPARADO — nunca fue duplicado, se queda como proyecto propio',
    CRITERIO: 'TU CRITERIO — los datos no alcanzan para decidir',
  };

  for (const g of ['UNIFICAR', 'SEPARADO', 'CRITERIO']) {
    const lista = grupos[g];
    console.log('\n' + '═'.repeat(76));
    console.log(' ' + titulos[g] + '  (' + lista.length + ')');
    console.log('═'.repeat(76));
    for (const r of lista) {
      const refs = [
        r.req > 0 && r.req + ' req', r.oc > 0 && r.oc + ' oc',
        r.os > 0 && r.os + ' os', r.mov > 0 && r.mov + ' mov',
        r.hp > 0 && r.hp + ' precios',
      ].filter(Boolean).join(' · ');
      console.log('\n  ' + r.codigo);
      console.log('    ' + refs + (Number(r.gasto) ? '   ' + money(r.gasto) : ''));
      if (r.destino) console.log('    → ' + r.destino);
      console.log('    ' + r.motivo);
    }
  }

  if (sinPlan.length) {
    console.log('\n⚠ sin propuesta: ' + sinPlan.join(', '));
  }

  const suma = (a) => a.reduce((s, r) => s + Number(r.gasto), 0);
  console.log('\n' + '═'.repeat(76));
  for (const g of ['UNIFICAR', 'SEPARADO', 'CRITERIO'])
    console.log('  ' + g.padEnd(10) + String(grupos[g].length).padStart(3) + ' proyectos   ' +
                money(suma(grupos[g])).padStart(15));
  console.log('═'.repeat(76) + '\n');

  await pg.cerrar();
})().catch(e => { console.error(e.message); process.exit(1); });
