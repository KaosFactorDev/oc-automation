'use strict';
/**
 * salud.js — Lo que responde GET /health.
 *
 * Lo usa el healthcheck del contenedor (docker-compose.yml), y con él el deploy,
 * que espera a que la app quede «healthy». Antes el healthcheck pedía «/», que
 * solo sirve la consola: el contenedor quedaba sano aunque Postgres no
 * respondiera y ninguna pantalla funcionara.
 *
 * La revisión es un «SELECT 1» con tope de tiempo. El tope va más corto que el
 * timeout del healthcheck (5 s) para que un Postgres colgado dé un 503 claro y
 * no un curl que se corta sin respuesta.
 *
 * Es pública (la pide Docker, sin sesión), así que la respuesta no dice nada
 * de la base: ni host ni el mensaje del error. El detalle va al log.
 */

const TOPE_MS = 3000;

/**
 * @param {() => Promise<unknown>} consultar hace la consulta a la base
 * @param {number} [topeMs]
 * @returns {Promise<{ status: number, cuerpo: { estado: 'ok' | 'error', base: 'ok' | 'sin_respuesta' } }>}
 */
async function revisarSalud(consultar, topeMs = TOPE_MS) {
  let temporizador;
  const tope = new Promise((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new Error(`la base no respondió en ${topeMs} ms`)),
      topeMs,
    );
  });
  try {
    await Promise.race([consultar(), tope]);
    return { status: 200, cuerpo: { estado: 'ok', base: 'ok' } };
  } catch (err) {
    console.warn('[health] La base no responde:', err.message);
    return { status: 503, cuerpo: { estado: 'error', base: 'sin_respuesta' } };
  } finally {
    clearTimeout(temporizador);
  }
}

module.exports = { revisarSalud, TOPE_MS };
