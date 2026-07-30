'use strict';
/**
 * db.js — Capa SQLite local
 * Fuente de lectura para todas las listas; SharePoint es la fuente de verdad.
 * El syncService mantiene este archivo sincronizado en segundo plano.
 */

const Database = require('better-sqlite3');
const path     = require('path');
require('dotenv').config();

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/local.db');

let _db = null;

function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');   // escrituras concurrentes sin bloquear lecturas
  _db.pragma('synchronous = NORMAL'); // equilibrio seguridad/velocidad
  _db.pragma('foreign_keys = ON');
  _crearEsquema(_db);
  return _db;
}

function _crearEsquema(d) {
  d.exec(`
    -- ── Historial de precios ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS historial_precios (
      sp_id       TEXT PRIMARY KEY,
      insumo      TEXT NOT NULL DEFAULT '',
      insumoNorm  TEXT NOT NULL DEFAULT '',
      proveedor   TEXT NOT NULL DEFAULT '',
      nit         TEXT NOT NULL DEFAULT '',
      precio      REAL NOT NULL DEFAULT 0,
      fecha       TEXT NOT NULL DEFAULT '',
      zona        TEXT NOT NULL DEFAULT '',
      proyecto    TEXT NOT NULL DEFAULT '',
      documento   TEXT NOT NULL DEFAULT '',
      cantidad    REAL NOT NULL DEFAULT 0,
      unidad      TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_hp_insumo  ON historial_precios(insumoNorm);
    CREATE INDEX IF NOT EXISTS idx_hp_fecha   ON historial_precios(fecha DESC);
    CREATE INDEX IF NOT EXISTS idx_hp_prov    ON historial_precios(nit);

    -- ── Proveedores ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS proveedores (
      sp_id      TEXT PRIMARY KEY,
      nit        TEXT NOT NULL DEFAULT '',
      nombre     TEXT NOT NULL DEFAULT '',
      zona       TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_prov_nit ON proveedores(nit);
  `);
  // Migraciones no destructivas — columnas nuevas en tabla existente
  try { db().exec(`ALTER TABLE proveedores ADD COLUMN data TEXT DEFAULT '{}'`); } catch {}
  try { db().exec(`ALTER TABLE proveedores ADD COLUMN activo INTEGER DEFAULT 1`); } catch {}
  db().exec(`
    -- ── Insumos ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS insumos (
      sp_id        TEXT PRIMARY KEY,
      nombre       TEXT NOT NULL DEFAULT '',
      nombreNorm   TEXT NOT NULL DEFAULT '',
      categoria    TEXT NOT NULL DEFAULT '',
      subcategoria TEXT NOT NULL DEFAULT '',
      unidad       TEXT NOT NULL DEFAULT '',
      activo       INTEGER NOT NULL DEFAULT 1,
      updated_at   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_ins_norm ON insumos(nombreNorm);

    -- ── Proyectos ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS proyectos (
      sp_id      TEXT PRIMARY KEY,
      nombre     TEXT NOT NULL DEFAULT '',
      zona       TEXT NOT NULL DEFAULT '',
      activo     INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT ''
    );

    -- ── Documentos (esquema flexible vía JSON) ───────────────────────────────
    -- Se usan JSON para no atarse a un schema rígido que cambia frecuentemente.
    CREATE TABLE IF NOT EXISTS requerimientos (
      sp_id      TEXT PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ordenes_compra (
      sp_id      TEXT PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ordenes_servicio (
      sp_id      TEXT PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS remisiones (
      sp_id      TEXT PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT ''
    );

    -- ── Movimientos de inventario ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS movimientos_inventario (
      sp_id      TEXT PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_mov_proyecto ON movimientos_inventario(
      json_extract(data, '$.proyecto')
    );
    CREATE INDEX IF NOT EXISTS idx_mov_tipo ON movimientos_inventario(
      json_extract(data, '$.tipo')
    );

    -- ── Estado de sincronización ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_state (
      lista      TEXT PRIMARY KEY,
      last_sync  TEXT NOT NULL DEFAULT '',
      item_count INTEGER NOT NULL DEFAULT 0
    );

    -- ── Usuarios ERP (caché de lista SharePoint UsuariosERP) ─────────────────
    CREATE TABLE IF NOT EXISTS usuarios (
      sp_id      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      nombre     TEXT NOT NULL DEFAULT '',
      cargo      TEXT NOT NULL DEFAULT '',
      rol        TEXT NOT NULL DEFAULT 'operador',
      activo     INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);

    -- ── Consecutivos por proyecto (contador atómico de requerimientos) ──────────
    CREATE TABLE IF NOT EXISTS consecutivos_proyecto (
      proyecto           TEXT PRIMARY KEY,
      ultimo_consecutivo INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT ''
    );

    -- ── Mapeo de proyectos hacia tesorería (solo local) ──────────────────────
    -- Los nombres de tesorería ("0378 IZZI 96") no coinciden con los códigos de
    -- oc-automation ("CT25-202 Micropilotes IZZI 96"), así que el emparejamiento
    -- lo hace una persona al enviar la primera OC del proyecto. Acá se recuerda
    -- esa elección para preseleccionarla la próxima vez — es una sugerencia,
    -- siempre editable, nunca un automatismo.
    CREATE TABLE IF NOT EXISTS mapeo_proyectos_tesoreria (
      proyecto         TEXT PRIMARY KEY,
      tesoreria_id     TEXT NOT NULL,
      tesoreria_nombre TEXT NOT NULL DEFAULT '',
      actualizado_por  TEXT NOT NULL DEFAULT '',
      updated_at       TEXT NOT NULL DEFAULT ''
    );

    -- ── Sesiones (solo local, nunca va a SharePoint) ─────────────────────────
    CREATE TABLE IF NOT EXISTS sesiones (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      nombre     TEXT NOT NULL DEFAULT '',
      rol        TEXT NOT NULL DEFAULT 'operador',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sesiones_expires ON sesiones(expires_at);
  `);
}

// ── Normalización (igual que en servidor-cotizaciones.js) ─────────────────────
function norm(s) {
  return String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s\/\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── UPSERT helpers ────────────────────────────────────────────────────────────

const UPSERT_HP = `
  INSERT INTO historial_precios
    (sp_id, insumo, insumoNorm, proveedor, nit, precio, fecha, zona, proyecto, documento, cantidad, unidad, updated_at)
  VALUES (@sp_id,@insumo,@insumoNorm,@proveedor,@nit,@precio,@fecha,@zona,@proyecto,@documento,@cantidad,@unidad,@updated_at)
  ON CONFLICT(sp_id) DO UPDATE SET
    insumo=excluded.insumo, insumoNorm=excluded.insumoNorm, proveedor=excluded.proveedor,
    nit=excluded.nit, precio=excluded.precio, fecha=excluded.fecha, zona=excluded.zona,
    proyecto=excluded.proyecto, documento=excluded.documento,
    cantidad=excluded.cantidad, unidad=excluded.unidad, updated_at=excluded.updated_at`;

const UPSERT_PROV = `
  INSERT INTO proveedores (sp_id,nit,nombre,zona,data,activo,updated_at)
  VALUES (@sp_id,@nit,@nombre,@zona,@data,@activo,@updated_at)
  ON CONFLICT(sp_id) DO UPDATE SET
    nit=excluded.nit, nombre=excluded.nombre, zona=excluded.zona,
    data=excluded.data, activo=excluded.activo, updated_at=excluded.updated_at`;

const UPSERT_INS = `
  INSERT INTO insumos (sp_id,nombre,nombreNorm,categoria,subcategoria,unidad,activo,updated_at)
  VALUES (@sp_id,@nombre,@nombreNorm,@categoria,@subcategoria,@unidad,@activo,@updated_at)
  ON CONFLICT(sp_id) DO UPDATE SET
    nombre=excluded.nombre,nombreNorm=excluded.nombreNorm,categoria=excluded.categoria,
    subcategoria=excluded.subcategoria,unidad=excluded.unidad,activo=excluded.activo,updated_at=excluded.updated_at`;

const UPSERT_PROY = `
  INSERT INTO proyectos (sp_id,nombre,zona,activo,updated_at)
  VALUES (@sp_id,@nombre,@zona,@activo,@updated_at)
  ON CONFLICT(sp_id) DO UPDATE SET nombre=excluded.nombre,zona=excluded.zona,activo=excluded.activo,updated_at=excluded.updated_at`;

const UPSERT_DOC = (tabla) => `
  INSERT INTO ${tabla} (sp_id,data,updated_at)
  VALUES (@sp_id,@data,@updated_at)
  ON CONFLICT(sp_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`;

const UPSERT_USR = `
  INSERT INTO usuarios (sp_id,email,nombre,cargo,rol,activo,updated_at)
  VALUES (@sp_id,@email,@nombre,@cargo,@rol,@activo,@updated_at)
  ON CONFLICT(sp_id) DO UPDATE SET
    email=excluded.email,nombre=excluded.nombre,cargo=excluded.cargo,
    rol=excluded.rol,activo=excluded.activo,updated_at=excluded.updated_at`;

// ── Escritura masiva (bulk upsert dentro de una transacción) ──────────────────

function bulkUpsertHistorial(rows) {
  const stmt = db().prepare(UPSERT_HP);
  const tx   = db().transaction((items) => {
    for (const f of items) {
      stmt.run({
        sp_id:      String(f.id || f.sp_id || ''),
        insumo:     String(f.insumo || '').trim(),
        insumoNorm: norm(f.insumo),
        proveedor:  String(f.nombreProveedor || f.proveedor || '').trim(),
        nit:        String(f.nitProveedor    || f.nit       || '').trim(),
        precio:     parseFloat(f.precioUnitario || f.precio || 0) || 0,
        fecha:      String(f.fecha || '').trim(),
        zona:       String(f.zona  || '').trim(),
        proyecto:   String(f.proyecto || '').trim(),
        documento:  String(f.numeroCompra || f.documento || '').trim(),
        cantidad:   parseFloat(f.cantidad || 0) || 0,
        unidad:     String(f.unidad || '').trim(),
        updated_at: String(f.updated_at || f.Modified || new Date().toISOString()),
      });
    }
  });
  tx(rows);
}

// Versión async: divide en chunks de 500 cediendo el event loop entre cada lote.
// Evita bloquear requests HTTP durante el sync de 3000+ filas.
async function bulkUpsertHistorialAsync(rows) {
  const CHUNK = 500;
  const stmt = db().prepare(UPSERT_HP);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const tx = db().transaction((items) => {
      for (const f of items) {
        stmt.run({
          sp_id:      String(f.id || f.sp_id || ''),
          insumo:     String(f.insumo || '').trim(),
          insumoNorm: norm(f.insumo),
          proveedor:  String(f.nombreProveedor || f.proveedor || '').trim(),
          nit:        String(f.nitProveedor    || f.nit       || '').trim().replace(/\.0$/, ''),
          precio:     parseFloat(f.precioUnitario || f.precio || 0) || 0,
          fecha:      String(f.fecha || '').trim(),
          zona:       String(f.zona  || '').trim(),
          proyecto:   String(f.proyecto || '').trim(),
          documento:  String(f.numeroCompra || f.documento || '').trim(),
          cantidad:   parseFloat(f.cantidad || 0) || 0,
          unidad:     String(f.unidad || '').trim(),
          updated_at: String(f.updated_at || f.Modified || new Date().toISOString()),
        });
      }
    });
    tx(chunk);
    if (i + CHUNK < rows.length) await new Promise(r => setImmediate(r));
  }
}

function bulkUpsertProveedores(rows) {
  const stmt = db().prepare(UPSERT_PROV);
  const tx   = db().transaction((items) => {
    for (const f of items) {
      const spId = String(f.id || f.sp_id || '');
      stmt.run({
        sp_id:      spId,
        nit:        String(f.nit || f.Identificacion || '').trim().replace(/\.0$/, ''),
        nombre:     String(f.razonSocial || f.nombre || f['Razon social'] || '').trim(),
        zona:       String(f.zona || '').trim(),
        activo:     f.activo === false ? 0 : 1,
        data:       JSON.stringify({ id: spId, ...f }),
        updated_at: String(f.updated_at || f.Modified || new Date().toISOString()),
      });
    }
  });
  tx(rows);
}

function upsertProveedor(item) {
  const id     = String(item.id || '');
  const f      = item.fields || item;
  const nit    = String(f.nit || f.Identificacion || '').trim().replace(/\.0$/, '');
  const nombre = String(f.nombre || f.razonSocial || f['Razon social'] || '').trim();
  const zona   = String(f.zona || '').trim();
  const activo = f.activo === false ? 0 : 1;
  db().prepare(UPSERT_PROV).run({
    sp_id: id, nit, nombre, zona, activo,
    data:  JSON.stringify({ id, ...f }),
    updated_at: String(f.Modified || f.updated_at || new Date().toISOString()),
  });
}

function bulkUpsertInsumos(rows) {
  const stmt = db().prepare(UPSERT_INS);
  const tx   = db().transaction((items) => {
    for (const f of items) {
      const nombre = String(f.nombre || '').trim();
      stmt.run({
        sp_id:       String(f.id || f.sp_id || ''),
        nombre,
        nombreNorm:  norm(nombre),
        categoria:   String(f.categoria    || '').trim(),
        subcategoria:String(f.subcategoria || '').trim(),
        unidad:      String(f.unidadEstandar || f.unidad || '').trim(),
        activo:      f.activo === false ? 0 : 1,
        updated_at:  String(f.updated_at || f.Modified || new Date().toISOString()),
      });
    }
  });
  tx(rows);
}

function bulkUpsertProyectos(rows) {
  const stmt = db().prepare(UPSERT_PROY);
  const tx   = db().transaction((items) => {
    for (const f of items) {
      stmt.run({
        sp_id:      String(f.id || f.sp_id || ''),
        nombre:     String(f.codigo || f.nombre || '').trim(),
        zona:       String(f.zona   || '').trim(),
        activo:     f.activo === false ? 0 : 1,
        updated_at: String(f.updated_at || f.Modified || new Date().toISOString()),
      });
    }
  });
  tx(rows);
}

function bulkUpsertDocs(tabla, rows) {
  const stmt = db().prepare(UPSERT_DOC(tabla));
  const tx   = db().transaction((items) => {
    for (const it of items) {
      const spId = String(it.id || it.sp_id || '');
      const fields = it.fields || it;
      stmt.run({
        sp_id:      spId,
        data:       JSON.stringify({ id: spId, ...fields }),
        updated_at: String(fields.Modified || fields.updated_at || new Date().toISOString()),
      });
    }
  });
  tx(rows);
}

// ── Sync state ────────────────────────────────────────────────────────────────

function setSyncState(lista, count) {
  db().prepare(`
    INSERT INTO sync_state (lista, last_sync, item_count)
    VALUES (@lista, @ts, @count)
    ON CONFLICT(lista) DO UPDATE SET last_sync=excluded.last_sync, item_count=excluded.item_count
  `).run({ lista, ts: new Date().toISOString(), count });
}

function getSyncState(lista) {
  return db().prepare('SELECT * FROM sync_state WHERE lista=?').get(lista) || null;
}

function getAllSyncState() {
  return db().prepare('SELECT * FROM sync_state').all();
}

// ── Lecturas de datos ─────────────────────────────────────────────────────────

function getHistorialPrecios() {
  return db().prepare('SELECT * FROM historial_precios ORDER BY fecha DESC').all();
}

function getProveedores({ soloActivos = false } = {}) {
  const q = soloActivos
    ? 'SELECT * FROM proveedores WHERE activo=1 ORDER BY nombre'
    : 'SELECT * FROM proveedores ORDER BY nombre';
  return db().prepare(q).all().map(r => {
    try {
      const d = JSON.parse(r.data || '{}');
      return { ...d, id: r.sp_id, nit: r.nit, nombre: r.nombre, zona: r.zona, activo: r.activo !== 0 };
    } catch {
      return { id: r.sp_id, nit: r.nit, nombre: r.nombre, zona: r.zona, activo: r.activo !== 0 };
    }
  });
}

function getInsumos({ soloActivos = true } = {}) {
  const q = soloActivos
    ? 'SELECT * FROM insumos WHERE activo=1 ORDER BY nombre'
    : 'SELECT * FROM insumos ORDER BY nombre';
  return db().prepare(q).all();
}

function getProyectos({ soloActivos = true } = {}) {
  const q = soloActivos
    ? 'SELECT * FROM proyectos WHERE activo=1 ORDER BY nombre'
    : 'SELECT * FROM proyectos ORDER BY nombre';
  return db().prepare(q).all();
}

function getRequerimientos() {
  return db().prepare('SELECT data FROM requerimientos').all().map(r => JSON.parse(r.data));
}

function getOrdenesCompra() {
  return db().prepare('SELECT data FROM ordenes_compra').all().map(r => JSON.parse(r.data));
}

function getOrdenesServicio() {
  return db().prepare('SELECT data FROM ordenes_servicio').all().map(r => JSON.parse(r.data));
}

function getRemisiones() {
  return db().prepare('SELECT data FROM remisiones').all().map(r => JSON.parse(r.data));
}

function getMovimientosInventario({ proyecto = null } = {}) {
  const baseWhere =
    "json_extract(data,'$.estado')!='anulado' " +
    "AND (json_extract(data,'$.estadoDoc') IS NULL OR json_extract(data,'$.estadoDoc')!='anulado')";
  if (proyecto) {
    return db().prepare(
      `SELECT data FROM movimientos_inventario WHERE json_extract(data,'$.proyecto')=? AND ${baseWhere}`
    ).all(proyecto).map(r => JSON.parse(r.data));
  }
  return db().prepare(
    `SELECT data FROM movimientos_inventario WHERE ${baseWhere}`
  ).all().map(r => JSON.parse(r.data));
}

// Calcula stock actual: Σ entradas − Σ salidas, agrupado por insumo. Opcional: filtrar por proyecto.
function getStock(proyecto = null) {
  const movs = getMovimientosInventario(proyecto ? { proyecto } : undefined);
  const mapa = {};
  for (const m of movs) {
    const key = `${m.insumo}|||${m.unidad || ''}`;
    if (!mapa[key]) mapa[key] = {
      insumo: m.insumo, unidad: m.unidad || '',
      precioUnitario: 0, entradas: 0, salidas: 0,
    };
    const entry = mapa[key];
    const cant = Number(m.cantidad) || 0;
    if (m.tipo === 'entrada') {
      entry.entradas += cant;
      entry.precioUnitario = Number(m.precioUnitario) || entry.precioUnitario;
    } else if (m.tipo === 'salida') {
      entry.salidas += cant;
    }
  }
  return Object.values(mapa).map(e => ({
    ...e,
    stock: e.entradas - e.salidas,
    valorInventario: (e.entradas - e.salidas) * e.precioUnitario,
    valorGastado:    e.salidas * e.precioUnitario,
  })).sort((a, b) => {
    if ((a.stock > 0) !== (b.stock > 0)) return b.stock > 0 ? 1 : -1;
    return b.valorInventario - a.valorInventario || b.valorGastado - a.valorGastado;
  });
}

// Devuelve las OC ids que ya tienen al menos una entrada de inventario
function getOcIdsConEntrada() {
  const rows = db().prepare(
    "SELECT DISTINCT json_extract(data,'$.ocId') AS ocId FROM movimientos_inventario WHERE json_extract(data,'$.tipo')='entrada' AND json_extract(data,'$.estado')!='anulado'"
  ).all();
  return new Set(rows.map(r => r.ocId).filter(Boolean));
}

// Genera el siguiente consecutivo global de documento (EA-XXXX / SA-XXXX)
// El contador es global (no por proyecto) para evitar duplicados entre proyectos
function getNextDocRef(tipo, proyecto) {
  const prefix = tipo === 'entrada' ? 'EA' : 'SA';
  const row = db().prepare(
    "SELECT MAX(CAST(SUBSTR(json_extract(data,'$.documentoRef'),4) AS INTEGER)) AS maxN " +
    "FROM movimientos_inventario " +
    "WHERE json_extract(data,'$.tipo')=? " +
    "  AND json_extract(data,'$.documentoRef') LIKE ? " +
    "  AND (json_extract(data,'$.estadoDoc')='aprobado' OR json_extract(data,'$.estadoDoc') IS NULL)"
  ).get(tipo, `${prefix}-%`);
  const n = (row?.maxN || 0) + 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

// Agrupa movimientos en documentos para la vista de registros
function getDocumentosInventario({ tipo = null } = {}) {
  let sql = "SELECT data FROM movimientos_inventario WHERE 1=1";
  const params = [];
  if (tipo) { sql += " AND json_extract(data,'$.tipo')=?"; params.push(tipo); }
  const movs = db().prepare(sql).all(...params).map(r => JSON.parse(r.data));

  const docs = {};
  for (const m of movs) {
    const groupKey = m.documentoRef || `__BORR__${m.batchId || m.fechaCreacion}`;
    if (!docs[groupKey]) docs[groupKey] = {
      ref:       m.documentoRef || null,
      batchId:   m.batchId || groupKey,
      tipo:      m.tipo,
      estadoDoc: m.estadoDoc || 'aprobado',
      fecha:     m.fecha,
      proyecto:  m.proyecto,
      numeroOC:  m.numeroOC || '',
      items:     [],
      total:     0,
    };
    docs[groupKey].items.push(m);
    docs[groupKey].total += Number(m.valorTotal) || 0;
  }
  return Object.values(docs).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
}

// ── Escritura individual de documentos (después de guardar en SP) ─────────────

function upsertDocumento(tabla, spItem) {
  const spId   = String(spItem.id || '');
  const fields = spItem.fields || spItem;
  db().prepare(UPSERT_DOC(tabla)).run({
    sp_id:      spId,
    data:       JSON.stringify({ id: spId, ...fields }),
    updated_at: String(fields.Modified || new Date().toISOString()),
  });
}

function upsertHistorialFila(fila) {
  bulkUpsertHistorial([fila]);
}

// ── Usuarios ──────────────────────────────────────────────────────────────────

function upsertUsuario(item) {
  db().prepare(UPSERT_USR).run({
    sp_id:      String(item.sp_id || item.id || ''),
    email:      String(item.email || '').toLowerCase().trim(),
    nombre:     String(item.nombre || '').trim(),
    cargo:      String(item.cargo  || '').trim(),
    rol:        String(item.rol    || 'operador'),
    activo:     (item.activo === true || item.activo === 1) ? 1 : 0,
    updated_at: String(item.updated_at || item.Modified || new Date().toISOString()),
  });
}

function bulkUpsertUsuarios(rows) {
  const stmt = db().prepare(UPSERT_USR);
  const tx   = db().transaction((items) => {
    for (const f of items) {
      stmt.run({
        sp_id:      String(f.id || f.sp_id || ''),
        email:      String(f.email || '').toLowerCase().trim(),
        nombre:     String(f.nombre || '').trim(),
        cargo:      String(f.cargo  || '').trim(),
        rol:        String(f.rol    || 'operador'),
        activo:     (f.activo === true || f.activo === 1) ? 1 : 0,
        updated_at: String(f.updated_at || f.Modified || new Date().toISOString()),
      });
    }
  });
  tx(rows);
}

function countUsuarios() {
  return db().prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
}

function getUsuarios() {
  return db().prepare('SELECT * FROM usuarios ORDER BY activo DESC, nombre').all();
}

function getUsuarioByEmail(email) {
  return db().prepare('SELECT * FROM usuarios WHERE email=? COLLATE NOCASE').get(
    String(email || '').toLowerCase()
  ) || null;
}

// ── Sesiones ──────────────────────────────────────────────────────────────────

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

// ── Consecutivos por proyecto ─────────────────────────────────────────────────

function getNextConsecutivoProyecto(proyecto) {
  const d   = db();
  const now = new Date().toISOString();
  const run = d.transaction(() => {
    d.prepare(
      `INSERT OR IGNORE INTO consecutivos_proyecto (proyecto, ultimo_consecutivo, updated_at) VALUES (?, 0, ?)`
    ).run(proyecto, now);
    d.prepare(
      `UPDATE consecutivos_proyecto SET ultimo_consecutivo = ultimo_consecutivo + 1, updated_at = ? WHERE proyecto = ?`
    ).run(now, proyecto);
    return d.prepare(
      `SELECT ultimo_consecutivo FROM consecutivos_proyecto WHERE proyecto = ?`
    ).get(proyecto).ultimo_consecutivo;
  });
  const n = run();
  return String(n).padStart(4, '0');
}

function setConsecutivoProyecto(proyecto, valor) {
  const d = db(), now = new Date().toISOString();
  d.prepare(`
    INSERT INTO consecutivos_proyecto (proyecto, ultimo_consecutivo, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(proyecto) DO UPDATE SET ultimo_consecutivo = ?, updated_at = ?
  `).run(proyecto, valor, now, valor, now);
}

// ── Mapeo de proyectos hacia tesorería ────────────────────────────────────────

/**
 * Última elección humana de proyecto de tesorería para un proyecto del ERP.
 * @returns {{tesoreria_id, tesoreria_nombre, actualizado_por, updated_at}|null}
 */
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

// ── Conteo ────────────────────────────────────────────────────────────────────

function counts() {
  const tablas = [
    'historial_precios','proveedores','insumos','proyectos',
    'requerimientos','ordenes_compra','ordenes_servicio','remisiones','movimientos_inventario',
  ];
  const result = {};
  for (const t of tablas) {
    result[t] = db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  return result;
}

function isReady() {
  try {
    db();
    return true;
  } catch { return false; }
}

module.exports = {
  db,
  bulkUpsertHistorial,
  bulkUpsertHistorialAsync,
  bulkUpsertProveedores,
  bulkUpsertInsumos,
  bulkUpsertProyectos,
  bulkUpsertDocs,
  setSyncState,
  getSyncState,
  getAllSyncState,
  getHistorialPrecios,
  getProveedores,
  getInsumos,
  getProyectos,
  getRequerimientos,
  getOrdenesCompra,
  getOrdenesServicio,
  getRemisiones,
  getMovimientosInventario,
  getStock,
  getOcIdsConEntrada,
  getNextDocRef,
  getDocumentosInventario,
  upsertProveedor,
  upsertDocumento,
  upsertHistorialFila,
  upsertUsuario,
  bulkUpsertUsuarios,
  countUsuarios,
  getUsuarios,
  getUsuarioByEmail,
  upsertSesion,
  getSesion,
  deleteSesion,
  cleanExpiredSesiones,
  counts,
  isReady,
  norm,
  getNextConsecutivoProyecto,
  setConsecutivoProyecto,
  getMapeoTesoreria,
  setMapeoTesoreria,
};
