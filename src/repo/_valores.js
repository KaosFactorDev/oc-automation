'use strict';
/**
 * _valores.js — Normalización de valores en el borde de la capa de repositorio.
 *
 * El problema que resuelve: un formulario web nunca manda `null`. Un desplegable
 * sin elegir y un campo de texto vacío llegan como `''`, y `datos.zona ?? null`
 * no los convierte —`??` solo actúa sobre `undefined` y `null`—, así que la
 * cadena vacía llega a la base tal cual.
 *
 * Para una columna cualquiera eso es feo pero inocuo. Para una con llave foránea
 * es un error:
 *
 *   ERROR: insert or update on table "proveedores" violates foreign key
 *          constraint "proveedores_zona_fkey"
 *   DETAIL: Key (zona)=() is not present in table "zonas".
 *
 * Y el mensaje no ayuda: habla de la llave foránea, no de que el valor sea una
 * cadena vacía, así que parece que faltara una zona en el catálogo.
 *
 * `fk()` se aplica solo a columnas con llave foránea, donde la cadena vacía es
 * inválida por definición y NULL significa "sin asignar". A propósito NO se
 * aplica a los demás campos de texto: ahí `''` y NULL se distinguen —uno es
 * "el usuario lo borró", el otro "no lo tocó"— y cambiarlo alteraría cómo se
 * comportan los COALESCE de los upsert.
 */

/**
 * Valor para una columna con llave foránea: la cadena vacía o en blanco pasa a
 * NULL. Cualquier otro valor va sin tocar, para que un código inexistente sí
 * falle contra la llave foránea, que es lo correcto.
 */
function fk(valor) {
  if (valor === undefined || valor === null) return null;
  const s = String(valor).trim();
  return s === '' ? null : s;
}

module.exports = { fk };
