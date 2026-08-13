'use strict';
/**
 * osTemplate.js
 * Motor de plantilla de Orden de Servicio. Produce HTML + Excel.
 *
 * Tipos de contrato:
 *   IVA_PLENO — IVA sobre cada ítem individualmente
 *   AIU       — IVA solo sobre la Utilidad (A + I + U calculados sobre subtotal)
 *
 * Entrada: objeto OS con forma
 *   {
 *     numeroOS, fecha, proyecto,
 *     proveedorNit, proveedorNombre,
 *     lugarPrestacion, fechaInicio, fechaFin,
 *     tipoServicio, clausulas,
 *     tipoContrato: 'IVA_PLENO' | 'AIU',
 *     items: [{ descripcion, unidad, cantidad, precioUnitario, ivaPct }],
 *     aiuA, aiuI, aiuU,            // % para tipo AIU
 *     condicionesComerciales, observaciones,
 *   }
 */

const ExcelJS = require('exceljs');

function money(n) {
  return '$ ' + Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 });
}
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function limpiarMarkdown(s) {
  return String(s ?? '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/#+\s+/g, '')
    .replace(/^\s*[-*]\s+/gm, '');
}

// ── Cálculos ──────────────────────────────────────────────────────────────────

function calcularTotales(os) {
  const items = (os.items || []).map(it => {
    const cant = Number(it.cantidad || 1);
    const pu   = Number(it.precioUnitario || 0);
    const iva  = Number(it.ivaPct || 0) / 100;
    const sub  = cant * pu;
    return { ...it, _sub: sub, _iva: sub * iva, _total: sub * (1 + iva) };
  });

  const tipo = os.tipoContrato || 'IVA_PLENO';

  if (tipo === 'AIU') {
    const subtotal = items.reduce((s, it) => s + it._sub, 0);
    const aPct = Number(os.aiuA || 0);
    const iPct = Number(os.aiuI || 0);
    const uPct = Number(os.aiuU || 0);
    const ivaPct = Number(os.ivaPct || 19);
    const A   = subtotal * aPct / 100;
    const I   = subtotal * iPct / 100;
    const U   = subtotal * uPct / 100;
    const iva = U * ivaPct / 100;
    const total = subtotal + A + I + U + iva;
    return { items, tipo, subtotal, A, I, U, aiuTotal: A + I + U, iva, total, aPct, iPct, uPct, ivaPct };
  } else {
    const subtotal = items.reduce((s, it) => s + it._sub,   0);
    const iva      = items.reduce((s, it) => s + it._iva,   0);
    const total    = subtotal + iva;
    return { items, tipo, subtotal, iva, total };
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function generarHTML(os, cfg) {
  const c        = calcularTotales(os);
  const emisor   = cfg.emisor   || {};
  const firmante = cfg.firmante || {};
  const logoHtml = cfg.logo
    ? `<img src="${esc(cfg.logo)}" alt="logo" style="max-width:160px;max-height:60px;object-fit:contain">`
    : `<div style="width:140px;height:44px;background:#6b1f2a;color:#fff;display:grid;place-items:center;font-weight:700;letter-spacing:.06em">CIVILTECH</div>`;

  // Filas de ítems
  const filasItems = c.items.map((it, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.descripcion || '')}</td>
      <td class="c">${esc(it.unidad || 'GLB')}</td>
      <td class="r">${Number(it.cantidad || 1).toLocaleString('es-CO')}</td>
      <td class="r mono">${money(it.precioUnitario)}</td>
      ${c.tipo === 'IVA_PLENO' ? `<td class="c">${Number(it.ivaPct || 0).toFixed(0)}%</td>` : ''}
      <td class="r mono">${money(it._sub)}</td>
    </tr>`).join('');


  // Bloque de totales
  let totalesHtml;
  if (c.tipo === 'AIU') {
    totalesHtml = `
      <tr><td class="lbl">Costos directos</td><td class="r mono">${money(c.subtotal)}</td></tr>
      <tr><td class="lbl">Administración (${c.aPct}%)</td><td class="r mono">${money(c.A)}</td></tr>
      <tr><td class="lbl">Imprevistos (${c.iPct}%)</td><td class="r mono">${money(c.I)}</td></tr>
      <tr><td class="lbl">Utilidad (${c.uPct}%)</td><td class="r mono">${money(c.U)}</td></tr>
      <tr><td class="lbl">IVA sobre utilidad (${c.ivaPct}%)</td><td class="r mono">${money(c.iva)}</td></tr>
      <tr class="gran"><td class="lbl" style="color:#fff">TOTAL</td><td class="r mono">${money(c.total)}</td></tr>`;
  } else {
    totalesHtml = `
      <tr><td class="lbl">Subtotal</td><td class="r mono">${money(c.subtotal)}</td></tr>
      <tr><td class="lbl">IVA</td><td class="r mono">${money(c.iva)}</td></tr>
      <tr class="gran"><td class="lbl" style="color:#fff">TOTAL</td><td class="r mono">${money(c.total)}</td></tr>`;
  }

  const clausulasHtml = limpiarMarkdown(os.clausulas || '')
    .split('\n').filter(l => l.trim())
    .map(l => `<p style="margin:0 0 7px;text-align:justify">${esc(l)}</p>`).join('');

  const etiquetaTipoContrato = c.tipo === 'AIU' ? 'AIU' : 'IVA Pleno';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${esc(os.numeroOS || 'Orden de Servicio')}</title>
<style>
  :root{--t:#6b1f2a;--t2:#8b2a38;--b:#d4dae2;--txt:#1a2430;--muted:#5a6478;--soft:#fbf6f7;}
  *{box-sizing:border-box}
  @page{size:letter;margin:15mm 12mm 14mm 12mm}
  body{font-family:'Segoe UI',Arial,sans-serif;color:var(--txt);font-size:11px;margin:0;background:#fff}
  .wrap{max-width:190mm;margin:0 auto;padding:6mm 4mm}
  .mono{font-family:'Consolas','Courier New',monospace;font-variant-numeric:tabular-nums}
  .c{text-align:center}.r{text-align:right}

  .hdr{display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:center;border-bottom:3px solid var(--t);padding-bottom:10px;margin-bottom:14px}
  .hdr .emisor{font-size:10px;line-height:1.45;color:var(--muted)}
  .hdr .emisor strong{display:block;color:var(--t);font-size:12px;letter-spacing:.02em}
  .hdr .titulo{text-align:right}
  .hdr .titulo h1{font-size:16px;color:var(--t);letter-spacing:.1em;margin:0;font-weight:700}
  .hdr .titulo .num{font-family:'Consolas',monospace;font-size:20px;color:#1a2430;margin-top:3px;font-weight:600}
  .hdr .titulo .doc{font-size:9px;color:var(--muted);margin-top:2px}

  .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
  .box{border:1px solid var(--b);border-radius:4px;padding:9px 11px}
  .box .lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;font-weight:600}
  .box .val{font-size:11px;color:var(--txt);line-height:1.45}
  .box .val strong{display:block;font-size:12px;color:var(--t);margin-bottom:2px}

  .mini-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
  .mini{border:1px solid var(--b);border-radius:3px;padding:6px 10px;font-size:10px}
  .mini .lbl{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
  .mini .val{margin-top:2px;color:var(--txt)}

  table.items{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:10px}
  table.items thead th{background:var(--t);color:#fff;padding:7px 6px;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--t)}
  table.items tbody td{border:1px solid var(--b);padding:5px 7px;vertical-align:middle}
  table.items tbody tr.vacio td{height:16px;color:transparent}
  table.items tbody tr:nth-child(even):not(.vacio){background:var(--soft)}

  .tot{display:grid;grid-template-columns:1fr 260px;gap:8px;margin-top:6px;margin-bottom:12px}
  .tot .obs{font-size:9px;color:var(--muted);padding:6px}
  .tot table{width:100%;border-collapse:collapse}
  .tot table td{padding:6px 10px;font-size:11px;border:1px solid var(--b)}
  .tot table td.lbl{background:var(--soft);color:var(--muted);text-transform:uppercase;font-size:9px;letter-spacing:.06em;font-weight:600;width:55%}
  .tot table tr.gran td{background:var(--t);color:#fff;font-weight:700;font-size:13px;border-color:var(--t)}

  .section{margin-bottom:12px}
  .section-title{font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--b);padding-bottom:4px;margin-bottom:7px}
  .section-body{font-size:11px;line-height:1.6;text-align:justify}

  .textos{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .textos .box h3{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:0 0 4px;font-weight:600}
  .textos .box p{margin:0;line-height:1.5;white-space:pre-wrap;font-size:10px}

  .firma{margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
  .firma .sig{text-align:center}
  .firma .line{border-top:1px solid var(--txt);margin:30px 10px 4px}
  .firma .sig strong{display:block;font-size:10px}
  .firma .sig span{display:block;font-size:9px;color:var(--muted)}

  .pie{margin-top:20px;padding-top:8px;border-top:1px solid var(--b);display:flex;justify-content:space-between;font-size:8px;color:var(--muted)}

  @media print{.no-print{display:none !important}body{background:#fff}.wrap{max-width:none;padding:0}}
  .no-print{position:fixed;top:14px;right:14px;z-index:10;display:flex;gap:8px}
  .no-print button{padding:8px 14px;border:none;border-radius:5px;font-size:12px;font-weight:500;cursor:pointer}
  .btn-pdf{background:var(--t);color:#fff}
  .btn-close{background:#e6e9ee;color:#1a2430}
  .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:8px;font-weight:700;letter-spacing:.05em;background:var(--soft);color:var(--t);border:1px solid var(--b)}

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

${os.estado === 'borrador' ? '<div class="marca-agua">NO APROBADO</div>'
  : os.estado === 'anulada' ? '<div class="marca-agua">ANULADO</div>'
  : ''}

<div class="wrap">
  <div class="hdr">
    <div class="logo">${logoHtml}</div>
    <div class="emisor">
      <strong>${esc(emisor.razonSocial || '')}</strong>
      NIT ${esc(emisor.nit || '')}<br>
      ${esc(emisor.direccion || '')}<br>
      ${esc(emisor.ciudad || '')}${emisor.telefono ? ` · Tel. ${esc(emisor.telefono)}` : ''}${emisor.correo ? ` · ${esc(emisor.correo)}` : ''}
    </div>
    <div class="titulo">
      <h1>ORDEN DE SERVICIO</h1>
      <div class="num">N° ${esc(os.numeroOS || '—')}</div>
      <div class="doc">CT-ADMIN-FO-007 &nbsp;<span class="badge">${etiquetaTipoContrato}</span></div>
    </div>
  </div>

  <div class="meta">
    <div class="box">
      <div class="lbl">Contratista / Prestador del servicio</div>
      <div class="val">
        <strong>${esc(os.proveedorNombre || '—')}</strong>
        NIT ${esc(os.proveedorNit || '—')}
      </div>
    </div>
    <div class="box">
      <div class="lbl">Proyecto</div>
      <div class="val"><strong>${esc(os.proyecto || '—')}</strong></div>
    </div>
  </div>

  <div class="mini-grid">
    <div class="mini"><div class="lbl">Fecha emisión</div><div class="val">${esc(os.fecha || '')}</div></div>
    <div class="mini"><div class="lbl">Inicio vigencia</div><div class="val">${esc(os.fechaInicio || '—')}</div></div>
    <div class="mini"><div class="lbl">Fin vigencia</div><div class="val">${esc(os.fechaFin || '—')}</div></div>
    <div class="mini"><div class="lbl">Lugar de prestación</div><div class="val">${esc(os.lugarPrestacion || '—')}</div></div>
  </div>

  <div class="section">
    <div class="section-title">Objeto / Descripción del servicio</div>
    <div class="box section-body" style="white-space:pre-wrap;text-align:justify">${esc(os.tipoServicio || '—')}</div>
  </div>

  <table class="items">
    <thead><tr>
      <th style="width:4%">#</th>
      <th style="width:${c.tipo === 'IVA_PLENO' ? '42%' : '48%'}">Descripción / Ítem</th>
      <th style="width:8%">Unidad</th>
      <th style="width:9%">Cant.</th>
      <th style="width:14%">V. Unitario</th>
      ${c.tipo === 'IVA_PLENO' ? '<th style="width:7%">IVA %</th>' : ''}
      <th style="width:${c.tipo === 'IVA_PLENO' ? '16%' : '17%'}">Subtotal</th>
    </tr></thead>
    <tbody>
      ${filasItems}
    </tbody>
  </table>

  <div class="tot">
    <div class="obs">${os.ofertaEconomicaRef ? `Ref. oferta: ${esc(os.ofertaEconomicaRef)}` : '&nbsp;'}</div>
    <table><tbody>${totalesHtml}</tbody></table>
  </div>

  <div class="section">
    <div class="section-title">Clausulado</div>
    <div class="box" style="line-height:1.6">
      ${clausulasHtml || `<p style="margin:0">${esc(os.clausulas || '—')}</p>`}
    </div>
  </div>

  <div class="textos">
    <div class="box">
      <h3>Condiciones comerciales</h3>
      <p>${esc(os.condicionesComerciales || '—')}</p>
    </div>
    <div class="box">
      <h3>Observaciones</h3>
      <p>${esc(os.observaciones || '—')}</p>
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
      <strong>Aceptación del contratista</strong>
      <span>Firma, nombre y fecha</span>
    </div>
  </div>

  <div class="pie">
    <span>${esc(emisor.razonSocial || '')}</span>
    <span>Documento: CT-ADMIN-FO-007</span>
    <span>Generado ${new Date().toLocaleString('es-CO')}</span>
  </div>
</div>
</body>
</html>`;
}

// ── Excel ─────────────────────────────────────────────────────────────────────

async function generarExcelBuffer(os, cfg) {
  const c  = calcularTotales(os);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OS Automation';
  wb.created = new Date();

  const COLS  = c.tipo === 'IVA_PLENO' ? 8 : 7;
  const ws    = wb.addWorksheet('OS', {
    pageSetup: { paperSize: 1, orientation: 'portrait', margins: { left:.4, right:.4, top:.5, bottom:.5, header:.3, footer:.3 } },
    views: [{ showGridLines: false }],
  });

  ws.columns = c.tipo === 'IVA_PLENO'
    ? [{ width:4 },{ width:30 },{ width:8 },{ width:9 },{ width:14 },{ width:7 },{ width:7 },{ width:15 }]
    : [{ width:4 },{ width:33 },{ width:8 },{ width:9 },{ width:14 },{ width:7 },{ width:15 }];

  const T      = 'FF6B1F2A';
  const MUTED  = 'FF5A6478';
  const BORDER = 'FFD4DAE2';
  const WHITE  = 'FFFFFFFF';
  const SOFT   = 'FFFBF6F7';
  const thin   = { style: 'thin', color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  const emisor = cfg.emisor || {};

  // Logo
  if (cfg.logo && cfg.logo.startsWith('data:image/')) {
    try {
      const m = cfg.logo.match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        const ext = m[1] === 'jpeg' ? 'jpeg' : m[1];
        ws.addImage(wb.addImage({ buffer: Buffer.from(m[2], 'base64'), extension: ext }), { tl: { col:0, row:0 }, ext: { width:160, height:50 } });
      }
    } catch {}
  }

  // Header
  ws.mergeCells(`A1:C3`);
  ws.mergeCells(`D1:E3`);
  const cEmisor = ws.getCell('D1');
  cEmisor.value = { richText: [
    { text: (emisor.razonSocial || '') + '\n', font: { bold:true, color:{ argb:T }, size:11 } },
    { text: 'NIT ' + (emisor.nit || '') + '\n', font: { size:9, color:{ argb:MUTED } } },
    { text: (emisor.direccion || '') + '\n', font: { size:9, color:{ argb:MUTED } } },
    { text: (emisor.ciudad || '') + (emisor.telefono ? ' · Tel. ' + emisor.telefono : ''), font: { size:9, color:{ argb:MUTED } } },
  ]};
  cEmisor.alignment = { vertical:'middle', horizontal:'left', wrapText:true };

  ws.mergeCells(`F1:${String.fromCharCode(64+COLS)}1`);
  ws.getCell('F1').value = 'ORDEN DE SERVICIO';
  ws.getCell('F1').font  = { bold:true, color:{ argb:T }, size:13 };
  ws.getCell('F1').alignment = { vertical:'middle', horizontal:'right' };

  ws.mergeCells(`F2:${String.fromCharCode(64+COLS)}2`);
  ws.getCell('F2').value = 'N° ' + (os.numeroOS || '—');
  ws.getCell('F2').font  = { bold:true, color:{ argb:'FF1A2430' }, size:18, name:'Consolas' };
  ws.getCell('F2').alignment = { vertical:'middle', horizontal:'right' };

  ws.mergeCells(`F3:${String.fromCharCode(64+COLS)}3`);
  ws.getCell('F3').value = `CT-ADMIN-FO-007  ·  ${c.tipo === 'AIU' ? 'AIU' : 'IVA Pleno'}`;
  ws.getCell('F3').font  = { size:9, color:{ argb:MUTED } };
  ws.getCell('F3').alignment = { vertical:'middle', horizontal:'right' };

  ws.getRow(1).height = 20; ws.getRow(2).height = 22; ws.getRow(3).height = 18;

  for (let col = 1; col <= COLS; col++) ws.getCell(4, col).border = { bottom: { style:'medium', color:{ argb:T } } };
  ws.getRow(4).height = 4;

  // Proveedor / Proyecto
  ws.mergeCells(`A5:D5`); ws.getCell('A5').value = 'CONTRATISTA / PRESTADOR'; ws.getCell('A5').font = { bold:true, size:8, color:{ argb:MUTED } };
  ws.mergeCells(`E5:${String.fromCharCode(64+COLS)}5`); ws.getCell('E5').value = 'PROYECTO'; ws.getCell('E5').font = { bold:true, size:8, color:{ argb:MUTED } };
  ws.mergeCells('A6:D8');
  ws.getCell('A6').value = { richText: [
    { text: (os.proveedorNombre || '—') + '\n', font: { bold:true, size:11, color:{ argb:T } } },
    { text: 'NIT ' + (os.proveedorNit || '—'), font: { size:10 } },
  ]};
  ws.getCell('A6').alignment = { vertical:'top', wrapText:true };
  for (let r = 6; r <= 8; r++) for (let c2 = 1; c2 <= 4; c2++) ws.getCell(r, c2).border = border;

  ws.mergeCells(`E6:${String.fromCharCode(64+COLS)}8`);
  ws.getCell('E6').value = os.proyecto || '—';
  ws.getCell('E6').font  = { bold:true, size:11, color:{ argb:T } };
  ws.getCell('E6').alignment = { vertical:'top', wrapText:true };
  for (let r = 6; r <= 8; r++) for (let c2 = 5; c2 <= COLS; c2++) ws.getCell(r, c2).border = border;

  // Mini-grid
  ws.mergeCells('A10:B10'); ws.getCell('A10').value = 'Fecha emisión';   ws.getCell('A10').font = { bold:true, size:8, color:{ argb:MUTED } };
  ws.mergeCells('A11:B11'); ws.getCell('A11').value = os.fecha || '';    ws.getCell('A11').font = { size:10 };
  ws.mergeCells('C10:D10'); ws.getCell('C10').value = 'Inicio vigencia'; ws.getCell('C10').font = { bold:true, size:8, color:{ argb:MUTED } };
  ws.mergeCells('C11:D11'); ws.getCell('C11').value = os.fechaInicio || '—'; ws.getCell('C11').font = { size:10 };
  ws.mergeCells(`E10:${String.fromCharCode(64+COLS)}10`); ws.getCell('E10').value = 'Fin vigencia'; ws.getCell('E10').font = { bold:true, size:8, color:{ argb:MUTED } };
  ws.mergeCells(`E11:${String.fromCharCode(64+COLS)}11`); ws.getCell('E11').value = os.fechaFin || '—'; ws.getCell('E11').font = { size:10 };
  for (let r = 10; r <= 11; r++) for (let c2 = 1; c2 <= COLS; c2++) ws.getCell(r, c2).border = border;

  ws.mergeCells(`A12:${String.fromCharCode(64+COLS)}12`); ws.getCell('A12').value = 'Lugar de prestación'; ws.getCell('A12').font = { bold:true, size:8, color:{ argb:MUTED } };
  ws.mergeCells(`A13:${String.fromCharCode(64+COLS)}13`); ws.getCell('A13').value = os.lugarPrestacion || '—'; ws.getCell('A13').font = { size:10 };
  for (let r = 12; r <= 13; r++) for (let c2 = 1; c2 <= COLS; c2++) ws.getCell(r, c2).border = border;

  // Header ítems
  const HR = 15;
  const heads = c.tipo === 'IVA_PLENO'
    ? ['#','Descripción / Ítem','Unidad','Cant.','V. Unitario','IVA %','—','Subtotal']
    : ['#','Descripción / Ítem','Unidad','Cant.','V. Unitario','Subtotal'];
  heads.forEach((h, i) => {
    const cell = ws.getCell(HR, i + 1);
    cell.value = h === '—' ? 'Dto.' : h;
    if (h === '—') { cell.value = ''; return; }
    cell.font  = { bold:true, color:{ argb:WHITE }, size:9 };
    cell.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:T } };
    cell.alignment = { vertical:'middle', horizontal: i === 1 ? 'left' : 'center' };
    cell.border = border;
  });
  ws.getRow(HR).height = 20;

  // Ítems
  const FILAS = Math.max(6, c.items.length);
  for (let i = 0; i < FILAS; i++) {
    const r  = HR + 1 + i;
    const it = c.items[i];
    ws.getRow(r).height = 15;
    if (it) {
      if (c.tipo === 'IVA_PLENO') {
        ws.getRow(r).values = [i+1, it.descripcion||'', it.unidad||'GLB', Number(it.cantidad||1), Number(it.precioUnitario||0), Number(it.ivaPct||0)/100, '', it._sub];
      } else {
        ws.getRow(r).values = [i+1, it.descripcion||'', it.unidad||'GLB', Number(it.cantidad||1), Number(it.precioUnitario||0), it._sub];
      }
    }
    for (let col = 1; col <= COLS; col++) {
      const cell = ws.getCell(r, col);
      cell.border = border;
      if (i % 2 === 1) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:SOFT } };
      cell.font = { size:9 };
      if ([1,3,6].includes(col)) cell.alignment = { horizontal:'center' };
      if ([4].includes(col))     cell.alignment = { horizontal:'right' };
      if (col === 5 || col === COLS) { cell.numFmt = '"$ "#,##0'; cell.alignment = { horizontal:'right' }; }
      if (col === 6 && c.tipo === 'IVA_PLENO') cell.numFmt = '0%';
      if (col === 2) cell.alignment = { horizontal:'left', wrapText:true };
    }
  }

  // Totales
  const TR = HR + 1 + FILAS + 1;
  const totRows = c.tipo === 'AIU'
    ? [
        [`Costos directos`, c.subtotal, false],
        [`Administración (${c.aPct}%)`, c.A, false],
        [`Imprevistos (${c.iPct}%)`, c.I, false],
        [`Utilidad (${c.uPct}%)`, c.U, false],
        [`IVA sobre utilidad (${c.ivaPct}%)`, c.iva, false],
        ['TOTAL', c.total, true],
      ]
    : [
        ['Subtotal', c.subtotal, false],
        ['IVA', c.iva, false],
        ['TOTAL', c.total, true],
      ];

  totRows.forEach(([lbl, val, grande], i) => {
    const r = TR + i;
    const c1 = COLS - 1; const c2 = COLS;
    ws.mergeCells(r, 1, r, c1 - 1);
    ws.getCell(r, c1).value = lbl;
    ws.getCell(r, c2).value = val;
    ws.getCell(r, c1).font = grande ? { bold:true, color:{ argb:WHITE }, size:11 } : { bold:true, size:9, color:{ argb:MUTED } };
    ws.getCell(r, c2).font = grande ? { bold:true, color:{ argb:WHITE }, size:12, name:'Consolas' } : { size:10 };
    ws.getCell(r, c2).numFmt = '"$ "#,##0';
    ws.getCell(r, c2).alignment = { horizontal:'right' };
    [c1, c2].forEach(col => {
      if (grande) {
        ws.getCell(r, col).fill   = { type:'pattern', pattern:'solid', fgColor:{ argb:T } };
        ws.getCell(r, col).border = border;
      } else {
        ws.getCell(r, col).fill   = { type:'pattern', pattern:'solid', fgColor:{ argb:SOFT } };
        ws.getCell(r, col).border = border;
      }
    });
    ws.getRow(r).height = grande ? 22 : 17;
  });

  // Clausulado
  const CR = TR + totRows.length + 2;
  ws.mergeCells(`A${CR}:${String.fromCharCode(64+COLS)}${CR}`);
  ws.getCell(`A${CR}`).value = 'CLAUSULADO';
  ws.getCell(`A${CR}`).font  = { bold:true, size:9, color:{ argb:WHITE } };
  ws.getCell(`A${CR}`).fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:T } };
  ws.getCell(`A${CR}`).border = border;
  ws.getRow(CR).height = 20;

  const clausEnd = CR + 8;
  ws.mergeCells(`A${CR+1}:${String.fromCharCode(64+COLS)}${clausEnd}`);
  ws.getCell(`A${CR+1}`).value = limpiarMarkdown(os.clausulas || '—');
  ws.getCell(`A${CR+1}`).font  = { size:9 };
  ws.getCell(`A${CR+1}`).alignment = { vertical:'top', wrapText:true };
  for (let r = CR+1; r <= clausEnd; r++) for (let c2 = 1; c2 <= COLS; c2++) ws.getCell(r, c2).border = border;
  for (let r = CR+1; r <= clausEnd; r++) ws.getRow(r).height = 13;

  // Firmas
  const FR = clausEnd + 3;
  ws.mergeCells(`A${FR}:C${FR}`);
  ws.getCell(`A${FR}`).value = (cfg.firmante?.nombre || '') + '\n' + (cfg.firmante?.cargo || '');
  ws.getCell(`A${FR}`).font  = { size:10 };
  ws.getCell(`A${FR}`).alignment = { horizontal:'center', wrapText:true };
  ws.getCell(`A${FR}`).border = { top: { style:'thin', color:{ argb:'FF1A2430' } } };

  ws.mergeCells(`E${FR}:${String.fromCharCode(64+COLS)}${FR}`);
  ws.getCell(`E${FR}`).value = 'Aceptación del contratista\nFirma, nombre y fecha';
  ws.getCell(`E${FR}`).font  = { size:10, color:{ argb:MUTED } };
  ws.getCell(`E${FR}`).alignment = { horizontal:'center', wrapText:true };
  ws.getCell(`E${FR}`).border = { top: { style:'thin', color:{ argb:'FF1A2430' } } };
  ws.getRow(FR).height = 30;

  return wb.xlsx.writeBuffer();
}

module.exports = { generarHTML, generarExcelBuffer };
