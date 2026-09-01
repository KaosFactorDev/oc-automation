'use strict';
/**
 * db-esperar.js — Espera a que Postgres acepte conexiones.
 *
 * "docker compose up -d" devuelve el control cuando el contenedor arrancó, no
 * cuando Postgres está listo para atender. En un arranque en frío la
 * inicialización toma unos segundos, así que un "db:push" inmediatamente
 * después falla con "connection refused" — un error que parece de
 * configuración cuando solo faltaba esperar.
 *
 * Conecta con las credenciales de ADMINISTRACIÓN, no con las de la app: en una
 * base recién creada el rol erp_app todavía no existe (lo crea la migración de
 * permisos), así que esperar con las credenciales de la app fallaría siempre.
 *
 *   node src/scripts/db-esperar.js [segundos]     (default 60)
 */

require('dotenv').config();

const { Client } = require('pg');
const { configAdmin } = require('./db-admin');

const LIMITE_S = Number(process.argv[2] || 60);

// Errores que no se arreglan esperando: fallar de una vez es más útil que
// agotar el minuto y reportar un timeout que no es el problema.
const DEFINITIVOS = /password authentication failed|role ".*" does not exist|database ".*" does not exist/i;

async function intentar() {
  const cliente = new Client(configAdmin());
  try {
    await cliente.connect();
    await cliente.query('SELECT 1');
    return null;
  } finally {
    await cliente.end().catch(() => {});
  }
}

async function main() {
  const inicio = Date.now();
  let ultimoError = '';
  let avisado = false;

  while ((Date.now() - inicio) / 1000 < LIMITE_S) {
    try {
      await intentar();
      console.log(`✓ Postgres responde (${Date.now() - inicio} ms)`);
      return;
    } catch (err) {
      ultimoError = err.message;

      if (DEFINITIVOS.test(ultimoError)) {
        console.error(`✖ ${ultimoError}`);
        console.error('\n  Esto no es un problema de arranque. Revisa PGUSER, POSTGRES_PASSWORD');
        console.error('  y POSTGRES_DB en .env: deben coincidir con lo que recibió el contenedor.');
        console.error('  Si cambiaste POSTGRES_PASSWORD despues de crear el volumen, la base');
        console.error('  conserva la contraseña vieja — hace falta "npm run db:reset".');
        process.exit(1);
      }

      if (!avisado) {
        console.log('Esperando a que Postgres acepte conexiones...');
        avisado = true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.error(`✖ Postgres no respondió en ${LIMITE_S} s. Último error:`);
  console.error(`  ${ultimoError}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
