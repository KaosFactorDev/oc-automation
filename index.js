'use strict';
/**
 * index.js  v5
 * Punto de entrada del sistema de automatización de OC.
 *
 * Uso:
 *   node index.js           → ejecutar una vez (llamado por Task Scheduler)
 *   node index.js --watch   → polling cada N minutos (desarrollo)
 *   node index.js --test    → prueba sin conectar al buzón
 */

require('dotenv').config();

const { procesarBuzon } = require('./src/leerCorreos');
const { procesarCorreo} = require('./src/procesarCorreo');
const requerimientos    = require('./src/requerimientos');
const { rotar }         = require('./src/rotar-logs');

// Rotar logs al inicio de cada ejecución
rotar();

// Logging con timestamp
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log   = (...a) => _log(`[${new Date().toISOString()}]`, ...a);
console.error = (...a) => _err(`[${new Date().toISOString()}] ERROR`, ...a);

// ── Callbacks ─────────────────────────────────────────────────────────────────

async function onSolicitud(asunto, rutaAdjunto) {
  return procesarCorreo(asunto, rutaAdjunto);
}

async function onOCGenerada(resultado, meta = {}) {
  // Los correos no generan OC automáticamente: el resultado se registra como
  // Requerimiento en Postgres (estado 'pendiente') para que el usuario lo
  // gestione desde la consola. El PDF de respaldo sí va al Drive de SharePoint.
  try {
    const { item, duplicado, consecutivoSistema } = await requerimientos.crearDesdeCorreo(resultado, meta);
    if (duplicado) {
      console.log(`  ⟳ Requerimiento ya existía (messageId: ${meta.messageId}) — omitido`);
    } else {
      console.log(`  ✓ Requerimiento creado (id: ${item.id}, consecutivoSistema: ${consecutivoSistema}, ref. usuario: ${resultado.solicitud?.consecutivo}, ítems: ${resultado.items?.length || 0})`);
    }
    (resultado.alertasGlobales || []).forEach(a => console.log(`      ${a}`));
    return [{
      id:                 item.id,
      consecutivo:        resultado.solicitud?.consecutivo,
      consecutivoSistema: consecutivoSistema || (item.fields || {}).consecutivoSistema || '',
      items:              resultado.items?.length || 0,
      duplicado,
    }];
  } catch (e) {
    console.error('  ✗ No se pudo registrar Requerimiento:', e.message);
    throw e;
  }
}

async function onError(err, asunto) {
  console.error(`Error en "${asunto}":`, err.message);
}

// ── Modos ─────────────────────────────────────────────────────────────────────

async function ejecutarUnaVez() {
  const buzon = process.env.MAILBOX || 'abastecimiento@civiltechic.com';
  console.log(`Iniciando ciclo — buzón: ${buzon} (los correos crean Requerimientos pendientes)`);
  try {
    const { procesados, errores } = await procesarBuzon(onSolicitud, onOCGenerada, onError);
    console.log(`Ciclo completado — procesados: ${procesados} | errores: ${errores}`);
  } catch (err) {
    console.error('Fallo crítico:', err.message);
    process.exit(1);
  }
}

async function modoPolling() {
  const mins = parseInt(process.env.POLLING_INTERVAL_MIN || '5', 10);
  console.log(`Modo polling — cada ${mins} min`);
  await ejecutarUnaVez();
  setInterval(ejecutarUnaVez, mins * 60 * 1000);
}

async function modoPrueba() {
  console.log('=== MODO PRUEBA — sin conexión al buzón ===\n');
  const { consultarProveedor } = require('./src/consultaProveedor');

  const casos = [
    { asunto: 'SOLICITUD REQUERIMIENTO 0005 20260414 POLANCO', adjunto: null },
    { asunto: 'Reunión del viernes', adjunto: null },
    { asunto: 'SOLICITUD REQUERIMIENTO 0006 20260414 CT25-134 ANCLAJES MISTRAL', adjunto: '__MOCK__' },
  ];

  for (const c of casos) {
    console.log(`─── Asunto: "${c.asunto}"`);
    if (c.adjunto === '__MOCK__') {
      const items = [
        { item:1, insumo:'BOTA DE SEGURIDAD EN MATERIAL PUNTA DE ACERO TALLA 40', cantidad:5, unidad:'PAR', necesidad:'', posibleProveedor:'' },
        { item:2, insumo:'CAMISA DE JEAN CON REFLECTIVOS TALLA M', cantidad:3, unidad:'UND', necesidad:'', posibleProveedor:'' },
        { item:3, insumo:'INSUMO NUEVO SIN PRECIO', cantidad:1, unidad:'UND', necesidad:'', posibleProveedor:'' },
      ];
      const resultado = {
        accion: 'GENERAR_OC',
        solicitud: { consecutivo:'0006', fechaCorreo:'14/04/2026', proyecto:'CT25-134 ANCLAJES MISTRAL', zona:'Occidente', responsable:'Test', cargo:'Residente', fechaSolicitud:'' },
        items: items.map(i => ({ ...i, consulta: consultarProveedor(i.insumo, 'CT25-134 ANCLAJES MISTRAL') })),
        alertasGlobales: [],
      };
      await onOCGenerada(resultado);
      console.log(`Acción: GENERAR_OC → registrado como Requerimiento pendiente\n`);
      continue;
    }
    const r = await procesarCorreo(c.asunto, c.adjunto);
    console.log(`Acción: ${r.accion}`);
    if (r.cuerpo) console.log('Respuesta:\n' + r.cuerpo.split('\n').slice(0, 5).join('\n') + '\n  ...\n');
  }
  console.log('=== PRUEBA COMPLETADA ===');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if      (args.includes('--test'))  modoPrueba().catch(console.error);
else if (args.includes('--watch')) modoPolling().catch(console.error);
else                               ejecutarUnaVez().catch(console.error);