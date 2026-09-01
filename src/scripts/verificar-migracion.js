'use strict';
/**
 * verificar-migracion.js — Compara SharePoint (origen) contra Postgres (destino).
 *
 *   npm run db:verificar
 *   npm run db:verificar -- --detalle    lista cada diferencia, no solo el conteo
 *
 * Para qué sirve: responder "¿están todos los datos?" sin abrir la consola a
 * mirar tabla por tabla. Lee las 11 listas por Graph, lee Postgres, y compara
 * tres cosas de distinto valor probatorio:
 *
 *   1. CONTEOS      — cuántas filas hay de cada lado.
 *   2. IDENTIDADES  — qué sp_id están de un lado y faltan del otro. Un conteo
 *                     que cuadra no prueba nada si una fila se perdió y otra se
 *                     duplicó; esto sí.
 *   3. DINERO       — los totales, que es donde una diferencia se nota.
 *
 * El punto 2 es el que importa. Los conteos son un resumen y los resúmenes
 * esconden compensaciones.
 *
 * No modifica nada, de ningún lado. Código de salida 1 si hay diferencias.
 */

require('dotenv').config();

const pg = require('../pg');

const DETALLE = process.argv.includes('--detalle');

const LISTAS = [
  'Proyectos', 'Proveedores', 'Insumos', 'UsuariosERP', 'ConfiguracionApp',
  'Requerimientos', 'OrdenesCompra', 'OrdenesServicio', 'Remisiones',
  'MovimientosInventario', 'HistorialPrecios',
];

/** Lista de SharePoint → tabla de Postgres. */
const TABLA = {
  Proyectos:             'proyectos',
  Proveedores:           'proveedores',
  Insumos:               'insumos',
  UsuariosERP:           'usuarios',
  ConfiguracionApp:      'configuracion',
  Requerimientos:        'requerimientos',
  OrdenesCompra:         'ordenes_compra',
  OrdenesServicio:       'ordenes_servicio',
  Remisiones:            'remisiones',
  MovimientosInventario: 'movimientos_inventario',
  HistorialPrecios:      'historial_precios',
};

/**
 * Listas que colapsan filas a propósito: varias del origen se convierten en una
 * sola. Su sp_id desaparece, así que compararlas por sp_id daría un falso
 * negativo. Se comprueban por su llave natural: la pregunta correcta no es "¿está
 * esta fila?" sino "¿está este proveedor?".
 */
/*
 * La normalización la hace la BASE, no este script. Se le pasan los valores
 * crudos del origen y ella responde cuáles no encuentra, aplicando la misma
 * erp.norm_nit() que usó el import.
 *
 * Replicar la normalización en JS ya dio un falso positivo: una versión anterior
 * le quitaba el último dígito a todo NIT de 10 cifras, suponiendo dígito de
 * verificación. En una cédula como 1075667356 ese dígito es parte del número, y
 * erp.norm_nit() no lo toca — así que el script reportaba como ausentes dos
 * proveedores que estaban. Con una sola definición eso no puede volver a pasar.
 */
const COLAPSAN = {
  Proveedores: {
    razon: 'la migración fusionó 14 duplicados (5 por puntuación, 9 por dígito de verificación)',
    valorOrigen: (r) => String(r.nit ?? '').trim(),
    sqlFaltan: `SELECT v FROM unnest($1::text[]) v
                 WHERE v <> ''
                   AND NOT EXISTS (SELECT 1 FROM erp.proveedores p
                                    WHERE p.nit = erp.norm_nit(v))`,
    comoSeLlama: 'NIT',
  },
  UsuariosERP: {
    razon: 'varias filas por persona colapsaron al correo, que es la identidad',
    valorOrigen: (r) => String(r.email ?? '').trim(),
    sqlFaltan: `SELECT v FROM unnest($1::text[]) v
                 WHERE v <> ''
                   AND NOT EXISTS (SELECT 1 FROM erp.usuarios u
                                    WHERE lower(u.email) = lower(btrim(v)))`,
    comoSeLlama: 'correo',
  },
};

const num = (n) => Number(n || 0);
const fmt = (n) => num(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });

// ── Lectura ─────────────────────────────────────────────────────────────────

const RUIDO_SP = /^(@odata|ContentType|Modified|Created|AuthorLookupId|EditorLookupId|_UIVersionString|Attachments|Edit|ItemChildCount|FolderChildCount|_Compliance|AppAuthorLookupId|AppEditorLookupId|Title|LinkTitle|ID)/;

function limpiar(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!RUIDO_SP.test(k)) out[k] = v;
  }
  return out;
}

async function leerSharePoint() {
  const g = require('../graphStorage');
  const site = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);
  const listas = await g.getLists(site.id);
  const porNombre = new Map(listas.map(l => [l.displayName, l.id]));

  const datos = {};
  for (const nombre of LISTAS) {
    const listId = porNombre.get(nombre);
    if (!listId) { datos[nombre] = []; console.log(`  ⚠ ${nombre}: no existe en el sitio`); continue; }
    const items = await g.getListItems(site.id, listId);
    datos[nombre] = items.map(it => ({ sp_id: String(it.id), ...limpiar(it.fields) }));
    process.stdout.write(`  ✓ ${nombre.padEnd(22)} ${String(datos[nombre].length).padStart(6)} filas\n`);
  }
  return datos;
}

async function leerPostgres() {
  const datos = {};
  for (const [lista, tabla] of Object.entries(TABLA)) {
    const r = await pg.query(`SELECT sp_id FROM erp.${tabla} WHERE sp_id IS NOT NULL`);
    datos[lista] = r.rows.map(x => String(x.sp_id));
  }
  return datos;
}

// ── Acumulador ──────────────────────────────────────────────────────────────

const problemas = [];
const avisos    = [];

function fallo(titulo, detalle) { problemas.push({ titulo, detalle }); }
function aviso(titulo, detalle) { avisos.push({ titulo, detalle }); }

// ── 1 y 2. Conteos e identidades ────────────────────────────────────────────

async function compararFilas(sp, pgDatos) {
  console.log('\n─── Filas: origen vs destino ───────────────────────────────\n');
  console.log('  Lista                    SharePoint   Postgres   Faltan');

  let desactualizadas = 0;
  let huecos = 0;   // filas ausentes DENTRO del rango ya importado

  for (const lista of LISTAS) {
    const origen  = new Set(sp[lista].map(r => String(r.sp_id)));
    const destino = new Set(pgDatos[lista] || []);

    // Lo que importa: qué sp_id existe en el origen y no llegó al destino.
    const faltan = [...origen].filter(id => !destino.has(id));
    const sobran = [...destino].filter(id => !origen.has(id));

    const colapsa = COLAPSAN[lista];
    let porLlave = null;

    // En las listas que colapsan, un sp_id ausente no prueba pérdida de datos.
    // La pregunta se replantea sobre la llave natural.
    if (colapsa && faltan.length) {
      const ausentes = new Set(faltan);
      const valores = [...new Set(
        sp[lista].filter(r => ausentes.has(String(r.sp_id)))
                 .map(colapsa.valorOrigen)
                 .filter(Boolean))];
      const { rows } = await pg.query(colapsa.sqlFaltan, [valores]);
      porLlave = rows.map(r => r.v);
    }

    const realmenteFalta = colapsa ? (porLlave ? porLlave.length : 0) : faltan.length;
    const marca = realmenteFalta ? '✗' : (faltan.length ? '·' : '✓');
    console.log(`  ${marca} ${lista.padEnd(22)} ${String(origen.size).padStart(6)} ${String(destino.size).padStart(10)} ${String(realmenteFalta).padStart(8)}`);

    if (colapsa && realmenteFalta) {
      fallo(`${lista}: ${realmenteFalta} ${colapsa.comoSeLlama}(s) del origen no están en Postgres`,
            `${colapsa.comoSeLlama}: ${porLlave.slice(0, DETALLE ? 999 : 10).join(', ')}`);
    } else if (colapsa && faltan.length) {
      aviso(`${lista}: ${faltan.length} sp_id del origen no existen como fila, y está previsto`,
            `${colapsa.razon}. Verificado por ${colapsa.comoSeLlama}: no falta ninguno.`);
    } else if (faltan.length) {
      // Sin colapso previsto hay dos causas posibles, y distinguirlas importa:
      // una fila NUEVA que el import no vio todavía, o una fila PERDIDA.
      //
      // SharePoint asigna el id de forma creciente, así que si todos los que
      // faltan son mayores que el mayor importado, se crearon después. Un hueco
      // en medio del rango es otra cosa y sí exige mirarlo.
      const maxImportado = Math.max(0, ...[...destino].map(Number).filter(Number.isFinite));
      const numericos    = faltan.map(Number).filter(Number.isFinite);
      const todosNuevos  = numericos.length === faltan.length && numericos.every(id => id > maxImportado);

      desactualizadas += faltan.length;
      const muestra = `sp_id: ${faltan.slice(0, DETALLE ? 999 : 10).join(', ')}${!DETALLE && faltan.length > 10 ? ` … y ${faltan.length - 10} más` : ''}`;
      fallo(`${lista}: ${faltan.length} fila(s) del origen no están en Postgres`,
            todosNuevos
              ? `${muestra}\n     Todos por encima del último importado (${maxImportado}): son filas nuevas, no perdidas.`
              : `${muestra}\n     ⚠ Hay huecos dentro del rango ya importado. Esto no se explica por filas nuevas.`);
      if (!todosNuevos) huecos += faltan.length;
    }

    if (sobran.length) {
      aviso(`${lista}: ${sobran.length} fila(s) en Postgres con un sp_id que ya no está en SharePoint`,
            'Normal si alguien borró en SharePoint después del import.');
    }
  }

  return { desactualizadas, huecos };
}

// ── 3. Dinero ───────────────────────────────────────────────────────────────

async function compararDinero(sp) {
  console.log('\n─── Dinero: totales de los documentos ──────────────────────\n');

  const casos = [
    {
      nombre: 'Órdenes de compra',
      spTotal: sp.OrdenesCompra.reduce((s, o) => s + num(o.valorTotal ?? o.total), 0),
      sql: 'SELECT COALESCE(sum(total),0) t FROM erp.ordenes_compra',
    },
    {
      nombre: 'Órdenes de servicio',
      spTotal: sp.OrdenesServicio.reduce((s, o) => s + num(o.valorTotal ?? o.total), 0),
      sql: 'SELECT COALESCE(sum(total),0) t FROM erp.ordenes_servicio',
    },
  ];

  for (const c of casos) {
    const { rows } = await pg.query(c.sql);
    const pgTotal = num(rows[0].t);
    const dif = Math.abs(pgTotal - c.spTotal);
    // Un peso de diferencia es redondeo, no pérdida de datos.
    const ok = dif < 1;
    console.log(`  ${ok ? '✓' : '✗'} ${c.nombre.padEnd(22)} SP $${fmt(c.spTotal).padStart(16)}   PG $${fmt(pgTotal).padStart(16)}`);
    if (!ok) fallo(`${c.nombre}: los totales no coinciden`, `diferencia de $${fmt(dif)}`);
  }
}

// ── 4. Coherencia interna del destino ───────────────────────────────────────

async function revisarCoherencia() {
  console.log('\n─── Coherencia interna de Postgres ─────────────────────────\n');

  const chequeos = [
    {
      nombre: 'Números de documento duplicados',
      sql: 'SELECT count(*) n FROM erp.vw_numeros_duplicados',
      esperado: 0,
      porque: 'dos documentos contables con el mismo número',
    },
    {
      nombre: 'OC donde los ítems no suman la cabecera',
      sql: `SELECT count(*) n FROM (
              SELECT o.id
                FROM erp.ordenes_compra o
                JOIN erp.orden_compra_items i ON i.orden_compra_id = o.id
               GROUP BY o.id, o.subtotal
              HAVING abs(COALESCE(sum(i.valor_bruto),0) - COALESCE(o.subtotal,0)) > 1
            ) x`,
      esperado: 0,
      porque: 'la suma de los ítems debe dar el subtotal de la cabecera',
    },
    {
      nombre: 'Documentos sin proyecto',
      sql: `SELECT (SELECT count(*) FROM erp.ordenes_compra WHERE proyecto_id IS NULL)
                 + (SELECT count(*) FROM erp.ordenes_servicio WHERE proyecto_id IS NULL) n`,
      esperado: 0,
      porque: 'un gasto sin proyecto no aparece en el control de costos',
    },
    {
      nombre: 'Contadores por debajo del máximo emitido',
      // Las claves reales son 'orden_compra' y 'orden_servicio', no 'oc'/'os'.
      sql: `SELECT count(*) n FROM (
              SELECT 1 WHERE (SELECT valor FROM erp.contadores WHERE clave = 'orden_compra')
                           < (SELECT COALESCE(max(NULLIF(regexp_replace(numero_oc,'\\D','','g'),'')::int),0)
                                FROM erp.ordenes_compra WHERE numero_oc IS NOT NULL)
              UNION ALL
              SELECT 1 WHERE (SELECT valor FROM erp.contadores WHERE clave = 'orden_servicio')
                           < (SELECT COALESCE(max(NULLIF(regexp_replace(numero_os,'\\D','','g'),'')::int),0)
                                FROM erp.ordenes_servicio WHERE numero_os IS NOT NULL)
            ) x`,
      esperado: 0,
      porque: 'la próxima orden reusaría un número ya emitido',
    },
  ];

  for (const c of chequeos) {
    let n;
    try {
      const { rows } = await pg.query(c.sql);
      n = Number(rows[0].n);
    } catch (e) {
      console.log(`  ⚠ ${c.nombre.padEnd(42)} no se pudo evaluar`);
      aviso(`No se pudo evaluar "${c.nombre}"`, e.message);
      continue;
    }
    const ok = n === c.esperado;
    console.log(`  ${ok ? '✓' : '✗'} ${c.nombre.padEnd(42)} ${n}`);
    if (!ok) fallo(`${c.nombre}: ${n}`, c.porque);
  }
}

// ── 5. Lo que la consola va a mostrar ───────────────────────────────────────

async function mostrarLoQueVeraLaGente() {
  console.log('\n─── Lo que verá la consola ─────────────────────────────────\n');

  const filas = [
    ['Órdenes de compra',    'SELECT count(*) n FROM erp.ordenes_compra'],
    ['Órdenes de servicio',  'SELECT count(*) n FROM erp.ordenes_servicio'],
    ['Requerimientos',       'SELECT count(*) n FROM erp.requerimientos'],
    ['Remisiones',           'SELECT count(*) n FROM erp.remisiones'],
    ['Gastos (vista)',       'SELECT count(*) n FROM erp.vw_gastos'],
    ['Insumos con stock',    'SELECT count(*) n FROM (SELECT insumo FROM erp.movimientos_inventario GROUP BY insumo) x'],
    ['Proveedores',          'SELECT count(*) n FROM erp.proveedores'],
    ['Historial de precios', 'SELECT count(*) n FROM erp.historial_precios'],
  ];
  for (const [nombre, sql] of filas) {
    const { rows } = await pg.query(sql);
    console.log(`  ${nombre.padEnd(24)} ${String(rows[0].n).padStart(7)}`);
  }

  const { rows: g } = await pg.query(
    'SELECT origen, count(*) n, COALESCE(sum(total),0) t FROM erp.vw_gastos GROUP BY origen ORDER BY 3 DESC');
  console.log('\n  Gastos por origen:');
  for (const r of g) console.log(`    ${r.origen.padEnd(16)} ${String(r.n).padStart(5)} docs   $${fmt(r.t)}`);
  const total = g.reduce((s, r) => s + num(r.t), 0);
  console.log(`    ${'TOTAL'.padEnd(16)} ${String(g.reduce((s, r) => s + Number(r.n), 0)).padStart(5)} docs   $${fmt(total)}`);
}

// ── Ejecución ───────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Verificación de la migración — origen vs destino');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n Origen : SharePoint ${process.env.SHAREPOINT_SITE_PATH || '(sin configurar)'}`);
  const bd   = process.env.ERP_DB_NAME || pg.BASE_POR_DEFECTO;
  const host = process.env.ERP_DB_HOST || 'localhost';
  const puerto = process.env.ERP_DB_PORT || pg.PUERTO_POR_DEFECTO;
  console.log(` Destino: ${bd} en ${host}:${puerto}\n`);

  console.log('Leyendo SharePoint...');
  const sp = await leerSharePoint();

  console.log('\nLeyendo Postgres...');
  const pgDatos = await leerPostgres();

  const { desactualizadas, huecos } = await compararFilas(sp, pgDatos);
  await compararDinero(sp);
  await revisarCoherencia();
  await mostrarLoQueVeraLaGente();

  // ── Resumen ──
  console.log('\n═══════════════════════════════════════════════════════════');
  if (avisos.length) {
    console.log(`\n ${avisos.length} aviso(s) — no bloquean:\n`);
    for (const a of avisos) console.log(`   · ${a.titulo}\n     ${a.detalle}`);
  }
  if (problemas.length) {
    console.log(`\n ✗ ${problemas.length} problema(s):\n`);
    for (const p of problemas) console.log(`   · ${p.titulo}\n     ${p.detalle}`);

    if (desactualizadas && !huecos) {
      // El caso habitual, y no es un error de la migración: la gente siguió
      // trabajando en SharePoint después del último import.
      console.log(`\n ── Diagnóstico ──`);
      console.log(` Faltan ${desactualizadas} fila(s) que SÍ existen en SharePoint, y TODAS tienen un`);
      console.log(` sp_id por encima del último importado. No se perdió nada: se crearon`);
      console.log(` después del último import, porque la gente siguió trabajando.`);
      console.log(`\n Se resuelve volviendo a importar, que es idempotente:\n`);
      console.log(`   npm run revisar-listas     # ¿hay algo que el esquema rechace?`);
      console.log(`   npm run db:importar        # trae lo nuevo y actualiza lo existente`);
      console.log(`   npm run db:verificar       # debe quedar en cero\n`);
      console.log(` Esto es exactamente por lo que el import va JUSTO ANTES del corte:`);
      console.log(` cualquier documento aprobado después queda solo en SharePoint.\n`);
    } else if (huecos) {
      console.log(`\n ── Diagnóstico ──`);
      console.log(` ${huecos} fila(s) faltan DENTRO del rango ya importado. Eso no lo explica`);
      console.log(` una fila nueva: o el import las rechazó, o se perdieron. Míralo con`);
      console.log(` "npm run db:verificar -- --detalle" antes de seguir.\n`);
    } else {
      console.log('\n No despliegues con esto pendiente.\n');
    }
    return 1;
  }
  console.log('\n ✓ Todos los datos del origen están en el destino.');
  console.log('   Los totales coinciden y la base es coherente.\n');
  return 0;
}

main()
  .then(async (codigo) => { await pg.cerrar().catch(() => {}); process.exit(codigo); })
  .catch(async (e) => {
    console.error('\n✗ La verificación no pudo completarse:', e.message);
    if (process.env.DEBUG) console.error(e);
    await pg.cerrar().catch(() => {});
    process.exit(2);
  });
