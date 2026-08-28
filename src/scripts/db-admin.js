'use strict';
/**
 * db-admin.js — Credenciales de ADMINISTRACIÓN de Postgres.
 *
 * Son las del rol con permiso de DDL (postgres), distintas a las de la
 * aplicación (erp_app, en src/pg.js). Todo lo que toque el esquema —migrar,
 * esperar el arranque, asignar la contraseña del rol de la app— pasa por acá,
 * para que exista un solo lugar donde se decide de dónde salen.
 *
 * Variables en .env:
 *   PGHOST=localhost  PGPORT=55432  PGUSER=postgres
 *   POSTGRES_DB=erp   POSTGRES_PASSWORD=...
 *
 * O bien MIGRATION_DB_URL con la cadena completa, que tiene prioridad.
 */

require('dotenv').config();

const v = (nombre, def = '') => (process.env[nombre] || def).toString().trim();

/** Configuración discreta para el driver `pg`. No requiere codificar nada. */
function configAdmin() {
  const url = v('MIGRATION_DB_URL');
  if (url) return { connectionString: url };

  const clave = process.env.POSTGRES_PASSWORD || '';
  if (!clave) {
    console.error('✖ Falta POSTGRES_PASSWORD en .env (o MIGRATION_DB_URL completa).');
    process.exit(1);
  }

  return {
    host:     v('PGHOST', 'localhost'),
    port:     Number(v('PGPORT', '55432')),
    database: v('POSTGRES_DB', 'erp'),
    user:     v('PGUSER', 'postgres'),
    password: clave,
    // Contra localhost o el servicio "db" del compose, el tráfico no sale del
    // host. Cualquier otro destino tendría que llevar TLS.
    ssl: false,
  };
}

/**
 * La misma conexión, pero como URL, porque el CLI de Supabase solo acepta
 * --db-url. Acá sí hay que percent-encodear: una contraseña con / % @ # o :
 * rompe la cadena, y el síntoma es un "no se pudo conectar" que no apunta a
 * la causa.
 */
function urlAdmin() {
  const directa = v('MIGRATION_DB_URL');
  if (directa) return { url: directa, origen: 'MIGRATION_DB_URL' };

  const c = configAdmin();

  // encodeURIComponent deja pasar ! ' ( ) * , que sí tienen significado en una
  // URI; se codifican a mano para que cualquier contraseña funcione.
  const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, ch =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase());

  const url = `postgresql://${enc(c.user)}:${enc(c.password)}@${c.host}:${c.port}/${enc(c.database)}?sslmode=disable`;
  return { url, origen: 'PGHOST/PGPORT/PGUSER/POSTGRES_PASSWORD/POSTGRES_DB' };
}

function ocultarClave(url) {
  return url.replace(/(postgresql:\/\/[^:]+:)[^@]*(@)/, '$1***$2');
}

module.exports = { configAdmin, urlAdmin, ocultarClave };
