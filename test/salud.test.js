'use strict';
// GET /health (T-131): 200 solo si la base responde a tiempo; si no, 503 sin
// detalles de la base en la respuesta.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { revisarSalud } = require('../src/salud');

describe('revisarSalud', () => {
  it('la base responde → 200', async () => {
    const r = await revisarSalud(async () => ({ rows: [{ '?column?': 1 }] }));
    assert.deepEqual(r, { status: 200, cuerpo: { estado: 'ok', base: 'ok' } });
  });

  it('la base falla → 503, sin el mensaje del error en la respuesta', async () => {
    const r = await revisarSalud(async () => {
      throw new Error('password authentication failed — conectando a erp_app@db:5432/erp');
    });
    assert.equal(r.status, 503);
    assert.deepEqual(r.cuerpo, { estado: 'error', base: 'sin_respuesta' });
    assert.ok(!JSON.stringify(r.cuerpo).includes('erp_app'));
  });

  it('la base no contesta a tiempo → 503 al vencer el tope', async () => {
    const inicio = Date.now();
    const r = await revisarSalud(() => new Promise(() => {}), 50);
    assert.equal(r.status, 503);
    assert.ok(Date.now() - inicio < 1000);
  });
});
