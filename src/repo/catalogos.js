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
  // `nit` está en el MAPA porque corregir un NIT mal escrito es tarea de quien
  // lo registró, no de una migración: el sistema tiene que dejarlo hacer.
  //
  // Es seguro por el esquema, no por suerte: las tres llaves foráneas que
  // apuntan a proveedores(nit) —órdenes de compra, de servicio e historial de
  // precios— están declaradas ON UPDATE CASCADE, así que el cambio repunta
  // todas sus filas en la misma sentencia. Y si el NIT nuevo ya existe, el
  // índice único lo rechaza en vez de fusionar dos proveedores en silencio.
  //
  // Antes esta clave NO estaba en el MAPA: la ruta PATCH aceptaba body.nit, el
  // bucle de abajo lo descartaba por no encontrar columna, y la respuesta era
  // un 200 sin haber cambiado nada.
  const MAPA = {
    nit: 'nit',
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
    if (col === 'zona') {
      sets.push(`zona = erp.zona_canonica($${vals.length})`);
    } else if (col === 'nit') {
      // El NIT se guarda normalizado y se conserva tal como se escribió, igual
      // que en el alta: nit es la llave y nit_original el rastro de auditoría.
      sets.push(`nit = erp.norm_nit($${vals.length}), nit_original = $${vals.length}`);
    } else {
      sets.push(`${col} = $${vals.length}`);
    }
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
  notas, requiere_revision, origen, kaos_code, sp_id`;

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
    // Quién manda sobre esta fila. 'kaos' = la administra KAOS y el ERP solo la
    // consume; 'local' = de la empresa y no existe allá (centros de costo);
    // 'huerfano' = la creó un documento antes de que se cerrara esa puerta.
    origen:           r.origen,
    kaosCode:         r.kaos_code,
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

/**
 * Retirada: el ERP no crea proyectos.
 *
 * El catálogo se administra en KAOS y acá solo se consume. Era el último
 * camino de escritura que quedaba —los seis módulos de documentos dejaron de
 * crear al vuelo, ver src/repo/_proyecto.js— y dejarla viva habría bastado
 * para que el catálogo volviera a divergir del de KAOS.
 *
 * Se conserva la función, lanzando, en vez de borrarla: si alguien vuelve a
 * llamarla, el error dice qué hacer. Una función ausente solo da
 * "crearProyecto is not a function", que no explica nada.
 */
async function crearProyecto() {
  throw new Error(
    'El ERP no crea proyectos: el catálogo se administra en KAOS y acá solo se consume.',
  );
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
//
// Los roles están en erp.usuario_roles (catálogo erp.roles). La columna vieja
// erp.usuarios.rol quedó OBSOLETA: no se lee ni se escribe desde acá.

const { EstadoInvalido } = require('./_estado');

// Los roles de cada usuario, en el orden del catálogo.
const USUARIO_COLS = `u.id, u.email, u.nombre, u.cargo, u.activo, u.sp_id,
  ARRAY(SELECT ur.rol FROM erp.usuario_roles ur JOIN erp.roles r ON r.codigo = ur.rol
         WHERE ur.usuario_id = u.id ORDER BY r.orden) AS roles`;

function mapUsuario(r) {
  return {
    id:     r.id,
    email:  r.email,
    nombre: r.nombre,
    cargo:  r.cargo,
    activo: r.activo,
    roles:  r.roles || [],
    sp_id:  r.sp_id,
  };
}

/** El catálogo de roles, para la pantalla de usuarios. */
async function getRoles() {
  return pg.rows('SELECT codigo, nombre, descripcion FROM erp.roles ORDER BY orden');
}

async function getUsuarios() {
  const filas = await pg.rows(
    `SELECT ${USUARIO_COLS} FROM erp.usuarios u ORDER BY u.activo DESC, u.nombre`);
  return filas.map(mapUsuario);
}

async function getUsuario(id) {
  const r = await pg.one(`SELECT ${USUARIO_COLS} FROM erp.usuarios u WHERE u.id = $1`, [id]);
  return r ? mapUsuario(r) : null;
}

async function getUsuarioByEmail(email) {
  const r = await pg.one(
    `SELECT ${USUARIO_COLS} FROM erp.usuarios u WHERE u.email = lower(btrim($1))`,
    [String(email || '')]);
  return r ? mapUsuario(r) : null;
}

/**
 * Alta o actualización por correo (el correo es la clave, en minúsculas como
 * exige el CHECK). Los roles se asignan aparte, con asignarRoles.
 */
async function guardarUsuario(datos) {
  const r = await pg.one(
    `INSERT INTO erp.usuarios AS x (email, nombre, cargo, activo)
     VALUES (lower(btrim($1)), $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, x.nombre),
       cargo  = COALESCE(EXCLUDED.cargo,  x.cargo),
       activo = EXCLUDED.activo
     RETURNING id`,
    [
      datos.email, datos.nombre ?? '', datos.cargo ?? '',
      datos.activo === undefined ? false : !!datos.activo,
    ]);
  return getUsuario(r.id);
}

/**
 * Cambia datos, estado y/o roles de un usuario en una sola transacción.
 *
 * Reglas que no dependen de la pantalla:
 *   · nadie se desactiva a sí mismo ni se quita su propio rol de administrador;
 *   · siempre queda al menos un administrador activo.
 * `porEmail` es quien hace el cambio (queda en usuario_roles.asignado_por).
 */
async function actualizarUsuario(id, cambios, porEmail = null) {
  return pg.tx(async (c) => {
    const { rows: [actual] } = await c.query(
      'SELECT id, email FROM erp.usuarios WHERE id = $1 FOR UPDATE', [id]);
    if (!actual) return null;
    const esUnoMismo = porEmail && actual.email === String(porEmail).toLowerCase();

    const MAPA = { nombre: 'nombre', cargo: 'cargo', activo: 'activo' };
    const sets = [];
    const vals = [];
    for (const [clave, valor] of Object.entries(cambios)) {
      const col = MAPA[clave];
      if (!col) continue;
      vals.push(valor);
      sets.push(`${col} = $${vals.length}`);
    }
    if (esUnoMismo && cambios.activo === false) {
      throw new EstadoInvalido('No puedes desactivar tu propia cuenta.');
    }
    if (sets.length) {
      vals.push(id);
      await c.query(`UPDATE erp.usuarios SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }

    if (Array.isArray(cambios.roles)) {
      const roles = [...new Set(cambios.roles.map(String))];
      const { rows: validos } = await c.query(
        'SELECT codigo FROM erp.roles WHERE codigo = ANY($1::text[])', [roles]);
      const desconocidos = roles.filter((r) => !validos.some((v) => v.codigo === r));
      if (desconocidos.length) throw new EstadoInvalido(`Rol desconocido: ${desconocidos.join(', ')}`);
      if (esUnoMismo && !roles.includes('admin')) {
        throw new EstadoInvalido('No puedes quitarte el rol de administrador a ti mismo.');
      }
      await c.query(
        'DELETE FROM erp.usuario_roles WHERE usuario_id = $1 AND NOT (rol = ANY($2::text[]))', [id, roles]);
      await c.query(
        `INSERT INTO erp.usuario_roles (usuario_id, rol, asignado_por)
         SELECT $1, r, $3 FROM unnest($2::text[]) r
         ON CONFLICT (usuario_id, rol) DO NOTHING`, [id, roles, porEmail]);
    }

    const { rows: [admins] } = await c.query(
      `SELECT count(*)::int AS n FROM erp.usuarios u
         JOIN erp.usuario_roles ur ON ur.usuario_id = u.id AND ur.rol = 'admin'
        WHERE u.activo`);
    if (admins.n === 0) throw new EstadoInvalido('Debe quedar al menos un administrador activo.');

    const { rows: [fila] } = await c.query(`SELECT ${USUARIO_COLS} FROM erp.usuarios u WHERE u.id = $1`, [id]);
    return mapUsuario(fila);
  });
}

/** Solo para el arranque (bootstrapAdmin): sin las reglas de quién asigna. */
async function asignarRolesIniciales(id, roles) {
  await pg.query(
    `INSERT INTO erp.usuario_roles (usuario_id, rol, asignado_por)
     SELECT $1, r, 'arranque' FROM unnest($2::text[]) r
     ON CONFLICT (usuario_id, rol) DO NOTHING`, [id, roles]);
}

async function contarUsuarios() {
  const r = await pg.one('SELECT count(*)::int AS n FROM erp.usuarios');
  return r.n;
}

module.exports = {
  getProveedores, getProveedorPorNit, guardarProveedor, actualizarProveedor,
  getProyectos, getProyecto, getProyectoPorCodigo, crearProyecto, actualizarProyecto,
  getInsumos, guardarInsumo,
  getRoles, getUsuarios, getUsuario, getUsuarioByEmail, guardarUsuario, actualizarUsuario,
  asignarRolesIniciales, contarUsuarios,
};
