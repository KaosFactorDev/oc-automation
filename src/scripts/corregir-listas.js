'use strict';
/**
 * corregir-listas.js — Corrige en SharePoint los datos que el esquema de
 * Postgres va a rechazar.
 *
 *   npm run corregir-listas              muestra el plan, NO escribe nada
 *   npm run corregir-listas -- --aplicar  escribe en SharePoint
 *
 * ── Por qué corregir el origen y no parchear al importar ───────────────────
 * SharePoint sigue siendo la fuente de verdad durante la etapa de doble
 * escritura. Si el arreglo vive solo en el import, SharePoint se queda con el
 * dato malo, las dos bases dejan de coincidir y cada re-import vuelve a aplicar
 * el mismo parche — justo cuando lo que se necesita es poder comparar las dos y
 * confiar en que cuadran. Arreglando el origen, el problema desaparece una vez.
 *
 * ── Las tres correcciones ──────────────────────────────────────────────────
 *
 * 1. NÚMEROS DE DOCUMENTO REPETIDOS (OC, OS, remisiones)
 *    Causa: contador.js calcula el siguiente número como MAX() excluyendo los
 *    anulados, así que al anular el documento más alto el siguiente reutiliza
 *    su número. El esquema nuevo lo hace imposible.
 *    Corrección: el número se queda con el documento VIGENTE y los anulados
 *    pasan a "0036-A", "0036-B". Nada se borra; solo cambia la etiqueta de
 *    documentos que ya estaban anulados.
 *
 * 2. DOCUMENTOS VIGENTES CON EL MISMO NÚMERO Y EL MISMO CONTENIDO
 *    Causa: doble envío del formulario. El número salía de
 *    (cantidad de remisiones + 1), así que dos creadas en el mismo segundo
 *    obtenían el mismo.
 *    Corrección: el más antiguo conserva el número; la copia se marca anulada
 *    con el motivo, y se le pone sufijo. NO se borra — queda el rastro de que
 *    existió, que es lo que uno quiere de un duplicado en un sistema contable.
 *    Si el contenido NO es idéntico, no se toca: eso no es un doble envío.
 *
 * 3. FECHAS DE SERVICIO INVERTIDAS (fin antes del inicio)
 *    Corrección: se intercambian. Es la causa habitual —los dos valores
 *    escritos en los campos cambiados— y intercambiar no inventa ni descarta
 *    ninguna fecha: quedan las dos, en el orden correcto.
 *
 * Todo lo que hace se imprime antes de hacerlo, y sin --aplicar no escribe.
 */

require('dotenv').config();

const g = require('../graphStorage');

const APLICAR = process.argv.includes('--aplicar');

const ANULADOS = new Set(['anulada', 'anulado']);
const txt = (v) => String(v ?? '').trim();

// ── Lectura ─────────────────────────────────────────────────────────────────

async function contexto() {
  const site = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);
  const listas = await g.getLists(site.id);
  const porNombre = new Map(listas.map(l => [l.displayName, l.id]));
  return { siteId: site.id, lista: (n) => porNombre.get(n) };
}

async function leer(ctx, nombre) {
  const listId = ctx.lista(nombre);
  if (!listId) throw new Error(`La lista "${nombre}" no existe en el sitio`);
  const items = await g.getListItems(ctx.siteId, listId);
  return { listId, filas: items.map(it => ({ sp_id: String(it.id), ...(it.fields || {}) })) };
}

// ── Cálculo de las correcciones ─────────────────────────────────────────────

/** Firma del contenido de un documento, para detectar copias exactas. */
function huella(doc) {
  let items = [];
  try { items = JSON.parse(doc.itemsJson || '[]'); } catch {}
  if (!Array.isArray(items)) items = [];
  return JSON.stringify({
    proyecto: txt(doc.proyecto),
    ocIds:    txt(doc.ocIds),
    items: items
      .map(i => [txt(i.descripcion) || txt(i.insumo), Number(i.cantidad) || 0, txt(i.unidad)])
      .sort(),
  });
}

const antiguedad = (d) =>
  Date.parse(d.fechaCreacion || d.fechaAprobacion || d.fecha || '') || Number(d.sp_id) || 0;

/**
 * Devuelve las ediciones a aplicar sobre una lista con números repetidos.
 * Cada edición es { sp_id, campos, descripcion }.
 */
function planNumeros(filas, campo, etiqueta) {
  const grupos = new Map();
  for (const d of filas) {
    const n = txt(d[campo]);
    if (!n) continue;
    if (!grupos.has(n)) grupos.set(n, []);
    grupos.get(n).push(d);
  }

  const ediciones = [];
  const sinResolver = [];

  for (const [numero, grupo] of grupos) {
    if (grupo.length < 2) continue;

    const vigentes = grupo.filter(d => !ANULADOS.has(txt(d.estado)));
    let conserva;
    let anularCopias = false;

    if (vigentes.length <= 1) {
      // Caso 1: el vigente conserva el número (o el más antiguo si todos están anulados).
      conserva = vigentes[0] || [...grupo].sort((a, b) => antiguedad(a) - antiguedad(b))[0];
    } else {
      // Caso 2: varios vigentes. Solo se resuelve si son copias exactas.
      const huellas = new Set(vigentes.map(huella));
      if (huellas.size > 1) {
        sinResolver.push(
          `${etiqueta} ${numero}: ${vigentes.length} vigentes con contenido DISTINTO ` +
          `(sp_id ${vigentes.map(d => d.sp_id).join(', ')}) — requiere criterio humano`);
        continue;
      }
      conserva = [...vigentes].sort((a, b) => antiguedad(a) - antiguedad(b))[0];
      anularCopias = true;
    }

    const resto = grupo.filter(d => d !== conserva)
      .sort((a, b) => antiguedad(a) - antiguedad(b));

    resto.forEach((d, i) => {
      const nuevo = `${numero}-${String.fromCharCode(65 + i)}`;
      const campos = { [campo]: nuevo };
      let detalle = `estado=${txt(d.estado)}`;

      if (anularCopias && !ANULADOS.has(txt(d.estado))) {
        // Una copia exacta de un documento vigente no debe quedar vigente ella
        // también: se anula con el motivo, en vez de borrarla.
        // 'anulada' es un estado válido en las tres listas (ESTADOS_OC,
        // ESTADOS_OS y ESTADOS_REM en esquemas.js).
        campos.estado = 'anulada';
        campos.motivoAnulacion =
          `Duplicado exacto de ${numero} (sp_id=${conserva.sp_id}) por doble envío del formulario. ` +
          `Anulada durante la migración a Postgres.`;
        detalle = 'copia exacta → se anula y se renombra';
      }

      ediciones.push({
        sp_id: d.sp_id,
        campos,
        descripcion: `${etiqueta} ${numero} → ${nuevo}  (sp_id=${d.sp_id}, ${detalle})`,
      });
    });
  }

  return { ediciones, sinResolver };
}

/** Fechas de servicio invertidas: se intercambian. */
function planFechas(filas) {
  const ediciones = [];
  for (const d of filas) {
    if (!d.fechaInicio || !d.fechaFin) continue;
    const ini = new Date(d.fechaInicio), fin = new Date(d.fechaFin);
    if (isNaN(ini) || isNaN(fin) || fin >= ini) continue;
    ediciones.push({
      sp_id: d.sp_id,
      campos: { fechaInicio: d.fechaFin, fechaFin: d.fechaInicio },
      descripcion:
        `OS ${txt(d.numeroOS) || '(sin número)'} (sp_id=${d.sp_id}): intercambia fechas — ` +
        `inicio ${String(d.fechaInicio).slice(0, 10)} ↔ fin ${String(d.fechaFin).slice(0, 10)}`,
    });
  }
  return ediciones;
}

// ── Aplicación ──────────────────────────────────────────────────────────────

async function aplicar(ctx, listId, ediciones, etiqueta) {
  let ok = 0;
  const fallos = [];
  for (const e of ediciones) {
    try {
      await g.updateListItem(ctx.siteId, listId, e.sp_id, e.campos);
      ok++;
      process.stdout.write(`\r  ${etiqueta}: ${ok}/${ediciones.length}   `);
    } catch (err) {
      fallos.push(`sp_id=${e.sp_id}: ${err.message.split('\n')[0]}`);
    }
  }
  if (ediciones.length) process.stdout.write('\n');
  return { ok, fallos };
}

// ── Programa ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n════ Corrección de datos en SharePoint ════\n');
  console.log(APLICAR
    ? '  MODO ESCRITURA: los cambios se van a aplicar.\n'
    : '  MODO PLAN: no se escribe nada. Agrega --aplicar para ejecutar.\n');

  const ctx = await contexto();

  console.log('Leyendo listas...');
  const oc  = await leer(ctx, 'OrdenesCompra');
  const os  = await leer(ctx, 'OrdenesServicio');
  const rem = await leer(ctx, 'Remisiones');
  console.log(`  OrdenesCompra   ${String(oc.filas.length).padStart(5)}`);
  console.log(`  OrdenesServicio ${String(os.filas.length).padStart(5)}`);
  console.log(`  Remisiones      ${String(rem.filas.length).padStart(5)}`);

  const pOC  = planNumeros(oc.filas,  'numeroOC', 'OC');
  const pOS  = planNumeros(os.filas,  'numeroOS', 'OS');
  const pREM = planNumeros(rem.filas, 'numero',   'Remisión');
  const pFechas = planFechas(os.filas);

  const grupos = [
    { titulo: 'Números de OC repetidos',       listId: oc.listId,  eds: pOC.ediciones,  etiqueta: 'OrdenesCompra' },
    { titulo: 'Números de OS repetidos',       listId: os.listId,  eds: pOS.ediciones,  etiqueta: 'OrdenesServicio' },
    { titulo: 'Números de remisión repetidos', listId: rem.listId, eds: pREM.ediciones, etiqueta: 'Remisiones' },
    { titulo: 'Fechas de servicio invertidas', listId: os.listId,  eds: pFechas,        etiqueta: 'OrdenesServicio (fechas)' },
  ];

  const total = grupos.reduce((s, x) => s + x.eds.length, 0);
  const sinResolver = [...pOC.sinResolver, ...pOS.sinResolver, ...pREM.sinResolver];

  console.log('\n──── Plan ────────────────────────────────────\n');
  for (const gr of grupos) {
    if (!gr.eds.length) continue;
    console.log(`  ${gr.titulo} (${gr.eds.length}):`);
    for (const e of gr.eds) console.log(`    · ${e.descripcion}`);
    console.log();
  }

  if (sinResolver.length) {
    console.log('  ✖ Casos que NO se corrigen automáticamente:\n');
    for (const s of sinResolver) console.log(`    ${s}`);
    console.log();
  }

  if (!total) {
    console.log('  No hay nada que corregir.\n');
    return;
  }

  console.log(`  Total: ${total} edición(es) en ${grupos.filter(gr => gr.eds.length).length} lista(s).`);
  console.log('  Ningún documento se borra. Los duplicados exactos se anulan con motivo.\n');

  if (!APLICAR) {
    console.log('  Para ejecutarlo:  npm run corregir-listas -- --aplicar\n');
    return;
  }

  console.log('Aplicando...');
  const fallos = [];
  let aplicadas = 0;
  for (const gr of grupos) {
    if (!gr.eds.length) continue;
    const r = await aplicar(ctx, gr.listId, gr.eds, gr.etiqueta);
    aplicadas += r.ok;
    fallos.push(...r.fallos);
  }

  console.log(`\n  ✓ ${aplicadas} de ${total} edición(es) aplicadas.`);
  if (fallos.length) {
    console.log(`\n  ✖ ${fallos.length} fallaron:`);
    for (const f of fallos) console.log(`    ${f}`);
    process.exitCode = 1;
  }

  console.log('\n  Siguiente paso:');
  console.log('    1. Sincroniza el caché (botón de la consola, o reinicia el servidor)');
  console.log('    2. npm run revisar-listas       → debe quedar sin bloqueadores');
  console.log('    3. npm run db:importar\n');
}

main().catch(err => {
  console.error('\n✖', err.message);
  process.exit(1);
});
