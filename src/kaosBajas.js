'use strict';
/**
 * kaosBajas.js — Cuándo una reconciliación completa puede marcar proyectos como
 * borrados en KAOS (T-124).
 *
 * Marcar una baja desactiva el proyecto en el catálogo en el siguiente
 * `kaos-aplicar`, y el cron corre los dos seguidos. Por eso esta regla es un
 * freno: si KAOS responde vacío o recortado —un error de su lado, una llave que
 * ve otra empresa, una página que no llegó— el ERP no puede leer eso como «se
 * borraron todas las obras» y apagar el catálogo a las 3 de la mañana.
 *
 *   · KAOS no entregó ningún proyecto       → no se marca nada.
 *   · Se iría más del UMBRAL de los vivos   → no se marca nada.
 *   · Si no, se marcan.
 *
 * Con `--forzar-bajas` se marcan igual: es para cuando una persona ya revisó la
 * lista y las bajas son reales (por ejemplo, una limpieza grande en KAOS).
 *
 * Sin base de datos ni red: solo números, para poder probarla sola.
 */

/** Fracción máxima de los proyectos vivos que puede darse de baja de una vez. */
const UMBRAL = 0.2;

/**
 * @param {object} p
 * @param {number} p.recibidos  proyectos que entregó KAOS en esta corrida
 * @param {number} p.vivos      proyectos del espejo sin marca de eliminado
 * @param {number} p.bajas      de esos, cuántos no llegaron en esta corrida
 * @param {boolean} [p.forzar]  `--forzar-bajas`: marcar aunque se pase el freno
 * @returns {{ marcar: boolean, motivo: string|null }}
 */
function decidirBajas({ recibidos, vivos, bajas, forzar = false }) {
  if (!bajas) return { marcar: false, motivo: null };
  if (forzar) return { marcar: true, motivo: null };

  if (!recibidos) {
    return {
      marcar: false,
      motivo: 'KAOS no entregó ningún proyecto. Se toma como una falla de KAOS, no ' +
              'como que se borraron todos.',
    };
  }

  if (vivos > 0 && bajas / vivos > UMBRAL) {
    const pct = Math.round((bajas / vivos) * 100);
    return {
      marcar: false,
      motivo: `Se darían de baja ${bajas} de ${vivos} proyectos (${pct} %), más del ` +
              `${Math.round(UMBRAL * 100)} % permitido de una vez. Si son bajas reales, ` +
              'revisa la lista y corre de nuevo con --forzar-bajas.',
    };
  }

  return { marcar: true, motivo: null };
}

module.exports = { decidirBajas, UMBRAL };
