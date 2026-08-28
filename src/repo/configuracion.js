'use strict';
/**
 * repo/configuracion.js — Acceso a la tabla erp.configuracion.
 *
 * ── Qué es src/repo/ ───────────────────────────────────────────────────────
 * La capa de datos del ERP. Es el ÚNICO lugar que sabe que detrás hay Postgres:
 * conoce nombres de tabla y de columna, y nada más.
 *
 * Dos reglas que la mantienen útil:
 *
 *  1. Fuera de src/repo/ no se escribe SQL, y aquí adentro no se toman
 *     decisiones de negocio. Los valores por defecto, el ensamblado y el caché
 *     de la configuración viven en configApp.js, que es quien los entiende.
 *
 *  2. Cada función es una operación completa. Quien llama pide "dame estas
 *     claves", no "arma esta consulta".
 *
 * Antes de esto, servidor-cotizaciones.js hablaba con Microsoft Graph
 * directamente en 88 lugares. Esta capa existe para que cambiar de motor sea
 * reescribir una carpeta y no perseguir llamadas por todo el monolito.
 *
 * ── Sobre esta tabla ───────────────────────────────────────────────────────
 * Clave-valor. El valor es `text` y no `jsonb` a propósito: guarda tanto JSON
 * (emisor, firmante) como texto plano gigante — el logo es un data-URL de
 * 459 KB — y configApp.js hace JSON.parse con fallback al string crudo.
 * Cambiarlo a jsonb obligaría a reescribir ese contrato.
 */

const pg = require('../pg');

/** Valor crudo de una clave, o null si no existe. */
async function obtener(clave) {
  const fila = await pg.one('SELECT valor FROM erp.configuracion WHERE clave = $1', [clave]);
  return fila ? fila.valor : null;
}

/**
 * Varias claves de una vez. En SharePoint esto eran seis consultas filtradas
 * por clave —seis viajes de red— porque no había forma de pedirlas juntas.
 * Devuelve un Map; las claves que no existen simplemente no aparecen.
 */
async function obtenerVarias(claves) {
  if (!claves.length) return new Map();
  const filas = await pg.rows(
    'SELECT clave, valor FROM erp.configuracion WHERE clave = ANY($1::text[])',
    [claves]
  );
  return new Map(filas.map(f => [f.clave, f.valor]));
}

/** Crea o actualiza una clave. */
async function guardar(clave, valor, descripcion = null) {
  await pg.query(
    `INSERT INTO erp.configuracion (clave, valor, descripcion)
     VALUES ($1, $2, $3)
     ON CONFLICT (clave) DO UPDATE
        SET valor = EXCLUDED.valor,
            -- Una descripción vacía no debe borrar la que ya estaba.
            descripcion = COALESCE(EXCLUDED.descripcion, erp.configuracion.descripcion)`,
    [clave, String(valor ?? ''), descripcion || null]
  );
}

/** Todas las claves, para la pantalla de configuración. */
async function listar() {
  return pg.rows('SELECT clave, valor, descripcion, updated_at FROM erp.configuracion ORDER BY clave');
}

module.exports = { obtener, obtenerVarias, guardar, listar };
