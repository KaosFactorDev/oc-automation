'use strict';
/**
 * remisionTemplate.js
 * Genera la Remisión de Materiales asociada a un Requerimiento aprobado.
 * Produce HTML imprimible y Excel (.xlsx) con diseño consistente con la OC.
 *
 * Entrada:
 *   rem = {
 *     numero,                     // consecutivo del requerimiento o numeroOC
 *     fecha,                      // DD/MM/YYYY
 *     proyecto, lugarEntrega,
 *     responsableEntrega, responsableRecepcion,
 *     observaciones,
 *     items: [{ descripcion, unidad, cantidad, observacion }]
 *   }
 *   cfg = configApp.getConfig()
 */

const ExcelJS = require('exceljs');

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function generarHTML(rem, cfg) {
  const emisor   = cfg.emisor   || {};
  const firmante = cfg.firmante || {};
  const logoHtml = cfg.logo
    ? `<img src="${esc(cfg.logo)}" alt="logo" style="max-width:160px;max-height:60px;object-fit:contain">`
    : `<div style="width:140px;height:44px;background:#6b1f2a;color:#fff;display:grid;place-items:center;font-weight:700;letter-spacing:.06em">CIVILTECH</div>`;

  const items = rem.items || [];
  const filasItems = items.map((it, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.descripcion || '')}</td>
      <td class="c">${esc(it.unidad || 'UND')}</td>
      <td class="r">${Number(it.cantidad || 0).toLocaleString('es-CO')}</td>
      <td>${esc(it.observacion || '')}</td>
    </tr>`).join('');
  const filasRelleno = Array.from({ length: Math.max(0, 14 - items.length) })
    .map(() => `<tr class="vacio"><td colspan="5">&nbsp;</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Remisión ${esc(rem.numero || '—')}</title>
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

  .obs{margin-top:14px;border:1px solid var(--b);border-radius:4px;padding:10px 12px}
  .obs h3{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:0 0 4px;font-weight:600}
  .obs p{margin:0;line-height:1.5;white-space:pre-wrap;font-size:10px;min-height:24px}

  .firma{margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
  .firma .sig{text-align:center}
  .firma .line{border-top:1px solid var(--txt);margin:40px 10px 4px}
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
      <h1>REMISIÓN DE MATERIALES</h1>
      <div class="num">N° ${esc(rem.numero || '—')}</div>
      <div class="doc">Asociada a req. ${esc(rem.consecutivoReq || rem.numero || '—')}</div>
    </div>
  </div>

  ${rem.estado === 'anulada' ? `
    <div style="border:2px solid #a10; background:#fde6e6; color:#a10; padding:10px 14px; border-radius:4px; margin-bottom:12px; font-size:11px">
      <strong>REMISIÓN ANULADA</strong>
      ${rem.motivoAnulacion ? `<div style="margin-top:3px;color:#611">${esc(rem.motivoAnulacion)}</div>` : ''}
    </div>` : ''}
  ${rem.estado === 'requiere-reemplazo' ? `
    <div style="border:2px solid #b87700; background:#fff4d6; color:#8a5a00; padding:10px 14px; border-radius:4px; margin-bottom:12px; font-size:11px">
      <strong>REQUIERE REEMPLAZO</strong>
      ${rem.alertas ? `<div style="margin-top:3px;white-space:pre-wrap">${esc(rem.alertas)}</div>` : ''}
    </div>` : ''}

  <div class="meta">
    <div class="box">
      <div class="lbl">Proyecto / Destino</div>
      <div class="val">
        <strong>${esc(rem.proyecto || '—')}</strong>
        ${esc(rem.lugarEntrega || '')}
      </div>
    </div>
    <div class="box">
      <div class="lbl">Solicitante</div>
      <div class="val">
        <strong>${esc(rem.solicitante || '—')}</strong>
        ${esc(rem.cargo || '')}
      </div>
    </div>
  </div>

  <div class="mini-grid">
    <div class="mini"><div class="lbl">Fecha</div><div class="val mono">${esc(rem.fecha || '')}</div></div>
    <div class="mini"><div class="lbl">Ítems</div><div class="val">${items.length}</div></div>
    <div class="mini"><div class="lbl">OC asociadas</div><div class="val mono">${esc(rem.ocsAsociadas || '—')}</div></div>
  </div>

  <table class="items">
    <thead><tr>
      <th style="width:5%">#</th>
      <th style="width:52%">Descripción</th>
      <th style="width:10%">Unidad</th>
      <th style="width:12%">Cantidad</th>
      <th style="width:21%">Observación</th>
    </tr></thead>
    <tbody>
      ${filasItems}
      ${filasRelleno}
    </tbody>
  </table>

  <div class="obs">
    <h3>Observaciones</h3>
    <p>${esc(rem.observaciones || '—')}</p>
  </div>

  <div class="firma">
    <div class="sig">
      <div class="line"></div>
      <strong>${esc(rem.responsableEntrega || firmante.nombre || '')}</strong>
      <span>Entrega</span>
    </div>
    <div class="sig">
      <div class="line"></div>
      <strong>${esc(rem.responsableRecepcion || '')}</strong>
      <span>Recibe — firma, nombre y fecha</span>
    </div>
  </div>

  <div class="pie">
    <span>${esc(emisor.razonSocial || '')}</span>
    <span>Remisión de materiales</span>
    <span>Generado ${new Date().toLocaleString('es-CO')}</span>
  </div>
</div>

</body>
</html>`;
}

async function generarExcelBuffer(rem, cfg) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OC Automation';
  wb.created = new Date();
  const ws = wb.addWorksheet('Remisión', {
    pageSetup: { paperSize: 1, orientation: 'portrait', margins: { left:.4, right:.4, top:.5, bottom:.5, header:.3, footer:.3 } },
    views: [{ showGridLines: false }],
  });

  ws.columns = [
    { width: 5 }, { width: 38 }, { width: 10 }, { width: 12 }, { width: 22 },
  ];

  const T      = 'FF6B1F2A';
  const MUTED  = 'FF5A6478';
  const BG_EVEN = 'FFFBF6F7';
  const BORDER = 'FFD4DAE2';
  const WHITE  = 'FFFFFFFF';
  const thin   = { style: 'thin', color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  if (cfg.logo && cfg.logo.startsWith('data:image/')) {
    try {
      const m = cfg.logo.match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        const ext = m[1] === 'jpeg' ? 'jpeg' : m[1];
        const imgId = wb.addImage({ buffer: Buffer.from(m[2], 'base64'), extension: ext });
        ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 160, height: 50 } });
      }
    } catch { /* ignore */ }
  }

  const emisor = cfg.emisor || {};
  ws.mergeCells('A1:B3');
  ws.mergeCells('C1:C3');
  ws.getCell('C1').value = {
    richText: [
      { text: (emisor.razonSocial || '') + '\n', font: { bold: true, color: { argb: T }, size: 11 } },
      { text: 'NIT ' + (emisor.nit || '') + '\n', font: { size: 9, color: { argb: MUTED } } },
      { text: (emisor.direccion || '') + '\n', font: { size: 9, color: { argb: MUTED } } },
      { text: (emisor.ciudad || '') + (emisor.telefono ? ' · Tel. ' + emisor.telefono : ''), font: { size: 9, color: { argb: MUTED } } },
    ],
  };
  ws.getCell('C1').alignment = { vertical: 'middle', wrapText: true };

  ws.mergeCells('D1:E1');
  ws.getCell('D1').value = 'REMISIÓN DE MATERIALES';
  ws.getCell('D1').font = { bold: true, color: { argb: T }, size: 14 };
  ws.getCell('D1').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.mergeCells('D2:E2');
  ws.getCell('D2').value = 'N° ' + (rem.numero || '—');
  ws.getCell('D2').font = { bold: true, size: 18, name: 'Consolas' };
  ws.getCell('D2').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.mergeCells('D3:E3');
  ws.getCell('D3').value = 'Req. ' + (rem.consecutivoReq || rem.numero || '—');
  ws.getCell('D3').font = { size: 9, color: { argb: MUTED } };
  ws.getCell('D3').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.getRow(1).height = 20; ws.getRow(2).height = 22; ws.getRow(3).height = 18;
  for (let col = 1; col <= 5; col++) {
    ws.getCell(4, col).border = { bottom: { style: 'medium', color: { argb: T } } };
  }
  ws.getRow(4).height = 4;

  // Meta
  ws.getCell('A5').value = 'PROYECTO / DESTINO';
  ws.getCell('C5').value = 'SOLICITANTE';
  for (const c of ['A5','C5']) {
    ws.getCell(c).font = { bold: true, size: 8, color: { argb: MUTED } };
  }
  ws.mergeCells('A5:B5'); ws.mergeCells('C5:E5');

  ws.mergeCells('A6:B9');
  ws.getCell('A6').value = {
    richText: [
      { text: (rem.proyecto || '—') + '\n', font: { bold: true, size: 11, color: { argb: T } } },
      { text: rem.lugarEntrega || '', font: { size: 9, color: { argb: MUTED } } },
    ],
  };
  ws.getCell('A6').alignment = { vertical: 'top', wrapText: true };
  for (let r = 6; r <= 9; r++) for (let c = 1; c <= 2; c++) ws.getCell(r, c).border = border;

  ws.mergeCells('C6:E9');
  ws.getCell('C6').value = {
    richText: [
      { text: (rem.solicitante || '—') + '\n', font: { bold: true, size: 11, color: { argb: T } } },
      { text: rem.cargo || '', font: { size: 9, color: { argb: MUTED } } },
    ],
  };
  ws.getCell('C6').alignment = { vertical: 'top', wrapText: true };
  for (let r = 6; r <= 9; r++) for (let c = 3; c <= 5; c++) ws.getCell(r, c).border = border;

  // Mini-grid fechas
  ws.getCell('A11').value = 'Fecha';     ws.getCell('A12').value = rem.fecha || '';
  ws.getCell('B11').value = 'Ítems';     ws.getCell('B12').value = (rem.items || []).length;
  ws.mergeCells('C11:E11'); ws.mergeCells('C12:E12');
  ws.getCell('C11').value = 'OC asociadas'; ws.getCell('C12').value = rem.ocsAsociadas || '—';
  for (const c of ['A11','B11','C11']) ws.getCell(c).font = { bold: true, size: 8, color: { argb: MUTED } };
  for (let r = 11; r <= 12; r++) for (let c = 1; c <= 5; c++) ws.getCell(r, c).border = border;

  // Items
  const HEAD = 14;
  const heads = ['#','Descripción','Unidad','Cantidad','Observación'];
  heads.forEach((h, i) => {
    const cell = ws.getCell(HEAD, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: WHITE }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T } };
    cell.alignment = { vertical: 'middle', horizontal: i === 1 || i === 4 ? 'left' : 'center' };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin, color: { argb: T } };
  });
  ws.getRow(HEAD).height = 22;

  const items = rem.items || [];
  const FILAS = Math.max(14, items.length);
  for (let i = 0; i < FILAS; i++) {
    const r = HEAD + 1 + i;
    const it = items[i];
    const row = ws.getRow(r);
    row.height = 16;
    if (it) {
      row.values = [i + 1, it.descripcion || '', it.unidad || 'UND', Number(it.cantidad || 0), it.observacion || ''];
    }
    for (let col = 1; col <= 5; col++) {
      const cell = ws.getCell(r, col);
      cell.border = border;
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_EVEN } };
      cell.font = { size: 9 };
      if (col === 1 || col === 3) cell.alignment = { horizontal: 'center' };
      if (col === 4) cell.alignment = { horizontal: 'right' };
      if (col === 2 || col === 5) cell.alignment = { horizontal: 'left', wrapText: true };
    }
  }

  // Observaciones
  const OBS = HEAD + 1 + FILAS + 1;
  ws.getCell(OBS, 1).value = 'Observaciones';
  ws.getCell(OBS, 1).font = { bold: true, size: 8, color: { argb: MUTED } };
  ws.mergeCells(OBS, 1, OBS, 5);
  ws.mergeCells(OBS + 1, 1, OBS + 3, 5);
  ws.getCell(OBS + 1, 1).value = rem.observaciones || '';
  ws.getCell(OBS + 1, 1).alignment = { vertical: 'top', wrapText: true };
  ws.getCell(OBS + 1, 1).font = { size: 9 };
  for (let r = OBS + 1; r <= OBS + 3; r++) for (let c = 1; c <= 5; c++) ws.getCell(r, c).border = border;

  // Firmas
  const FIR = OBS + 6;
  ws.mergeCells(FIR, 1, FIR, 2);
  ws.mergeCells(FIR, 3, FIR, 5);
  const firm = cfg.firmante || {};
  ws.getCell(FIR, 1).value = {
    richText: [
      { text: (rem.responsableEntrega || firm.nombre || '') + '\n', font: { bold: true, size: 9 } },
      { text: 'Entrega', font: { size: 8, color: { argb: MUTED } } },
    ],
  };
  ws.getCell(FIR, 3).value = {
    richText: [
      { text: (rem.responsableRecepcion || '') + '\n', font: { bold: true, size: 9 } },
      { text: 'Recibe — firma, nombre y fecha', font: { size: 8, color: { argb: MUTED } } },
    ],
  };
  ws.getCell(FIR, 1).alignment = { vertical: 'bottom', horizontal: 'center', wrapText: true };
  ws.getCell(FIR, 3).alignment = { vertical: 'bottom', horizontal: 'center', wrapText: true };
  ws.getCell(FIR, 1).border = { top: { style: 'thin', color: { argb: 'FF1A2430' } } };
  ws.getCell(FIR, 3).border = { top: { style: 'thin', color: { argb: 'FF1A2430' } } };
  ws.getRow(FIR).height = 36;

  return wb.xlsx.writeBuffer();
}

module.exports = { generarHTML, generarExcelBuffer };
