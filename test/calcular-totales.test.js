'use strict';
/**
 * Pruebas del cálculo de totales (npm test).
 *
 * Los valores esperados están hechos a mano, no con la misma función: si
 * alguien cambia la fórmula, estas pruebas fallan aunque el código "cuadre".
 *
 *   · apiRrhh.calcularTotales — la orden de servicio que crea RRHH por /api.
 *     Su total decide si la orden entra aprobada (≤ tope) o en borrador, así
 *     que un error acá aprueba solas órdenes que no debían.
 *   · ocTemplate.calcularTotales — los totales del PDF y el Excel de la OC.
 *   · osTemplate.calcularTotales — los de la OS (IVA pleno o AIU).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiRrhh    = require('../src/apiRrhh');
const ocTemplate = require('../src/ocTemplate');
const osTemplate = require('../src/osTemplate');

/** Las plantillas no redondean: se comparan al centavo. */
function assertMonto(real, esperado, que) {
  assert.ok(Math.abs(real - esperado) < 0.005, `${que}: ${real} y se esperaba ${esperado}`);
}

// ── apiRrhh ─────────────────────────────────────────────────────────────────

describe('apiRrhh.calcularTotales', () => {
  const calcular = apiRrhh.calcularTotales;

  it('suma la base y el IVA del 19 %', () => {
    assert.deepEqual(calcular([{ cantidad: 2, precioUnitario: 45000, ivaPct: 19 }]),
      { valor: 90000, iva: 17100, total: 107100 });
  });

  it('con IVA 0 % el total es la base', () => {
    assert.deepEqual(calcular([{ cantidad: 4, precioUnitario: 12500, ivaPct: 0 }]),
      { valor: 50000, iva: 0, total: 50000 });
  });

  it('acepta cantidades con decimales', () => {
    assert.deepEqual(calcular([{ cantidad: 2.5, precioUnitario: 1000, ivaPct: 19 }]),
      { valor: 2500, iva: 475, total: 2975 });
  });

  it('redondea la base y el IVA de cada línea al centavo', () => {
    // 3 × 33.333,33 = 99.999,99; su IVA, 18.999,9981, queda en 19.000.
    assert.deepEqual(calcular([{ cantidad: 3, precioUnitario: 33333.33, ivaPct: 19 }]),
      { valor: 99999.99, iva: 19000, total: 118999.99 });
  });

  it('el IVA se redondea por línea, no sobre la suma', () => {
    // Cada línea: 0,13 × 19 % = 0,0247 → 0,02. Sobre la suma sería 0,0494 → 0,05.
    const linea = { cantidad: 1, precioUnitario: 0.13, ivaPct: 19 };
    assert.deepEqual(calcular([linea, linea]), { valor: 0.26, iva: 0.04, total: 0.3 });
  });

  it('suma varias líneas con IVA distinto', () => {
    assert.deepEqual(calcular([
      { cantidad: 3, precioUnitario: 33333.33, ivaPct: 19 },
      { cantidad: 1, precioUnitario: 50000,    ivaPct: 0 },
    ]), { valor: 149999.99, iva: 19000, total: 168999.99 });
  });

  it('no arrastra el error de coma flotante (0,1 + 0,2)', () => {
    const r = calcular([
      { cantidad: 1, precioUnitario: 0.1, ivaPct: 0 },
      { cantidad: 1, precioUnitario: 0.2, ivaPct: 0 },
    ]);
    assert.equal(r.valor, 0.3);
    assert.equal(r.total, 0.3);
  });

  it('sin ítems todo es cero', () => {
    assert.deepEqual(calcular([]), { valor: 0, iva: 0, total: 0 });
  });

  it('el total es siempre valor + IVA', () => {
    const casos = [
      [{ cantidad: 7, precioUnitario: 18350.75, ivaPct: 19 }],
      [{ cantidad: 1, precioUnitario: 999999.99, ivaPct: 5 }, { cantidad: 12, precioUnitario: 0.33, ivaPct: 19 }],
    ];
    for (const items of casos) {
      const r = calcular(items);
      assert.equal(r.total, Math.round((r.valor + r.iva) * 100) / 100);
    }
  });
});

// ── ocTemplate (OC) ─────────────────────────────────────────────────────────

describe('ocTemplate.calcularTotales', () => {
  const calcular = ocTemplate.calcularTotales;

  it('aplica el descuento antes del IVA', () => {
    // 10 × 1.000 = 10.000; −10 % = 9.000; IVA 19 % = 1.710.
    const r = calcular({ items: [{ cantidad: 10, precioUnitario: 1000, descuentoPct: 10, ivaPct: 19 }] });
    assertMonto(r.subtotal, 9000, 'subtotal');
    assertMonto(r.iva, 1710, 'iva');
    assertMonto(r.total, 10710, 'total');
    assertMonto(r.items[0]._total, 10710, 'total del ítem');
  });

  it('suma varias líneas', () => {
    const r = calcular({ items: [
      { cantidad: 2, precioUnitario: 25000, ivaPct: 19 },
      { cantidad: 5, precioUnitario: 4000,  descuentoPct: 5, ivaPct: 0 },
    ] });
    // 50.000 + 19.000 (20.000 − 5 %) = 69.000; IVA solo de la primera: 9.500.
    assertMonto(r.subtotal, 69000, 'subtotal');
    assertMonto(r.iva, 9500, 'iva');
    assertMonto(r.total, 78500, 'total');
  });

  it('convierte a número los valores que llegan como texto', () => {
    const r = calcular({ items: [{ cantidad: '2', precioUnitario: '1500.5', ivaPct: '0' }] });
    assertMonto(r.total, 3001, 'total');
  });

  it('un ítem sin cantidad ni precio vale cero', () => {
    const r = calcular({ items: [{ descripcion: 'Sin datos' }] });
    assert.equal(r.total, 0);
  });

  it('sin ítems todo es cero', () => {
    assert.deepEqual(calcular({}), { items: [], subtotal: 0, iva: 0, total: 0 });
  });
});

// ── osTemplate (OS) ─────────────────────────────────────────────────────────

describe('osTemplate.calcularTotales', () => {
  const calcular = osTemplate.calcularTotales;

  it('por defecto es IVA pleno, por ítem', () => {
    const r = calcular({ items: [
      { cantidad: 2, precioUnitario: 100000, ivaPct: 19 },
      { precioUnitario: 50000, ivaPct: 0 },               // sin cantidad cuenta 1
    ] });
    assert.equal(r.tipo, 'IVA_PLENO');
    assertMonto(r.subtotal, 250000, 'subtotal');
    assertMonto(r.iva, 38000, 'iva');
    assertMonto(r.total, 288000, 'total');
  });

  it('AIU: el IVA va solo sobre la utilidad', () => {
    const r = calcular({
      tipoContrato: 'AIU',
      items: [{ cantidad: 1, precioUnitario: 1000000 }],
      aiuA: 10, aiuI: 5, aiuU: 5, ivaPct: 19,
    });
    assert.equal(r.tipo, 'AIU');
    assertMonto(r.subtotal, 1000000, 'costos directos');
    assertMonto(r.A, 100000, 'administración');
    assertMonto(r.I, 50000, 'imprevistos');
    assertMonto(r.U, 50000, 'utilidad');
    assertMonto(r.aiuTotal, 200000, 'AIU');
    assertMonto(r.iva, 9500, 'IVA sobre la utilidad');
    assertMonto(r.total, 1209500, 'total');
  });

  it('AIU sin ivaPct usa el 19 %', () => {
    const r = calcular({ tipoContrato: 'AIU', items: [{ precioUnitario: 200000 }], aiuU: 10 });
    assertMonto(r.iva, 3800, 'IVA sobre la utilidad');
    assertMonto(r.total, 223800, 'total');
  });
});
