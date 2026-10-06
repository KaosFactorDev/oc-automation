'use strict';
/**
 * verificar-tesoreria.js
 * Comprueba que la integración con tesorería (Pagos Diarios) esté bien
 * configurada: variables del .env, login del usuario dedicado, rol correcto y
 * lectura de proyectos.
 *
 * Solo hace lecturas — NO crea solicitudes de pago.
 *
 * Uso:
 *   node src/scripts/verificar-tesoreria.js
 *   node src/scripts/verificar-tesoreria.js --ocs 0169,0173   → además consulta esas OC
 */

require('dotenv').config();
const tesoreria = require('../tesoreriaClient');

const VARS = ['TESORERIA_URL', 'TESORERIA_ANON_KEY', 'TESORERIA_EMAIL', 'TESORERIA_PASSWORD'];

// Nunca imprimir secretos completos.
function tapar(v) {
  if (!v) return '(vacío)';
  return v.length <= 12 ? v[0] + '…' : v.slice(0, 8) + '…' + v.slice(-4);
}

async function main() {
  const args = process.argv.slice(2);
  const ocsArg = args.includes('--ocs') ? (args[args.indexOf('--ocs') + 1] || '') : '';

  console.log('\n=== 1. Variables del .env ===');
  let faltan = [];
  for (const v of VARS) {
    const val = process.env[v] || '';
    const oculto = v === 'TESORERIA_PASSWORD' || v === 'TESORERIA_ANON_KEY';
    console.log(`  ${val ? '✓' : '✗'} ${v} = ${oculto ? tapar(val) : (val || '(vacío)')}`);
    if (!val) faltan.push(v);
  }
  if (/PEGAR_AQUI|<contrase/i.test(process.env.TESORERIA_PASSWORD || '')) {
    console.log('\n✗ TESORERIA_PASSWORD todavía tiene el texto de relleno. Reemplázalo por la contraseña real.');
    process.exit(1);
  }
  if (faltan.length) {
    console.log(`\n✗ Faltan ${faltan.length} variable(s). La integración quedaría oculta en la consola.`);
    process.exit(1);
  }
  if (!tesoreria.habilitado()) {
    console.log('\n✗ habilitado() dice false pese a que las variables están. Revisar espacios o comillas.');
    process.exit(1);
  }

  // Los proyectos ya no se leen de tesorería: Cash_Flow no tiene catálogo propio
  // y el desplegable sale del espejo de KAOS. Acá solo se prueba el login.
  console.log('\n=== 2. Login ===');
  try {
    await tesoreria.probarLogin();
  } catch (e) {
    console.log('  ✗ Falló:', e.message);
    console.log('\n  Pistas según el mensaje:');
    console.log('   • "email_not_confirmed" → el usuario quedó sin confirmar en Supabase.');
    console.log('     Studio → Authentication → Users → el usuario → confirmar.');
    console.log('   • "Invalid login credentials" → contraseña o correo distintos.');
    process.exit(1);
  }
  console.log('  ✓ Login correcto');

  if (ocsArg) {
    console.log('\n=== 3. Solicitudes ya existentes para esas OC ===');
    const ocs = ocsArg.split(',').map(s => s.trim()).filter(Boolean);
    const enviadas = await tesoreria.consultarEnviadas(ocs);
    for (const oc of ocs) {
      const e = enviadas[oc];
      console.log(`  ${oc}: ${e ? `${e.egreso_id} · ${e.estado}` : 'sin solicitud'}`);
    }
  }

  console.log('\n✓ Configuración correcta. La columna "Tesorería" y el botón deben aparecer en la consola.');
  console.log('  (Este script no creó ninguna solicitud de pago.)\n');
}

main().catch(e => { console.error('\nError inesperado:', e.message); process.exit(1); });
