'use strict';
/**
 * Pruebas de la API de lectura para KAOS Connect (src/apiKaosConnect.js), sin
 * base de datos (npm test).
 *
 * Se entra por atender(), igual que el servidor, con una petición y una
 * respuesta falsas. Lo que iría a Postgres se reemplaza con t.mock.method.
 *
 * La llave (x-api-key) se valida en servidor-cotizaciones.js, antes de llegar
 * acá: eso lo cubre la prueba de humo (test/humo/api-kaos-connect.test.js).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const api           = require('../src/apiKaosConnect');
const repo          = require('../src/repo/kaosConnect');
const repoCatalogos = require('../src/repo/catalogos');
const repoProyecto  = require('../src/repo/_proyecto');

const CORREO   = 'persona@empresa.co';
const PROYECTO = '00000000-0000-4000-a000-000000000101';
const ACTIVO   = { id: 7, email: CORREO, activo: true, roles: ['consulta'] };

function respuestaFalsa() {
  return {
    status: null,
    headers: {},
    cuerpo: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    },
    end(c = '') { this.cuerpo += c; },
    get json() { return JSON.parse(this.cuerpo); },
  };
}

/** Llama a atender() como lo hace el servidor: la ruta va sin query string. */
async function llamar(t, url, { metodo = 'GET', correo = CORREO } = {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const headers = correo === null ? {} : { 'x-kaos-connect-correo': correo };
  const req = { method: metodo, url, headers };
  const res = respuestaFalsa();
  await api.atender(req, res, url.split('?')[0]);
  return res;
}

/** Usuario y proyecto simulados, y una lectura que devuelve `filas`. */
function simular(t, { usuario = ACTIVO, obra = { id: 1, codigo: 'LOCAL-P0' }, filas = [] } = {}) {
  return {
    usuario: t.mock.method(repoCatalogos, 'getUsuarioByEmail', async () => usuario),
    obra:    t.mock.method(repoProyecto, 'porKaosId', async () => obra),
    leer:    t.mock.method(repo, 'ordenesCompra', async () => filas),
  };
}

describe('KAOS Connect — la persona', () => {
  it('sin el correo: 422', async (t) => {
    simular(t);
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra', { correo: null });
    assert.equal(res.status, 422);
    assert.match(res.json.detalles[0], /x-kaos-connect-correo/);
  });

  it('sin cuenta: 403 sin datos', async (t) => {
    const m = simular(t, { usuario: null });
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra');
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'forbidden' });
    assert.equal(m.leer.mock.callCount(), 0);
  });

  it('cuenta inactiva: 403 sin datos', async (t) => {
    const m = simular(t, { usuario: { ...ACTIVO, activo: false } });
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra');
    assert.equal(res.status, 403);
    assert.equal(m.leer.mock.callCount(), 0);
  });

  it('el correo se busca en minúsculas y sin espacios', async (t) => {
    const m = simular(t);
    await llamar(t, '/api/kaos-connect/ordenes-compra', { correo: '  Persona@Empresa.CO ' });
    assert.equal(m.usuario.mock.calls[0].arguments[0], CORREO);
  });
});

describe('KAOS Connect — rutas y método', () => {
  it('ruta desconocida: 404', async (t) => {
    simular(t);
    for (const url of ['/api/kaos-connect/usuarios', '/api/kaos-connect/constructor', '/api/kaos-connect/__proto__']) {
      assert.equal((await llamar(t, url)).status, 404, url);
    }
  });

  it('POST: 405 con Allow: GET', async (t) => {
    simular(t);
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra', { metodo: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  });
});

describe('KAOS Connect — parámetros', () => {
  for (const [caso, qs] of [
    ['limit de 201', 'limit=201'],
    ['limit de 0', 'limit=0'],
    ['limit no entero', 'limit=1.5'],
    ['cursor inválido', 'cursor=xx'],
    ['proyecto que no es uuid', 'proyecto=LOCAL-P0'],
    ['fecha con otro formato', 'desde=01/11/2026'],
  ]) {
    it(`${caso}: 422`, async (t) => {
      const m = simular(t);
      const res = await llamar(t, `/api/kaos-connect/ordenes-compra?${qs}`);
      assert.equal(res.status, 422);
      assert.equal(res.json.error, 'payload_invalido');
      assert.equal(m.leer.mock.callCount(), 0);
    });
  }

  it('proveedores no se filtra por proyecto: 422', async (t) => {
    simular(t);
    const res = await llamar(t, `/api/kaos-connect/proveedores?proyecto=${PROYECTO}`);
    assert.equal(res.status, 422);
  });

  it('pasa proyecto, estado, fechas, limit y offset al repo', async (t) => {
    const m = simular(t);
    const cursor = api.codificarCursor(40);
    await llamar(t, `/api/kaos-connect/ordenes-compra?proyecto=${PROYECTO}&estado=Aprobada&desde=2026-11-01&hasta=2026-11-30&limit=20&cursor=${cursor}`);
    assert.deepEqual(m.leer.mock.calls[0].arguments[0], {
      proyectoId: 1, estado: 'Aprobada', desde: '2026-11-01', hasta: '2026-11-30', limit: 20, offset: 40,
    });
  });
});

describe('KAOS Connect — respuesta', () => {
  it('proyecto de KAOS sin obra ligada: lista vacía, sin leer', async (t) => {
    const m = simular(t, { obra: null });
    const res = await llamar(t, `/api/kaos-connect/ordenes-compra?proyecto=${PROYECTO}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { rows: [], next_cursor: null });
    assert.equal(m.leer.mock.callCount(), 0);
  });

  it('con una fila de más hay next_cursor, y la página trae solo limit', async (t) => {
    simular(t, { filas: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra?limit=2');
    assert.equal(res.status, 200);
    assert.equal(res.json.rows.length, 2);
    assert.equal(api.leerCursor(res.json.next_cursor), 2);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('sin más filas: next_cursor null', async (t) => {
    simular(t, { filas: [{ id: '1' }] });
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra?limit=2');
    assert.equal(res.json.next_cursor, null);
  });

  it('un error de la base: 500 sin detalles', async (t) => {
    simular(t);
    t.mock.method(repo, 'ordenesCompra', async () => { throw new Error('conexión caída'); });
    const res = await llamar(t, '/api/kaos-connect/ordenes-compra');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'error_interno' });
  });

  it('el log no lleva el correo', async (t) => {
    simular(t);
    const lineas = [];
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', (...a) => lineas.push(a.join(' ')));
    const res = respuestaFalsa();
    await api.atender({ method: 'GET', url: '/api/kaos-connect/ordenes-compra', headers: { 'x-kaos-connect-correo': CORREO } },
      res, '/api/kaos-connect/ordenes-compra');
    assert.equal(res.status, 200);
    assert.ok(lineas.length > 0);
    assert.ok(lineas.every((l) => !l.includes(CORREO)));
  });
});
