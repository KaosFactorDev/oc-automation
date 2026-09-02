'use strict';
/**
 * repo/catalogos.js — Proveedores, proyectos, insumos y usuarios.
 *
 * Reemplaza dos cosas a la vez: las lecturas que salían del caché SQLite
 * (localDb.getProveedores y compañía) y las escrituras que iban a SharePoint
 * por Graph. Antes cada alta era una escritura doble —a la lista y al caché—
 * que podían quedar desalineadas; acá es una sola.
 *
 * ── Sobre la forma que devuelve ────────────────────────────────────────────
 * Estas funciones devuelven los MISMOS nombres de campo que devolvía db.js,
 * porque la consola los consume directo. Donde el nombre en Postgres es otro
 * se traduce acá y no en el llamador:
 *
 *   proyectos.nombre  ← codigo        (en SQLite, "nombre" guardaba el código
 *                                      de SharePoint: "CT25-134 ANCLAJES...")
 *   proveedores.nombre ← razon_social
 *
 * ── Sobre el id ────────────────────────────────────────────────────────────
 * El id que ve la consola ya no es el de SharePoint. No puede serlo: los 12
 * proveedores y 23 proyectos que el import creó para no perder referencias
 * huérfanas no tienen sp_id, y con el criterio anterior habrían quedado
 * inalcanzables desde la interfaz. Ahora es la clave real de la tabla — el NIT
 * para proveedores, el id de Postgres para el resto. sp_id se sigue exponiendo
 * por si hace falta rastrear el origen.
 */

const pg = require('../pg');
const { fk } = require('./_valores');

// ── Proveedores ─────────────────────────────────────────────────────────────

const PROVEEDOR_COLS = `
  nit, nit_original, razon_social, nombre_comercial, regimen, municipio,
  direccion, telefono, correo, zona, banco, tipo_cuenta, cuenta_bancaria,
  activo, requiere_revision, sp_id`;

function mapProveedor(r) {
  return {
    id:               r.nit,
    nit:              r.nit,
    nitOriginal:      r.nit_original,
    // La consola usa "nombre" en 21 lugares y "razonSocial" en 4: se exponen
    // los dos con el mismo valor en vez de tocar la interfaz.
    nombre:           r.razon_social,
    razonSocial:      r.razon_social,
    nombreComercial:  r.nombre_comercial,
    regimen:          r.regimen,
    municipio:        r.municipio,
    direccion:        r.direccion,
    telefono:         r.telefono,
    correo:           r.correo,
    zona:             r.zona,
    banco:            r.banco,
    tipoCuenta:       r.tipo_cuenta,
    cuentaBancaria:   r.cuenta_bancaria,
    activo:           r.activo,
    requiereRevision: r.requiere_revision,
    spId:             r.sp_id,
  };
}

async function getProveedores({ soloActivos = false } = {}) {
  const filas = await pg.rows(
    `SELECT ${PROVEEDOR_COLS} FROM erp.proveedores
      ${soloActivos ? 'WHERE activo' : ''}
      ORDER BY razon_social`);
  return filas.map(mapProveedor);
}

async function getProveedorPorNit(nit) {
  const r = await pg.one(
    `SELECT ${PROVEEDOR_COLS} FROM erp.proveedores WHERE nit = erp.norm_nit($1)`, [nit]);
  return r ? mapProveedor(r) : null;
}

/**
 * Alta o actualización por NIT. El NIT se normaliza en la base con
 * erp.norm_nit(), así que "900.807.426-3" y "900807426-3" son el mismo
 * proveedor y no se duplican como pasaba en SharePoint.
 */
async function guardarProveedor(datos) {
  const r = await pg.one(
    `INSERT INTO erp.proveedores
       (nit, nit_original, razon_social, nombre_comercial, regimen, municipio,
        direccion, telefono, correo, zona, banco, tipo_cuenta, cuenta_bancaria, activo)
     VALUES (erp.norm_nit($1), $1, $2, $3, $4, $5, $6, $7, $8, erp.zona_canonica($9), $10, $11, $12, $13)
     ON CONFLICT (nit) DO UPDATE SET
       razon_social     = COALESCE(EXCLUDED.razon_social, erp.proveedores.razon_social),
       nombre_comercial = COALESCE(EXCLUDED.nombre_comercial, erp.proveedores.nombre_comercial),
       regimen          = COALESCE(EXCLUDED.regimen, erp.proveedores.regimen),
       municipio        = COALESCE(EXCLUDED.municipio, erp.proveedores.municipio),
       direccion        = COALESCE(EXCLUDED.direccion, erp.proveedores.direccion),
       telefono         = COALESCE(EXCLUDED.telefono, erp.proveedores.telefono),
       correo           = COALESCE(EXCLUDED.correo, erp.proveedores.correo),
       zona             = COALESCE(EXCLUDED.zona, erp.proveedores.zona),
       banco            = COALESCE(EXCLUDED.banco, erp.proveedores.banco),
       tipo_cuenta      = COALESCE(EXCLUDED.tipo_cuenta, erp.proveedores.tipo_cuenta),
       cuenta_bancaria  = COALESCE(EXCLUDED.cuenta_bancaria, erp.proveedores.cuenta_bancaria),
       activo           = EXCLUDED.activo,
       -- Editarlo a mano es justamente la revisión que estaba pendiente.
       requiere_revision = false
     RETURNING ${PROVEEDOR_COLS}`,
    [
      datos.nit, datos.razonSocial ?? datos.nombre ?? null, datos.nombreComercial ?? null,
      datos.regimen ?? null, datos.municipio ?? null, datos.direccion ?? null,
      datos.telefono ?? null, datos.correo ?? null, fk(datos.zona),
      datos.banco ?? null, datos.tipoCuenta ?? null, datos.cuentaBancaria ?? null,
      datos.activo === undefined ? true : !!datos.activo,
    ]);
  return mapProveedor(r);
}

/** Actualización parcial: solo toca las columnas presentes en `cambios`. */
async function actualizarProveedor(nit, cambios) {
  const MAPA = {
    razonSocial: 'razon_social', nombre: 'razon_social',
    nombreComercial: 'nombre_comercial', regimen: 'regimen', municipio: 'municipio',
    direccion: 'direccion', telefono: 'telefono', correo: 'correo', zona: 'zona',
    banco: 'banco', tipoCuenta: 'tipo_cuenta', cuentaBancaria: 'cuenta_bancaria',
    activo: 'activo',
  };
  const sets = [];
  const vals = [];
  for (const [clave, valor] of Object.entries(cambios)) {
    const col = MAPA[clave];
    if (!col || sets.some(s => s.startsWith(col + ' '))) continue;
    // zona tiene llave foránea. fk() convierte el blanco en NULL y
    // erp.zona_canonica() resuelve la caja: "CENTRO" y "Centro" son la misma.
    vals.push(col === 'zona' ? fk(valor) : valor);
    sets.push(col === 'zona'
      ? `zona = erp.zona_canonica($${vals.length})`
      : `${col} = $${vals.length}`);
  }
  if (!sets.length) return getProveedorPorNit(nit);

  vals.push(nit);
  const r = await pg.one(
    `UPDATE erp.proveedores SET ${sets.join(', ')}, requiere_revision = false
      WHERE nit = erp.norm_nit($${vals.length})
      RETURNING ${PROVEEDOR_COLS}`, vals);
  return r ? mapProveedor(r) : null;
}

// ── Proyectos ───────────────────────────────────────────────────────────────

const PROYECTO_COLS = `
  id, codigo, nombre, tipo, ciudad, departamento, zona, activo,
  notas, requiere_revision, sp_id`;

function mapProyecto(r) {
  return {
    id:               r.id,
    // "nombre" es el CÓDIGO: es lo que el resto del sistema guarda en el campo
    // "proyecto" de cada documento y lo que la consola muestra en 18 lugares.
    nombre:           r.codigo,
    codigo:           r.codigo,
    // El nombre descriptivo, que en SQLite no estaba disponible.
    descripcion:      r.nombre,
    tipo:             r.tipo,
    ciudad:           r.ciudad,
    departamento:     r.departamento,
    zona:             r.zona,
    activo:           r.activo,
    notas:            r.notas,
    requiereRevision: r.requiere_revision,
    sp_id:            r.sp_id,
  };
}

async function getProyectos({ soloActivos = true } = {}) {
  const filas = await pg.rows(
    `SELECT ${PROYECTO_COLS} FROM erp.proyectos
      ${soloActivos ? 'WHERE activo' : ''}
      ORDER BY codigo`);
  return filas.map(mapProyecto);
}

async function getProyecto(id) {
  const r = await pg.one(`SELECT ${PROYECTO_COLS} FROM erp.proyectos WHERE id = $1`, [id]);
  return r ? mapProyecto(r) : null;
}

/** Busca por código, sin distinguir tildes ni mayúsculas. */
async function getProyectoPorCodigo(codigo) {
  const r = await pg.one(
    `SELECT ${PROYECTO_COLS} FROM erp.proyectos WHERE erp.norm(codigo) = erp.norm($1)`, [codigo]);
  return r ? mapProyecto(r) : null;
}

async function crearProyecto(datos) {
  const r = await pg.one(
    `INSERT INTO erp.proyectos (codigo, nombre, tipo, ciudad, departamento, zona, activo, notas)
     VALUES ($1, COALESCE($2, $1), $3, $4, $5, erp.zona_canonica($6), $7, $8)
     RETURNING ${PROYECTO_COLS}`,
    [
      datos.codigo ?? datos.nombre, datos.descripcion ?? null, datos.tipo ?? null,
      datos.ciudad ?? null, datos.departamento ?? null, fk(datos.zona),
      datos.activo === undefined ? true : !!datos.activo, datos.notas ?? null,
    ]);
  return mapProyecto(r);
}

async function actualizarProyecto(id, cambios) {
  const MAPA = {
    codigo: 'codigo', nombre: 'codigo', descripcion: 'nombre', tipo: 'tipo',
    ciudad: 'ciudad', departamento: 'departamento', zona: 'zona',
    activo: 'activo', notas: 'notas',
  };
  const sets = [];
  const vals = [];
  for (const [clave, valor] of Object.entries(cambios)) {
    const col = MAPA[clave];
    if (!col || sets.some(s => s.startsWith(col + ' '))) continue;
    // zona tiene llave foránea: la cadena vacía del formulario va como NULL.
    vals.push(col === 'zona' ? fk(valor) : valor);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return getProyecto(id);

  vals.push(id);
  const r = await pg.one(
    `UPDATE erp.proyectos SET ${sets.join(', ')}, requiere_revision = false
      WHERE id = $${vals.length} RETURNING ${PROYECTO_COLS}`, vals);
  return r ? mapProyecto(r) : null;
}

// ── Insumos ─────────────────────────────────────────────────────────────────

const INSUMO_COLS = `id, nombre, nombre_norm, categoria, subcategoria, unidad,
                     sinonimos, activo, sp_id`;

function mapInsumo(r) {
  return {
    id:           r.id,
    nombre:       r.nombre,
    nombreNorm:   r.nombre_norm,
    categoria:    r.categoria,
    subcategoria: r.subcategoria,
    unidad:       r.unidad,
    sinonimos:    r.sinonimos || [],
    activo:       r.activo,
    sp_id:        r.sp_id,
  };
}

async function getInsumos({ soloActivos = true } = {}) {
  const filas = await pg.rows(
    `SELECT ${INSUMO_COLS} FROM erp.insumos
      ${soloActivos ? 'WHERE activo' : ''}
      ORDER BY nombre`);
  return filas.map(mapInsumo);
}

/**
 * Alta idempotente por nombre normalizado. nombre_norm es una columna generada,
 * así que el conflicto se resuelve contra su índice único: dos formas de
 * escribir el mismo insumo no crean dos filas.
 */
async function guardarInsumo(datos) {
  const r = await pg.one(
    `INSERT INTO erp.insumos (nombre, categoria, subcategoria, unidad, sinonimos, activo)
     VALUES ($1, $2, $3, $4, COALESCE($5, '{}'), $6)
     ON CONFLICT (nombre_norm) DO UPDATE SET
       categoria    = COALESCE(EXCLUDED.categoria, erp.insumos.categoria),
       subcategoria = COALESCE(EXCLUDED.subcategoria, erp.insumos.subcategoria),
       unidad       = COALESCE(EXCLUDED.unidad, erp.insumos.unidad),
       activo       = EXCLUDED.activo
     RETURNING ${INSUMO_COLS}`,
    [
      datos.nombre, datos.categoria ?? null, datos.subcategoria ?? null,
      datos.unidad ?? datos.unidadEstandar ?? null,
      Array.isArray(datos.sinonimos) ? datos.sinonimos : null,
      datos.activo === undefined ? true : !!datos.activo,
    ]);
  return mapInsumo(r);
}

// ── Usuarios ────────────────────────────────────────────────────────────────

const USUARIO_COLS = 'id, email, nombre, cargo, rol, activo, sp_id';

function mapUsuario(r) {
  return {
    id:     r.id,
    email:  r.email,
    nombre: r.nombre,
    cargo:  r.cargo,
    rol:    r.rol,
    activo: r.activo,
    sp_id:  r.sp_id,
  };
}

async function getUsuarios() {
  const filas = await pg.rows(
    `SELECT ${USUARIO_COLS} FROM erp.usuarios ORDER BY activo DESC, nombre`);
  return filas.map(mapUsuario);
}

async function getUsuarioByEmail(email) {
  const r = await pg.one(
    `SELECT ${USUARIO_COLS} FROM erp.usuarios WHERE email = lower(btrim($1))`,
    [String(email || '')]);
  return r ? mapUsuario(r) : null;
}

/** El correo es la clave: siempre en minúsculas, como exige el CHECK. */
async function guardarUsuario(datos) {
  const r = await pg.one(
    `INSERT INTO erp.usuarios (email, nombre, cargo, rol, activo)
     VALUES (lower(btrim($1)), $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, erp.usuarios.nombre),
       cargo  = COALESCE(EXCLUDED.cargo,  erp.usuarios.cargo),
       rol    = COALESCE(EXCLUDED.rol,    erp.usuarios.rol),
       activo = EXCLUDED.activo
     RETURNING ${USUARIO_COLS}`,
    [
      datos.email, datos.nombre ?? '', datos.cargo ?? '',
      ['admin', 'operador'].includes(datos.rol) ? datos.rol : 'operador',
      datos.activo === undefined ? false : !!datos.activo,
    ]);
  return mapUsuario(r);
}

async function actualizarUsuario(id, cambios) {
  const MAPA = { nombre: 'nombre', cargo: 'cargo', rol: 'rol', activo: 'activo' };
  const sets = [];
  const vals = [];
  for (const [clave, valor] of Object.entries(cambios)) {
    const col = MAPA[clave];
    if (!col) continue;
    vals.push(valor);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return null;

  vals.push(id);
  const r = await pg.one(
    `UPDATE erp.usuarios SET ${sets.join(', ')}
      WHERE id = $${vals.length} RETURNING ${USUARIO_COLS}`, vals);
  return r ? mapUsuario(r) : null;
}

async function contarUsuarios() {
  const r = await pg.one('SELECT count(*)::int AS n FROM erp.usuarios');
  return r.n;
}

module.exports = {
  getProveedores, getProveedorPorNit, guardarProveedor, actualizarProveedor,
  getProyectos, getProyecto, getProyectoPorCodigo, crearProyecto, actualizarProyecto,
  getInsumos, guardarInsumo,
  getUsuarios, getUsuarioByEmail, guardarUsuario, actualizarUsuario, contarUsuarios,
};
