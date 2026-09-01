'use strict';
/**
 * db.js — Almacén local (SQLite)
 *
 * Lo que queda acá es solo lo que tiene sentido guardar en la máquina y no en
 * la base de datos del negocio:
 *
 *   sesiones                    → las cookies activas. Son de este proceso y de
 *                                 esta instalación; no tienen por qué viajar.
 *   mapeo_proyectos_tesoreria   → la última equivalencia que alguien eligió
 *                                 entre un proyecto del ERP y uno de tesorería.
 *                                 Es una sugerencia para preseleccionar la
 *                                 próxima vez, siempre editable, nunca un
 *                                 automatismo.
 *
 * ── Lo que había antes ─────────────────────────────────────────────────────
 * Este archivo eran 737 líneas: un caché completo de las once listas de
 * SharePoint, con 43 funciones y su propia lógica de stock, consecutivos y
 * agregación. Existía por una sola razón —leer por Microsoft Graph tarda
 * cientos de milisegundos y la consola no podía esperar eso en cada pantalla—
 * y desapareció con la razón: Postgres corre en el mismo host y responde en
 * menos de un milisegundo.
 *
 * Con él se fueron el sync cada 2 minutos, la ventana en que el caché quedaba
 * viejo, y el problema de tener dos copias de todo donde una podía mentir.
 */

const Database = require('better-sqlite3');
const path     = require('path');
require('dotenv').config();

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/local.db');

let _db = null;

function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _crearEsquema(_db);
  return _db;
}

function _crearEsquema(d) {
  d.exec(`
    -- ── Sesiones ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sesiones (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      nombre     TEXT NOT NULL DEFAULT '',
      rol        TEXT NOT NULL DEFAULT 'operador',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sesiones_expires ON sesiones(expires_at);

    -- ── Mapeo de proyectos hacia tesorería ──────────────────────────────────
    -- Los nombres de tesorería ("0378 IZZI 96") no coinciden con los códigos de
    -- oc-automation ("CT25-202 Micropilotes IZZI 96"), así que el emparejamiento
    -- lo hace una persona al enviar la primera OC del proyecto. Acá se recuerda
    -- esa elección para preseleccionarla la próxima vez.
    CREATE TABLE IF NOT EXISTS mapeo_proyectos_tesoreria (
      proyecto         TEXT PRIMARY KEY,
      tesoreria_id     TEXT NOT NULL,
      tesoreria_nombre TEXT NOT NULL DEFAULT '',
      actualizado_por  TEXT NOT NULL DEFAULT '',
      updated_at       TEXT NOT NULL DEFAULT ''
    );
  `);
}

// ── Sesiones ─────────────────────────────────────────────────────────────────

function upsertSesion({ id, email, nombre, rol, expires_at }) {
  db().prepare(`
    INSERT INTO sesiones (id,email,nombre,rol,expires_at,created_at)
    VALUES (@id,@email,@nombre,@rol,@expires_at,@created_at)
    ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at
  `).run({ id, email, nombre, rol, expires_at, created_at: new Date().toISOString() });
}

function getSesion(id) {
  return db().prepare('SELECT * FROM sesiones WHERE id=?').get(id) || null;
}

function deleteSesion(id) {
  db().prepare('DELETE FROM sesiones WHERE id=?').run(id);
}

function cleanExpiredSesiones() {
  db().prepare('DELETE FROM sesiones WHERE expires_at<?').run(new Date().toISOString());
}

// ── Mapeo de proyectos hacia tesorería ───────────────────────────────────────

function getMapeoTesoreria(proyecto) {
  if (!proyecto) return null;
  return db().prepare(`
    SELECT tesoreria_id, tesoreria_nombre, actualizado_por, updated_at
    FROM mapeo_proyectos_tesoreria WHERE proyecto = ?
  `).get(String(proyecto)) || null;
}

function setMapeoTesoreria({ proyecto, tesoreriaId, tesoreriaNombre = '', actualizadoPor = '' }) {
  if (!proyecto || !tesoreriaId) return;
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO mapeo_proyectos_tesoreria
      (proyecto, tesoreria_id, tesoreria_nombre, actualizado_por, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(proyecto) DO UPDATE SET
      tesoreria_id = excluded.tesoreria_id,
      tesoreria_nombre = excluded.tesoreria_nombre,
      actualizado_por = excluded.actualizado_por,
      updated_at = excluded.updated_at
  `).run(String(proyecto), String(tesoreriaId), String(tesoreriaNombre), String(actualizadoPor), now);
}

module.exports = {
  db,
  upsertSesion, getSesion, deleteSesion, cleanExpiredSesiones,
  getMapeoTesoreria, setMapeoTesoreria,
};
