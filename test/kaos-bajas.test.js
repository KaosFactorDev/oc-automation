'use strict';
/**
 * Pruebas del freno de bajas de KAOS (npm test).
 *
 * `decidirBajas` decide si una reconciliación completa puede marcar proyectos
 * como borrados en KAOS. Marcar los desactiva en el catálogo en el siguiente
 * `kaos-aplicar`, que el cron corre enseguida, así que un error acá apaga obras
 * vivas. Los casos están escritos a mano: el umbral es del 20 %.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decidirBajas, UMBRAL } = require('../src/kaosBajas');

describe('kaosBajas.decidirBajas', () => {
  it('el umbral es del 20 %', () => {
    assert.equal(UMBRAL, 0.2);
  });

  it('sin bajas no hay nada que marcar ni que explicar', () => {
    assert.deepEqual(decidirBajas({ recibidos: 50, vivos: 50, bajas: 0 }), { marcar: false, motivo: null });
  });

  it('marca unas pocas bajas normales', () => {
    assert.deepEqual(decidirBajas({ recibidos: 48, vivos: 50, bajas: 2 }), { marcar: true, motivo: null });
  });

  it('marca justo en el 20 %: el límite es «más de»', () => {
    assert.equal(decidirBajas({ recibidos: 40, vivos: 50, bajas: 10 }).marcar, true);
  });

  it('frena por encima del 20 % y lo explica', () => {
    const r = decidirBajas({ recibidos: 39, vivos: 50, bajas: 11 });
    assert.equal(r.marcar, false);
    assert.match(r.motivo, /11 de 50 proyectos \(22 %\)/);
    assert.match(r.motivo, /--forzar-bajas/);
  });

  it('frena si KAOS no entregó ningún proyecto, aunque se fueran todos', () => {
    const r = decidirBajas({ recibidos: 0, vivos: 50, bajas: 50 });
    assert.equal(r.marcar, false);
    assert.match(r.motivo, /falla de KAOS/);
  });

  it('frena una respuesta vacía aunque el espejo sea chico', () => {
    assert.equal(decidirBajas({ recibidos: 0, vivos: 1, bajas: 1 }).marcar, false);
  });

  it('--forzar-bajas marca aunque se pase el freno', () => {
    assert.deepEqual(decidirBajas({ recibidos: 39, vivos: 50, bajas: 11, forzar: true }), { marcar: true, motivo: null });
    assert.equal(decidirBajas({ recibidos: 0, vivos: 50, bajas: 50, forzar: true }).marcar, true);
  });
});
