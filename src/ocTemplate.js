'use strict';
/**
 * ocTemplate.js
 * Motor de plantilla de Orden de Compra. Produce dos artefactos a partir
 * del mismo objeto OC:
 *   - HTML con estilos de impresión (el usuario descarga PDF desde el navegador)
 *   - Excel (.xlsx) con diseño profesional vía ExcelJS
 *
 * Diseño moderno (no fiel a la plantilla original). La plantilla antigua
 * sólo se usó como referencia de contenido (campos requeridos, firmante,
 * documento No.).
 *
 * Entrada: objeto OC con forma
 *   {
 *     numeroOC, fecha, proyecto,
 *     proveedor: { nombre, nit, direccion, telefono, correo, municipio },
 *     lugarEntrega, fechaEntrega, fechaEntregaPrevista, requerimientoOrigen,
 *     condicionesComerciales, observaciones,
 *     items: [{ descripcion, unidad, cantidad, precioUnitario, descuentoPct, ivaPct }],
 *     subtotal, iva, total,         // opcionalmente precalculados
 *   }
 * Config: objeto devuelto por configApp.getConfig()
 */

const ExcelJS = require('exceljs');

// ── Cálculos ──────────────────────────────────────────────────────────────────

function calcularTotales(oc) {
  const items = (oc.items || []).map(it => {
    const cant = Number(it.cantidad || 0);
    const pu   = Number(it.precioUnitario || 0);
    const dto  = Number(it.descuentoPct || 0) / 100;
    const iva  = Number(it.ivaPct || 0) / 100;
    const base = cant * pu * (1 - dto);
    const ivaV = base * iva;
    return { ...it, _base: base, _iva: ivaV, _total: base + ivaV };
  });
  const subtotal = items.reduce((s, it) => s + it._base, 0);
  const iva      = items.reduce((s, it) => s + it._iva,  0);
  const total    = subtotal + iva;
  return { items, subtotal, iva, total };
}

function money(n) {
  return '$ ' + Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function generarHTML(oc, cfg) {
  const c = calcularTotales(oc);
  const emisor = cfg.emisor || {};
  const firmante = cfg.firmante || {};
  const logoHtml = cfg.logo
    ? `<img src="${esc(cfg.logo)}" alt="logo" style="max-width:160px;max-height:60px;object-fit:contain">`
    : `<div style="width:140px;height:44px;background:#6b1f2a;color:#fff;display:grid;place-items:center;font-weight:700;letter-spacing:.06em">CIVILTECH</div>`;

  const filasItems = c.items.map((it, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.descripcion || '')}</td>
      <td class="c">${esc(it.unidad || 'UND')}</td>
      <td class="r">${Number(it.cantidad || 0).toLocaleString('es-CO')}</td>
      <td class="r mono">${money(it.precioUnitario)}</td>
      <td class="c">${Number(it.descuentoPct || 0).toFixed(0)}%</td>
      <td class="c">${Number(it.ivaPct || 0).toFixed(0)}%</td>
      <td class="r mono">${money(it._total)}</td>
    </tr>`).join('');

  const filasRelleno = Array.from({ length: Math.max(0, 12 - c.items.length) })
    .map(() => `<tr class="vacio"><td colspan="8">&nbsp;</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>OC ${esc(oc.numeroOC || '—')}</title>
<style>
  :root{--t:#6b1f2a;--t2:#8b2a38;--b:#d4dae2;--txt:#1a2430;--muted:#5a6478;--soft:#fbf6f7;}
  *{box-sizing:border-box}
  @page{size:letter;margin:15mm 12mm 14mm 12mm}
  body{font-family:'Segoe UI',Arial,sans-serif;color:var(--txt);font-size:11px;margin:0;background:#fff}
  .wrap{max-width:190mm;margin:0 auto;padding:6mm 4mm}
  .mono{font-family:'Consolas','Courier New',monospace;font-variant-numeric:tabular-nums}
  .c{text-align:center}.r{text-align:right}.l{text-align:left}

  .hdr{display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:center;border-bottom:3px solid var(--t);padding-bottom:10px;margin-bottom:14px}
  .hdr .emisor{font-size:10px;line-height:1.45;color:var(--muted)}
  .hdr .emisor strong{display:block;color:var(--t);font-size:12px;letter-spacing:.02em}
  .hdr .titulo{text-align:right}
  .hdr .titulo h1{font-size:16px;color:var(--t);letter-spacing:.1em;margin:0;font-weight:700}
  .hdr .titulo .num{font-family:'Consolas',monospace;font-size:20px;color:#1a2430;margin-top:3px;font-weight:600}
  .hdr .titulo .doc{font-size:9px;color:var(--muted);margin-top:2px}

  .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .box{border:1px solid var(--b);border-radius:4px;padding:9px 11px}
  .box .lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;font-weight:600}
  .box .val{font-size:11px;color:var(--txt);line-height:1.45}
  .box .val strong{display:block;font-size:12px;color:var(--t);margin-bottom:2px}

  .mini-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
  .mini{border:1px solid var(--b);border-radius:3px;padding:6px 10px;font-size:10px}
  .mini .lbl{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
  .mini .val{margin-top:2px;color:var(--txt)}

  table.items{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:10px}
  table.items thead th{background:var(--t);color:#fff;padding:7px 6px;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--t)}
  table.items tbody td{border:1px solid var(--b);padding:5px 7px;vertical-align:middle}
  table.items tbody tr.vacio td{height:18px;color:transparent}
  table.items tbody tr:nth-child(even):not(.vacio){background:var(--soft)}

  .tot{display:grid;grid-template-columns:1fr 260px;gap:8px;margin-top:6px;margin-bottom:12px}
  .tot .obs{font-size:9px;color:var(--muted);padding:6px}
  .tot table{width:100%;border-collapse:collapse}
  .tot table td{padding:6px 10px;font-size:11px;border:1px solid var(--b)}
  .tot table td.lbl{background:var(--soft);color:var(--muted);text-transform:uppercase;font-size:9px;letter-spacing:.06em;font-weight:600;width:55%}
  .tot table tr.gran td{background:var(--t);color:#fff;font-weight:700;font-size:13px;border-color:var(--t)}

  .textos{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .textos .box h3{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:0 0 4px;font-weight:600}
  .textos .box p{margin:0;line-height:1.5;white-space:pre-wrap;font-size:10px}

  .firma{margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
  .firma .sig{text-align:center}
  .firma .line{border-top:1px solid var(--txt);margin:30px 10px 4px}
  .firma .sig strong{display:block;font-size:10px}
  .firma .sig span{display:block;font-size:9px;color:var(--muted)}

  .pie{margin-top:20px;padding-top:8px;border-top:1px solid var(--b);display:flex;justify-content:space-between;font-size:8px;color:var(--muted)}

  @media print{
    .no-print{display:none !important}
    body{background:#fff}
    .wrap{max-width:none;padding:0}
  }
  .no-print{position:fixed;top:14px;right:14px;z-index:10;display:flex;gap:8px}
  .no-print button{padding:8px 14px;border:none;border-radius:5px;font-size:12px;font-weight:500;cursor:pointer}
  .btn-pdf{background:var(--t);color:#fff}
  .btn-close{background:#e6e9ee;color:#1a2430}

  .marca-agua{
    position:fixed;top:50%;left:50%;
    transform:translate(-50%,-50%) rotate(-45deg);
    font-size:80px;font-weight:900;
    color:rgba(160,20,20,0.13);
    white-space:nowrap;pointer-events:none;user-select:none;
    z-index:0;letter-spacing:10px;
    font-family:'Segoe UI',Arial,sans-serif;
  }
</style>
</head>
<body>

<div class="no-print">
  <button class="btn-pdf" onclick="window.print()">Imprimir / Guardar PDF</button>
  <button class="btn-close" onclick="cerrarVista()">Cerrar</button>
</div>

<script>
// window.close() solo funciona en pestanas abiertas por script, y esta vista se
// abre con un <a target="_blank"> normal, asi que el navegador lo ignora en
// silencio. Si la pestana sigue viva tras intentarlo, volver atras es lo mas
// cercano a cerrarla; si se abrio sin historial previo, no queda a donde ir y
// se avisa en vez de dejar el boton mudo.
function cerrarVista() {
  window.close();
  setTimeout(function () {
    if (window.closed) return;
    if (history.length > 1) history.back();
    else alert('Cierra esta pestana con Ctrl+W (el navegador no permite que la pagina se cierre sola).');
  }, 120);
}
</script>

${oc.estado === 'borrador' ? '<div class="marca-agua">NO APROBADO</div>'
  : oc.estado === 'anulada' ? '<div class="marca-agua">ANULADO</div>'
  : ''}

<div class="wrap">
  <div class="hdr">
    <div class="logo">${logoHtml}</div>
    <div class="emisor">
      <strong>${esc(emisor.razonSocial || '')}</strong>
      NIT ${esc(emisor.nit || '')}<br>
      ${esc(emisor.direccion || '')}<br>
      ${esc(emisor.ciudad || '')}
      ${emisor.telefono ? `· Tel. ${esc(emisor.telefono)}` : ''}
      ${emisor.correo   ? `· ${esc(emisor.correo)}`       : ''}
    </div>
    <div class="titulo">
      <h1>ORDEN DE COMPRA</h1>
      <div class="num">N° ${esc(oc.numeroOC || '—')}</div>
      <div class="doc">CT-ADMIN-FO-006</div>
    </div>
  </div>

  <div class="meta">
    <div class="box">
      <div class="lbl">Proveedor</div>
      <div class="val">
        <strong>${esc(oc.proveedor?.nombre || '—')}</strong>
        NIT ${esc(oc.proveedor?.nit || '—')}<br>
        ${esc(oc.proveedor?.direccion || '')}${oc.proveedor?.municipio ? ' · ' + esc(oc.proveedor.municipio) : ''}<br>
        ${oc.proveedor?.telefono ? 'Tel. ' + esc(oc.proveedor.telefono) : ''}
        ${oc.proveedor?.correo   ? ' · ' + esc(oc.proveedor.correo)     : ''}
      </div>
    </div>
    <div class="box">
      <div class="lbl">Proyecto / Destino</div>
      <div class="val">
        <strong>${esc(oc.proyecto || '—')}</strong>
        ${esc(oc.lugarEntrega || '')}
      </div>
    </div>
  </div>

  <div class="mini-grid">
    <div class="mini"><div class="lbl">Fecha emisión</div><div class="val mono">${esc(oc.fecha || '')}</div></div>
    <div class="mini"><div class="lbl">Fecha entrega</div><div class="val mono">${esc(oc.fechaEntregaPrevista || oc.fechaEntrega || '—')}</div></div>
    <div class="mini"><div class="lbl">Requerimiento</div><div class="val">${esc(oc.requerimientoOrigen || '—')}</div></div>
  </div>

  <table class="items">
    <thead><tr>
      <th style="width:4%">#</th>
      <th style="width:44%">Descripción</th>
      <th style="width:7%">Unidad</th>
      <th style="width:8%">Cant.</th>
      <th style="width:12%">P. Unitario</th>
      <th style="width:6%">Dto.</th>
      <th style="width:6%">IVA</th>
      <th style="width:13%">Subtotal</th>
    </tr></thead>
    <tbody>
      ${filasItems}
      ${filasRelleno}
    </tbody>
  </table>

  <div class="tot">
    <div class="obs">&nbsp;</div>
    <table>
      <tr><td class="lbl">Subtotal</td><td class="r mono">${money(c.subtotal)}</td></tr>
      <tr><td class="lbl">IVA</td><td class="r mono">${money(c.iva)}</td></tr>
      <tr class="gran"><td class="lbl" style="color:#fff">TOTAL</td><td class="r mono">${money(c.total)}</td></tr>
    </table>
  </div>

  <div class="textos">
    <div class="box">
      <h3>Condiciones comerciales</h3>
      <p>${esc(oc.condicionesComerciales || '—')}</p>
    </div>
    <div class="box">
      <h3>Observaciones</h3>
      <p>${esc(oc.observaciones || '—')}</p>
    </div>
  </div>

  <div class="firma">
    <div class="sig">
      <div class="line"></div>
      <strong>${esc(firmante.nombre || '')}</strong>
      <span>${esc(firmante.cargo || '')}</span>
    </div>
    <div class="sig">
      <div class="line"></div>
      <strong>Aceptación del proveedor</strong>
      <span>Firma, nombre y fecha</span>
    </div>
  </div>

  <div class="pie">
    <span>${esc(emisor.razonSocial || '')}</span>
    <span>Documento: CT-ADMIN-FO-006</span>
    <span>Generado ${new Date().toLocaleString('es-CO')}</span>
  </div>
</div>

</body>
</html>`;
}

// ── Excel ─────────────────────────────────────────────────────────────────────

async function generarExcelBuffer(oc, cfg) {
  const c = calcularTotales(oc);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OC Automation';
  wb.created = new Date();
  const ws = wb.addWorksheet('OC', {
    pageSetup: { paperSize: 1, orientation: 'portrait', margins: { left:.4, right:.4, top:.5, bottom:.5, header:.3, footer:.3 } },
    views: [{ showGridLines: false }],
  });

  // Ancho columnas (8 cols = A..H)
  ws.columns = [
    { width: 5 }, { width: 32 }, { width: 8 }, { width: 9 },
    { width: 14 }, { width: 7 }, { width: 7 }, { width: 15 },
  ];

  const T  = 'FF6B1F2A'; // Civiltech burgundy
  const T2 = 'FF8B2A38';
  const MUTED = 'FF5A6478';
  const BG_EVEN = 'FFFBF6F7';
  const BG_LBL  = 'FFFBF6F7';
  const BORDER  = 'FFD4DAE2';
  const WHITE   = 'FFFFFFFF';

  const thin = { style: 'thin', color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  // ── Logo (si hay data-URL) ──
  let filaInicio = 1;
  if (cfg.logo && cfg.logo.startsWith('data:image/')) {
    try {
      const m = cfg.logo.match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        const ext = m[1] === 'jpeg' ? 'jpeg' : m[1];
        const imgId = wb.addImage({ buffer: Buffer.from(m[2], 'base64'), extension: ext });
        ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 160, height: 50 } });
      }
    } catch { /* ignorar logo inválido */ }
  }

  // ── Encabezado ──
  ws.mergeCells('A1:C3');
  ws.mergeCells('D1:E3');
  const emisor = cfg.emisor || {};
  const infoEmisor = ws.getCell('D1');
  infoEmisor.value = {
    richText: [
      { text: (emisor.razonSocial || '') + '\n', font: { bold: true, color: { argb: T }, size: 11 } },
      { text: 'NIT ' + (emisor.nit || '') + '\n', font: { size: 9, color: { argb: MUTED } } },
      { text: (emisor.direccion || '') + '\n', font: { size: 9, color: { argb: MUTED } } },
      { text: (emisor.ciudad || '') + (emisor.telefono ? ' · Tel. ' + emisor.telefono : ''), font: { size: 9, color: { argb: MUTED } } },
    ],
  };
  infoEmisor.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

  ws.mergeCells('F1:H1');
  ws.getCell('F1').value = 'ORDEN DE COMPRA';
  ws.getCell('F1').font = { bold: true, color: { argb: T }, size: 14 };
  ws.getCell('F1').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.mergeCells('F2:H2');
  ws.getCell('F2').value = 'N° ' + (oc.numeroOC || '—');
  ws.getCell('F2').font = { bold: true, color: { argb: 'FF1A2430' }, size: 18, name: 'Consolas' };
  ws.getCell('F2').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.mergeCells('F3:H3');
  ws.getCell('F3').value = 'Doc. CT-ADMIN-FO-006';
  ws.getCell('F3').font = { size: 9, color: { argb: MUTED } };
  ws.getCell('F3').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.getRow(1).height = 20; ws.getRow(2).height = 22; ws.getRow(3).height = 18;

  // Línea divisoria
  for (let col = 1; col <= 8; col++) {
    ws.getCell(4, col).border = { bottom: { style: 'medium', color: { argb: T } } };
  }
  ws.getRow(4).height = 4;

  // ── Meta: proveedor + proyecto ──
  ws.getCell('A5').value = 'PROVEEDOR';
  ws.getCell('A5').font = { bold: true, size: 8, color: { argb: MUTED } };
  ws.mergeCells('A5:D5');

  ws.getCell('E5').value = 'PROYECTO / DESTINO';
  ws.getCell('E5').font = { bold: true, size: 8, color: { argb: MUTED } };
  ws.mergeCells('E5:H5');

  ws.mergeCells('A6:D9');
  const prov = oc.proveedor || {};
  ws.getCell('A6').value = {
    richText: [
      { text: (prov.nombre || '—') + '\n', font: { bold: true, size: 11, color: { argb: T } } },
      { text: 'NIT ' + (prov.nit || '—') + '\n', font: { size: 10 } },
      { text: (prov.direccion || '') + (prov.municipio ? ' · ' + prov.municipio : '') + '\n', font: { size: 9, color: { argb: MUTED } } },
      { text: (prov.telefono ? 'Tel. ' + prov.telefono : '') + (prov.correo ? ' · ' + prov.correo : ''), font: { size: 9, color: { argb: MUTED } } },
    ],
  };
  ws.getCell('A6').alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
  for (let r = 6; r <= 9; r++) for (let c = 1; c <= 4; c++) ws.getCell(r, c).border = border;

  ws.mergeCells('E6:H9');
  ws.getCell('E6').value = {
    richText: [
      { text: (oc.proyecto || '—') + '\n', font: { bold: true, size: 11, color: { argb: T } } },
      { text: (oc.lugarEntrega || ''), font: { size: 9, color: { argb: MUTED } } },
    ],
  };
  ws.getCell('E6').alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
  for (let r = 6; r <= 9; r++) for (let col = 5; col <= 8; col++) ws.getCell(r, col).border = border;

  // ── Mini-grid: fechas ──
  const mini = [
    ['Fecha emisión',  oc.fecha || ''],
    ['Fecha entrega',  oc.fechaEntregaPrevista || oc.fechaEntrega || '—'],
    ['Requerimiento',  oc.requerimientoOrigen || '—'],
  ];
  const minis = [['A11','B11','C11'], ['D11','E11','F11'], ['G11','H11','H11']];
  ws.getCell('A11').value = 'Fecha emisión';    ws.mergeCells('A11:B11');
  ws.getCell('A12').value = oc.fecha || '';      ws.mergeCells('A12:B12');
  ws.getCell('C11').value = 'Fecha entrega';     ws.mergeCells('C11:D11');
  ws.getCell('C12').value = oc.fechaEntregaPrevista || oc.fechaEntrega || '—'; ws.mergeCells('C12:D12');
  ws.getCell('E11').value = 'Requerimiento';     ws.mergeCells('E11:H11');
  ws.getCell('E12').value = oc.requerimientoOrigen || '—'; ws.mergeCells('E12:H12');
  for (const col of ['A11','C11','E11']) {
    ws.getCell(col).font = { bold: true, size: 8, color: { argb: MUTED } };
  }
  for (const rc of ['A12','C12','E12']) {
    ws.getCell(rc).font = { size: 10 };
    ws.getCell(rc).alignment = { vertical: 'middle', wrapText: true };
  }
  for (let r = 11; r <= 12; r++) for (let c = 1; c <= 8; c++) ws.getCell(r, c).border = border;

  // ── Encabezado de items ──
  const HEAD_ROW = 14;
  const heads = ['#','Descripción','Unidad','Cant.','P. Unitario','Dto.','IVA','Subtotal'];
  heads.forEach((h, i) => {
    const cell = ws.getCell(HEAD_ROW, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: WHITE }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T } };
    cell.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'center' };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin, color: { argb: T } };
  });
  ws.getRow(HEAD_ROW).height = 22;

  // ── Items ──
  const FILAS = Math.max(12, c.items.length);
  for (let i = 0; i < FILAS; i++) {
    const r = HEAD_ROW + 1 + i;
    const it = c.items[i];
    const row = ws.getRow(r);
    row.height = 16;
    if (it) {
      row.values = [
        i + 1,
        it.descripcion || '',
        it.unidad || 'UND',
        Number(it.cantidad || 0),
        Number(it.precioUnitario || 0),
        Number(it.descuentoPct || 0) / 100,
        Number(it.ivaPct || 0) / 100,
        it._total,
      ];
    }
    for (let col = 1; col <= 8; col++) {
      const cell = ws.getCell(r, col);
      cell.border = border;
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_EVEN } };
      cell.font = { size: 9 };
      if (col === 1 || col === 3 || col === 6 || col === 7) cell.alignment = { horizontal: 'center' };
      if (col === 4) cell.alignment = { horizontal: 'right' };
      if (col === 5 || col === 8) { cell.numFmt = '"$ "#,##0'; cell.alignment = { horizontal: 'right' }; }
      if (col === 6 || col === 7) cell.numFmt = '0%';
      if (col === 2) cell.alignment = { horizontal: 'left', wrapText: true };
    }
  }

  // ── Totales ──
  const TOT_ROW = HEAD_ROW + 1 + FILAS;
  const tot = [
    ['Subtotal', c.subtotal, false],
    ['IVA',      c.iva,      false],
    ['TOTAL',    c.total,    true],
  ];
  tot.forEach((t, i) => {
    const r = TOT_ROW + i;
    ws.getCell(r, 7).value = t[0];
    ws.getCell(r, 8).value = t[1];
    ws.getCell(r, 7).alignment = { horizontal: 'right' };
    ws.getCell(r, 8).alignment = { horizontal: 'right' };
    ws.getCell(r, 8).numFmt = '"$ "#,##0';
    ws.getCell(r, 7).border = border;
    ws.getCell(r, 8).border = border;
    if (t[2]) {
      ws.getCell(r, 7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T } };
      ws.getCell(r, 8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T } };
      ws.getCell(r, 7).font = { bold: true, color: { argb: WHITE }, size: 11 };
      ws.getCell(r, 8).font = { bold: true, color: { argb: WHITE }, size: 11 };
    } else {
      ws.getCell(r, 7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_LBL } };
      ws.getCell(r, 7).font = { bold: true, size: 9, color: { argb: MUTED } };
    }
  });

  // ── Textos: condiciones + observaciones ──
  const TEX_ROW = TOT_ROW + 4;
  ws.getCell(TEX_ROW,     1).value = 'Condiciones comerciales';
  ws.getCell(TEX_ROW,     5).value = 'Observaciones';
  for (const col of [1, 5]) {
    ws.getCell(TEX_ROW, col).font = { bold: true, size: 8, color: { argb: MUTED } };
  }
  ws.mergeCells(TEX_ROW, 1, TEX_ROW, 4);
  ws.mergeCells(TEX_ROW, 5, TEX_ROW, 8);
  ws.mergeCells(TEX_ROW + 1, 1, TEX_ROW + 3, 4);
  ws.mergeCells(TEX_ROW + 1, 5, TEX_ROW + 3, 8);
  ws.getCell(TEX_ROW + 1, 1).value = oc.condicionesComerciales || '';
  ws.getCell(TEX_ROW + 1, 5).value = oc.observaciones || '';
  for (const rc of [ [TEX_ROW + 1, 1], [TEX_ROW + 1, 5] ]) {
    ws.getCell(...rc).alignment = { vertical: 'top', wrapText: true };
    ws.getCell(...rc).font = { size: 9 };
  }
  for (let r = TEX_ROW + 1; r <= TEX_ROW + 3; r++) for (let col = 1; col <= 8; col++) ws.getCell(r, col).border = border;

  // ── Firma ──
  const FIR_ROW = TEX_ROW + 6;
  ws.mergeCells(FIR_ROW, 1, FIR_ROW, 4);
  ws.mergeCells(FIR_ROW, 5, FIR_ROW, 8);
  const firm = cfg.firmante || {};
  ws.getCell(FIR_ROW, 1).value = {
    richText: [
      { text: (firm.nombre || '') + '\n', font: { bold: true, size: 9 } },
      { text: firm.cargo || '', font: { size: 8, color: { argb: MUTED } } },
    ],
  };
  ws.getCell(FIR_ROW, 5).value = {
    richText: [
      { text: 'Aceptación del proveedor\n', font: { bold: true, size: 9 } },
      { text: 'Firma, nombre y fecha', font: { size: 8, color: { argb: MUTED } } },
    ],
  };
  ws.getCell(FIR_ROW, 1).alignment = { vertical: 'bottom', horizontal: 'center', wrapText: true };
  ws.getCell(FIR_ROW, 5).alignment = { vertical: 'bottom', horizontal: 'center', wrapText: true };
  ws.getCell(FIR_ROW, 1).border = { top: { style: 'thin', color: { argb: 'FF1A2430' } } };
  ws.getCell(FIR_ROW, 5).border = { top: { style: 'thin', color: { argb: 'FF1A2430' } } };
  ws.getRow(FIR_ROW).height = 34;

  return wb.xlsx.writeBuffer();
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  calcularTotales,
  generarHTML,
  generarExcelBuffer,
};
