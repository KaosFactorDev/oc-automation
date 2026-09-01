'use strict';
/**
 * backfill-pdf-ordenes-compra.js
 * Genera y sube a SharePoint (carpeta OrdenesCompraPDF) el PDF de las OC que
 * ya están marcadas como entregadas pero quedaron sin pdfUrl (creadas antes
 * de que la generación automática existiera).
 *
 * Uso:
 *   node src/scripts/backfill-pdf-ordenes-compra.js            → dry-run (solo lista)
 *   node src/scripts/backfill-pdf-ordenes-compra.js --confirm  → ejecuta
 *   node src/scripts/backfill-pdf-ordenes-compra.js --confirm --todos
 *       → además de las que no tienen PDF, regenera las que ya tienen uno
 */

require('dotenv').config();
const g          = require('../graphStorage');
const ocTemplate = require('../ocTemplate');
const configApp  = require('../configApp');
const repoCatalogos = require('../repo/catalogos');
const repoOrdenesCompra = require('../repo/ordenesCompra');
const { htmlAPdf } = require('../pdfGenerator');

const CONFIRM = process.argv.includes('--confirm');
const TODOS   = process.argv.includes('--todos');

function ocDesdeFields(f) {
  let itemsRaw = [];
  try { itemsRaw = JSON.parse(f.itemsJson || '[]'); } catch { itemsRaw = []; }
  const items = itemsRaw.map(it => ({
    descripcion:    it.descripcion || it.insumo || '',
    unidad:         it.unidad || 'UND',
    cantidad:       Number(it.cantidad || 0),
    precioUnitario: Number(it.precioUnitario || it.precio || 0),
    descuentoPct:   Number(it.descuentoPct || 0),
    ivaPct:         Number(it.ivaPct || 0),
  }));
  return {
    numeroOC: f.numeroOC || '',
    fecha: f.fechaCreacion ? new Date(f.fechaCreacion).toLocaleDateString('es-CO') : '',
    proyecto: f.proyecto || '',
    proveedor: {
      nombre: f.proveedorNombre || '', nit: f.proveedorNit || '',
      direccion: '', municipio: '', telefono: '', correo: '',
    },
    lugarEntrega:           f.lugarEntrega || '',
    fechaEntregaPrevista:   f.fechaEntregaPrevista ? new Date(f.fechaEntregaPrevista).toLocaleDateString('es-CO') : '',
    fechaEntrega:           f.fechaEntrega ? new Date(f.fechaEntrega).toLocaleDateString('es-CO') : '',
    requerimientoOrigen:    f.requerimientoOrigen || '',
    condicionesComerciales: f.condicionesComerciales || '',
    observaciones:          f.observaciones || '',
    estado:                 f.estado || 'borrador',
    items,
  };
}

async function cfgConFirmantePorEmail(cfg, email) {
  if (!email) return cfg;
  const usuario = (await repoCatalogos.getUsuarioByEmail(email)) || {};
  return { ...cfg, firmante: { nombre: usuario.nombre || email, cargo: usuario.cargo || '' } };
}

async function main() {
  const site = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);

  const todas = await repoOrdenesCompra.listar();
  const entregadas = todas.filter(oc => oc.entregado);
  const pendientes = TODOS ? entregadas : entregadas.filter(oc => !oc.pdfUrl);

  console.log(`OC entregadas: ${entregadas.length}`);
  console.log(`Pendientes de PDF${TODOS ? ' (--todos: se regeneran todas)' : ''}: ${pendientes.length}`);

  if (!CONFIRM) {
    pendientes.forEach(oc => console.log(`  - id ${oc.id} · ${oc.numeroOC || '(sin número)'} · ${oc.proyecto || '(sin proyecto)'}`));
    console.log('\nDry-run. Ejecuta con --confirm para generar y subir los PDFs.');
    return;
  }

  const cfgBase = await configApp.getConfig();
  let ok = 0, fallidos = 0;
  for (const ocLocal of pendientes) {
    try {
      // Los datos salen de Postgres; el PDF sigue subiéndose al Drive de
      // SharePoint, que es donde la gente los busca.
      const oc  = ocDesdeFields(ocLocal);
      const cfg = await cfgConFirmantePorEmail(cfgBase, ocLocal.entregadoPor);

      const html   = ocTemplate.generarHTML(oc, cfg);
      const buffer = await htmlAPdf(html);
      const nombre = `${oc.numeroOC || ocLocal.id}_${oc.proyecto || 'SIN-PROYECTO'}`.replace(/[\\/:*?"<>|]/g, '-');
      const driveItem = await g.uploadFileToSite(site.id, `/OrdenesCompraPDF/${nombre}.pdf`, buffer, 'application/pdf');
      await repoOrdenesCompra.actualizar(ocLocal.id, { pdfUrl: driveItem.webUrl });

      ok++;
      console.log(`  ✓ id ${ocLocal.id} (${ok + fallidos}/${pendientes.length})`);
    } catch (e) {
      fallidos++;
      console.error(`  ✗ id ${ocLocal.id}: ${e.message}`);
    }
  }
  console.log(`\nCompletado — ok: ${ok} | fallidos: ${fallidos}`);
}

main().catch(e => { console.error('Fallo crítico:', e); process.exit(1); });
