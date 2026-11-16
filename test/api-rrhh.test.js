'use strict';
/**
 * Pruebas de la API de RRHH (src/apiRrhh.js), sin base de datos (npm test).
 *
 * Se entra por atender(), igual que el servidor, con una petición y una
 * respuesta falsas. Lo que iría a Postgres se reemplaza con t.mock.method sobre
 * los mismos objetos que usa apiRrhh (repoOS, repoProyecto, configApp,
 * bitacora, repoReq); cada mock se restaura solo al terminar su prueba.
 *
 * La llave (x-api-key) se valida en servidor-cotizaciones.js, antes de llegar
 * acá: eso lo cubre la prueba de humo (test/humo/).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const apiRrhh      = require('../src/apiRrhh');
const repoOS       = require('../src/repo/ordenesServicio');
const repoReq      = require('../src/repo/requerimientos');
const repoProyecto = require('../src/repo/_proyecto');
const configApp    = require('../src/configApp');
const bitacora     = require('../src/bitacora');

const SOLICITUD = '11111111-1111-4111-8111-111111111111';
const PROYECTO  = '00000000-0000-4000-a000-000000000101';
const PROYECTO_ACTIVO = { id: 1, codigo: 'LOCAL-P0', activo: true, etiqueta: 'Proyecto Local P0' };

// ── Petición y respuesta falsas ─────────────────────────────────────────────

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
async function llamar(t, metodo, url, cuerpo) {
  // El log de una línea por llamada ([api] …) ensucia la salida de las pruebas.
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const datos = cuerpo === undefined ? []
    : [Buffer.from(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo))];
  const req = Object.assign(Readable.from(datos), { method: metodo, url, headers: {} });
  const res = respuestaFalsa();
  await apiRrhh.atender(req, res, url.split('?')[0]);
  return res;
}

// ── La base, simulada ───────────────────────────────────────────────────────

/**
 * Una base con el proyecto activo, sin la orden y con el tope dado. Devuelve los
 * mocks para revisar con qué se llamaron.
 */
function simularBase(t, { existente = [], proyecto = PROYECTO_ACTIVO, tope = 500000, crear } = {}) {
  return {
    porOrigenSolicitud: t.mock.method(repoOS, 'porOrigenSolicitud', async () => existente),
    porKaosId:          t.mock.method(repoProyecto, 'porKaosId', async () => proyecto),
    configGet:          t.mock.method(configApp, 'get', async () => tope),
    crearDesdeApi:      t.mock.method(repoOS, 'crearDesdeApi', crear ||
      (async (_datos, _items, { aprobar, formatear }) => ({ id: '7', numeroOS: aprobar ? formatear(7) : null }))),
    foto:               t.mock.method(bitacora, 'foto', async () => null),
    anotar:             t.mock.method(bitacora, 'anotar', async () => {}),
  };
}

/** Orden de servicio válida: total 168.999,99 (149.999,99 + IVA 19.000). */
function cuerpoOS(cambios = {}) {
  return {
    origenSistema:             'rrhh-app',
    origenSolicitudId:         SOLICITUD,
    origenSolicitadoPor:       'rrhh@ejemplo.test',
    origenSolicitadoPorNombre: 'Persona de Prueba',
    proyectoKaosId:            PROYECTO,
    proveedorNit:              '0000000301',
    proveedorNombre:           'IPS de Prueba',
    cotizacionReferencia:      'COT-0001',
    tipoServicio:              'Exámenes médicos de ingreso',
    items: [
      { descripcion: 'Examen de ingreso', cantidad: 3, precioUnitario: 33333.33, ivaPct: 19 },
      { descripcion: 'Audiometría',       cantidad: 1, precioUnitario: 50000,    ivaPct: 0 },
    ],
    ...cambios,
  };
}

const TOTALES = { valor: 149999.99, iva: 19000, total: 168999.99 };

// ── Rutas ───────────────────────────────────────────────────────────────────

describe('apiRrhh: rutas y cuerpo', () => {
  it('ruta desconocida → 404', async (t) => {
    const res = await llamar(t, 'GET', '/api/otra');
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: 'not_found' });
  });

  it('método distinto de GET o POST → 405 con Allow', async (t) => {
    const res = await llamar(t, 'PUT', '/api/ordenes-servicio');
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, POST');
  });

  it('GET con origenSolicitudId que no es uuid → 422', async (t) => {
    const res = await llamar(t, 'GET', '/api/ordenes-servicio?origenSolicitudId=123');
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'payload_invalido');
  });

  it('POST con JSON inválido → 422', async (t) => {
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', '{no es json');
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.detalles, ['El cuerpo no es JSON válido.']);
  });

  it('POST con un array en vez de objeto → 422', async (t) => {
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', []);
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.detalles, ['El cuerpo debe ser un objeto JSON.']);
  });

  it('POST de más de 256 KB → 413', async (t) => {
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', `{"x":"${'a'.repeat(300 * 1024)}"}`);
    assert.equal(res.status, 413);
    assert.deepEqual(res.json, { error: 'payload_muy_grande' });
  });
});

// ── Orden de servicio ───────────────────────────────────────────────────────

describe('apiRrhh: POST /api/ordenes-servicio', () => {
  it('valida cada campo y no toca la base si hay errores', async (t) => {
    const base = simularBase(t);
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS({
      origenSistema: 'otro',
      proveedorNit:  '90012A',
      items: [{ descripcion: 'Examen', cantidad: 0, precioUnitario: 1000 }],
    }));
    assert.equal(res.status, 422);
    for (const msg of [
      '"origenSistema" debe ser "rrhh-app".',
      '"proveedorNit" debe traer solo dígitos.',
      'Ítem 1: "cantidad" debe ser mayor que 0.',
      // Sin valor por defecto: un 19 % puesto por omisión pasaría al total.
      'Ítem 1: falta "ivaPct".',
    ]) assert.ok(res.json.detalles.includes(msg), `falta el detalle: ${msg}`);
    assert.equal(base.porOrigenSolicitud.mock.callCount(), 0);
  });

  it('sin ítems → 422', async (t) => {
    simularBase(t);
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS({ items: [] }));
    assert.equal(res.status, 422);
    assert.ok(res.json.detalles.includes('"items" debe ser una lista con al menos un ítem.'));
  });

  it('total ≤ tope → 201 aprobada, con los totales calculados en el ERP', async (t) => {
    const base = simularBase(t, { tope: 500000 });
    // Los totales del payload se ignoran: los fija el ERP desde los ítems.
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS({ valor: 1, iva: 1, total: 1 }));
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, {
      creada: true, erpItemId: '7', erpTipoDocumento: 'OS', estado: 'aprobada',
      aprobadaAutomaticamente: true, numeroOS: 'OS-0007', tope: 500000,
      proyecto: 'Proyecto Local P0', ...TOTALES,
    });

    assert.equal(base.crearDesdeApi.mock.callCount(), 1);
    const [datos, items, opciones] = base.crearDesdeApi.mock.calls[0].arguments;
    assert.equal(datos.valor, TOTALES.valor);
    assert.equal(datos.iva, TOTALES.iva);
    assert.equal(datos.total, TOTALES.total);
    assert.equal(datos.creadoPor, 'rrhh@ejemplo.test');
    assert.equal(items.length, 2);
    assert.equal(opciones.aprobar, true);
    // Bitácora: la creación y la aprobación automática.
    assert.deepEqual(base.anotar.mock.calls.map(c => c.arguments[0].accion), ['crear', 'aprobar']);
  });

  it('total igual al tope → aprobada', async (t) => {
    simularBase(t, { tope: TOTALES.total });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.json.estado, 'aprobada');
  });

  it('tope guardado como texto → se interpreta como número', async (t) => {
    simularBase(t, { tope: '500000' });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.json.estado, 'aprobada');
    assert.equal(res.json.tope, 500000);
  });

  it('total > tope → 201 en borrador, sin número', async (t) => {
    const base = simularBase(t, { tope: 100000 });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.status, 201);
    assert.equal(res.json.estado, 'borrador');
    assert.equal(res.json.aprobadaAutomaticamente, false);
    assert.equal(res.json.motivo, 'supera_tope');
    assert.equal(res.json.numeroOS, null);
    assert.equal(res.json.total, TOTALES.total);
    assert.equal(base.crearDesdeApi.mock.calls[0].arguments[2].aprobar, false);
    assert.deepEqual(base.anotar.mock.calls.map(c => c.arguments[0].accion), ['crear']);
  });

  for (const tope of [null, 'abc', -1]) {
    it(`tope ${JSON.stringify(tope)} → borrador (falla cerrado)`, async (t) => {
      simularBase(t, { tope });
      const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
      assert.equal(res.status, 201);
      assert.equal(res.json.estado, 'borrador');
      assert.equal(res.json.motivo, 'tope_no_configurado');
      assert.equal(res.json.tope, null);
    });
  }

  it('ya existe para esa solicitud → 200 con la existente, sin crear otra', async (t) => {
    const base = simularBase(t, { existente: [{
      id: 7, estado: 'aprobada', numero_os: 'OS-0007', proyecto: 'Proyecto Local P0',
      valor: '149999.99', iva: '19000.00', total: '168999.99',
    }] });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      creada: false, duplicada: true, erpItemId: '7', erpTipoDocumento: 'OS',
      estado: 'aprobada', numeroOS: 'OS-0007', proyecto: 'Proyecto Local P0', ...TOTALES,
    });
    assert.equal(base.crearDesdeApi.mock.callCount(), 0);
  });

  it('proyecto que no existe → 422', async (t) => {
    const base = simularBase(t, { proyecto: null });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'payload_invalido');
    assert.equal(base.crearDesdeApi.mock.callCount(), 0);
  });

  it('proyecto inactivo → 409', async (t) => {
    simularBase(t, { proyecto: { ...PROYECTO_ACTIVO, activo: false } });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'proyecto_inactivo');
  });

  it('dos POST en paralelo: el que choca con el índice único devuelve 200', async (t) => {
    const base = simularBase(t, {
      crear: async () => {
        throw Object.assign(new Error('duplicate key'),
          { code: '23505', constraint: 'ordenes_servicio_origen_solicitud_key' });
      },
    });
    // La primera consulta no la encuentra; la de después del choque, sí.
    let consultas = 0;
    base.porOrigenSolicitud.mock.mockImplementation(async () => (consultas++ === 0 ? [] : [{
      id: 8, estado: 'borrador', numero_os: null, proyecto: 'Proyecto Local P0',
      valor: '149999.99', iva: '19000.00', total: '168999.99',
    }]));
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.status, 200);
    assert.equal(res.json.duplicada, true);
    assert.equal(res.json.erpItemId, '8');
  });

  it('error inesperado → 500 sin detalles internos', async (t) => {
    simularBase(t, { crear: async () => { throw new Error('se cayó la base'); } });
    const res = await llamar(t, 'POST', '/api/ordenes-servicio', cuerpoOS());
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'error_interno' });
  });
});

describe('apiRrhh: GET /api/ordenes-servicio', () => {
  it('devuelve las órdenes con total numérico y fecha ISO', async (t) => {
    const base = simularBase(t, { existente: [{
      id: 7, numero_os: null, estado: 'borrador', pagado: false, cumplido: false,
      proyecto: null, total: '1190.00', fecha_creacion: new Date('2026-11-05T15:00:00Z'),
    }] });
    const res = await llamar(t, 'GET', `/api/ordenes-servicio?origenSolicitudId=${SOLICITUD.toUpperCase()}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ordenesServicio: [{
      erpItemId: '7', numeroOS: null, estado: 'borrador', pagado: false, cumplido: false,
      proyecto: '', total: 1190, fechaCreacion: '2026-11-05T15:00:00.000Z',
    }] });
    // El uuid se busca en minúsculas.
    assert.deepEqual(base.porOrigenSolicitud.mock.calls[0].arguments, [SOLICITUD]);
  });

  it('sin resultados → 200 con la lista vacía, nunca 404', async (t) => {
    simularBase(t);
    const res = await llamar(t, 'GET', `/api/ordenes-servicio?origenSolicitudId=${SOLICITUD}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ordenesServicio: [] });
  });
});

// ── Requerimiento ───────────────────────────────────────────────────────────

describe('apiRrhh: POST /api/requerimientos', () => {
  const cuerpoReq = (items) => ({ ...cuerpoOS(), items });

  it('ítem sin insumo o con cantidad ≤ 0 → 422', async (t) => {
    const porOrigenCorreo = t.mock.method(repoReq, 'porOrigenCorreo', async () => null);
    const res = await llamar(t, 'POST', '/api/requerimientos', cuerpoReq([{ insumo: ' ', cantidad: 0 }]));
    assert.equal(res.status, 422);
    assert.ok(res.json.detalles.includes('Ítem 1: falta "insumo".'));
    assert.ok(res.json.detalles.includes('Ítem 1: "cantidad" debe ser mayor que 0.'));
    assert.equal(porOrigenCorreo.mock.callCount(), 0);
  });

  it('ya existe para esa solicitud → 200 con el existente', async (t) => {
    const porOrigenCorreo = t.mock.method(repoReq, 'porOrigenCorreo', async () => ({
      id: 9, consecutivoSistema: 'LOCAL-P0-0001', estado: 'pendiente',
    }));
    const res = await llamar(t, 'POST', '/api/requerimientos',
      cuerpoReq([{ insumo: 'Botas de seguridad', cantidad: 2, unidad: 'par' }]));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      creado: false, duplicado: true, erpItemId: '9', erpTipoDocumento: 'REQ',
      consecutivo: 'LOCAL-P0-0001', estado: 'pendiente',
    });
    assert.deepEqual(porOrigenCorreo.mock.calls[0].arguments, [`rrhh:${SOLICITUD}`]);
  });
});
