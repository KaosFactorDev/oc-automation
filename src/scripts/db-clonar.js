'use strict';
/**
 * db-clonar.js — Trae los datos de producción a la base LOCAL de desarrollo.
 *
 *   npm run db:clonar            muestra qué haría, sin tocar nada
 *   npm run db:clonar -- --si    lo ejecuta
 *
 * Para qué: `db:reset` deja el esquema listo pero vacío, y una consola sin datos
 * no sirve para probar casi nada. Antes del corte se usaba `db:importar`, que
 * leía SharePoint; ahora la fuente de verdad es el Postgres del VPS, así que los
 * datos se traen de ahí.
 *
 * ── Cómo funciona ──────────────────────────────────────────────────────────
 * Corre `pg_dump` DENTRO del contenedor del VPS por SSH y canaliza la salida
 * directamente a la base local. Sin archivo intermedio: no queda una copia de
 * los datos de la empresa tirada en /tmp, y lo que llega es el estado de este
 * momento y no el respaldo de anoche.
 *
 * ── Lo que protege ────────────────────────────────────────────────────────
 * El destino TIENE que ser local. El script se niega a correr contra cualquier
 * otro host, porque su primer paso es borrar el esquema: apuntarlo por error a
 * producción sería catastrófico y el nombre del comando no lo sugiere.
 *
 * ── El detalle que no es obvio ────────────────────────────────────────────
 * `DROP SCHEMA erp CASCADE` se lleva también los DEFAULT PRIVILEGES: la entrada
 * de pg_default_acl está atada al esquema y desaparece con él. Comprobado — tras
 * recrear el esquema, una tabla nueva ya NO le concede nada a erp_app. Como el
 * dump se toma con --no-owner --no-privileges, sin volver a aplicar los permisos
 * la aplicación arrancaría y fallaría con "permission denied for table", que no
 * se parece en nada a un problema de clonado. Por eso el último paso los repone.
 *
 * ── Variables ─────────────────────────────────────────────────────────────
 *   VPS_SSH        usuario@host del servidor        (obligatoria)
 *   VPS_SSH_KEY    ruta a la llave privada          (opcional)
 *   VPS_DB_CONTENEDOR  nombre del contenedor        (por defecto oc-automation-db)
 *   VPS_DB_USER / VPS_DB_NAME                       (postgres / erp)
 *
 * Los datos que trae son REALES: órdenes, proveedores y precios de la empresa.
 * En un equipo de desarrollo eso merece la misma cabeza que un respaldo.
 */

require('dotenv').config({ quiet: true });

const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const { configAdmin } = require('./db-admin');
const pgDefaults = require('../pg');

// Se conecta con las credenciales de ADMINISTRACIÓN y no con las de la
// aplicación: el primer paso es DROP SCHEMA, y erp_app no es dueño del esquema
// —falla con "must be owner of schema erp"—, que es exactamente lo que se
// quiere de un rol que solo debe leer y escribir filas.
let cli = null;
async function sql(texto, valores) {
  if (!cli) { cli = new Client(configAdmin()); await cli.connect(); }
  return cli.query(texto, valores);
}
async function cerrar() { if (cli) { await cli.end().catch(() => {}); cli = null; } }

const CONFIRMADO = process.argv.includes('--si');

const SSH_HOST  = (process.env.VPS_SSH || '').trim();
const SSH_KEY   = (process.env.VPS_SSH_KEY || '').trim();
const CONTENEDOR = (process.env.VPS_DB_CONTENEDOR || 'oc-automation-db').trim();
const REMOTO_USER = (process.env.VPS_DB_USER || 'postgres').trim();
const REMOTO_DB   = (process.env.VPS_DB_NAME || 'erp').trim();

const LOCAL_HOST = (process.env.PGHOST || 'localhost').trim();
const LOCAL_PORT = String(process.env.PGPORT || pgDefaults.PUERTO_POR_DEFECTO).trim();
const LOCAL_DB   = (process.env.POSTGRES_DB || pgDefaults.BASE_POR_DEFECTO).trim();

const ES_LOCAL = /^(localhost|127\.0\.0\.1|::1)$/i.test(LOCAL_HOST);

// Los mismos permisos que concede la migración 20260828120500. Se repiten acá
// porque el DROP SCHEMA se los lleva; ver la nota de la cabecera.
const PERMISOS = `
  GRANT USAGE ON SCHEMA erp TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA erp TO erp_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA erp TO erp_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA erp TO erp_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT EXECUTE ON FUNCTIONS TO erp_app;
`;

function ssh(args) {
  const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  if (SSH_KEY) base.unshift('-i', SSH_KEY);
  return [...base, SSH_HOST, ...args];
}

function salir(msg, codigo = 1) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(codigo);
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' Clonar producción → base local de desarrollo');
  console.log('══════════════════════════════════════════════════════════\n');

  if (!SSH_HOST) {
    salir('Falta VPS_SSH en el .env (por ejemplo: usuario@servidor).\n' +
          '  Ver la cabecera de src/scripts/db-clonar.js.');
  }

  console.log(`  Origen : ${CONTENEDOR} (${REMOTO_DB}) en ${SSH_HOST}`);
  console.log(`  Destino: ${LOCAL_DB} en ${LOCAL_HOST}:${LOCAL_PORT}\n`);

  // ── La protección que importa ──
  if (!ES_LOCAL) {
    salir(`El destino es "${LOCAL_HOST}", que no es local.\n` +
          '  Este script BORRA el esquema del destino antes de restaurar, así que\n' +
          '  solo se ejecuta contra localhost. Revisa PGHOST en tu .env.');
  }

  // ── Que el origen responda antes de destruir nada ──
  process.stdout.write('  Comprobando el origen… ');
  const prueba = spawnSync('ssh',
    ssh([`docker exec ${CONTENEDOR} psql -U ${REMOTO_USER} -d ${REMOTO_DB} -tAc "SELECT count(*) FROM erp.ordenes_compra"`]),
    { encoding: 'utf8' });
  if (prueba.status !== 0) {
    console.log('');
    salir('No se pudo leer el origen:\n  ' + (prueba.stderr || '').trim().split('\n').slice(0, 3).join('\n  '));
  }
  const ocOrigen = Number((prueba.stdout || '').trim());
  console.log(`${ocOrigen} órdenes de compra`);

  // ── Qué se va a perder en el destino ──
  let ocLocal = null;
  try {
    const r = await sql('SELECT count(*)::int AS n FROM erp.ordenes_compra');
    ocLocal = r.rows[0].n;
  } catch { /* esquema vacío o inexistente */ }
  console.log(`  El destino tiene ${ocLocal === null ? 'el esquema sin crear' : ocLocal + ' órdenes de compra'}, y se BORRA.\n`);

  if (!CONFIRMADO) {
    console.log('  Esto fue solo el plan. Para ejecutarlo:\n');
    console.log('    npm run db:clonar -- --si\n');
    console.log('  Traerá datos REALES de la empresa a este equipo. Con MODO_PRUEBA=1');
    console.log('  la aplicación no escribirá a SharePoint, al buzón ni a tesorería.\n');
    await cerrar();
    return 0;
  }

  // ── 1. Vaciar el destino ──
  console.log('  1/4  Borrando el esquema local…');
  await sql('DROP SCHEMA IF EXISTS erp CASCADE');

  // ── 2. Traer el dump por SSH, directo a psql ──
  console.log('  2/4  Copiando desde el VPS (sin archivo intermedio)…');
  await new Promise((resolve, reject) => {
    const origen = spawn('ssh', ssh([
      `docker exec ${CONTENEDOR} pg_dump -U ${REMOTO_USER} -d ${REMOTO_DB} ` +
      `--schema=erp --format=plain --no-owner --no-privileges`,
    ]), { stdio: ['ignore', 'pipe', 'pipe'] });

    const destino = spawn('docker', [
      'exec', '-i', 'oc-automation-db-dev',
      'psql', '-U', 'postgres', '-d', LOCAL_DB, '-q', '-v', 'ON_ERROR_STOP=1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

    const errores = [];
    origen.stderr.on('data', d => errores.push('ssh: ' + d));
    destino.stderr.on('data', d => errores.push('psql: ' + d));
    origen.stdout.pipe(destino.stdin);

    destino.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error('La restauración falló:\n  ' +
        errores.join('').trim().split('\n').slice(0, 6).join('\n  ')));
    });
    origen.on('error', reject);
    destino.on('error', reject);
  });

  // ── 3. Reponer los permisos que se llevó el DROP SCHEMA ──
  console.log('  3/4  Reponiendo permisos de erp_app…');
  await sql(PERMISOS);

  // ── 4. Comprobar ──
  console.log('  4/4  Comprobando…\n');
  const { rows } = await sql(`
    SELECT (SELECT count(*) FROM erp.ordenes_compra)        AS oc,
           (SELECT count(*) FROM erp.ordenes_servicio)      AS os,
           (SELECT count(*) FROM erp.requerimientos)        AS req,
           (SELECT count(*) FROM erp.proveedores)           AS prov,
           (SELECT count(*) FROM erp.movimientos_inventario) AS mov,
           (SELECT count(*) FROM erp.vw_gastos)             AS gastos,
           has_table_privilege('erp_app','erp.ordenes_compra','SELECT') AS puede_leer,
           has_table_privilege('erp_app','erp.ordenes_compra','INSERT') AS puede_escribir`);
  const r = rows[0];
  console.log(`     órdenes de compra    ${String(r.oc).padStart(6)}   (origen: ${ocOrigen})`);
  console.log(`     órdenes de servicio  ${String(r.os).padStart(6)}`);
  console.log(`     requerimientos       ${String(r.req).padStart(6)}`);
  console.log(`     proveedores          ${String(r.prov).padStart(6)}`);
  console.log(`     movimientos          ${String(r.mov).padStart(6)}`);
  console.log(`     gastos (vista)       ${String(r.gastos).padStart(6)}`);
  console.log(`     erp_app lee/escribe  ${r.puede_leer && r.puede_escribir ? 'sí' : 'NO ✖'}`);

  if (Number(r.oc) !== ocOrigen) {
    salir(`El destino quedó con ${r.oc} órdenes y el origen tiene ${ocOrigen}.`);
  }
  if (!r.puede_leer || !r.puede_escribir) {
    salir('erp_app no quedó con permisos. La aplicación fallaría con "permission denied".');
  }

  console.log('\n  ✓ Listo. Arranca con:  npm run dev');
  console.log('    Verifica que salga el recuadro de MODO_PRUEBA al levantar.\n');
  await cerrar();
  return 0;
}

main()
  .then(c => process.exit(c))
  .catch(async (e) => {
    console.error(`\n✖ ${e.message}\n`);
    await cerrar().catch(() => {});
    process.exit(1);
  });
