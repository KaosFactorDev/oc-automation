'use strict';
/**
 * importar-listas.js — Carga las 11 listas de SharePoint en Postgres.
 *
 *   npm run db:importar                   importa desde SharePoint
 *   npm run db:importar -- --dry-run      hace todo y revierte al final
 *   npm run db:importar -- --truncate     vacía las tablas erp antes de cargar
 *
 * ── Qué hace, en orden ─────────────────────────────────────────────────────
 *  1. Lee las 11 listas.
 *  2. Carga catálogos: proyectos, proveedores, insumos, usuarios, configuración.
 *  3. Carga documentos en orden de dependencia, resolviendo las llaves foráneas
 *     con mapas sp_id → id.
 *  4. Sincroniza los contadores de consecutivos.
 *  5. Reporta qué entró, qué se creó de más y qué se rechazó.
 *
 * Todo corre en UNA transacción: si algo falla, la base queda como estaba. No
 * hay estado intermedio posible.
 *
 * ── Decisiones de conversión ───────────────────────────────────────────────
 * Cada una responde a algo que está realmente en los datos:
 *
 *  · Ítems de OC con dos formas. 692 traen la clave "descripcion" y 546 traen
 *    "insumo", según por dónde se creó la orden. Se unifican en descripcion, y
 *    el nombre previo a la homologación queda en insumo_original.
 *
 *  · numeroOC vacío → NULL. El número solo existe al aprobar; en SharePoint las
 *    órdenes sin aprobar guardaban cadena vacía, que no permite índice único.
 *
 *  · Zonas en dos casos. Los proveedores traen "Centro" y "CENTRO" mezclados.
 *    Se resuelven contra erp.zonas sin distinguir mayúsculas; lo que no calce
 *    queda en NULL en vez de romper la llave foránea.
 *
 *  · NIT normalizados. "900.807.426-3", "800,118,549-1" y "811017552.0" son
 *    tres formatos del mismo dato; erp.norm_nit() los unifica. Cuatro pares de
 *    proveedores colapsan en uno solo por esto, y está bien: es el mismo
 *    proveedor dado de alta dos veces.
 *
 *  · Fechas del historial. La columna es texto en SharePoint, con cuatro
 *    formatos conviviendo. Se guarda la interpretación en "fecha" y el original
 *    intacto en "fecha_texto". Lo que no se pueda interpretar queda NULL y no
 *    se pierde.
 *
 *  · Proyectos y proveedores referenciados que no están en su catálogo. Se
 *    crean con activo=false y requiere_revision=true, para no perder la
 *    referencia del documento ni inventar que están vigentes.
 *
 *  · ocsGeneradas y ocsAsociadas no se migran. Eran listas de ids en texto que
 *    duplicaban lo que ya dicen ordenes_compra.requerimiento_id y la tabla
 *    remision_ordenes.
 */

require('dotenv').config();

const path     = require('path');
const { Client } = require('pg');
const { configAdmin } = require('./db-admin');

const DRY_RUN  = process.argv.includes('--dry-run');
const TRUNCATE = process.argv.includes('--truncate');
const RENUMERAR = process.argv.includes('--renumerar-duplicados');

// ── Normalizadores (espejo de erp.norm y erp.norm_nit) ──────────────────────

function norm(s) {
  return String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9/-]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normNit(s) {
  // Debe dar exactamente lo mismo que erp.norm_nit(): se corta en el guion
  // para quedarse con la raíz, porque el dígito de verificación es un checksum
  // de esa raíz y no distingue empresas.
  const v = String(s || '')
    .replace(/\.0+$/, '')
    .replace(/[^0-9A-Za-z-]/g, '')
    .split('-')[0];
  return v || null;
}

const txt  = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
const txt0 = (v) => String(v ?? '').trim();
const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Timestamps: SharePoint entrega ISO con Z. Postgres los parsea tal cual. */
const ts = (v) => {
  const s = txt(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

/** Los cuatro formatos que conviven en HistorialPrecios.fecha. → 'YYYY-MM-DD' */
function fechaSuelta(val) {
  const s = txt0(val).toLowerCase();
  if (!s) return null;
  const arma = (a, m, d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  let m = s.match(/^([a-záéíóú]+)\s+(\d{1,2}),?\s+(\d{4})$/);       // "junio 23, 2026"
  if (m && MESES[m[1]]) return arma(m[3], MESES[m[1]], m[2]);

  m = s.match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})$/);   // "23 de junio de 2026"
  if (m && MESES[m[2]]) return arma(m[3], MESES[m[2]], m[1]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);                   // "23/04/2026"
  if (m) return arma(m[3], m[2], m[1]);

  return null;
}

// ── Lectura de las listas ───────────────────────────────────────────────────

const LISTAS = [
  'Proyectos', 'Proveedores', 'Insumos', 'UsuariosERP', 'ConfiguracionApp',
  'Requerimientos', 'OrdenesCompra', 'OrdenesServicio', 'Remisiones',
  'MovimientosInventario', 'HistorialPrecios',
];

/** Campos que SharePoint agrega a cada item y que no son datos del negocio. */
const RUIDO_SP = /^(@odata|ContentType|Modified|Created|AuthorLookupId|EditorLookupId|_UIVersionString|Attachments|Edit|ItemChildCount|FolderChildCount|_Compliance|AppAuthorLookupId|AppEditorLookupId|Title|LinkTitle|ID)/;

function limpiar(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!RUIDO_SP.test(k)) out[k] = v;
  }
  return out;
}

async function leerDeSharePoint() {
  const g = require('../graphStorage');
  const site = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);
  const listas = await g.getLists(site.id);
  const porNombre = new Map(listas.map(l => [l.displayName, l.id]));

  const datos = {};
  for (const nombre of LISTAS) {
    const listId = porNombre.get(nombre);
    if (!listId) {
      console.log(`  ⚠ lista "${nombre}" no existe en el sitio — se omite`);
      datos[nombre] = [];
      continue;
    }
    const items = await g.getListItems(site.id, listId);
    datos[nombre] = items.map(it => ({ sp_id: String(it.id), ...limpiar(it.fields) }));
    console.log(`  ✓ ${nombre.padEnd(22)} ${String(datos[nombre].length).padStart(6)} filas`);
  }
  return datos;
}

// ── Números de documento repetidos ──────────────────────────────────────────

const ANULADOS = new Set(['anulada', 'anulado']);

/**
 * En los datos hay 11 números de OC, 5 de OS y 1 de remisión repetidos. Casi
 * todos tienen la misma forma: una orden anulada y su reemplazo, que heredó el
 * número porque contador.js calcula el siguiente MAX excluyendo las anuladas.
 * (El esquema nuevo ya no permite que eso vuelva a pasar.)
 *
 * Solo se ejecuta con --renumerar-duplicados. Sin esa bandera el import se
 * detiene contra el índice único, que es lo correcto por defecto: cambiar el
 * número de un documento contable no es algo que deba pasar en silencio.
 *
 * La regla: el número se queda con el documento VIGENTE y los anulados pasan a
 * "0036-A", "0036-B". Si no hay ninguno vigente, lo conserva el más antiguo.
 * Ningún documento se borra ni se pierde; solo cambia la etiqueta de los que ya
 * estaban anulados.
 *
 * Si hay DOS vigentes con el mismo número, no se decide automáticamente: eso no
 * es el patrón conocido y merece que lo mire una persona.
 */
function renumerarDuplicados(docs, campo, etiqueta) {
  const grupos = new Map();
  for (const d of docs) {
    const n = txt0(d[campo]);
    if (!n) continue;
    if (!grupos.has(n)) grupos.set(n, []);
    grupos.get(n).push(d);
  }

  const cambios = [];
  const conflictivos = [];

  for (const [numero, grupo] of grupos) {
    if (grupo.length < 2) continue;

    const antiguedad = (d) =>
      Date.parse(d.fechaCreacion || d.fechaAprobacion || '') || Number(d.sp_id) || 0;

    const vigentes = grupo.filter(d => !ANULADOS.has(txt0(d.estado)));

    if (vigentes.length > 1) {
      // Caso no contemplado por la regla: se reporta y se deja intacto, así el
      // índice único lo frena y alguien lo revisa.
      conflictivos.push(
        `${etiqueta} ${numero}: ${vigentes.length} documentos vigentes (sp_id ${vigentes.map(d => d.sp_id).join(', ')})`);
      continue;
    }

    const conserva = vigentes.length === 1
      ? vigentes[0]
      : [...grupo].sort((a, b) => antiguedad(a) - antiguedad(b))[0];

    const resto = grupo.filter(d => d !== conserva)
      .sort((a, b) => antiguedad(a) - antiguedad(b));

    resto.forEach((d, i) => {
      const nuevo = `${numero}-${String.fromCharCode(65 + i)}`;
      cambios.push(`${etiqueta} ${numero} → ${nuevo} (sp_id=${d.sp_id}, estado=${txt0(d.estado)})`);
      d[campo] = nuevo;
    });
  }

  return { cambios, conflictivos };
}

// ── Inserción por lotes ─────────────────────────────────────────────────────

/**
 * INSERT multi-fila con ON CONFLICT sobre sp_id, para que el script se pueda
 * repetir: la segunda corrida actualiza en vez de duplicar.
 * Devuelve un mapa sp_id → id, que es lo que resuelve las llaves foráneas.
 */
async function insertar(cliente, tabla, columnas, filas, { conflicto = 'sp_id', devolver = 'id, sp_id' } = {}) {
  const mapa = new Map();
  if (!filas.length) return mapa;

  // Postgres rechaza un INSERT ... ON CONFLICT DO UPDATE donde dos filas del
  // mismo statement chocan en la clave ("cannot affect row a second time"), así
  // que la deduplicación tiene que pasar acá y no en el servidor. Ocurre de
  // verdad: cuatro pares de proveedores colapsan en un solo NIT al normalizar.
  // Gana la última aparición, que es la más reciente en la lista.
  const unicas = new Map();
  const colapsadas = [];
  for (const fila of filas) {
    const clave = String(fila[conflicto] ?? '');
    if (unicas.has(clave)) colapsadas.push(clave);
    unicas.set(clave, fila);
  }
  if (colapsadas.length) {
    avisar(`${tabla}: ${colapsadas.length} fila(s) colapsadas por ${conflicto} repetido (${[...new Set(colapsadas)].slice(0, 4).join(', ')}${colapsadas.length > 4 ? '…' : ''})`);
  }
  filas = [...unicas.values()];

  const LOTE = 400;
  const actualizables = columnas.filter(c => c !== conflicto);

  for (let i = 0; i < filas.length; i += LOTE) {
    const chunk = filas.slice(i, i + LOTE);
    const valores = [];
    const grupos = chunk.map((fila, f) =>
      '(' + columnas.map((c, j) => {
        valores.push(fila[c] ?? null);
        return `$${f * columnas.length + j + 1}`;
      }).join(',') + ')'
    );

    const sql = `
      INSERT INTO erp.${tabla} (${columnas.join(', ')})
      VALUES ${grupos.join(', ')}
      ON CONFLICT (${conflicto}) DO UPDATE SET
        ${actualizables.map(c => `${c} = EXCLUDED.${c}`).join(', ')}
      RETURNING ${devolver}`;

    const r = await cliente.query(sql, valores);
    for (const row of r.rows) mapa.set(String(row.sp_id), row.id ?? row[conflicto]);
  }
  return mapa;
}

/**
 * Igual, pero para tablas hijas: sin sp_id ni ON CONFLICT.
 *
 * Antes de insertar borra los hijos de los documentos que se van a recargar.
 * Sin esto, reimportar duplica cada ítem: la cabecera se actualiza por
 * ON CONFLICT pero los hijos se acumularían, y el segundo intento choca contra
 * el índice (documento, línea). Con el borrado previo, correr el import dos
 * veces deja exactamente el mismo resultado que correrlo una.
 */
async function insertarHijos(cliente, tabla, columnas, filas) {
  if (!filas.length) return 0;

  const fk = columnas[0];   // por convención, la primera columna es la llave al padre
  const padres = [...new Set(filas.map(f => f[fk]))];
  await cliente.query(`DELETE FROM erp.${tabla} WHERE ${fk} = ANY($1::bigint[])`, [padres]);

  const LOTE = 400;
  let total = 0;
  for (let i = 0; i < filas.length; i += LOTE) {
    const chunk = filas.slice(i, i + LOTE);
    const valores = [];
    const grupos = chunk.map((fila, f) =>
      '(' + columnas.map((c, j) => {
        valores.push(fila[c] ?? null);
        return `$${f * columnas.length + j + 1}`;
      }).join(',') + ')'
    );
    const r = await cliente.query(
      `INSERT INTO erp.${tabla} (${columnas.join(', ')}) VALUES ${grupos.join(', ')}`, valores);
    total += r.rowCount;
  }
  return total;
}

// ── Programa ────────────────────────────────────────────────────────────────

const reporte = { tablas: [], avisos: [] };
const anotar  = (t, n) => reporte.tablas.push([t, n]);
const avisar  = (m)    => reporte.avisos.push(m);

async function main() {
  console.log('\n════ Import de las 11 listas de SharePoint → Postgres ════\n');
  if (DRY_RUN) console.log('  MODO ENSAYO: al final se revierte todo.\n');

  console.log('Leyendo listas...');
  const datos = await leerDeSharePoint();

  if (RENUMERAR) {
    console.log('\nResolviendo números de documento repetidos...');
    const todos = [];
    const trabados = [];
    for (const [lista, campo, etiqueta] of [
      ['OrdenesCompra',   'numeroOC', 'OC'],
      ['OrdenesServicio', 'numeroOS', 'OS'],
      ['Remisiones',      'numero',   'Remisión'],
    ]) {
      const { cambios, conflictivos } = renumerarDuplicados(datos[lista], campo, etiqueta);
      todos.push(...cambios);
      trabados.push(...conflictivos);
    }

    for (const c of todos)    console.log(`  · ${c}`);
    for (const c of trabados) console.log(`  ✖ ${c}`);

    if (!todos.length && !trabados.length) console.log('  (no había ninguno)');
    if (todos.length) avisar(`${todos.length} número(s) de documento reasignados con sufijo. Revisa la lista de arriba y replica el cambio en SharePoint.`);

    if (trabados.length) {
      console.error('\n✖ Hay números repetidos entre documentos VIGENTES, que la regla');
      console.error('  automática no cubre: no se puede decidir cuál conserva el número.');
      console.error('  Resuélvelos en SharePoint y vuelve a correr.\n');
      process.exit(1);
    }
  }

  const cliente = new Client(configAdmin());
  await cliente.connect();

  try {
    await cliente.query('BEGIN');

    if (TRUNCATE) {
      console.log('\nVaciando tablas...');
      await cliente.query(`
        TRUNCATE erp.remision_items, erp.remision_ordenes, erp.remisiones,
                 erp.movimientos_inventario, erp.historial_precios,
                 erp.orden_compra_items, erp.ordenes_compra,
                 erp.orden_servicio_items, erp.ordenes_servicio,
                 erp.requerimiento_items, erp.requerimientos,
                 erp.usuarios, erp.configuracion, erp.insumos,
                 erp.proveedores, erp.proyectos
        RESTART IDENTITY CASCADE`);
      await cliente.query(`UPDATE erp.contadores SET valor = 0`);
      console.log('  ✓ tablas vacías');
    }

    // ── Zonas: resolución sin distinguir mayúsculas ───────────────────────
    const zonasValidas = new Map(
      (await cliente.query('SELECT zona FROM erp.zonas')).rows.map(r => [r.zona.toUpperCase(), r.zona])
    );
    const zonasDesconocidas = new Set();
    const zona = (v) => {
      const s = txt0(v).toUpperCase();
      if (!s) return null;
      const canon = zonasValidas.get(s);
      if (!canon) { zonasDesconocidas.add(txt0(v)); return null; }
      return canon;
    };

    console.log('\nCargando catálogos...');

    // ── 1. Proyectos ──────────────────────────────────────────────────────
    // En SharePoint la clave es "codigo"; es el texto que los documentos
    // guardan en su campo "proyecto".
    const vistosProyecto = new Map();
    for (const p of datos.Proyectos) {
      const codigo = txt(p.codigo) || txt(p.nombre);
      if (!codigo) { avisar(`Proyecto sp_id=${p.sp_id} sin código: omitido`); continue; }
      const clave = norm(codigo);
      if (vistosProyecto.has(clave)) {
        avisar(`Proyecto "${codigo}": sp_id=${vistosProyecto.get(clave).sp_id} reemplazado por el más reciente sp_id=${p.sp_id}`);
      }
      vistosProyecto.set(clave, {
        codigo, nombre: txt0(p.nombre) || codigo, tipo: txt(p.tipo),
        ciudad: txt(p.ciudad), departamento: txt(p.departamento), zona: zona(p.zona),
        activo: bool(p.activo), notas: txt(p.notas), requiere_revision: false,
        sp_id: p.sp_id,
      });
    }
    const idProyecto = await insertar(cliente, 'proyectos',
      ['codigo','nombre','tipo','ciudad','departamento','zona','activo','notas','requiere_revision','sp_id'],
      [...vistosProyecto.values()]);
    anotar('proyectos', idProyecto.size);

    // Mapa código-normalizado → id, que es como los documentos referencian.
    const proyectoPorCodigo = new Map(
      (await cliente.query('SELECT id, codigo FROM erp.proyectos')).rows
        .map(r => [norm(r.codigo), r.id])
    );

    /** Resuelve el texto de proyecto de un documento; lo crea si no existe. */
    const proyectosCreados = [];
    async function resolverProyecto(valor) {
      const s = txt(valor);
      if (!s) return null;
      const clave = norm(s);
      if (proyectoPorCodigo.has(clave)) return proyectoPorCodigo.get(clave);
      const r = await cliente.query(
        `INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
         VALUES ($1, $1, false, true) RETURNING id`, [s]);
      proyectoPorCodigo.set(clave, r.rows[0].id);
      proyectosCreados.push(s);
      return r.rows[0].id;
    }

    // ── 2. Proveedores ────────────────────────────────────────────────────
    // El NIT es la clave primaria. Cuatro pares de items de SharePoint
    // colapsan acá en una sola fila: es el mismo proveedor dado de alta dos
    // veces, y el ON CONFLICT conserva el último que entra.
    const provFilas = [];
    const nitsVistos = new Map();
    for (const p of datos.Proveedores) {
      const nit = normNit(p.nit);
      if (!nit) { avisar(`Proveedor sp_id=${p.sp_id} sin NIT: omitido`); continue; }
      if (nitsVistos.has(nit)) {
        avisar(`Proveedores fusionados por NIT ${nit}: sp_id=${nitsVistos.get(nit)} y sp_id=${p.sp_id}`);
      }
      nitsVistos.set(nit, p.sp_id);
      provFilas.push({
        nit, nit_original: txt(p.nit),
        razon_social: txt0(p.razonSocial) || txt0(p.nombre),
        nombre_comercial: txt(p.nombreComercial), regimen: txt(p.regimen),
        municipio: txt(p.municipio), direccion: txt(p.direccion),
        telefono: txt(p.telefono), correo: txt(p.correo), zona: zona(p.zona),
        banco: txt(p.banco), tipo_cuenta: txt(p.tipoCuenta),
        cuenta_bancaria: txt(p.cuentaBancaria),
        activo: p.activo === undefined ? true : bool(p.activo),
        requiere_revision: false, sp_id: p.sp_id,
      });
    }
    await insertar(cliente, 'proveedores',
      ['nit','nit_original','razon_social','nombre_comercial','regimen','municipio','direccion',
       'telefono','correo','zona','banco','tipo_cuenta','cuenta_bancaria','activo','requiere_revision','sp_id'],
      provFilas, { conflicto: 'nit', devolver: 'nit, sp_id' });
    const nitsEnBase = new Set(
      (await cliente.query('SELECT nit FROM erp.proveedores')).rows.map(r => r.nit));
    anotar('proveedores', nitsEnBase.size);

    /** Resuelve el NIT de un documento; crea el proveedor si falta. */
    const proveedoresCreados = [];
    async function resolverProveedor(valorNit, valorNombre) {
      const nit = normNit(valorNit);
      if (!nit) return null;
      if (nitsEnBase.has(nit)) return nit;
      await cliente.query(
        `INSERT INTO erp.proveedores (nit, nit_original, razon_social, activo, requiere_revision)
         VALUES ($1, $2, $3, false, true) ON CONFLICT (nit) DO NOTHING`,
        [nit, txt(valorNit), txt0(valorNombre) || '(sin nombre)']);
      nitsEnBase.add(nit);
      proveedoresCreados.push(`${nit} — ${txt0(valorNombre) || '?'}`);
      return nit;
    }

    // ── 3. Insumos ────────────────────────────────────────────────────────
    // nombre_norm es columna generada, así que no se envía.
    const insumosVistos = new Map();
    for (const it of datos.Insumos) {
      const nombre = txt(it.nombre);
      if (!nombre) { avisar(`Insumo sp_id=${it.sp_id} sin nombre: omitido`); continue; }
      const clave = norm(nombre);
      if (insumosVistos.has(clave)) {
        avisar(`Insumo "${nombre}": sp_id=${insumosVistos.get(clave).sp_id} reemplazado por el más reciente sp_id=${it.sp_id}`);
      }
      const sin = txt0(it.sinonimos);
      insumosVistos.set(clave, {
        nombre, categoria: txt(it.categoria), subcategoria: txt(it.subcategoria),
        unidad: txt(it.unidadEstandar) || txt(it.unidad),
        sinonimos: sin ? sin.split(/\s*[,;|]\s*/).filter(Boolean) : [],
        activo: it.activo === undefined ? true : bool(it.activo),
        sp_id: it.sp_id,
      });
    }
    const idInsumo = await insertar(cliente, 'insumos',
      ['nombre','categoria','subcategoria','unidad','sinonimos','activo','sp_id'],
      [...insumosVistos.values()]);
    anotar('insumos', idInsumo.size);

    // ── 4. Usuarios ───────────────────────────────────────────────────────
    // Gana la fila MÁS RECIENTE, igual que bulkUpsertUsuarios() en db.js, que
    // hace upsert por correo recorriendo la lista en orden. Con la regla
    // contraria el import se quedaba con estados viejos: lfelizzola tiene 8
    // filas y las primeras dicen admin mientras la última dice operador, así
    // que "gana la primera" concedía permisos que el registro vigente no da.
    const correosVistos = new Map();
    for (const u of datos.UsuariosERP) {
      const email = txt0(u.email).toLowerCase();
      if (!email || !email.includes('@')) {
        avisar(`Usuario sp_id=${u.sp_id} con correo inválido ("${txt0(u.email)}"): omitido`);
        continue;
      }
      const previo = correosVistos.get(email);
      if (previo) {
        const cambio = previo.rol !== (txt0(u.rol) || 'operador') || previo.activo !== bool(u.activo);
        avisar(
          `Usuario ${email}: sp_id=${previo.sp_id} (${previo.rol}${previo.activo ? '' : ', inactivo'}) ` +
          `reemplazado por el más reciente sp_id=${u.sp_id} (${txt0(u.rol) || 'operador'}${bool(u.activo) ? '' : ', inactivo'})` +
          (cambio ? ' ← cambia rol o estado' : ''));
      }
      correosVistos.set(email, {
        email, nombre: txt0(u.nombre), cargo: txt0(u.cargo),
        rol: ['admin','operador'].includes(txt0(u.rol)) ? txt0(u.rol) : 'operador',
        activo: bool(u.activo), sp_id: u.sp_id,
      });
    }

    // Un mismo correo con NOMBRES distintos no es un duplicado: son dos
    // personas compartiendo un login, y el que quede define a quién se le
    // atribuyen los documentos en creadoPor.
    const nombresPorCorreo = new Map();
    for (const u of datos.UsuariosERP) {
      const email = txt0(u.email).toLowerCase();
      const nombre = txt0(u.nombre);
      if (!email || !nombre) continue;
      if (!nombresPorCorreo.has(email)) nombresPorCorreo.set(email, new Set());
      nombresPorCorreo.get(email).add(nombre);
    }
    for (const [email, nombres] of nombresPorCorreo) {
      if (nombres.size > 1) {
        avisar(`⚠ ${email} aparece con ${nombres.size} nombres distintos (${[...nombres].join(' / ')}). Si son dos personas, necesitan correos separados.`);
      }
    }

    // El conflicto va contra el CORREO, no contra sp_id: el correo es la clave
    // real del usuario y es lo que tiene índice único. Con ON CONFLICT (sp_id),
    // reimportar después de que una persona cambia de fila en SharePoint choca
    // contra usuarios_email_key en vez de actualizar la que ya está.
    const idUsuario = await insertar(cliente, 'usuarios',
      ['email','nombre','cargo','rol','activo','sp_id'], [...correosVistos.values()],
      { conflicto: 'email', devolver: 'id, email AS sp_id' });
    anotar('usuarios', idUsuario.size);

    // ── 5. Configuración ──────────────────────────────────────────────────
    const configFilas = datos.ConfiguracionApp
      .filter(c => txt(c.clave))
      .map(c => ({
        clave: txt(c.clave), valor: String(c.valorJson ?? ''),
        descripcion: txt(c.descripcion), sp_id: c.sp_id,
      }));
    await insertar(cliente, 'configuracion',
      ['clave','valor','descripcion','sp_id'], configFilas,
      { conflicto: 'clave', devolver: 'clave, sp_id' });
    anotar('configuracion', configFilas.length);

    console.log('\nCargando documentos...');

    // ── 6. Requerimientos ─────────────────────────────────────────────────
    const reqFilas = [];
    for (const r of datos.Requerimientos) {
      reqFilas.push({
        consecutivo: txt0(r.consecutivo), consecutivo_sistema: txt(r.consecutivoSistema),
        proyecto_id: await resolverProyecto(r.proyecto),
        fecha_solicitud: ts(r.fechaSolicitud), solicitante: txt(r.solicitante),
        estado: txt0(r.estado) || 'pendiente',
        origen_correo_id: txt(r.origenCorreoId), adjunto_url: txt(r.adjuntoUrl),
        bloqueado_por: txt(r.bloqueadoPor), bloqueado_hasta: ts(r.bloqueadoHasta),
        notas: txt(r.notas), sp_id: r.sp_id,
      });
    }
    const idReq = await insertar(cliente, 'requerimientos',
      ['consecutivo','consecutivo_sistema','proyecto_id','fecha_solicitud','solicitante','estado',
       'origen_correo_id','adjunto_url','bloqueado_por','bloqueado_hasta','notas','sp_id'], reqFilas);
    anotar('requerimientos', idReq.size);

    const reqItems = [];
    for (const r of datos.Requerimientos) {
      const docId = idReq.get(r.sp_id);
      if (!docId) continue;
      let its = [];
      try { its = JSON.parse(r.itemsJson || '[]'); } catch {}
      if (!Array.isArray(its)) its = [];
      let linea = 0;
      for (const it of its) {
        const insumo = txt(it.insumo) || txt(it.descripcion);
        if (!insumo) { avisar(`Requerimiento sp_id=${r.sp_id}: ítem sin insumo, omitido`); continue; }
        reqItems.push({
          requerimiento_id: docId, linea: ++linea, insumo,
          cantidad: num(it.cantidad), unidad: txt0(it.unidad) || 'UND',
          necesidad: txt(it.necesidad), posible_proveedor: txt(it.posibleProveedor),
          homologado_con: txt(it.homologadoCon), descartado: bool(it.descartado),
          consulta: it.consulta ? JSON.stringify(it.consulta) : null,
        });
      }
    }
    anotar('requerimiento_items', await insertarHijos(cliente, 'requerimiento_items',
      ['requerimiento_id','linea','insumo','cantidad','unidad','necesidad','posible_proveedor',
       'homologado_con','descartado','consulta'], reqItems));

    // ── 7. Órdenes de compra ──────────────────────────────────────────────
    const ocFilas = [];
    for (const o of datos.OrdenesCompra) {
      ocFilas.push({
        numero_oc: txt(o.numeroOC),                       // '' → NULL
        requerimiento_id: idReq.get(txt0(o.requerimientoId)) ?? null,
        requerimiento_origen: txt(o.requerimientoOrigen),
        cotizacion_id: txt(o.cotizacionId),
        proveedor_nit: await resolverProveedor(o.proveedorNit, o.proveedorNombre),
        proyecto_id: await resolverProyecto(o.proyecto),
        subtotal: num(o.subtotal), iva: num(o.iva), total: num(o.total),
        estado: txt0(o.estado) || 'borrador',
        tipo_gasto: txt(o.tipoGasto), lugar_entrega: txt(o.lugarEntrega),
        fecha_entrega_prevista: ts(o.fechaEntregaPrevista),
        condiciones_comerciales: txt(o.condicionesComerciales),
        observaciones: txt(o.observaciones),
        creado_por: txt(o.creadoPor), fecha_creacion: ts(o.fechaCreacion) || new Date().toISOString(),
        aprobado_por: txt(o.aprobadoPor), fecha_aprobacion: ts(o.fechaAprobacion),
        anulado_por: txt(o.anuladoPor), fecha_anulacion: ts(o.fechaAnulacion),
        motivo_anulacion: txt(o.motivoAnulacion),
        pagado: bool(o.pagado), pagado_por: txt(o.pagadoPor), fecha_pago: ts(o.fechaPago),
        entregado: bool(o.entregado), entregado_por: txt(o.entregadoPor), fecha_entrega: ts(o.fechaEntrega),
        pdf_url: txt(o.pdfUrl), xlsx_url: txt(o.xlsxUrl),
        solicitud_tesoreria_id: txt(o.solicitudTesoreriaId),
        solicitud_tesoreria_por: txt(o.solicitudTesoreriaPor),
        fecha_solicitud_tesoreria: ts(o.fechaSolicitudTesoreria),
        sp_id: o.sp_id,
      });
    }
    const idOC = await insertar(cliente, 'ordenes_compra',
      ['numero_oc','requerimiento_id','requerimiento_origen','cotizacion_id','proveedor_nit','proyecto_id',
       'subtotal','iva','total','estado','tipo_gasto','lugar_entrega','fecha_entrega_prevista',
       'condiciones_comerciales','observaciones','creado_por','fecha_creacion','aprobado_por',
       'fecha_aprobacion','anulado_por','fecha_anulacion','motivo_anulacion','pagado','pagado_por',
       'fecha_pago','entregado','entregado_por','fecha_entrega','pdf_url','xlsx_url',
       'solicitud_tesoreria_id','solicitud_tesoreria_por','fecha_solicitud_tesoreria','sp_id'], ocFilas);
    anotar('ordenes_compra', idOC.size);

    // Ítems de OC: acá se unifica "descripcion" con "insumo".
    const ocItems = [];
    let itemsInsumoClave = 0;
    for (const o of datos.OrdenesCompra) {
      const docId = idOC.get(o.sp_id);
      if (!docId) continue;
      let its = [];
      try { its = JSON.parse(o.itemsJson || '[]'); } catch {}
      if (!Array.isArray(its)) its = [];
      let linea = 0;
      for (const it of its) {
        const desc = txt(it.descripcion) || txt(it.insumo);
        if (!desc) { avisar(`OC sp_id=${o.sp_id}: ítem sin descripción, omitido`); continue; }
        if (!txt(it.descripcion) && txt(it.insumo)) itemsInsumoClave++;
        ocItems.push({
          orden_compra_id: docId, linea: ++linea, descripcion: desc,
          insumo_original: txt(it.insumoOriginal),
          cantidad: num(it.cantidad), unidad: txt0(it.unidad) || 'UND',
          precio_unitario: num(it.precioUnitario),
          descuento_pct: Math.min(100, Math.max(0, num(it.descuentoPct))),
          iva_pct: Math.min(100, Math.max(0, num(it.ivaPct))),
        });
      }
    }
    anotar('orden_compra_items', await insertarHijos(cliente, 'orden_compra_items',
      ['orden_compra_id','linea','descripcion','insumo_original','cantidad','unidad',
       'precio_unitario','descuento_pct','iva_pct'], ocItems));
    if (itemsInsumoClave) {
      avisar(`${itemsInsumoClave} ítem(s) de OC traían el nombre en la clave "insumo" en vez de "descripcion": unificados.`);
    }

    // ── 8. Órdenes de servicio ────────────────────────────────────────────
    const osFilas = [];
    for (const o of datos.OrdenesServicio) {
      osFilas.push({
        numero_os: txt(o.numeroOS),
        requerimiento_id: idReq.get(txt0(o.requerimientoId)) ?? null,
        proyecto_id: await resolverProyecto(o.proyecto),
        proveedor_nit: await resolverProveedor(o.proveedorNit, o.proveedorNombre),
        tipo_servicio: txt(o.tipoServicio), clausulas: txt(o.clausulas),
        oferta_economica_ref: txt(o.ofertaEconomicaRef),
        oferta_economica_condiciones: txt(o.ofertaEconomicaCondiciones),
        valor: num(o.valor), iva: num(o.iva), total: num(o.total),
        tipo_contrato: ['IVA_PLENO','AIU'].includes(txt0(o.tipoContrato)) ? txt0(o.tipoContrato) : 'IVA_PLENO',
        aiu_a: num(o.aiuA), aiu_i: num(o.aiuI), aiu_u: num(o.aiuU),
        estado: txt0(o.estado) || 'borrador', tipo_gasto: txt(o.tipoGasto),
        lugar_prestacion: txt(o.lugarPrestacion),
        fecha_inicio: ts(o.fechaInicio), fecha_fin: ts(o.fechaFin),
        condiciones_comerciales: txt(o.condicionesComerciales),
        observaciones: txt(o.observaciones),
        creado_por: txt(o.creadoPor), fecha_creacion: ts(o.fechaCreacion) || new Date().toISOString(),
        aprobado_por: txt(o.aprobadoPor), fecha_aprobacion: ts(o.fechaAprobacion),
        anulado_por: txt(o.anuladoPor), fecha_anulacion: ts(o.fechaAnulacion),
        motivo_anulacion: txt(o.motivoAnulacion),
        pagado: bool(o.pagado), pagado_por: txt(o.pagadoPor), fecha_pago: ts(o.fechaPago),
        cumplido: bool(o.cumplido), cumplido_por: txt(o.cumplidoPor), fecha_cumplido: ts(o.fechaCumplido),
        pdf_url: txt(o.pdfUrl), sp_id: o.sp_id,
      });
    }
    const idOS = await insertar(cliente, 'ordenes_servicio',
      ['numero_os','requerimiento_id','proyecto_id','proveedor_nit','tipo_servicio','clausulas',
       'oferta_economica_ref','oferta_economica_condiciones','valor','iva','total','tipo_contrato',
       'aiu_a','aiu_i','aiu_u','estado','tipo_gasto','lugar_prestacion','fecha_inicio','fecha_fin',
       'condiciones_comerciales','observaciones','creado_por','fecha_creacion','aprobado_por',
       'fecha_aprobacion','anulado_por','fecha_anulacion','motivo_anulacion','pagado','pagado_por',
       'fecha_pago','cumplido','cumplido_por','fecha_cumplido','pdf_url','sp_id'], osFilas);
    anotar('ordenes_servicio', idOS.size);

    const osItems = [];
    for (const o of datos.OrdenesServicio) {
      const docId = idOS.get(o.sp_id);
      if (!docId) continue;
      let its = [];
      try { its = JSON.parse(o.itemsJson || '[]'); } catch {}
      if (!Array.isArray(its)) its = [];
      let linea = 0;
      for (const it of its) {
        const desc = txt(it.descripcion) || txt(it.insumo);
        if (!desc) { avisar(`OS sp_id=${o.sp_id}: ítem sin descripción, omitido`); continue; }
        osItems.push({
          orden_servicio_id: docId, linea: ++linea, descripcion: desc,
          cantidad: num(it.cantidad), unidad: txt0(it.unidad) || 'GLB',
          precio_unitario: num(it.precioUnitario),
          iva_pct: Math.min(100, Math.max(0, num(it.ivaPct))),
        });
      }
    }
    anotar('orden_servicio_items', await insertarHijos(cliente, 'orden_servicio_items',
      ['orden_servicio_id','linea','descripcion','cantidad','unidad','precio_unitario','iva_pct'], osItems));

    // ── 9. Remisiones ─────────────────────────────────────────────────────
    const remFilas = [];
    for (const r of datos.Remisiones) {
      const numero = txt(r.numero);
      if (!numero) { avisar(`Remisión sp_id=${r.sp_id} sin número: omitida`); continue; }
      remFilas.push({
        numero, fecha: ts(r.fecha), proyecto_id: await resolverProyecto(r.proyecto),
        observaciones: txt(r.observaciones),
        responsable_entrega: txt(r.responsableEntrega),
        responsable_recepcion: txt(r.responsableRecepcion),
        lugar_entrega: txt(r.lugarEntrega),
        estado: txt0(r.estado) || 'activa', motivo_anulacion: txt(r.motivoAnulacion),
        alertas: txt(r.alertas), creado_por: txt(r.creadoPor),
        fecha_creacion: ts(r.fechaCreacion) || new Date().toISOString(),
        sp_id: r.sp_id,
      });
    }
    const idRem = await insertar(cliente, 'remisiones',
      ['numero','fecha','proyecto_id','observaciones','responsable_entrega','responsable_recepcion',
       'lugar_entrega','estado','motivo_anulacion','alertas','creado_por','fecha_creacion','sp_id'], remFilas);
    anotar('remisiones', idRem.size);

    // ocIds era un array JSON de ids de SharePoint → tabla de unión.
    const remOC = [];
    const remItems = [];
    for (const r of datos.Remisiones) {
      const docId = idRem.get(r.sp_id);
      if (!docId) continue;

      let ids = [];
      try { ids = JSON.parse(r.ocIds || '[]'); } catch {}
      if (!Array.isArray(ids)) ids = [];
      const yaVistas = new Set();
      for (const spOC of ids.map(String)) {
        const ocId = idOC.get(spOC);
        if (!ocId) { avisar(`Remisión sp_id=${r.sp_id}: referencia a OC sp_id=${spOC} que no existe`); continue; }
        if (yaVistas.has(ocId)) continue;   // la PK compuesta no admite repetidos
        yaVistas.add(ocId);
        remOC.push({ remision_id: docId, orden_compra_id: ocId });
      }

      let its = [];
      try { its = JSON.parse(r.itemsJson || '[]'); } catch {}
      if (!Array.isArray(its)) its = [];
      let linea = 0;
      for (const it of its) {
        const desc = txt(it.descripcion) || txt(it.insumo);
        if (!desc) { avisar(`Remisión sp_id=${r.sp_id}: ítem sin descripción, omitido`); continue; }
        remItems.push({
          remision_id: docId, linea: ++linea, descripcion: desc,
          cantidad: num(it.cantidad), unidad: txt0(it.unidad) || 'UND',
          observacion: txt(it.observacion),
        });
      }
    }
    anotar('remision_ordenes', await insertarHijos(cliente, 'remision_ordenes',
      ['remision_id','orden_compra_id'], remOC));
    anotar('remision_items', await insertarHijos(cliente, 'remision_items',
      ['remision_id','linea','descripcion','cantidad','unidad','observacion'], remItems));

    // ── 10. Movimientos de inventario ─────────────────────────────────────
    const movFilas = [];
    for (const m of datos.MovimientosInventario) {
      const tipo = txt0(m.tipo);
      if (!['entrada','salida'].includes(tipo)) {
        avisar(`Movimiento sp_id=${m.sp_id} con tipo inválido ("${tipo}"): omitido`);
        continue;
      }
      const insumo = txt(m.insumo);
      if (!insumo) { avisar(`Movimiento sp_id=${m.sp_id} sin insumo: omitido`); continue; }
      movFilas.push({
        tipo, fecha: ts(m.fecha) || ts(m.fechaCreacion) || new Date().toISOString(),
        proyecto_id: await resolverProyecto(m.proyecto),
        orden_compra_id: idOC.get(txt0(m.ocId)) ?? null,
        insumo, unidad: txt0(m.unidad) || 'UND',
        cantidad: Math.abs(num(m.cantidad)),   // el signo lo lleva "tipo"
        precio_unitario: num(m.precioUnitario),
        responsable: txt(m.responsable), notas: txt(m.notas),
        estado: txt0(m.estado) || 'activo',
        documento_ref: txt(m.documentoRef),
        estado_doc: txt0(m.estadoDoc) || 'borrador',
        batch_id: txt(m.batchId), creado_por: txt(m.creadoPor),
        fecha_creacion: ts(m.fechaCreacion) || new Date().toISOString(),
        sp_id: m.sp_id,
      });
    }
    const idMov = await insertar(cliente, 'movimientos_inventario',
      ['tipo','fecha','proyecto_id','orden_compra_id','insumo','unidad','cantidad','precio_unitario',
       'responsable','notas','estado','documento_ref','estado_doc','batch_id','creado_por',
       'fecha_creacion','sp_id'], movFilas);
    anotar('movimientos_inventario', idMov.size);

    // ── 11. Historial de precios ──────────────────────────────────────────
    const hpFilas = [];
    let sinFecha = 0;
    for (const h of datos.HistorialPrecios) {
      const insumo = txt(h.insumo);
      if (!insumo) { avisar(`Historial sp_id=${h.sp_id} sin insumo: omitido`); continue; }
      const original = txt(h.fecha);
      const fecha = fechaSuelta(original);
      if (original && !fecha) sinFecha++;
      const cant = num(h.cantidad);
      const precio = num(h.precioUnitario ?? h.precio);
      hpFilas.push({
        proyecto_id: await resolverProyecto(h.proyecto),
        numero_compra: txt(h.numeroCompra ?? h.documento),
        tipo_compra: txt(h.tipoCompra),
        insumo, cantidad: cant, precio_unitario: precio,
        // valorTotal en SharePoint podía discrepar de cantidad × precio;
        // cuando falta se calcula.
        valor_total: h.valorTotal !== undefined ? num(h.valorTotal) : precio * cant,
        fecha, fecha_texto: original,
        proveedor_nit: await resolverProveedor(h.nitProveedor ?? h.nit, h.nombreProveedor ?? h.proveedor),
        proveedor_nombre: txt(h.nombreProveedor ?? h.proveedor),
        estado_compra: txt(h.estadoCompra), forma_pago: txt(h.formaPago),
        anticipo: num(h.anticipo), zona: zona(h.zona),
        sp_id: h.sp_id,
      });
    }
    const idHP = await insertar(cliente, 'historial_precios',
      ['proyecto_id','numero_compra','tipo_compra','insumo','cantidad','precio_unitario','valor_total',
       'fecha','fecha_texto','proveedor_nit','proveedor_nombre','estado_compra','forma_pago',
       'anticipo','zona','sp_id'], hpFilas);
    anotar('historial_precios', idHP.size);
    if (sinFecha) avisar(`${sinFecha} fila(s) de historial con fecha no interpretable: fecha=NULL, fecha_texto conserva el original.`);

    // ── 12. Contadores ────────────────────────────────────────────────────
    const contadores = (await cliente.query('SELECT * FROM erp.sincronizar_contadores()')).rows;

    // ── Avisos acumulados de creación automática ──────────────────────────
    if (proyectosCreados.length) {
      avisar(`${proyectosCreados.length} proyecto(s) creados con requiere_revision=true: ${proyectosCreados.slice(0,5).join(' · ')}${proyectosCreados.length>5?' …':''}`);
    }
    if (proveedoresCreados.length) {
      avisar(`${proveedoresCreados.length} proveedor(es) creados con requiere_revision=true: ${proveedoresCreados.slice(0,5).join(' · ')}${proveedoresCreados.length>5?' …':''}`);
    }
    if (zonasDesconocidas.size) {
      avisar(`Zona(s) fuera del catálogo, guardadas como NULL: ${[...zonasDesconocidas].join(', ')}`);
    }

    // ── Cuadre contra el origen ───────────────────────────────────────────
    const sumaOrigen = datos.OrdenesCompra.reduce((s, o) => s + Math.round(num(o.total) * 100), 0) / 100;
    const sumaDestino = Number((await cliente.query('SELECT COALESCE(sum(total),0) s FROM erp.ordenes_compra')).rows[0].s);
    const dif = Math.abs(sumaOrigen - sumaDestino);

    if (DRY_RUN) {
      await cliente.query('ROLLBACK');
      console.log('\n  ↺ ENSAYO: todo revertido.');
    } else {
      await cliente.query('COMMIT');
    }

    // ── Reporte ───────────────────────────────────────────────────────────
    console.log('\n════ Resultado ══════════════════════════════════════════\n');
    for (const [t, n] of reporte.tablas) {
      console.log(`  ${t.padEnd(24)} ${String(n).padStart(6)}`);
    }

    console.log('\n  Consecutivos:');
    for (const c of contadores) console.log(`    ${c.contador.padEnd(18)} ${c.ultimo_numero}`);

    console.log('\n  Cuadre de dinero (total de OC):');
    console.log(`    origen  ${sumaOrigen.toLocaleString('es-CO')}`);
    console.log(`    destino ${sumaDestino.toLocaleString('es-CO')}`);
    console.log(`    ${dif < 1 ? '✓ cuadra' : '⚠ diferencia de ' + dif.toFixed(2)} (se admite < $1 por el redondeo a 2 decimales)`);

    if (reporte.avisos.length) {
      console.log(`\n  ${reporte.avisos.length} aviso(s):\n`);
      for (const a of reporte.avisos) console.log(`    · ${a}`);
    }

    console.log('\n  Siguiente paso: revisar las filas marcadas para revisión —');
    console.log("    SELECT codigo FROM erp.proyectos WHERE requiere_revision;");
    console.log("    SELECT nit, razon_social FROM erp.proveedores WHERE requiere_revision;\n");

  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error('\n✖ El import falló y se revirtió por completo. La base quedó como estaba.\n');
    console.error(`  ${err.message}`);
    if (err.detail)     console.error(`  detalle:    ${err.detail}`);
    if (err.constraint) console.error(`  constraint: ${err.constraint}`);
    if (err.table)      console.error(`  tabla:      ${err.table}`);
    if (err.constraint && /numero_key/.test(err.constraint)) {
      console.error('\n  Es un número de documento repetido. Corre "npm run revisar-listas"');
      console.error('  para ver cuáles y corrígelos en SharePoint antes de reintentar.');
    }
    process.exitCode = 1;
  } finally {
    await cliente.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('✖', err.message);
  process.exit(1);
});
