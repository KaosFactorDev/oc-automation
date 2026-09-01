'use strict';
/**
 * test.js — Prueba de humo manual.
 *   node src/test.js
 *
 * La consulta de proveedor necesita la base levantada (npm run db:up), porque
 * trabaja sobre el historial de precios. Antes este archivo apuntaba a tres CSV
 * del disco, que se retiraron con la migración.
 */

const { procesarCorreo }     = require('./procesarCorreo');
const { consultarProveedor } = require('./consultaProveedor');
const { parsearAsunto }      = require('./parsearAsunto');
const repoHistorial          = require('./repo/historialPrecios');
const repoCatalogos          = require('./repo/catalogos');
const pg                     = require('./pg');

const linea = () => console.log('═══════════════════════════════════════════════════════');

// ── TEST 1: Parseo de asunto ──────────────────────────────────────────────────

function test1() {
  console.log('\n');
  linea();
  console.log(' TEST 1 — Parseo de asunto del correo');
  linea();

  const casos = [
    'SOLICITUD REQUERIMIENTO 0001 20260410 MISTRAL',
    'SOLICITUD REQUERIMIENTO 0042 20260101 CT25-034 ANCLAJES SOLEI',
    'SOLICITUD REQUERIMIENTO 0005 20260415 CERREJON',
    'RE: Reunión del lunes',                          // debe ignorarse
    'SOLICITUD REQUERIMIENTO 99 20261399 POLANCO',    // fecha inválida
  ];

  for (const a of casos) {
    const r = parsearAsunto(a);
    console.log(`\nAsunto: "${a}"`);
    console.log(`  válido: ${r.valido}`);
    if (r.valido) console.log(`  → cons: ${r.consecutivo} | fecha: ${r.fechaTexto} | proyecto: "${r.proyecto}"`);
    else          console.log(`  → error: ${r.error}`);
  }
}

// ── TEST 2: Correo sin adjunto ────────────────────────────────────────────────

async function test2() {
  console.log('\n');
  linea();
  console.log(' TEST 2 — Correo sin adjunto');
  linea();

  const r = await procesarCorreo('SOLICITUD REQUERIMIENTO 0003 20260410 MISTRAL', null);
  console.log(`\nAcción: ${r.accion}`);
  console.log('Asunto respuesta:', r.asunto);
  console.log('Adjunto:', r.nombreAdjunto);
}

// ── TEST 3: Consulta de proveedor sobre el historial real ─────────────────────

async function test3() {
  console.log('\n');
  linea();
  console.log(' TEST 3 — Consulta de proveedor por insumo');
  linea();

  // El llamador precarga los datos: consultarProveedor ya no lee del disco.
  const [historialSP, proveedoresSP] = await Promise.all([
    repoHistorial.listar(),
    repoCatalogos.getProveedores(),
  ]);
  console.log(`\nHistorial: ${historialSP.length} compras · Proveedores: ${proveedoresSP.length}`);

  // Se prueban insumos que existen de verdad, más uno inventado.
  const reales = [...new Set(historialSP.map(h => h.insumo))].slice(0, 2);
  const casos  = [...reales, 'INSUMO QUE NO EXISTE EN LA BASE'];

  for (const insumo of casos) {
    console.log(`\nInsumo: "${insumo}"`);
    const r = consultarProveedor(insumo, '', { historialSP, proveedoresSP });
    if (r.encontrado) {
      console.log(`  ✓ ${r.proveedor.nombre} (${r.proveedor.nit})`);
      console.log(`  ✓ Precio: $${r.precio.toLocaleString('es-CO')} · última compra ${r.fechaUltimaCompra}`);
      if (r.alertas.length) console.log('  Alertas:\n    ' + r.alertas.join('\n    '));
    } else {
      console.log(`  ✗ ${r.mensaje}`);
    }
  }
}

// ── Ejecución ─────────────────────────────────────────────────────────────────

(async () => {
  test1();
  try { await test2(); } catch (e) { console.log('\n⚠ TEST 2:', e.message); }
  try { await test3(); } catch (e) {
    console.log('\n⚠ TEST 3 no pudo consultar la base:', e.message);
    console.log('  Levántala con: npm run db:up');
  }

  console.log('\n');
  linea();
  console.log(' Tests completados');
  linea();
  console.log();

  await pg.cerrar().catch(() => {});
})();
