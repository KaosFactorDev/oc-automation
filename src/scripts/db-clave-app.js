'use strict';
/**
 * db-clave-app.js — Asigna al rol de la aplicación la contraseña de .env.
 *
 * La migración de permisos crea erp_app con LOGIN pero SIN contraseña, porque
 * una contraseña en un archivo de migración terminaría en git. Este script
 * cierra ese hueco: toma ERP_DB_PASSWORD del .env y la aplica.
 *
 * Se corre después de cada "db:reset", porque borrar el volumen se lleva el
 * rol y su contraseña con él.
 *
 *   node src/scripts/db-clave-app.js
 */

require('dotenv').config();

const { Client } = require('pg');
const { configAdmin } = require('./db-admin');

const USUARIO = (process.env.ERP_DB_USER || 'erp_app').trim();
const CLAVE   = process.env.ERP_DB_PASSWORD || '';

async function main() {
  if (!CLAVE) {
    console.error('✖ Falta ERP_DB_PASSWORD en .env.');
    console.error('  Genera una (solo letras y dígitos evita problemas de parseo):');
    console.error("    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40");
    process.exit(1);
  }

  const cliente = new Client(configAdmin());
  await cliente.connect();

  try {
    const existe = await cliente.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [USUARIO]);
    if (!existe.rowCount) {
      console.error(`✖ El rol ${USUARIO} no existe. Corre las migraciones primero (npm run db:push).`);
      process.exit(1);
    }

    // ALTER ROLE no acepta parámetros ($1), así que la contraseña va
    // interpolada. escapeLiteral es el escapado del propio driver: es lo que
    // evita que una contraseña con una comilla simple se convierta en
    // inyección de SQL.
    const literal = cliente.escapeLiteral(CLAVE);
    await cliente.query(`ALTER ROLE ${cliente.escapeIdentifier(USUARIO)} PASSWORD ${literal}`);

    console.log(`✓ Contraseña de ${USUARIO} asignada desde ERP_DB_PASSWORD.`);
  } finally {
    await cliente.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
