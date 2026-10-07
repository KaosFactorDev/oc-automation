'use strict';
/**
 * controlCostos.js — Reporte de Control de Costos.
 *
 * ── Qué cambió ─────────────────────────────────────────────────────────────
 * Este módulo escribía filas en la tabla tblGastos de "Control Costos.xlsx", en
 * el Drive de SharePoint, mediante la Workbook API. Exponía dos funciones:
 *
 *   registrarGasto()  llamada al aprobar una OC, una OS o una salida de almacén
 *   actualizarFila()  llamada al marcar pago, entrega o cumplimiento
 *
 * Las dos desaparecieron. El gasto ya no se registra: **se deriva**. La vista
 * erp.vw_gastos lo calcula desde las órdenes aprobadas y las salidas de almacén,
 * así que no hay una copia que pueda quedar desincronizada.
 *
 * Eso resuelve tres cosas que el libro tenía:
 *
 *  · Si la escritura fallaba —y se llamaba con .catch() que solo dejaba una
 *    advertencia en el log— el gasto no quedaba registrado y nadie se enteraba.
 *  · Anular una OC ya aprobada no borraba su fila, porque actualizarFila() solo
 *    se llamaba para pago y entrega. El libro sumaba gastos de órdenes que ya no
 *    existían.
 *  · actualizarFila() buscaba la fila leyendo toda la tabla del libro y
 *    recorriéndola hasta encontrar el número. Con cada OC esa búsqueda crecía.
 *
 * ── Qué se conserva ────────────────────────────────────────────────────────
 * El archivo. La gente lo consulta en SharePoint y ahí sigue: exportarXlsx()
 * genera el libro completo —las 14 columnas de siempre más las tres hojas de
 * resumen— y lo sube al mismo sitio. La diferencia es que el Excel pasó de ser
 * base de datos a ser reporte, y se regenera entero en vez de irse editando.
 */

const ExcelJS = require('exceljs');
const g          = require('./graphStorage');
const repoGastos = require('./repo/gastos');

const CARPETA_REMOTA = 'Control Costos';
const NOMBRE_ARCHIVO = 'Control Costos.xlsx';

const COLUMNAS = [
  { header: 'Fecha OC',         key: 'fechaOC',         width: 12 },
  { header: 'Número',           key: 'numero',          width: 14 },
  { header: 'Proyecto',         key: 'proyecto',        width: 38 },
  { header: 'NIT Proveedor',    key: 'proveedorNit',    width: 16 },
  { header: 'Proveedor',        key: 'proveedorNombre', width: 34 },
  { header: 'Tipo de gasto',    key: 'tipoGasto',       width: 18 },
  { header: 'Subtotal',         key: 'subtotal',        width: 16 },
  { header: 'IVA',              key: 'iva',             width: 14 },
  { header: 'Total',            key: 'total',           width: 16 },
  { header: 'Estado',           key: 'estado',          width: 13 },
  { header: 'Fecha aprobación', key: 'fechaAprobacion', width: 15 },
  { header: 'Fecha pago',       key: 'fechaPago',       width: 13 },
  { header: 'Fecha entrega',    key: 'fechaEntrega',    width: 13 },
  { header: 'Creado por',       key: 'creadoPor',       width: 28 },
];

const MONEDA = '#,##0.00';

function encabezado(hoja) {
  const fila = hoja.getRow(1);
  fila.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C6B76' } };
  fila.alignment = { vertical: 'middle' };
  fila.height = 20;
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Construye el libro completo desde las vistas. Devuelve un Buffer. */
async function generarXlsx() {
  const [gastos, porProyecto, porProveedor, porTipo, tot] = await Promise.all([
    repoGastos.listar(),
    repoGastos.porProyecto(),
    repoGastos.porProveedor(),
    repoGastos.porTipo(),
    repoGastos.totales(),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'oc-automation';
  wb.created = new Date();

  // ── Gastos ────────────────────────────────────────────────────────────────
  const hg = wb.addWorksheet('Gastos');
  hg.columns = COLUMNAS;
  for (const row of gastos) hg.addRow(row);
  encabezado(hg);
  for (const key of ['subtotal', 'iva', 'total']) {
    hg.getColumn(key).numFmt = MONEDA;
  }
  hg.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNAS.length } };

  // ── Resúmenes ─────────────────────────────────────────────────────────────
  // Se escriben como valores y no como fórmulas: los calculó Postgres y no
  // pueden quedar viejos respecto de la hoja de Gastos.
  const hp = wb.addWorksheet('Por Proyecto');
  hp.columns = [
    { header: 'Proyecto',   key: 'proyecto',   width: 42 },
    { header: 'Documentos', key: 'documentos', width: 12 },
    { header: 'Subtotal',   key: 'subtotal',   width: 16 },
    { header: 'IVA',        key: 'iva',        width: 14 },
    { header: 'Total',      key: 'total',      width: 16 },
  ];
  for (const row of porProyecto) hp.addRow(row);
  encabezado(hp);
  for (const key of ['subtotal', 'iva', 'total']) hp.getColumn(key).numFmt = MONEDA;

  const hpr = wb.addWorksheet('Por Proveedor');
  hpr.columns = [
    { header: 'Proveedor',  key: 'proveedor',    width: 40 },
    { header: 'NIT',        key: 'proveedorNit', width: 16 },
    { header: 'Documentos', key: 'documentos',   width: 12 },
    { header: 'Total',      key: 'total',        width: 16 },
  ];
  for (const row of porProveedor) hpr.addRow(row);
  encabezado(hpr);
  hpr.getColumn('total').numFmt = MONEDA;

  const ht = wb.addWorksheet('Por Tipo de Gasto');
  ht.columns = [
    { header: 'Tipo de gasto', key: 'tipoGasto',  width: 24 },
    { header: 'Documentos',    key: 'documentos', width: 12 },
    { header: 'Total',         key: 'total',      width: 16 },
  ];
  for (const row of porTipo) ht.addRow(row);
  encabezado(ht);
  ht.getColumn('total').numFmt = MONEDA;

  // ── Resumen ───────────────────────────────────────────────────────────────
  const hr = wb.addWorksheet('Resumen');
  hr.columns = [
    { header: 'Concepto', key: 'concepto', width: 30 },
    { header: 'Valor',    key: 'valor',    width: 20 },
  ];
  hr.addRow({ concepto: 'Documentos de gasto', valor: tot.documentos });
  hr.addRow({ concepto: 'Subtotal',            valor: tot.subtotal });
  hr.addRow({ concepto: 'IVA',                 valor: tot.iva });
  hr.addRow({ concepto: 'Total',               valor: tot.total });
  hr.addRow({ concepto: 'Generado',            valor: new Date().toLocaleString('es-CO') });
  encabezado(hr);
  hr.getColumn('valor').numFmt = MONEDA;

  return wb.xlsx.writeBuffer();
}

/**
 * Genera el libro y lo sube al mismo sitio de SharePoint donde estaba, para que
 * quien lo consulta hoy no tenga que cambiar de lugar. Devuelve el webUrl.
 */
async function exportarXlsx() {
  const buffer = await generarXlsx();
  const site   = await g.getSite(process.env.SHAREPOINT_HOSTNAME, process.env.SHAREPOINT_SITE_PATH);
  const item   = await g.uploadFileToSite(
    site.id,
    `/${CARPETA_REMOTA}/${NOMBRE_ARCHIVO}`,
    buffer,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  return item.webUrl;
}

// ── Descarga desde la pantalla de Control de Costos ─────────────────────────
//
// Lo que se está viendo, con los filtros aplicados, como archivo que se baja al
// equipo. No pasa por SharePoint. La obra va con su nombre de KAOS, y el código
// del ERP en una columna aparte, igual que en pantalla.

const COLUMNAS_PANTALLA = [
  { header: 'Fecha',            key: 'fechaOC',         width: 12 },
  { header: 'Origen',           key: 'origenNombre',    width: 17 },
  { header: 'Número',           key: 'numero',          width: 13 },
  { header: 'Obra (KAOS)',      key: 'obra',            width: 46 },
  { header: 'KP',               key: 'kaosCode',        width: 12 },
  { header: 'Código ERP',       key: 'codigoErp',       width: 34 },
  { header: 'Zona',             key: 'zona',            width: 12 },
  { header: 'NIT Proveedor',    key: 'proveedorNit',    width: 15 },
  { header: 'Proveedor',        key: 'proveedorNombre', width: 32 },
  { header: 'Tipo de gasto',    key: 'tipoGasto',       width: 18 },
  { header: 'Subtotal',         key: 'subtotal',        width: 16 },
  { header: 'IVA',              key: 'iva',             width: 14 },
  { header: 'Total',            key: 'total',           width: 16 },
  { header: 'Estado',           key: 'estado',          width: 12 },
  { header: 'Pago',             key: 'pago',            width: 11 },
  { header: 'Fecha aprobación', key: 'fechaAprobacion', width: 15 },
  { header: 'Fecha pago',       key: 'fechaPago',       width: 12 },
  { header: 'Fecha entrega',    key: 'fechaEntrega',    width: 13 },
  { header: 'Creado por',       key: 'creadoPor',       width: 26 },
];

/** Agrupa filas por una clave y suma subtotal, IVA y total. */
function agrupar(filas, clave, extra = () => ({})) {
  const m = new Map();
  for (const f of filas) {
    const k = clave(f);
    const a = m.get(k) || { ...extra(f), documentos: 0, subtotal: 0, iva: 0, total: 0 };
    a.documentos += 1; a.subtotal += f.subtotal; a.iva += f.iva; a.total += f.total;
    m.set(k, a);
  }
  return [...m.values()].sort((x, y) => y.total - x.total);
}

/**
 * @param {object} filtros     los de repoGastos.controlCostos()
 * @param {string[]} descripcion  los filtros en palabras, para la hoja Resumen
 * @returns {Promise<Buffer>}
 */
async function generarXlsxControl(filtros = {}, descripcion = []) {
  const filas = await repoGastos.controlCostos(filtros);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'oc-automation';
  wb.created = new Date();

  const hg = wb.addWorksheet('Gastos');
  hg.columns = COLUMNAS_PANTALLA;
  for (const row of filas) hg.addRow(row);
  encabezado(hg);
  for (const key of ['subtotal', 'iva', 'total']) hg.getColumn(key).numFmt = MONEDA;
  hg.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNAS_PANTALLA.length } };

  const hp = wb.addWorksheet('Por Obra');
  hp.columns = [
    { header: 'Obra (KAOS)', key: 'obra',       width: 46 },
    { header: 'KP',          key: 'kaosCode',   width: 12 },
    { header: 'Código ERP',  key: 'codigoErp',  width: 34 },
    { header: 'Estado obra', key: 'estadoObra', width: 12 },
    { header: 'Documentos',  key: 'documentos', width: 12 },
    { header: 'Subtotal',    key: 'subtotal',   width: 16 },
    { header: 'IVA',         key: 'iva',        width: 14 },
    { header: 'Total',       key: 'total',      width: 16 },
  ];
  for (const row of agrupar(filas, f => f.proyectoId || f.codigoErp, f => ({
    obra: f.obra, kaosCode: f.kaosCode, codigoErp: f.codigoErp,
    estadoObra: f.proyectoId ? (f.obraActiva ? 'Activa' : 'Inactiva') : '',
  }))) hp.addRow(row);
  encabezado(hp);
  for (const key of ['subtotal', 'iva', 'total']) hp.getColumn(key).numFmt = MONEDA;

  const hpr = wb.addWorksheet('Por Proveedor');
  hpr.columns = [
    { header: 'Proveedor',  key: 'proveedor',    width: 40 },
    { header: 'NIT',        key: 'proveedorNit', width: 16 },
    { header: 'Documentos', key: 'documentos',   width: 12 },
    { header: 'Total',      key: 'total',        width: 16 },
  ];
  for (const row of agrupar(filas, f => f.proveedorNit || '(sin proveedor)', f => ({
    proveedor: f.proveedorNombre || (f.origen === 'salida_almacen' ? '(salida de almacén)' : '(sin proveedor)'),
    proveedorNit: f.proveedorNit,
  }))) hpr.addRow(row);
  encabezado(hpr);
  hpr.getColumn('total').numFmt = MONEDA;

  const ht = wb.addWorksheet('Por Tipo de Gasto');
  ht.columns = [
    { header: 'Tipo de gasto', key: 'tipoGasto',  width: 24 },
    { header: 'Documentos',    key: 'documentos', width: 12 },
    { header: 'Total',         key: 'total',      width: 16 },
  ];
  for (const row of agrupar(filas, f => f.tipoGasto, f => ({ tipoGasto: f.tipoGasto }))) ht.addRow(row);
  encabezado(ht);
  ht.getColumn('total').numFmt = MONEDA;

  const tot = agrupar(filas, () => 'todo')[0] || { documentos: 0, subtotal: 0, iva: 0, total: 0 };
  const hr = wb.addWorksheet('Resumen');
  hr.columns = [
    { header: 'Concepto', key: 'concepto', width: 30 },
    { header: 'Valor',    key: 'valor',    width: 48 },
  ];
  hr.addRow({ concepto: 'Documentos de gasto', valor: tot.documentos });
  hr.addRow({ concepto: 'Subtotal',            valor: tot.subtotal });
  hr.addRow({ concepto: 'IVA',                 valor: tot.iva });
  hr.addRow({ concepto: 'Total',               valor: tot.total });
  hr.addRow({ concepto: 'Filtros',             valor: descripcion.length ? descripcion.join(' · ') : 'Ninguno (todo el histórico)' });
  hr.addRow({ concepto: 'Generado',            valor: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }) });
  encabezado(hr);
  for (let i = 3; i <= 5; i++) hr.getRow(i).getCell('valor').numFmt = MONEDA;

  return wb.xlsx.writeBuffer();
}

module.exports = { generarXlsx, exportarXlsx, generarXlsxControl, NOMBRE_ARCHIVO };
