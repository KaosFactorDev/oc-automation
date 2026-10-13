'use strict';
/**
 * formatoRequerimiento.js — El formato CT-ADMIN-FO-002 que se le manda a obra.
 *
 * Era un archivo fijo en data/. Tenía dos problemas que hacían que la gente
 * viera "proyectos antiguos":
 *
 *  · La casilla PROYECTO era texto libre. Cada quien escribía la obra como la
 *    recordaba —«IZZY 96», «mistral», «LT Norte»— y de ahí nacieron las 21
 *    variantes que hubo que fusionar al conectar el catálogo con KAOS.
 *  · La hoja oculta «Insumos» (precios de referencia) cita en su columna
 *    «Proyecto» 26 nombres de la época de SharePoint.
 *
 * Ahora se arma a partir de esa plantilla con:
 *
 *  · Una lista desplegable en PROYECTO con las obras ACTIVAS, por su nombre de
 *    KAOS —el mismo que ven en KAOS y en Cash_Flow—. El ERP reconoce ese nombre
 *    (procesarCorreo lo mapea al código). Si la obra no está en la lista, Excel
 *    avisa pero deja escribir: mejor un requerimiento que llega a la bandeja que
 *    uno que no se manda.
 *  · La columna «Proyecto» de la hoja oculta vacía. Los precios se conservan.
 *
 * Se regenera cuando el que hay tiene más de 15 minutos, que es lo mismo que
 * tarda un cambio de KAOS en llegar (deploy/crontab).
 */

const fs      = require('fs');
const path    = require('path');
const ExcelJS = require('exceljs');
const repoCatalogos = require('./repo/catalogos');

const PLANTILLA = () => process.env.PATH_FORMATO_REQUERIMIENTO ||
  path.join(__dirname, '../data', 'CT-ADMIN-FO-002_FORMATO_SOLICITUD_DE_REQUERIMIENTO_V3_0.xlsx');
const GENERADO  = path.join(__dirname, '../temp', 'formato-requerimiento.xlsx');
const VIGENCIA_MS = 15 * 60 * 1000;

// Celda (combinada D8:I8) donde va el proyecto en la hoja visible.
const CELDA_PROYECTO = 'D8';

let _generando = null;

/** Arma el formato y lo deja en temp/. Devuelve la ruta. */
async function generar() {
  const activos = (await repoCatalogos.getProyectos({ soloActivos: true }))
    .map(p => (p.origen === 'kaos' && p.descripcion ? p.descripcion : p.codigo))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(PLANTILLA());

  // Precios de referencia sin los nombres viejos de proyecto.
  const insumos = wb.getWorksheet('Insumos');
  if (insumos) {
    const col = insumos.getRow(1).values.findIndex(v => /^proyecto$/i.test(String(v || '').trim()));
    if (col > 0) insumos.eachRow((r, i) => { if (i > 1) r.getCell(col).value = null; });
  }

  // La lista de obras, en una hoja oculta que alimenta el desplegable. Va en una
  // hoja y no inline porque Excel limita una lista escrita a 255 caracteres.
  const anterior = wb.getWorksheet('Proyectos');
  if (anterior) wb.removeWorksheet(anterior.id);
  const hoja = wb.addWorksheet('Proyectos', { state: 'veryHidden' });
  activos.forEach((nombre, i) => { hoja.getCell(`A${i + 1}`).value = nombre; });

  const req = wb.getWorksheet('Requerimientos');
  if (req && activos.length) {
    req.getCell(CELDA_PROYECTO).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`Proyectos!$A$1:$A$${activos.length}`],
      showInputMessage: true,
      promptTitle: 'Proyecto',
      prompt: 'Elige la obra de la lista (obras activas en KAOS).',
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Obra que no está en la lista',
      error: 'Esa obra no está activa en KAOS. Si igual la envías, el requerimiento llegará sin proyecto y habrá que asignarlo a mano.',
    };
  }

  fs.mkdirSync(path.dirname(GENERADO), { recursive: true });
  const tmp = `${GENERADO}.${process.pid}.tmp`;
  await wb.xlsx.writeFile(tmp);
  fs.renameSync(tmp, GENERADO);
  return GENERADO;
}

/**
 * Deja el formato al día si hace falta. Nunca lanza: si no se puede generar (la
 * base no responde, la plantilla falta), se sigue usando el fijo de data/.
 */
async function asegurarFormato() {
  try {
    const st = fs.existsSync(GENERADO) ? fs.statSync(GENERADO) : null;
    if (st && Date.now() - st.mtimeMs < VIGENCIA_MS) return GENERADO;
    _generando = _generando || generar().finally(() => { _generando = null; });
    return await _generando;
  } catch (e) {
    console.warn('[formatoRequerimiento] No se pudo generar; se usa la plantilla fija:', e.message);
    return PLANTILLA();
  }
}

/** La ruta del formato a adjuntar: el generado si existe, si no la plantilla. */
function rutaFormato() {
  return fs.existsSync(GENERADO) ? GENERADO : PLANTILLA();
}

module.exports = { asegurarFormato, rutaFormato, generar };
