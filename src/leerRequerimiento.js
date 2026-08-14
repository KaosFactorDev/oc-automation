'use strict';
/**
 * leerRequerimiento.js  v2
 * Lee el Excel adjunto CT-ADMIN-FO-002 y extrae cabecera e ítems.
 *
 * Estructura real de la hoja "Requerimientos". Los rótulos van a la izquierda y
 * el valor diligenciado en las celdas combinadas a su derecha:
 *   B8:C8  "PROYECTO"     → valor en D8:I8      J8:K8  "FECHA:"  → valor en L8:M8
 *   B9:C9  "RESPONSABLE:" → valor en D9:I9      J9:K9  "CARGO:"  → valor en L9:M9
 *   Fila 11 = encabezados (ITEM, INSUMO, CANT, UND, NECESIDAD, POSIBLE PROVEEDOR)
 *   Filas 12-21 = ítems (B=item, C=insumo, H=cant, I=und, J=necesidad, L=posible proveedor)
 *   Fila 22 en adelante = firmas — nunca son ítems
 */

const XLSX = require('xlsx');

// Rótulos del formato: nunca son el valor diligenciado, aunque caigan en el rango
// que se escanea. Se comparan sin tildes ni dos puntos.
const ES_ROTULO = /^(PROYECTO|OBRA|RESPONSABLE|SOLICITANTE|FECHA|CARGO|ITEM|INSUMO)\s*:?$/i;

function leerRequerimiento(rutaExcel) {
  let wb;
  try {
    wb = XLSX.readFile(rutaExcel, { raw: false, cellDates: true });
  } catch (e) {
    throw new Error(`No se pudo abrir el archivo adjunto: ${e.message}`);
  }

  const ws = wb.Sheets['Requerimientos'];
  if (!ws) throw new Error('El archivo no contiene la hoja "Requerimientos". Verifique que sea el formato CT-ADMIN-FO-002.');

  const get = (celda) => {
    const c = ws[celda];
    if (!c) return '';
    // Celdas de fecha: preferir el texto formateado antes que el objeto Date
    if (c.v instanceof Date) return String(c.w || c.v.toISOString().slice(0, 10)).trim();
    const val = c.v !== undefined ? c.v : (c.w || '');
    return String(val).trim();
  };

  // Primer valor real de la fila, saltando los rótulos del formato
  const primerValor = (cols, fila) => {
    for (const col of cols) {
      const v = get(`${col}${fila}`);
      if (v && !ES_ROTULO.test(v)) return v;
    }
    return '';
  };

  const COLS_IZQ = ['C','D','E','F','G','H','I'];
  const COLS_DER = ['J','K','L','M','N'];

  // Cabecera en filas 8 y 9
  let proyecto = primerValor(COLS_IZQ, 8);
  // Si no está en fila 8, intentar fila 6 (algunas versiones del formato)
  if (!proyecto) {
    for (const col of ['C','D','E','F','G','H']) {
      const v = get(`${col}6`);
      if (v && !v.includes('Versión') && !v.includes('Documento') && !v.includes('Fecha')) {
        proyecto = v; break;
      }
    }
  }

  const cabecera = {
    proyecto,
    fecha:       primerValor(COLS_DER, 8),
    responsable: primerValor(COLS_IZQ, 9),
    cargo:       primerValor(COLS_DER, 9),
  };

  // Buscar fila de inicio de ítems dinámicamente
  // Busca la fila donde B contiene un número (1, 2, 3...) y C tiene texto de insumo
  let filaInicio = 12; // default para V3
  for (let f = 8; f <= 20; f++) {
    const bVal = get(`B${f}`);
    const cVal = get(`C${f}`);
    // Si B tiene un número y C tiene texto, es la primera fila de ítems
    if (!isNaN(parseInt(bVal)) && cVal && !['ITEM','INSUMO','DESCRIPCION'].includes(cVal.toUpperCase())) {
      filaInicio = f;
      break;
    }
  }

  // Leer ítems: parar cuando la columna insumo (C) esté vacía
  const items = [];
  for (let fila = filaInicio; ; fila++) {
    const insumo = get(`C${fila}`);
    if (!insumo || insumo.toUpperCase() === 'INSUMO') break;

    const cantRaw  = get(`H${fila}`);
    const cantidad = isNaN(parseFloat(cantRaw)) ? 1 : parseFloat(cantRaw);
    const unidad   = get(`I${fila}`);

    if (!insumo) break;

    items.push({
      item:             get(`B${fila}`) || String(items.length + 1),
      insumo,
      cantidad,
      unidad:           unidad || 'UND',
      necesidad:        get(`J${fila}`) || '',
      posibleProveedor: get(`L${fila}`) || '',
    });
  }

  if (items.length === 0) {
    throw new Error('El formato de requerimiento no contiene ítems diligenciados. Verifique que la hoja "Requerimientos" esté completada con los insumos.');
  }

  return { cabecera, items };
}

module.exports = { leerRequerimiento };