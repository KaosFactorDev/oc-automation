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
let _destino = "";

const v = (nombre, def = '') => (process.env[nombre] || def).toString().trim();

/**
 * Valores por defecto de la conexión, compartidos con src/scripts/db-admin.js
 * (el que arma las credenciales de migración). Tienen que vivir en un solo
 * lugar: si los dos módulos usan puertos distintos, las migraciones y la
 * aplicación terminan en bases diferentes y nada lo avisa.
 *
 * 55432 y no 5432 porque es lo que publica docker-compose.dev.yml, elegido
 * para no chocar con un Postgres instalado en Windows. En el VPS la app usa
 * ERP_DB_HOST=db y ERP_DB_PORT=5432, que ganan sobre esto.
 */
const PUERTO_POR_DEFECTO = '55432';
const BASE_POR_DEFECTO   = 'erp';

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

  // El host, el puerto y la base son los mismos para el rol de la aplicación y
  // para el de migraciones: lo único que cambia entre los dos son las
  // credenciales. Por eso ERP_DB_HOST/PORT/NAME solo hacen falta cuando
  // difieren de los de administración — que es el caso en el VPS, donde la app
  // ve la base como "db" en la red del compose y las migraciones corren desde
  // el host contra localhost.
  const host = v('ERP_DB_HOST') || v('PGHOST', 'localhost');
  const user = v('ERP_DB_USER', 'erp_app');
  const password = process.env.ERP_DB_PASSWORD || '';

  if (!password) {
    throw new Error(
      `Falta ERP_DB_PASSWORD en .env. El rol ${user} se crea sin contraseña en la ` +
      `migración de permisos; asígnala con: ALTER ROLE ${user} PASSWORD '...'`
    );
  }

  return {
    host,
    // PUERTO_POR_DEFECTO tiene que ser el mismo que usa db-admin.js. Cuando no
    // lo era, con un .env que no define PGPORT las migraciones iban a un puerto
    // y la aplicación a otro: dos bases distintas sin que nada lo dijera.
    port: Number(v('ERP_DB_PORT') || v('PGPORT') || PUERTO_POR_DEFECTO),
    database: v('ERP_DB_NAME') || v('POSTGRES_DB', BASE_POR_DEFECTO),
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

  _destino = conexion.connectionString
    ? '(DATABASE_URL)'
    : `${conexion.user}@${conexion.host}:${conexion.port}/${conexion.database}`;

  return _pool;
}

/**
 * Un fallo de conexión sin decir contra qué se intentó obliga a adivinar entre
 * host, puerto, base y usuario — y un puerto equivocado da exactamente el mismo
 * "password authentication failed" que una contraseña equivocada. Acá se le
 * agrega el destino al error.
 *
 * Va en los helpers y no envolviendo pool.connect: pg llama a connect() con
 * callback internamente, así que ahí no siempre hay una promesa que encadenar.
 */
function conDestino(err) {
  if (_destino && !err.message.includes(' — conectando a ')) {
    err.message = `${err.message} — conectando a ${_destino}`;
  }
  return err;
}

/** Consulta suelta, sin transacción. */
async function query(sql, params = []) {
  try { return await pool().query(sql, params); }
  catch (err) { throw conDestino(err); }
}

/** Igual que query() pero devuelve solo las filas. */
async function rows(sql, params = []) {
  return (await query(sql, params)).rows;
}

/** Igual que query() pero devuelve la primera fila o null. */
async function one(sql, params = []) {
  return (await query(sql, params)).rows[0] || null;
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
  let client;
  try { client = await pool().connect(); }
  catch (err) { throw conDestino(err); }

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

module.exports = {
  habilitado, pool, query, rows, one, tx, cerrar,
  // Compartidos con src/scripts/db-admin.js para que no existan dos defaults.
  PUERTO_POR_DEFECTO, BASE_POR_DEFECTO,
};
