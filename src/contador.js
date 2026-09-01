'use strict';
/**
 * contador.js — Formato de los consecutivos de OC y OS.
 *
 * Solo el FORMATO. El número lo emite Postgres:
 *   erp.siguiente_numero_oc()  →  repoOrdenesCompra.aprobar()
 *   erp.siguiente_numero_os()  →  repoOrdenesServicio.aprobar()
 *
 * El prefijo y el relleno se quedan acá porque son configuración de la
 * aplicación (OC_PREFIX, OC_PAD, OS_PREFIX, OS_PAD) y no tienen por qué vivir
 * en la base: las funciones de Postgres devuelven el entero y quien aprueba le
 * da forma.
 *
 * ── Qué había antes ────────────────────────────────────────────────────────
 * Este módulo calculaba el siguiente número como MAX(numeroOC) sobre la lista
 * de SharePoint —o sobre el caché SQLite—, excluyendo los estados que "no
 * consumen número" (anulada, borrador). Eso tenía dos fallas:
 *
 *  · Excluir los anulados significaba que anular la orden más alta liberaba su
 *    número, y la siguiente lo reutilizaba. Ocurrió 16 veces en producción: 11
 *    números de OC y 5 de OS quedaron repetidos.
 *
 *  · Un MAX() leído antes de escribir es una condición de carrera. Se intentó
 *    mitigar llamando a syncAll() justo antes de leer, lo que reducía la
 *    ventana sin cerrarla.
 *
 * Las dos desaparecen emitiendo desde una tabla de contadores con
 * UPDATE ... RETURNING dentro de la transacción que escribe el documento: el
 * contador nunca retrocede, anular no libera un número, y dos aprobaciones
 * simultáneas se serializan.
 */

function formato(numero) {
  const prefix = process.env.OC_PREFIX || '';
  const pad    = parseInt(process.env.OC_PAD || '4', 10);
  return prefix + String(numero).padStart(pad, '0');
}

function formatoOS(numero) {
  const prefix = process.env.OS_PREFIX || 'OS-';
  const pad    = parseInt(process.env.OS_PAD || '4', 10);
  return prefix + String(numero).padStart(pad, '0');
}

module.exports = { formato, formatoOS };
