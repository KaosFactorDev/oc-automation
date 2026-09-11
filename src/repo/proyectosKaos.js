'use strict';
/**
 * repo/proyectosKaos.js — El espejo de los proyectos de KAOS.
 *
 * Regla de la capa: acá solo hay SQL. Qué hacer con las discrepancias se decide
 * en src/scripts/kaos-sync.js, no acá.
 */

const pg = require('../pg');

/**
 * Vuelca lo que entregó la API. Idempotente: correrlo dos veces deja lo mismo.
 *
 * `visto_en` se refresca SIEMPRE, incluso si nada más cambió. Es lo que permite
 * detectar bajas después de una reconciliación completa: lo que no se vio en
 * esta corrida, KAOS ya no lo entrega.
 */
async function volcar(proyectos) {
  if (!proyectos.length) return 0;

  return pg.tx(async (c) => {
    let n = 0;
    for (const p of proyectos) {
      await c.query(
        `INSERT INTO erp.proyectos_kaos
           (kaos_id, project_code, nombre, descripcion, estado,
            ciudad, departamento, pais, zona, kaos_creado, kaos_actualizado, visto_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (kaos_id) DO UPDATE SET
           project_code     = EXCLUDED.project_code,
           nombre           = EXCLUDED.nombre,
           descripcion      = EXCLUDED.descripcion,
           estado           = EXCLUDED.estado,
           ciudad           = EXCLUDED.ciudad,
           departamento     = EXCLUDED.departamento,
           pais             = EXCLUDED.pais,
           zona             = EXCLUDED.zona,
           kaos_creado      = EXCLUDED.kaos_creado,
           kaos_actualizado = EXCLUDED.kaos_actualizado,
           visto_en         = now()`,
        [
          p.id, p.project_code, p.name || '', p.description ?? null, p.estado ?? null,
          p.ciudad ?? null, p.departamento ?? null, p.pais ?? null, p.zona ?? null,
          p.created_at ?? null, p.updated_at,
        ],
      );
      n++;
    }
    return n;
  });
}

async function marcaGuardada() {
  const r = await pg.one('SELECT ultima_marca FROM erp.kaos_sync_estado WHERE id = 1');
  return r ? r.ultima_marca : null;
}

async function guardarMarca(marca, resultado) {
  await pg.query(
    `UPDATE erp.kaos_sync_estado
        SET ultima_marca = COALESCE($1, ultima_marca),
            ultima_corrida = now(),
            ultimo_resultado = $2
      WHERE id = 1`, [marca, resultado || null]);
}

/**
 * El informe de discrepancias. Cuatro preguntas, cada una con su consecuencia:
 *
 *  · ligados       ya se sabe qué fila del ERP es qué proyecto de KAOS
 *  · porNombre     el nombre coincide exacto: candidatos a ligar sin dudar
 *  · soloKaos      están en KAOS y no acá: el espejo los va a traer
 *  · soloErp       están acá y no en KAOS: centros de costo, huérfanos, u obras
 *                  viejas que nunca se cargaron. Cada uno se decide distinto,
 *                  por eso se devuelven con su `origen` y su conteo de uso.
 */
async function discrepancias() {
  const ligados = await pg.rows(
    `SELECT p.codigo, p.kaos_code, k.nombre AS kaos_nombre, k.zona
       FROM erp.proyectos p
       JOIN erp.proyectos_kaos k ON k.kaos_id = p.kaos_id
      ORDER BY p.codigo`);

  const porNombre = await pg.rows(
    `SELECT p.id, p.codigo, k.kaos_id, k.project_code, k.nombre AS kaos_nombre, k.zona
       FROM erp.proyectos p
       JOIN erp.proyectos_kaos k ON erp.norm(k.nombre) = erp.norm(p.codigo)
      WHERE p.kaos_id IS NULL
      ORDER BY p.codigo`);

  const soloKaos = await pg.rows(
    `SELECT k.kaos_id, k.project_code, k.nombre, k.estado, k.zona
       FROM erp.proyectos_kaos k
      WHERE NOT EXISTS (SELECT 1 FROM erp.proyectos p WHERE p.kaos_id = k.kaos_id)
        AND NOT EXISTS (SELECT 1 FROM erp.proyectos p WHERE erp.norm(p.codigo) = erp.norm(k.nombre))
      ORDER BY k.nombre`);

  // El uso decide qué hacer con los que solo están acá: uno con cientos de
  // compras es un centro de costo real, no un error de escritura.
  const soloErp = await pg.rows(
    `SELECT p.codigo, p.origen, p.activo, p.zona,
            (SELECT count(*) FROM erp.ordenes_compra   o WHERE o.proyecto_id = p.id)
          + (SELECT count(*) FROM erp.ordenes_servicio s WHERE s.proyecto_id = p.id)
          + (SELECT count(*) FROM erp.requerimientos   r WHERE r.proyecto_id = p.id)
          + (SELECT count(*) FROM erp.historial_precios h WHERE h.proyecto_id = p.id) AS documentos
       FROM erp.proyectos p
      WHERE p.kaos_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM erp.proyectos_kaos k
                         WHERE erp.norm(k.nombre) = erp.norm(p.codigo))
      ORDER BY documentos DESC, p.codigo`);

  const sinZona = await pg.one(
    `SELECT count(*) FILTER (WHERE zona IS NULL) AS sin,
            count(*) AS total FROM erp.proyectos_kaos`);

  return { ligados, porNombre, soloKaos, soloErp, sinZona };
}

// ─────────────────────────────────────────────────────────────────────────────
// El espejo alimenta el catálogo
// ─────────────────────────────────────────────────────────────────────────────
// Tres reglas, y las tres importan:
//
//  1. `codigo` NUNCA se toca en una fila que ya existía. Es lo que imprimen los
//     PDF y lo que `erp.vw_gastos` muestra por JOIN — o sea que pisarlo
//     reescribiría cómo se ve todo el pasado de esa obra en el control de
//     costos. Los proyectos viejos conservan su código de siempre.
//
//  2. La zona se valida contra `erp.zonas`. `erp.zona_canonica()` no valida
//     —devuelve tal cual lo que le den— así que una zona que KAOS tuviera y el
//     ERP no rompería la llave foránea. Lo que no calce queda en NULL.
//
//  3. `activo` sale del `estado` de KAOS. Es el dueño del catálogo: si allá la
//     obra se cerró, acá deja de ofrecerse para documentos nuevos.

const CAMPOS_DESDE_KAOS = `
  nombre       = k.nombre,
  ciudad       = k.ciudad,
  departamento = k.departamento,
  zona         = (SELECT z.zona FROM erp.zonas z
                   WHERE erp.norm(z.zona) = erp.norm(k.zona)),
  activo       = (k.estado = 'Activo'),
  updated_at   = now()`;

/**
 * Vuelca el espejo sobre el catálogo.
 *
 * @param {boolean} opts.aplicar  false (por defecto) solo cuenta qué haría.
 */
async function aplicar({ aplicar: hacerlo = false } = {}) {
  return pg.tx(async (c) => {
    // Los ya ligados: se actualizan. `codigo` queda intacto.
    const upd = await c.query(
      `UPDATE erp.proyectos p SET ${CAMPOS_DESDE_KAOS}
         FROM erp.proyectos_kaos k
        WHERE p.kaos_id = k.kaos_id AND p.origen = 'kaos'
       RETURNING p.codigo`);

    // Los de KAOS que todavía no están: entran como proyectos nuevos.
    //
    // `codigo` toma el NOMBRE de KAOS y no su project_code. El código corto
    // (KP-XXXXXX) es una llave, no una etiqueta: ponerlo en `codigo` haría que
    // el desplegable del comprador y el PDF que recibe el proveedor dijeran
    // "KP-4T7Q2X" en vez del nombre de la obra. El KP queda en `kaos_code`,
    // que es donde sirve.
    const ins = await c.query(
      `INSERT INTO erp.proyectos
         (codigo, nombre, ciudad, departamento, zona, activo, origen, kaos_id, kaos_code)
       SELECT k.nombre, k.nombre, k.ciudad, k.departamento,
              (SELECT z.zona FROM erp.zonas z WHERE erp.norm(z.zona) = erp.norm(k.zona)),
              (k.estado = 'Activo'), 'kaos', k.kaos_id, k.project_code
         FROM erp.proyectos_kaos k
        WHERE NOT EXISTS (SELECT 1 FROM erp.proyectos p WHERE p.kaos_id = k.kaos_id)
          AND NOT EXISTS (SELECT 1 FROM erp.proyectos p
                           WHERE erp.norm(p.codigo) = erp.norm(k.nombre))
       RETURNING codigo, kaos_code`);

    // Los que chocan: el nombre de KAOS ya existe en el catálogo, en una fila
    // que no está ligada —típicamente una obra vieja e inactiva—. No se inserta
    // (el índice único lo rechazaría) ni se liga por la fuerza: que dos filas
    // compartan nombre es justo lo que una persona tiene que resolver.
    const choques = await c.query(
      `SELECT k.project_code, k.nombre, p.codigo AS fila_erp, p.activo
         FROM erp.proyectos_kaos k
         JOIN erp.proyectos p ON erp.norm(p.codigo) = erp.norm(k.nombre)
        WHERE p.kaos_id IS NULL
        ORDER BY k.nombre`);

    if (!hacerlo) throw new SimulacionTerminada({
      actualizados: upd.rowCount, insertados: ins.rows, choques: choques.rows,
    });

    return { actualizados: upd.rowCount, insertados: ins.rows, choques: choques.rows };
  });
}

/** Aborta la transacción del ensayo llevándose el resultado. */
class SimulacionTerminada extends Error {
  constructor(resumen) { super('simulacion'); this.resumen = resumen; }
}

module.exports = { volcar, marcaGuardada, guardarMarca, discrepancias, aplicar, SimulacionTerminada };
