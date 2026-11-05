'use strict';
/**
 * Prueba de humo de /api (npm run test:humo).
 *
 * Arranca el servidor de verdad (src/servidor-cotizaciones.js) como proceso
 * hijo, con MODO_PRUEBA=1 y las credenciales externas vacías, y le hace
 * llamadas HTTP como las de RRHH: llave, orden de servicio aprobada y en
 * borrador, idempotencia y requerimiento.
 *
 * Necesita un Postgres local ya preparado: migraciones, contraseña de erp_app y
 * supabase/seeds/local-p0.sql. Es lo que hace el workflow validar-pr.yml antes
 * de correrla; para repetirlo en local, ver CONTRIBUTING.md.
 *
 * Los uuid de las solicitudes son nuevos en cada corrida, así que se puede
 * repetir sobre la misma base.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');

const { verificarEntornoLocal, variablesQueDebenIrVacias } = require('./entorno-local');

const RAIZ   = path.join(__dirname, '../..');
const PUERTO = Number(process.env.PUERTO_COTIZACIONES || 3002);
const BASE   = `http://127.0.0.1:${PUERTO}`;
const LLAVE  = String(process.env.RRHH_API_KEY || '').trim();

// Del seed local-p0.sql: el «Proyecto Local P0» y el tope de 500.000.
const PROYECTO = '00000000-0000-4000-a000-000000000101';
const TOPE     = 500000;
// Los proveedores de prueba llevan NIT con prefijo 0000 (ver el seed).
const NIT      = '0000000301';

let servidor = null;
let log = '';
let huboFallo = false;

/** Una prueba que, si falla, hace imprimir el log del servidor al final. */
function caso(nombre, fn) {
  it(nombre, async (t) => {
    try { await fn(t); } catch (err) { huboFallo = true; throw err; }
  });
}

async function esperar(condicion, ms, queEspera) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (condicion()) return;
    if (servidor && servidor.exitCode !== null) {
      throw new Error(`El servidor terminó con código ${servidor.exitCode}.\n${log}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Pasaron ${ms / 1000} s sin ${queEspera}.\n${log}`);
}

async function pedir(metodo, ruta, { cuerpo, llave = LLAVE } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (llave) headers['x-api-key'] = llave;
  const res = await fetch(BASE + ruta, {
    method: metodo, headers,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function cuerpoOS(origenSolicitudId, cambios = {}) {
  return {
    origenSistema:             'rrhh-app',
    origenSolicitudId,
    origenSolicitadoPor:       'humo@ejemplo.test',
    origenSolicitadoPorNombre: 'Prueba de Humo',
    proyectoKaosId:            PROYECTO,
    proveedorNit:              NIT,
    proveedorNombre:           'IPS de Prueba',
    cotizacionReferencia:      'COT-HUMO',
    tipoServicio:              'Exámenes médicos de ingreso',
    // 3 × 33.333,33 al 19 % + 1 × 50.000 al 0 % = 149.999,99 + 19.000 de IVA.
    items: [
      { descripcion: 'Examen de ingreso', cantidad: 3, precioUnitario: 33333.33, ivaPct: 19 },
      { descripcion: 'Audiometría',       cantidad: 1, precioUnitario: 50000,    ivaPct: 0 },
    ],
    ...cambios,
  };
}

before(async () => {
  verificarEntornoLocal();

  // Si ya hay algo en el puerto (un servidor de desarrollo, con su base), las
  // llamadas irían a ese y no al que arranca esta prueba.
  const ocupado = await fetch(`${BASE}/`).then(() => true, () => false);
  if (ocupado) throw new Error(`Ya hay algo escuchando en ${BASE}. Detenlo o usa otro PUERTO_COTIZACIONES.`);

  // Las credenciales externas van declaradas y vacías: así dotenv no las
  // carga de un .env aunque exista (no sobrescribe lo ya definido).
  const env = { ...process.env, PUERTO_COTIZACIONES: String(PUERTO) };
  for (const nombre of variablesQueDebenIrVacias()) env[nombre] = '';
  delete env.NODE_TEST_CONTEXT;

  servidor = spawn(process.execPath, ['src/servidor-cotizaciones.js'], {
    cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', (d) => { log += d; });
  servidor.stderr.on('data', (d) => { log += d; });

  await esperar(() => log.includes('App de cotizaciones corriendo'), 30000, 'que el servidor arranque');
});

after(async () => {
  if (servidor && servidor.exitCode === null) {
    servidor.kill();
    await once(servidor, 'exit');
  }
  if (huboFallo) console.log(`\n── Log del servidor ──\n${log}`);
});

describe('humo: /api contra el Postgres local', () => {
  const solicitud     = crypto.randomUUID();
  const solicitudCara = crypto.randomUUID();
  const solicitudReq  = crypto.randomUUID();
  let creada = null;

  caso('el servidor arranca en MODO_PRUEBA', async () => {
    await esperar(() => log.includes('MODO_PRUEBA activo'), 5000, 'el aviso de MODO_PRUEBA');
  });

  caso('sin llave → 401', async () => {
    const r = await pedir('GET', `/api/ordenes-servicio?origenSolicitudId=${solicitud}`, { llave: '' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'unauthorized' });
  });

  caso('con una llave equivocada → 401', async () => {
    const r = await pedir('GET', `/api/ordenes-servicio?origenSolicitudId=${solicitud}`,
      { llave: 'x'.repeat(LLAVE.length) });
    assert.equal(r.status, 401);
  });

  caso('con llave y sin órdenes → 200 con la lista vacía', async () => {
    const r = await pedir('GET', `/api/ordenes-servicio?origenSolicitudId=${solicitud}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ordenesServicio: [] });
  });

  caso('orden sin ítems → 422', async () => {
    const r = await pedir('POST', '/api/ordenes-servicio', { cuerpo: cuerpoOS(solicitud, { items: [] }) });
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'payload_invalido');
  });

  caso('orden para un proyecto que no existe → 422', async () => {
    const r = await pedir('POST', '/api/ordenes-servicio',
      { cuerpo: cuerpoOS(solicitud, { proyectoKaosId: crypto.randomUUID() }) });
    assert.equal(r.status, 422);
  });

  caso('orden con total ≤ tope → 201 aprobada, con los totales exactos', async () => {
    const r = await pedir('POST', '/api/ordenes-servicio', { cuerpo: cuerpoOS(solicitud) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    creada = r.json;
    assert.equal(creada.estado, 'aprobada');
    assert.equal(creada.aprobadaAutomaticamente, true);
    assert.match(creada.numeroOS, /^OS-\d{4,}$/);
    assert.equal(creada.tope, TOPE);
    assert.equal(creada.proyecto, 'Proyecto Local P0');
    assert.equal(creada.valor, 149999.99);
    assert.equal(creada.iva, 19000);
    assert.equal(creada.total, 168999.99);
  });

  caso('repetir el POST → 200 con la misma orden, sin crear otra', async () => {
    assert.ok(creada, 'depende de la prueba anterior');
    const r = await pedir('POST', '/api/ordenes-servicio', { cuerpo: cuerpoOS(solicitud) });
    assert.equal(r.status, 200);
    assert.equal(r.json.duplicada, true);
    assert.equal(r.json.erpItemId, creada.erpItemId);
    assert.equal(r.json.numeroOS, creada.numeroOS);
    assert.equal(r.json.total, 168999.99);
  });

  caso('GET → la orden, con el total guardado en Postgres', async () => {
    const r = await pedir('GET', `/api/ordenes-servicio?origenSolicitudId=${solicitud}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ordenesServicio.length, 1);
    const [os] = r.json.ordenesServicio;
    assert.equal(os.erpItemId, creada.erpItemId);
    assert.equal(os.estado, 'aprobada');
    assert.equal(os.total, 168999.99);
  });

  caso('orden con total > tope → 201 en borrador, sin número', async () => {
    const r = await pedir('POST', '/api/ordenes-servicio', { cuerpo: cuerpoOS(solicitudCara, {
      items: [{ descripcion: 'Batería de exámenes', cantidad: 1, precioUnitario: 600000, ivaPct: 19 }],
    }) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.estado, 'borrador');
    assert.equal(r.json.motivo, 'supera_tope');
    assert.equal(r.json.numeroOS, null);
    assert.equal(r.json.total, 714000);
  });

  caso('requerimiento de dotación → 201 pendiente', async () => {
    const r = await pedir('POST', '/api/requerimientos', { cuerpo: {
      ...cuerpoOS(solicitudReq),
      items: [
        { insumo: 'Botas de seguridad', cantidad: 2, unidad: 'par' },
        { insumo: 'Casco', cantidad: 1 },
      ],
    } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.creado, true);
    assert.equal(r.json.erpTipoDocumento, 'REQ');
    assert.equal(r.json.estado, 'pendiente');
    assert.equal(r.json.proyecto, 'Proyecto Local P0');
    assert.ok(r.json.consecutivo, 'sin consecutivo');

    const g = await pedir('GET', `/api/requerimientos?origenSolicitudId=${solicitudReq}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.requerimientos.length, 1);
    assert.equal(g.json.requerimientos[0].erpItemId, r.json.erpItemId);
    assert.deepEqual(g.json.requerimientos[0].ordenesCompra, []);
  });
});
