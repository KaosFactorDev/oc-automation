'use strict';
/**
 * pg.js — Conexión a Postgres
 *
 * Se conecta con el driver `pg`, no por una API REST, porque el ERP necesita
 * transacciones de verdad: emitir un consecutivo y escribir el documento tienen
 * que ser una sola operación.
 *
 * ── Configuración: variables separadas, no una URL ─────────────────────────
 * Lo esperado en .env son credenciales sueltas:
 *
 *   ERP_DB_HOST=localhost     ERP_DB_PORT=55432    ERP_DB_NAME=erp
 *   ERP_DB_USER=erp_app       ERP_DB_PASSWORD=...
 *
 * Y NO una URL, por una razón concreta: una contraseña generada al azar suele
 * traer caracteres que rompen una URL. Con "H!JV8k.%Vbi*^/W", por ejemplo, el
 * "/" corta la sección de autoridad y new URL() falla con "Invalid URL"; y un
 * "%" seguido de algo que no sea un par hexadecimal hace estallar el decodifi-
 * cador. Escribir la URL a mano exige percent-encoding, y equivocarse ahí da
 * como síntoma "password authentication failed", que no apunta a la causa.
 * Con variables separadas el driver recibe la contraseña literal y no hay nada
 * que codificar.
 *
 * DATABASE_URL se sigue aceptando y tiene prioridad, para el caso de un
 * proveedor gestionado que entregue la cadena ya armada.
 *
 * El search_path se fija en "erp" para que las consultas no tengan que
 * calificar cada tabla, y se deja "public" al final solo para las funciones
 * del sistema. Ningún objeto del ERP vive en public.
 */

const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

let _pool = null;

const v = (nombre, def = '') => (process.env[nombre] || def).toString().trim();

function habilitado() {
  return !!(v('DATABASE_URL') || (v('ERP_DB_HOST') && v('ERP_DB_USER')));
}

/** Solo un Postgres en la misma máquina puede ir sin TLS. */
function esLocal(host) {
  return ['localhost', '127.0.0.1', '::1', 'db'].includes(host);
}

/**
 * TLS con verificación de certificado siempre activa. PG_CA_CERT permite
 * apuntar al CA del proveedor si el store del sistema no lo trae; no existe una
 * variable para saltarse la verificación, a propósito.
 */
function opcionesTLS() {
  const rutaCA = v('PG_CA_CERT');
  if (rutaCA) {
    if (!fs.existsSync(rutaCA)) {
      throw new Error(`PG_CA_CERT apunta a un archivo que no existe: ${rutaCA}`);
    }
    return { rejectUnauthorized: true, ca: fs.readFileSync(rutaCA, 'utf8') };
  }
  return { rejectUnauthorized: true };
}

/**
 * Arma la configuración del pool. Con DATABASE_URL presente se usa la cadena;
 * si no, las variables sueltas.
 */
function configuracion() {
  const url = v('DATABASE_URL');

  if (url) {
    let host = '';
    try { host = new URL(url).hostname; }
    catch {
      throw new Error(
        'DATABASE_URL no es una URL válida. Lo más probable es que la contraseña ' +
        'traiga un carácter que hay que percent-encodear (/, %, @, #, :). ' +
        'Usa ERP_DB_HOST / ERP_DB_PORT / ERP_DB_NAME / ERP_DB_USER / ERP_DB_PASSWORD ' +
        'en su lugar y no tendrás que codificar nada.'
      );
    }
    return { connectionString: url, _host: host };
  }

  const host = v('ERP_DB_HOST', 'localhost');
  const user = v('ERP_DB_USER');
  const password = process.env.ERP_DB_PASSWORD || '';

  if (!user) {
    throw new Error(
      'Falta la configuración de Postgres en .env: define ERP_DB_USER, ' +
      'ERP_DB_PASSWORD, ERP_DB_HOST, ERP_DB_PORT y ERP_DB_NAME (o DATABASE_URL).'
    );
  }
  if (!password) {
    throw new Error(
      `Falta ERP_DB_PASSWORD en .env. El rol ${user} se crea sin contraseña en la ` +
      `migración de permisos; asígnala con: ALTER ROLE ${user} PASSWORD '...'`
    );
  }

  return {
    host,
    port: Number(v('ERP_DB_PORT', '5432')),
    database: v('ERP_DB_NAME', 'erp'),
    user,
    password,
    _host: host,
  };
}

function pool() {
  if (_pool) return _pool;

  const { _host, ...conexion } = configuracion();

  _pool = new Pool({
    ...conexion,
    // Un pool chico y con reciclaje evita quedarse con sockets que el servidor
    // ya cerró por inactividad.
    max: Number(v('PG_POOL_MAX', '8')),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Postgres en Docker no habla TLS y el tráfico no sale del host, así que
    // ahí va sin cifrado. Contra cualquier host remoto la verificación de
    // certificado queda ACTIVADA: sin ella, quien se interponga puede leer las
    // credenciales y todo el tráfico. Para un CA que el sistema no conozca, la
    // salida es PG_CA_CERT, no desactivar la verificación.
    ssl: esLocal(_host) ? false : opcionesTLS(),

    // El search_path se fija como opción de la conexión, no con un
    // "SET search_path" en el evento 'connect'. Esa variante dispara un query
    // que puede solaparse con el primero del llamador (pg avisa
    // "client is already executing a query") y, peor, deja una ventana en la
    // que el search_path todavía no está puesto.
    options: '-c search_path=erp,public',
  });

  _pool.on('error', (err) => {
    console.warn('[pg] Error en cliente idle del pool:', err.message);
  });

  return _pool;
}

/** Consulta suelta, sin transacción. */
async function query(sql, params = []) {
  return pool().query(sql, params);
}

/** Igual que query() pero devuelve solo las filas. */
async function rows(sql, params = []) {
  const r = await pool().query(sql, params);
  return r.rows;
}

/** Igual que query() pero devuelve la primera fila o null. */
async function one(sql, params = []) {
  const r = await pool().query(sql, params);
  return r.rows[0] || null;
}

/**
 * Ejecuta fn dentro de una transacción. Hace COMMIT si fn resuelve y ROLLBACK
 * si lanza. Es el camino obligatorio para cualquier escritura que emita un
 * consecutivo: si el documento falla, el número se devuelve.
 *
 *   await pg.tx(async (c) => {
 *     const { rows } = await c.query('SELECT erp.siguiente_numero_oc() AS n');
 *     await c.query('UPDATE erp.ordenes_compra SET numero_oc = $1 WHERE id = $2',
 *                   [formato(rows[0].n), id]);
 *   });
 */
async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function cerrar() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { habilitado, pool, query, rows, one, tx, cerrar };
