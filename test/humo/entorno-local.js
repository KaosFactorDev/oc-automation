'use strict';
/**
 * entorno-local.js — Guarda de la prueba de humo: aborta si algo no es local.
 *
 *   node test/humo/entorno-local.js      (el CI la corre antes de migrar)
 *
 * La prueba de humo escribe en Postgres (migraciones, seed y órdenes de prueba)
 * y arranca el servidor de verdad. Antes de nada comprueba:
 *
 *   · que MODO_PRUEBA esté activo: sin él, el servidor sube PDF al Drive real
 *     y responde correos;
 *   · que las dos conexiones, la de administración (PGHOST, la usan las
 *     migraciones y db-clave-app.js) y la de la app (ERP_DB_HOST), vayan a
 *     127.0.0.1 o localhost: el contenedor local o el service container del
 *     CI, nunca el VPS;
 *   · que DATABASE_URL, MIGRATION_DB_URL y las credenciales externas estén
 *     vacías. Las dos URL ganan sobre PGHOST/ERP_DB_HOST, y la lista de
 *     credenciales es la de «Siempre vacías en local» de .env.local.example;
 *   · que un .env en la carpeta no inyecte nada. dotenv carga de ahí toda
 *     variable que el entorno no declare: en T-077, un .env viejo traía una
 *     MIGRATION_DB_URL que apuntaba a otra base.
 *
 * El .env se revisa antes de cargar src/pg.js, que llama a dotenv.config().
 */

const fs   = require('fs');
const path = require('path');

const RAIZ          = path.join(__dirname, '../..');
const HOSTS_LOCALES = ['127.0.0.1', 'localhost', '::1'];
const OBLIGATORIAS  = ['POSTGRES_PASSWORD', 'ERP_DB_PASSWORD', 'RRHH_API_KEY'];

const v = (nombre) => String(process.env[nombre] || '').trim();

/** Las variables que tienen que ir vacías: la sección de .env.local.example y las dos URL. */
function variablesQueDebenIrVacias() {
  const texto = fs.readFileSync(path.join(RAIZ, '.env.local.example'), 'utf8');
  // El título de la sección, no la mención que hace el comentario de cabecera.
  const desde = texto.search(/^#\s*─+\s*Siempre vacías en local/m);
  const nombres = desde < 0 ? []
    : [...texto.slice(desde).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]);
  // Si alguien reescribe la plantilla y la sección cambia de nombre, esto no
  // puede quedar revisando una lista vacía sin decir nada.
  for (const clave of ['CLIENT_SECRET', 'TESORERIA_URL', 'GEMINI_API_KEY']) {
    if (!nombres.includes(clave)) {
      throw new Error(`No encontré ${clave} en «Siempre vacías en local» de .env.local.example.`);
    }
  }
  return [...nombres, 'DATABASE_URL', 'MIGRATION_DB_URL'];
}

function problemas() {
  const lista = [];

  const rutaEnv = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(rutaEnv)) {
    const { parse } = require('dotenv');
    const inyectadas = Object.keys(parse(fs.readFileSync(rutaEnv))).filter(n => !(n in process.env));
    if (inyectadas.length) {
      lista.push(`${rutaEnv} inyectaría variables que el entorno no declara: ${inyectadas.join(', ')}. ` +
        'Decláralas vacías o corre la prueba en un worktree sin .env.');
    }
  }

  if (!require('../../src/modoPrueba').activo) lista.push('MODO_PRUEBA no está activo.');

  const hostAdmin = v('PGHOST') || 'localhost';
  const hostApp   = v('ERP_DB_HOST') || hostAdmin;
  if (!HOSTS_LOCALES.includes(hostAdmin)) lista.push(`PGHOST es "${hostAdmin}", no una base local.`);
  if (!HOSTS_LOCALES.includes(hostApp))   lista.push(`ERP_DB_HOST es "${hostApp}", no una base local.`);

  const llenas = variablesQueDebenIrVacias().filter(n => v(n));
  if (llenas.length) lista.push(`Tienen que ir vacías: ${llenas.join(', ')}.`);

  const faltan = OBLIGATORIAS.filter(n => !v(n));
  if (faltan.length) lista.push(`Faltan: ${faltan.join(', ')}.`);

  return lista;
}

/**
 * Lanza si el entorno no es local. Si lo es, devuelve a dónde van las dos
 * conexiones (sin claves), con los mismos valores por defecto que src/pg.js y
 * src/scripts/db-admin.js.
 */
function verificarEntornoLocal() {
  const lista = problemas();
  if (lista.length) {
    throw new Error('El entorno no es local; no se escribe en ninguna base:\n  · ' + lista.join('\n  · '));
  }
  const { PUERTO_POR_DEFECTO, BASE_POR_DEFECTO } = require('../../src/pg');
  const hostAdmin = v('PGHOST') || 'localhost';
  return {
    admin: `${hostAdmin}:${v('PGPORT') || PUERTO_POR_DEFECTO}/${v('POSTGRES_DB') || BASE_POR_DEFECTO}`,
    app:   `${v('ERP_DB_HOST') || hostAdmin}:${v('ERP_DB_PORT') || v('PGPORT') || PUERTO_POR_DEFECTO}/` +
           `${v('ERP_DB_NAME') || v('POSTGRES_DB') || BASE_POR_DEFECTO}`,
  };
}

module.exports = { verificarEntornoLocal, variablesQueDebenIrVacias };

if (require.main === module) {
  try {
    const destino = verificarEntornoLocal();
    console.log('✓ Entorno local');
    console.log(`  migraciones y seed → ${destino.admin}`);
    console.log(`  app                → ${destino.app}`);
    console.log('  MODO_PRUEBA activo y credenciales externas vacías.');
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
}
