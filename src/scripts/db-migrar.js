'use strict';
/**
 * db-migrar.js — Aplica las migraciones de supabase/migrations sobre el
 * Postgres autoalojado, usando el CLI de Supabase como motor.
 *
 *   npm run db:push                 aplica las pendientes
 *   npm run db:push -- --dry-run    muestra qué aplicaría, sin aplicar
 *   npm run db:push -- --include-all
 *
 * ── Por qué existe este envoltorio ─────────────────────────────────────────
 * Tres cosas que hacer a mano sale mal:
 *
 *  1. El CLI exige que la contraseña venga percent-encoded en la URL. Una
 *     contraseña con @ / : o # rompe la cadena en silencio y el error que da
 *     es "no se pudo conectar", que no apunta a la causa. Acá se codifica.
 *
 *  2. Las migraciones necesitan un rol con permiso de DDL (postgres), mientras
 *     que la app se conecta con erp_app, que no puede crear tablas. Son dos
 *     credenciales distintas y confundirlas es fácil: esto usa siempre la de
 *     administración y nunca la de la app.
 *
 *  3. Postgres en Docker no habla TLS, así que la URL necesita
 *     sslmode=disable. Sin eso el CLI falla con "The server does not support
 *     SSL connections". No es un problema de seguridad mientras la base no
 *     publique puertos: el tráfico no sale del host.
 *
 * Variables en .env (cualquiera de las dos formas):
 *   MIGRATION_DB_URL=postgresql://postgres:clave@localhost:55432/erp?sslmode=disable
 * o, y es lo recomendado porque evita el problema de codificación:
 *   PGHOST=localhost  PGPORT=55432  PGUSER=postgres
 *   POSTGRES_PASSWORD=...  POSTGRES_DB=erp
 */

require('dotenv').config();

const { spawnSync } = require('child_process');

const { urlAdmin, ocultarClave } = require('./db-admin');

/**
 * El CLI de Supabase se instala como devDependency (queda pinneado en
 * package.json, en vez de que "npx --yes" baje la versión del día) y su
 * ejecutable es un script de Node. Así se puede lanzar con el mismo node que
 * corre este archivo, SIN shell.
 *
 * Eso importa en Windows: desde el parche de CVE-2024-27980, spawn de un .cmd
 * sin shell:true falla con EINVAL, y con shell:true la URL tendría que pasar
 * por el intérprete de cmd, que trata % y & como sintaxis. Invocando el .js
 * directamente no hay intérprete de por medio y la URL llega intacta.
 */
function rutaCli() {
  try {
    return require.resolve('supabase/dist/supabase.js');
  } catch {
    console.error('✖ El CLI de Supabase no está instalado.');
    console.error('  Corre: npm install --save-dev supabase');
    process.exit(1);
  }
}

const { url, origen } = urlAdmin();
const extra = process.argv.slice(2);

console.log(`\nMigrando con ${origen}`);
console.log(`  → ${ocultarClave(url)}\n`);

const r = spawnSync(
  process.execPath,
  [rutaCli(), 'db', 'push', '--db-url', url, ...extra],
  { stdio: 'inherit' }
);

if (r.error) {
  console.error('✖ No se pudo ejecutar el CLI de Supabase:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
