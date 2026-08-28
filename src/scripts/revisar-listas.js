'use strict';
/**
 * revisar-listas.js — Chequeo previo al import de las 11 listas de SharePoint.
 *
 *   npm run revisar-listas              lee de SharePoint (la fuente de verdad)
 *   npm run revisar-listas -- --cache   lee del SQLite local (rápido, puede estar viejo)
 *   npm run revisar-listas -- --detalle muestra todas las filas de cada hallazgo
 *
 * SharePoint no valida nada: no tiene unicidad, ni llaves foráneas, ni tipos
 * estrictos. Las migraciones sí. Este script aplica por adelantado las mismas
 * reglas que el esquema de Postgres va a exigir y lista qué filas las rompen,
 * para poder corregirlas ANTES del import y no descubrirlas con un error a
 * mitad de la carga.
 *
 * ── Por qué lee de SharePoint y no del caché ───────────────────────────────
 * Porque es la misma fuente que usa importar-listas.js. Cuando este chequeo
 * leía del caché podía dar verde sobre datos viejos mientras el import fallaba
 * contra los datos reales: el caché tenía 276 órdenes de compra cuando
 * SharePoint ya tenía 282, así que 6 nunca se revisaban. Un chequeo que valida
 * una fuente distinta a la que se va a importar no sirve de compuerta.
 *
 * --cache sigue disponible para una mirada rápida sin gastar llamadas a Graph,
 * pero no reemplaza la corrida real.
 *
 * Salida: código 0 si no hay bloqueadores, 1 si hay algo que rompería el import.
 */

require('dotenv').config();

const path     = require('path');
const Database = require('better-sqlite3');

const CACHE   = process.argv.includes('--cache');
const DETALLE = process.argv.includes('--detalle');
const TOPE    = DETALLE ? Infinity : 8;

// ── Mismas normalizaciones que erp.norm() y erp.norm_nit() ──────────────────

function norm(s) {
  return String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9/-]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const txtNum = (v) => String(v ?? '').trim() || '(sin número)';

function normNit(s) {
  return String(s || '').replace(/\.0+$/, '').replace(/[^0-9A-Za-z-]/g, '');
}

function items(doc, campo = 'itemsJson') {
  try {
    const arr = JSON.parse(doc[campo] || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ── Lectura: SharePoint (por defecto) o caché SQLite (--cache) ──────────────

/** Campos que SharePoint agrega a cada item y que no son datos del negocio. */
const RUIDO_SP = /^(@odata|ContentType|Modified|Created|AuthorLookupId|EditorLookupId|_UIVersionString|Attachments|Edit|ItemChildCount|FolderChildCount|_Compliance|AppAuthorLookupId|AppEditorLookupId|Title|LinkTitle|ID)/;

function limpiar(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!RUIDO_SP.test(k)) out[k] = v;
  }
  return out;
}

async function cargarDeSharePoint() {
  const g = require('../graphStorage');
  const site = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);
  const listas = await g.getLists(site.id);
  const porNombre = new Map(listas.map(l => [l.displayName, l.id]));

  async function leer(nombre) {
    const listId = porNombre.get(nombre);
    if (!listId) return [];
    const its = await g.getListItems(site.id, listId);
    return its.map(it => ({ sp_id: String(it.id), ...limpiar(it.fields) }));
  }

  const [proyectos, proveedores, insumos, usuarios, req, oc, os, rem, mov, hp] = await Promise.all([
    leer('Proyectos'), leer('Proveedores'), leer('Insumos'), leer('UsuariosERP'),
    leer('Requerimientos'), leer('OrdenesCompra'), leer('OrdenesServicio'),
    leer('Remisiones'), leer('MovimientosInventario'), leer('HistorialPrecios'),
  ]);

  return {
    origen: `SharePoint · ${process.env.SHAREPOINT_SITE_PATH}`,
    catalogo: {
      // El chequeo compara contra "nombre"; en SharePoint la clave del
      // proyecto es "codigo" y la del proveedor "razonSocial".
      proyectos:   proyectos.map(p => ({ sp_id: p.sp_id, nombre: p.codigo || p.nombre, zona: p.zona, activo: p.activo })),
      proveedores: proveedores.map(p => ({ sp_id: p.sp_id, nit: p.nit, nombre: p.razonSocial || p.nombre })),
      insumos:     insumos.map(i => ({ sp_id: i.sp_id, nombre: i.nombre })),
      usuarios:    usuarios.map(u => ({ sp_id: u.sp_id, email: u.email, rol: u.rol })),
    },
    req, oc, os, rem, mov,
    // precio y nit con los nombres que usa el resto del script.
    hp: hp.map(h => ({ ...h, precio: h.precioUnitario ?? h.precio, nit: h.nitProveedor ?? h.nit })),
  };
}

function cargarDeCache() {
  const ruta = process.env.SQLITE_PATH || path.join(__dirname, '../../data/local.db');
  const db = new Database(ruta, { readonly: true });

  const docs = (tabla) => db.prepare(`SELECT sp_id, data FROM ${tabla}`).all().map(r => {
    let o = {};
    try { o = JSON.parse(r.data); } catch {}
    return { sp_id: r.sp_id, ...limpiar(o) };
  });

  return {
    origen: `caché SQLite · ${ruta}`,
    catalogo: {
      proyectos:   db.prepare('SELECT sp_id, nombre, zona, activo FROM proyectos').all(),
      proveedores: db.prepare('SELECT sp_id, nit, nombre FROM proveedores').all(),
      insumos:     db.prepare('SELECT sp_id, nombre FROM insumos').all(),
      usuarios:    db.prepare('SELECT sp_id, email, rol FROM usuarios').all(),
    },
    req: docs('requerimientos'),
    oc:  docs('ordenes_compra'),
    os:  docs('ordenes_servicio'),
    rem: docs('remisiones'),
    mov: docs('movimientos_inventario'),
    hp:  db.prepare('SELECT * FROM historial_precios').all(),
  };
}

// ── Acumulador de hallazgos ─────────────────────────────────────────────────

const hallazgos = [];

function reportar(nivel, titulo, filas, comoArreglar) {
  if (!filas.length) return;
  hallazgos.push({ nivel, titulo, filas, comoArreglar });
}

async function main() {
  const datos = CACHE ? cargarDeCache() : await cargarDeSharePoint();
  const { catalogo, req, oc, os, rem, mov, hp, origen } = datos;
  const DB_PATH = origen;

  const codigosProyecto = new Set(catalogo.proyectos.map(p => norm(p.nombre)));
  const nitsCatalogo    = new Set(catalogo.proveedores.map(p => normNit(p.nit)).filter(Boolean));


  // ═══ 1. Números de documento duplicados (rompen un índice UNIQUE) ═══════════

  function duplicados(lista, campoNumero, etiqueta) {
    const porNumero = new Map();
    for (const d of lista) {
      const v = String(d[campoNumero] || '').trim();
      if (!v) continue;
      if (!porNumero.has(v)) porNumero.set(v, []);
      porNumero.get(v).push(d);
    }
    const salida = [];
    for (const [numero, grupo] of porNumero) {
      if (grupo.length < 2) continue;
      const vigentes = grupo.filter(d => !['anulada', 'anulado'].includes(d.estado));
      salida.push(
        `${etiqueta} ${numero} — ${grupo.length} documentos ` +
        `(${vigentes.length} vigente(s), ${grupo.length - vigentes.length} anulado(s)): ` +
        grupo.map(d => `sp_id=${d.sp_id}/${d.estado}`).join('  ')
      );
    }
    return salida;
  }


  reportar(
    'bloqueador',
    'Números de orden de compra repetidos',
    duplicados(oc, 'numeroOC', 'numeroOC'),
    'El índice ordenes_compra_numero_key los rechaza. Casi todos son una orden anulada\n' +
    '  y su reemplazo, que heredó el número por el bug de contador.js. Decide una regla y\n' +
    '  aplícala en SharePoint antes de importar: lo habitual es que el número se quede con\n' +
    '  el documento vigente y las anuladas pasen a "0036-A", "0036-B".'
  );

  reportar(
    'bloqueador',
    'Números de orden de servicio repetidos',
    duplicados(os, 'numeroOS', 'numeroOS'),
    'Misma causa y misma salida que en las OC.'
  );

  reportar(
    'bloqueador',
    'Números de remisión repetidos',
    duplicados(rem, 'numero', 'numero'),
    'Causa distinta: crearRemisionYGuardar() numera con (cantidad de remisiones + 1), así\n' +
    '  que dos remisiones creadas en el mismo segundo obtienen el mismo número. Renumera la\n' +
    '  más reciente al siguiente libre.'
  );

  // ═══ 2. Referencias que no resuelven (rompen una llave foránea) ═════════════
  // El import puede crear filas de catálogo marcadas requiere_revision=true para
  // no perder la referencia, así que esto es advertencia, no bloqueador.

  function proyectosHuerfanos(lista, etiqueta) {
    const faltan = new Map();
    for (const d of lista) {
      const p = String(d.proyecto || '').trim();
      if (!p) continue;
      if (codigosProyecto.has(norm(p))) continue;
      faltan.set(p, (faltan.get(p) || 0) + 1);
    }
    return [...faltan.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `"${p}" — ${n} ${etiqueta}`);
  }

  reportar(
    'aviso',
    'Proyectos referenciados que no están en el catálogo',
    [
      ...proyectosHuerfanos(oc,  'orden(es) de compra'),
      ...proyectosHuerfanos(os,  'orden(es) de servicio'),
      ...proyectosHuerfanos(req, 'requerimiento(s)'),
      ...proyectosHuerfanos(rem, 'remisión(es)'),
      ...proyectosHuerfanos(mov, 'movimiento(s)'),
    ],
    'El import los crea en erp.proyectos con activo=false y requiere_revision=true, así que\n' +
    '  la carga no falla. Después hay que revisarlos: varios son el mismo proyecto escrito de\n' +
    '  otra forma y deberían fusionarse, no quedar como proyectos nuevos.'
  );

  const nitsHuerfanos = new Map();
  for (const [lista, etiqueta] of [[oc, 'OC'], [os, 'OS']]) {
    for (const d of lista) {
      const nit = normNit(d.proveedorNit);
      if (!nit || nitsCatalogo.has(nit)) continue;
      const clave = `${nit} (${String(d.proveedorNombre || '?').slice(0, 34)})`;
      nitsHuerfanos.set(clave, (nitsHuerfanos.get(clave) || 0) + 1);
    }
    void etiqueta;
  }

  reportar(
    'aviso',
    'NIT referenciados que no están en el catálogo de proveedores',
    [...nitsHuerfanos.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} — ${n} documento(s)`),
    'Igual que los proyectos: el import los crea con requiere_revision=true. Ojo que la\n' +
    '  normalización de NIT ya resuelve la mayoría de los casos ("800.118.549-1" y\n' +
    '  "800,118,549-1" colapsan en el mismo), así que los que queden acá son reales.'
  );

  // ═══ 3. Filas de catálogo que colapsan al normalizar ════════════════════════

  function colisiones(filas, fn, etiqueta) {
    const m = new Map();
    for (const f of filas) {
      const k = fn(f);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return [...m.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([k, g]) => `${etiqueta} ${k} ← ${g.map(f => `sp_id=${f.sp_id} "${String(f.nombre || f.nit || '').trim()}"`).join('  |  ')}`);
  }

  reportar(
    'aviso',
    'Proveedores que colapsan en un solo NIT',
    colisiones(catalogo.proveedores, p => normNit(p.nit), 'NIT'),
    'Es el mismo proveedor dado de alta dos veces. En Postgres el NIT es la clave primaria,\n' +
    '  así que el import los fusiona y conserva los datos de la primera fila. Verifica que la\n' +
    '  fila que gana sea la que tiene los datos bancarios correctos.'
  );

  reportar(
    'bloqueador',
    'Proyectos que colapsan en un solo código',
    colisiones(catalogo.proyectos, p => norm(p.nombre), 'código'),
    'El índice proyectos_codigo_norm_key los rechaza. Unifica en SharePoint antes de importar.'
  );

  reportar(
    'bloqueador',
    'Insumos que colapsan en un solo nombre normalizado',
    colisiones(catalogo.insumos, i => norm(i.nombre), 'nombre'),
    'El índice insumos_nombre_norm_key los rechaza. Unifícalos y repunta lo que los referencie.'
  );

  // ═══ 4. Ítems sin descripción (rompen un CHECK NOT NULL/no vacío) ═══════════

  function itemsSinDescripcion(lista, etiqueta, claves) {
    const salida = [];
    for (const d of lista) {
      const its = items(d);
      its.forEach((it, i) => {
        const desc = claves.map(k => String(it[k] || '').trim()).find(Boolean);
        if (!desc) salida.push(`${etiqueta} sp_id=${d.sp_id} línea ${i + 1} sin descripción`);
      });
    }
    return salida;
  }

  reportar(
    'bloqueador',
    'Ítems sin descripción',
    [
      ...itemsSinDescripcion(oc,  'OC',           ['descripcion', 'insumo']),
      ...itemsSinDescripcion(os,  'OS',           ['descripcion']),
      ...itemsSinDescripcion(rem, 'Remisión',     ['descripcion']),
      ...itemsSinDescripcion(req, 'Requerimiento',['insumo', 'descripcion']),
    ],
    'La columna descripcion es NOT NULL y no admite cadena vacía: un ítem sin nombre es una\n' +
    '  línea que sale en blanco en el PDF. Complétalos o bórralos del documento.'
  );

  // ═══ 5. Estados fuera del conjunto permitido (rompen un CHECK) ══════════════

  const ESTADOS = {
    requerimientos:         ['pendiente', 'parcial', 'gestionado', 'cerrado', 'anulado'],
    ordenes_compra:         ['borrador', 'aprobada', 'anulada', 'pagada', 'entregada', 'finalizada'],
    ordenes_servicio:       ['borrador', 'aprobada', 'anulada', 'finalizada'],
    remisiones:             ['activa', 'anulada', 'requiere-reemplazo'],
    movimientos_inventario: ['activo', 'anulado'],
  };

  const estadosMalos = [];
  for (const [tabla, validos] of Object.entries(ESTADOS)) {
    const lista = { requerimientos: req, ordenes_compra: oc, ordenes_servicio: os,
                    remisiones: rem, movimientos_inventario: mov }[tabla];
    const vistos = new Map();
    for (const d of lista) {
      const e = d.estado;
      if (validos.includes(e)) continue;
      const k = `${tabla}.estado = ${e === undefined ? '(ausente)' : JSON.stringify(e)}`;
      vistos.set(k, (vistos.get(k) || 0) + 1);
    }
    for (const [k, n] of vistos) estadosMalos.push(`${k} — ${n} fila(s)`);
  }

  reportar(
    'bloqueador',
    'Estados fuera del conjunto permitido',
    estadosMalos,
    'Los CHECK de las migraciones de documentos e inventario los rechazan. Corrige el estado en SharePoint.'
  );

  // ═══ 6. Aprobadas sin número (rompen un CHECK) ══════════════════════════════

  reportar(
    'bloqueador',
    'Documentos aprobados o finalizados sin número asignado',
    [
      ...oc.filter(d => !['borrador', 'anulada'].includes(d.estado) && !String(d.numeroOC || '').trim())
           .map(d => `OC sp_id=${d.sp_id} estado=${d.estado} sin numeroOC`),
      ...os.filter(d => !['borrador', 'anulada'].includes(d.estado) && !String(d.numeroOS || '').trim())
           .map(d => `OS sp_id=${d.sp_id} estado=${d.estado} sin numeroOS`),
    ],
    'Un documento aprobado sin consecutivo no es rastreable. Asígnale número o pásalo a borrador.'
  );

  // ═══ 6b. Órdenes de servicio con fechas invertidas (rompen un CHECK) ════════

  reportar(
    'bloqueador',
    'Órdenes de servicio que terminan antes de empezar',
    os.filter(d => d.fechaInicio && d.fechaFin && new Date(d.fechaFin) < new Date(d.fechaInicio))
      .map(d => `OS ${txtNum(d.numeroOS)} (sp_id=${d.sp_id}, ${d.estado}): inicio ${String(d.fechaInicio).slice(0,10)}, fin ${String(d.fechaFin).slice(0,10)}`),
    'El CHECK ordenes_servicio_rango_fechas las rechaza. Es un error de digitación en una\n' +
    '  de las dos fechas; corrígela en SharePoint mirando cuál es la correcta.'
  );

  // ═══ 6c. Valores fuera de los conjuntos permitidos ══════════════════════════

  const fueraDeConjunto = [];

  for (const d of os) {
    const tc = String(d.tipoContrato ?? '').trim();
    if (tc && !['IVA_PLENO', 'AIU'].includes(tc)) {
      fueraDeConjunto.push(`OS sp_id=${d.sp_id}: tipoContrato = ${JSON.stringify(tc)}`);
    }
  }
  for (const d of mov) {
    const t = String(d.tipo ?? '').trim();
    if (!['entrada', 'salida'].includes(t)) {
      fueraDeConjunto.push(`Movimiento sp_id=${d.sp_id}: tipo = ${JSON.stringify(t)}`);
    }
    const ed = String(d.estadoDoc ?? '').trim();
    if (ed && !['borrador', 'aprobado', 'anulado'].includes(ed)) {
      fueraDeConjunto.push(`Movimiento sp_id=${d.sp_id}: estadoDoc = ${JSON.stringify(ed)}`);
    }
    if (Number(d.cantidad) < 0) {
      fueraDeConjunto.push(`Movimiento sp_id=${d.sp_id}: cantidad negativa (${d.cantidad}) — el signo lo lleva el tipo`);
    }
  }
  for (const u of catalogo.usuarios) {
    if (!String(u.email || '').includes('@')) {
      fueraDeConjunto.push(`Usuario sp_id=${u.sp_id}: correo sin @ (${JSON.stringify(u.email)})`);
    }
  }
  for (const p of catalogo.proveedores) {
    if (!normNit(p.nit)) {
      fueraDeConjunto.push(`Proveedor sp_id=${p.sp_id}: NIT vacío o sin dígitos (${JSON.stringify(p.nit)})`);
    }
  }
  for (const r of rem) {
    if (!String(r.numero ?? '').trim()) {
      fueraDeConjunto.push(`Remisión sp_id=${r.sp_id}: sin número`);
    }
  }
  for (const h of hp) {
    if (Number(h.precio) < 0) {
      fueraDeConjunto.push(`Historial sp_id=${h.sp_id}: precio negativo (${h.precio})`);
    }
  }

  reportar(
    'bloqueador',
    'Valores fuera de los conjuntos o rangos permitidos',
    fueraDeConjunto,
    'Los rechazan los CHECK del esquema. Corrígelos en SharePoint.'
  );

  // ═══ 6d. Porcentajes fuera de 0-100 (el import los recorta) ═════════════════

  const pctRaros = [];
  for (const d of oc) {
    items(d).forEach((it, i) => {
      for (const campo of ['descuentoPct', 'ivaPct']) {
        const v = Number(it[campo]);
        if (Number.isFinite(v) && (v < 0 || v > 100)) {
          pctRaros.push(`OC sp_id=${d.sp_id} línea ${i + 1}: ${campo} = ${v}`);
        }
      }
    });
  }

  reportar(
    'aviso',
    'Porcentajes fuera del rango 0-100',
    pctRaros,
    'No bloquea: el import los recorta al rango antes de escribir. Pero el valor original\n' +
    '  es un error de captura y conviene mirarlo.'
  );

  // ═══ 7. Fechas del historial que no se pueden interpretar ═══════════════════

  const MESES = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  };

  function parsearFecha(val) {
    const txt = String(val || '').trim().toLowerCase();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(txt)) return txt.slice(0, 10);
    let m = txt.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);            // "junio 23, 2026"
    if (m && MESES[m[1]]) return `${m[3]}-${String(MESES[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = txt.match(/^(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})$/);        // "23 de junio de 2026"
    if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);                // "23/04/2026"
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  }

  const fechasMalas = new Map();
  for (const f of hp) {
    if (parsearFecha(f.fecha)) continue;
    const k = f.fecha ? JSON.stringify(f.fecha) : '(vacía)';
    fechasMalas.set(k, (fechasMalas.get(k) || 0) + 1);
  }

  reportar(
    'aviso',
    'Fechas del historial de precios que no se pueden interpretar',
    [...fechasMalas.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} — ${n} fila(s)`),
    'No bloquea: la columna fecha queda NULL y fecha_texto conserva el original. Pero esas\n' +
    '  filas no participan del criterio "las 3 compras más recientes" de consultaProveedor.js,\n' +
    '  así que conviene arreglarlas.'
  );

  // ═══ 8. Totales con más de 2 decimales (se van a redondear) ═════════════════

  const conDecimales = [];
  for (const [lista, etiqueta, campos] of [
    [oc, 'OC', ['subtotal', 'iva', 'total']],
    [os, 'OS', ['valor', 'iva', 'total']],
  ]) {
    for (const d of lista) {
      for (const c of campos) {
        const v = Number(d[c]);
        if (!Number.isFinite(v) || v === 0) continue;
        if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
          conDecimales.push(`${etiqueta} sp_id=${d.sp_id} ${c}=${v} → se guardará ${v.toFixed(2)}`);
        }
      }
    }
  }

  reportar(
    'aviso',
    'Valores de dinero con más de 2 decimales',
    conDecimales,
    'Las columnas son numeric(16,2), así que se redondean al centavo. Son residuos del cálculo\n' +
    '  de IVA en punto flotante (0,0035 de peso), no valores reales — pero anótalo, porque el\n' +
    '  script de verificación tiene que comparar las sumas ya redondeadas o va a marcar\n' +
    '  diferencias que no existen.'
  );

  // ── Salida ──────────────────────────────────────────────────────────────────

  const volumen = [
    ['Proyectos',             catalogo.proyectos.length],
    ['Proveedores',           catalogo.proveedores.length],
    ['Insumos',               catalogo.insumos.length],
    ['UsuariosERP',           catalogo.usuarios.length],
    ['Requerimientos',        req.length],
    ['OrdenesCompra',         oc.length],
    ['OrdenesServicio',       os.length],
    ['Remisiones',            rem.length],
    ['MovimientosInventario', mov.length],
    ['HistorialPrecios',      hp.length],
  ];

  console.log('\n════ Chequeo previo al import ════════════════════════════════════════\n');
  console.log(`  Origen: ${DB_PATH}\n`);
  for (const [nombre, n] of volumen) {
    console.log(`  ${nombre.padEnd(24)} ${String(n).padStart(6)} filas`);
  }
  console.log(`  ${'ConfiguracionApp'.padEnd(24)} ${'—'.padStart(6)} (clave-valor; el import la lee de SharePoint)`);

  const bloqueadores = hallazgos.filter(h => h.nivel === 'bloqueador');
  const avisos       = hallazgos.filter(h => h.nivel === 'aviso');

  for (const grupo of [bloqueadores, avisos]) {
    for (const h of grupo) {
      const marca = h.nivel === 'bloqueador' ? '✖ BLOQUEA EL IMPORT' : '⚠ AVISO';
      console.log(`\n─── ${marca} — ${h.titulo} (${h.filas.length}) ───\n`);
      for (const f of h.filas.slice(0, TOPE)) console.log(`  ${f}`);
      if (h.filas.length > TOPE) {
        console.log(`  … y ${h.filas.length - TOPE} más (usa --detalle para verlas todas)`);
      }
      console.log(`\n  Qué hacer:\n  ${h.comoArreglar}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════════════\n');
  if (bloqueadores.length) {
    const total = bloqueadores.reduce((s, h) => s + h.filas.length, 0);
    console.log(`  ✖ ${bloqueadores.length} problema(s) que bloquean el import, ${total} fila(s) afectada(s).`);
    console.log(`  ⚠ ${avisos.length} aviso(s) que no bloquean.\n`);
    console.log('  Corrige los bloqueadores y corre esto otra vez. Para los automáticos: npm run corregir-listas\n');
    process.exit(1);
  }

  console.log(`  ✓ Sin bloqueadores. ${avisos.length} aviso(s) que no impiden importar.\n`);
  process.exitCode = 0;

}

main().catch(err => {
  console.error("✖", err.message);
  process.exit(1);
});
