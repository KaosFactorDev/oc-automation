'use strict';
/**
 * Prueba de humo de /api/kaos-connect (npm run test:humo).
 *
 * Arranca el servidor de verdad (src/servidor-cotizaciones.js) como proceso
 * hijo, con MODO_PRUEBA=1 y las credenciales externas vacías, y le hace las
 * llamadas que haría el orquestador de KAOS: llave, persona activa e inactiva,
 * órdenes de compra de un proyecto con sus ítems, paginación y proveedores sin
 * datos bancarios. Comprueba también que la llave de RRHH no abre esta API ni
 * esta la de RRHH.
 *
 * Usa su propio puerto (PUERTO_COTIZACIONES + 1): node --test corre los
 * archivos de test/humo/ en paralelo, y la de RRHH ya ocupa el suyo.
 *
 * Necesita el mismo Postgres local que api-rrhh.test.js (migraciones,
 * contraseña de erp_app y supabase/seeds/local-p0.sql). Lo que inserta lleva
 * datos nuevos en cada corrida (correos, NIT y un día propio para las
 * órdenes), así que se puede repetir sobre la misma base.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');

const { verificarEntornoLocal, variablesQueDebenIrVacias } = require('./entorno-local');

const RAIZ   = path.join(__dirname, '../..');
const PUERTO = Number(process.env.PUERTO_COTIZACIONES || 3002) + 1;
const BASE   = `http://127.0.0.1:${PUERTO}`;
const LLAVE  = String(process.env.KAOS_CONNECT_API_KEY || '').trim();
const LLAVE_RRHH = String(process.env.RRHH_API_KEY || '').trim();

// Del seed local-p0.sql: el «Proyecto Local P0», ligado a este proyecto de KAOS.
const PROYECTO = '00000000-0000-4000-a000-000000000101';

// Datos propios de esta corrida.
const SUFIJO   = crypto.randomBytes(4).toString('hex');
const ACTIVA   = `humo-kc-activa-${SUFIJO}@ejemplo.test`;
const INACTIVA = `humo-kc-inactiva-${SUFIJO}@ejemplo.test`;
const NIT      = `0000${parseInt(SUFIJO, 16) % 1_000_000}`.slice(0, 10);
// Un día propio para las órdenes de esta corrida: el filtro desde/hasta las aísla.
const DIA      = `209${crypto.randomInt(0, 10)}-0${crypto.randomInt(1, 10)}-1${crypto.randomInt(0, 10)}`;

let servidor = null;
let log = '';
let huboFallo = false;
let pg = null;

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

async function leer(ruta, { llave = LLAVE, correo = ACTIVA } = {}) {
  const headers = {};
  if (llave) headers['x-api-key'] = llave;
  if (correo) headers['x-kaos-connect-correo'] = correo;
  const res = await fetch(BASE + ruta, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  verificarEntornoLocal();
  if (!LLAVE) throw new Error('Falta KAOS_CONNECT_API_KEY para la prueba de humo.');

  const ocupado = await fetch(`${BASE}/`).then(() => true, () => false);
  if (ocupado) throw new Error(`Ya hay algo escuchando en ${BASE}. Detenlo o usa otro PUERTO_COTIZACIONES.`);

  // Datos de prueba: después de verificarEntornoLocal, que exige base local.
  pg = require('../../src/pg');
  await pg.query(
    `INSERT INTO erp.usuarios (email, nombre, activo) VALUES ($1, 'Humo activa', true), ($2, 'Humo inactiva', false)`,
    [ACTIVA, INACTIVA]);
  await pg.query(
    `INSERT INTO erp.proveedores (nit, razon_social, banco, tipo_cuenta, cuenta_bancaria, activo)
     VALUES ($1, 'Proveedor Humo KAOS Connect', 'Banco Humo', 'Ahorros', '000-HUMO-123', true)`, [NIT]);
  const obra = await pg.one(`SELECT id FROM erp.proyectos WHERE kaos_id = $1`, [PROYECTO]);
  assert.ok(obra, 'el seed local-p0.sql tiene que ligar el proyecto de prueba');
  for (const total of [100, 200, 300]) {
    const oc = await pg.one(
      `INSERT INTO erp.ordenes_compra (proyecto_id, proveedor_nit, subtotal, total, fecha_creacion)
       VALUES ($1, $2, $3, $3, $4::date + interval '12 hours') RETURNING id`, [obra.id, NIT, total, DIA]);
    await pg.query(
      `INSERT INTO erp.orden_compra_items (orden_compra_id, linea, descripcion, cantidad, precio_unitario)
       VALUES ($1, 1, 'Ítem humo', 1, $2), ($1, 2, 'Otro ítem humo', 2, 0)`, [oc.id, total]);
  }

  const env = {
    ...process.env, PUERTO_COTIZACIONES: String(PUERTO), KAOS_CONNECT_API_KEY: LLAVE,
  };
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
  if (pg) await pg.cerrar();
  if (huboFallo) console.log(`\n── Log del servidor ──\n${log}`);
});

describe('humo: /api/kaos-connect contra el Postgres local', () => {
  const ordenes = `/api/kaos-connect/ordenes-compra?proyecto=${PROYECTO}&desde=${DIA}&hasta=${DIA}`;

  caso('sin llave → 401', async () => {
    const r = await leer(ordenes, { llave: '' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'unauthorized' });
  });

  caso('con una llave equivocada → 401', async () => {
    assert.equal((await leer(ordenes, { llave: 'x'.repeat(LLAVE.length) })).status, 401);
  });

  caso('la llave de RRHH no abre KAOS Connect, ni la de KAOS Connect abre RRHH', async () => {
    if (LLAVE_RRHH) assert.equal((await leer(ordenes, { llave: LLAVE_RRHH })).status, 401);
    const r = await fetch(`${BASE}/api/ordenes-servicio?origenSolicitudId=${crypto.randomUUID()}`,
      { headers: { 'x-api-key': LLAVE } });
    await r.body?.cancel();
    assert.equal(r.status, LLAVE_RRHH ? 401 : 404);
  });

  caso('persona inactiva → 403 sin datos', async () => {
    const r = await leer(ordenes, { correo: INACTIVA });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'forbidden' });
  });

  caso('correo desconocido → 403', async () => {
    assert.equal((await leer(ordenes, { correo: `nadie-${SUFIJO}@ejemplo.test` })).status, 403);
  });

  caso('persona activa → las órdenes del proyecto, con sus ítems', async () => {
    const r = await leer(ordenes);
    assert.equal(r.status, 200);
    assert.equal(r.json.rows.length, 3);
    const oc = r.json.rows[0];
    assert.equal(oc.proyectoKaosId, PROYECTO);
    assert.equal(oc.proveedorNombre, 'Proveedor Humo KAOS Connect');
    assert.equal(oc.items.length, 2);
    assert.equal(oc.items[0].descripcion, 'Ítem humo');
  });

  caso('paginación: dos páginas sin repetir', async () => {
    const p1 = await leer(`${ordenes}&limit=2`);
    assert.equal(p1.json.rows.length, 2);
    assert.ok(p1.json.next_cursor);
    const p2 = await leer(`${ordenes}&limit=2&cursor=${p1.json.next_cursor}`);
    assert.equal(p2.json.rows.length, 1);
    assert.equal(p2.json.next_cursor, null);
    const ids = new Set([...p1.json.rows, ...p2.json.rows].map(o => o.id));
    assert.equal(ids.size, 3);
  });

  caso('otro proyecto de KAOS, sin obra ligada → lista vacía', async () => {
    const r = await leer(`/api/kaos-connect/ordenes-compra?proyecto=${crypto.randomUUID()}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { rows: [], next_cursor: null });
  });

  caso('proveedores sin datos bancarios', async () => {
    let cursor = null;
    let hallado = null;
    do {
      const r = await leer(`/api/kaos-connect/proveedores?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      for (const p of r.json.rows) {
        for (const campo of ['banco', 'tipoCuenta', 'tipo_cuenta', 'cuentaBancaria', 'cuenta_bancaria']) {
          assert.ok(!(campo in p), `el proveedor ${p.nit} trae ${campo}`);
        }
        if (p.nit === NIT) hallado = p;
      }
      cursor = r.json.next_cursor;
    } while (cursor);
    assert.ok(hallado, 'el proveedor de prueba aparece');
    assert.ok(!JSON.stringify(hallado).includes('000-HUMO-123'));
  });

  caso('los demás recursos responden 200', async () => {
    for (const recurso of ['requerimientos', 'ordenes-servicio', 'remisiones', 'inventario']) {
      const r = await leer(`/api/kaos-connect/${recurso}?proyecto=${PROYECTO}&limit=5`);
      assert.equal(r.status, 200, recurso);
      assert.ok(Array.isArray(r.json.rows), recurso);
    }
  });
});
