'use strict';
/**
 * procesarCorreo.js
 * Orquesta el flujo completo desde la llegada del correo hasta
 * la generación del resultado listo para OC.
 *
 * Flujo:
 *   1. Parsear asunto → extraer consecutivo, fecha, proyecto
 *   2. Si NO hay adjunto Excel → retornar instrucción de respuesta automática
 *   3. Si SÍ hay adjunto → leer requerimiento → consultar proveedor/precio
 *      por cada ítem → retornar resultado estructurado
 */

const path                           = require('path');
const { parsearAsunto, resolverProyecto, esConfiable } = require('./parsearAsunto');
const { leerRequerimiento }          = require('./leerRequerimiento');
const { leerRequerimientoPDF }       = require('./leerRequerimientoPDF');
const { consultarProveedor } = require('./consultaProveedor');
const repoCatalogos                      = require('./repo/catalogos');
const repoHistorial                      = require('./repo/historialPrecios');

async function leerRequerimientoAuto(rutaArchivo) {
  const ext = path.extname(rutaArchivo).toLowerCase();
  if (ext === '.pdf')             return await leerRequerimientoPDF(rutaArchivo);
  if (['.xlsx', '.xls'].includes(ext)) return leerRequerimiento(rutaArchivo);
  throw new Error(`Extensión no soportada: ${ext}. Solo .xlsx, .xls o .pdf.`);
}

// ── Formato oficial en blanco ─────────────────────────────────────────────────
// Va adjunto en las tres respuestas automáticas — asunto mal escrito, correo sin
// adjunto y adjunto ilegible — porque en todas el remitente necesita el formato
// para corregir. También lo entrega la descarga desde la consola, y ambos
// caminos resuelven la ruta aquí para que circule una sola copia.

const NOMBRE_FORMATO = 'CT-ADMIN-FO-002_FORMATO_SOLICITUD_DE_REQUERIMIENTO_V3_0.xlsx';

function rutaFormatoRequerimiento() {
  return process.env.PATH_FORMATO_REQUERIMIENTO ||
         path.join(__dirname, '../data', NOMBRE_FORMATO);
}

// ── Respuesta automática cuando el asunto no matchea el formato esperado ─────

function mensajeFormatoAsuntoInvalido(infoAsunto) {
  return {
    accion:        'RESPONDER_FORMATO_ASUNTO_INVALIDO',
    asunto:        `RE: ${infoAsunto.raw}`,
    rutaAdjunto:   rutaFormatoRequerimiento(),
    nombreAdjunto: NOMBRE_FORMATO,
    cuerpo:
`Estimado(a),

Hemos recibido su correo, pero el asunto no cumple con el formato requerido para procesar la solicitud:

  ${infoAsunto.error}

Por favor reenvíe su solicitud con el asunto en el siguiente formato exacto:

  SOLICITUD REQUERIMIENTO {CONSECUTIVO} {AAAAMMDD} {PROYECTO}

Ejemplo: SOLICITUD REQUERIMIENTO 0001 20260410 MISTRAL

Se adjunta el formato oficial de solicitud (CT-ADMIN-FO-002). Diligéncielo y envíelo adjunto junto con el asunto corregido — sin ese archivo no es posible procesar la solicitud.

Saludos,
Sistema de Gestión de Compras – Civiltech`,
  };
}

// ── Respuesta automática cuando no hay adjunto ────────────────────────────────

function mensajeSinAdjunto(infoAsunto) {
  const proyecto      = infoAsunto.valido ? infoAsunto.proyecto : '(proyecto no identificado)';
  const cons          = infoAsunto.valido ? infoAsunto.consecutivo : '—';

  return {
    accion:        'RESPONDER_SOLICITAR_ADJUNTO',
    asunto:        `RE: ${infoAsunto.raw || 'SOLICITUD REQUERIMIENTO'}`,
    rutaAdjunto:   rutaFormatoRequerimiento(),
    nombreAdjunto: NOMBRE_FORMATO,
    cuerpo:
`Estimado(a),

Hemos recibido su solicitud de requerimiento ${cons} para el proyecto ${proyecto}.

Sin embargo, el correo no incluye el formato de solicitud adjunto requerido (CT-ADMIN-FO-002 en Excel o PDF). Sin este archivo no es posible procesar la orden de compra.

Se adjunta el formato oficial. Por favor diligéncielo con la siguiente información y reenvíelo adjunto (Excel o PDF):
  • Nombre exacto del insumo (según catálogo)
  • Cantidad y unidad de medida
  • Fecha de necesidad
  • Proyecto

Quedo atento a su respuesta.

Saludos,
Sistema de Gestión de Compras – Civiltech`,
  };
}

// ── Procesamiento con adjunto ─────────────────────────────────────────────────

async function procesarConAdjunto(infoAsunto, rutaAdjunto, opts = {}) {
  // 1. Leer requerimiento (Excel o PDF)
  let requerimiento;
  try {
    requerimiento = await leerRequerimientoAuto(rutaAdjunto);
  } catch (e) {
    return {
      accion:        'RESPONDER_FORMATO_INVALIDO',
      asunto:        `RE: ${infoAsunto.raw}`,
      rutaAdjunto:   rutaFormatoRequerimiento(),
      nombreAdjunto: NOMBRE_FORMATO,
      cuerpo:
`Estimado(a),

Se recibió el adjunto de su solicitud ${infoAsunto.consecutivo}, pero no fue posible procesarlo:

  ${e.message}

Se adjunta de nuevo el formato oficial CT-ADMIN-FO-002 en blanco. Diligéncielo sobre esta copia —sin mover filas ni columnas, y sin dejar filas vacías entre los insumos— y reenvíe su solicitud.

Saludos,
Sistema de Gestión de Compras – Civiltech`,
      error: e.message,
    };
  }

  return construirResultado(infoAsunto, requerimiento, opts);
}

// ── Enriquecimiento común (correo con adjunto y captura manual) ───────────────
// Resuelve el proyecto contra la tabla maestra, consulta proveedor/precio por
// ítem y arma el resultado GENERAR_OC. `infoAsunto` puede provenir de un correo
// real o ser sintético (captura manual desde la consola).

async function construirResultado(infoAsunto, requerimiento, opts = {}) {
  // 3. Resolver proyecto: prioridad asunto > Excel.
  // El catálogo sale de Postgres. El fallback que leía tabla_proyectos.csv se
  // retiró con el archivo.
  // El mapa guarda el código canónico junto con la zona. Sin él, el llamador
  // leía proyectoFinal.codigo_proyecto —un campo que nunca existió— así que el
  // primer término del || era siempre undefined y ganaba el texto tecleado. La
  // resolución funcionaba y su resultado se descartaba.
  const proyPorCodigo = {};
  for (const p of await repoCatalogos.getProyectos({ soloActivos: false })) {
    const codigo = String(p.nombre || '').trim();
    const key    = codigo.toUpperCase();
    if (key) proyPorCodigo[key] = { zona: p.zona || '', codigo };
  }
  // Añadir proyectos externos pasados explícitamente (carga manual)
  for (const p of (opts.proyectosExternos || [])) {
    const codigo = String(p.codigo || p).trim();
    const key    = codigo.toUpperCase();
    if (key && !proyPorCodigo[key]) proyPorCodigo[key] = { zona: p.zona || '', codigo };
  }
  const proyectoAsunto = infoAsunto.valido
    ? resolverProyecto(infoAsunto.proyecto, proyPorCodigo)
    : null;
  const proyectoExcel  = resolverProyecto(requerimiento.cabecera.proyecto, proyPorCodigo);
  const proyectoFinal  = proyectoAsunto || proyectoExcel;
  // Descartar marcadores sintéticos que nunca deben ganar al texto del documento
  const asuntoProyecto = (infoAsunto.proyecto === '__AUTO__' || infoAsunto.proyecto === 'SIN_PROYECTO')
    ? null
    : infoAsunto.proyecto;
  // El código del catálogo solo se toma si el acierto es confiable. Un acierto
  // por palabra suelta cargaría el gasto a otra obra: "CT26-034LT ZIPAQUIRA
  // Norte 230KV - JE Jaimes" empareja con "CT26-026 Micropilotes RSO - JE
  // Jaimes" porque ambos dicen JAIMES, y son obras distintas en zonas distintas.
  const codigoFinal    = (esConfiable(proyectoFinal) ? proyectoFinal.codigo : null)
    || asuntoProyecto
    || requerimiento.cabecera.proyecto
    || infoAsunto.proyecto;

  // 4. Consultar proveedor/precio por ítem (historial y proveedores desde SQLite)
  // El historial viene ordenado por fecha real. El caché ordenaba por texto,
  // así que "septiembre 9, 2025" quedaba antes que "agosto 28, 2026" y el
  // criterio de "las 3 compras más recientes" elegía las equivocadas.
  const [historialSP, proveedoresSP] = await Promise.all([
    repoHistorial.listar(),
    repoCatalogos.getProveedores(),
  ]);
  const itemsConsultados = requerimiento.items.map(item => {
    const consulta = consultarProveedor(item.insumo, codigoFinal, {
      historialSP,
      proveedoresSP,
      zonaProyecto: esConfiable(proyectoFinal) ? (proyectoFinal.zona || '') : '',
    });
    return { ...item, consulta };
  });

  // 5. Resumen de alertas globales
  const alertasGlobales = [];
  // Tres situaciones distintas, tres avisos distintos. Antes solo existía el
  // primero, así que un acierto dudoso —que es peor, porque parece resuelto—
  // pasaba sin decir nada.
  if (!proyectoFinal) {
    alertasGlobales.push(`⚠️ Proyecto "${codigoFinal}" no está en el catálogo. Se creará como proyecto nuevo: si es una obra que ya existe, corrige el nombre.`);
  } else if (!esConfiable(proyectoFinal)) {
    const cands = (proyectoFinal.candidatos || []).join(' · ');
    alertasGlobales.push(
      `⚠️ Proyecto "${codigoFinal}" no se pudo identificar con certeza` +
      (cands ? `. Se parece a: ${cands}` : '') +
      `. Se registra con el nombre tal cual y sin zona, así que la sugerencia de proveedor usó historial nacional.`);
  } else if (!proyectoFinal.zona) {
    alertasGlobales.push(
      `ℹ️ El proyecto "${proyectoFinal.codigo}" no tiene zona asignada, así que la sugerencia de proveedor usó historial nacional. Se asigna en el panel de proyectos.`);
  }
  const sinPrecio = itemsConsultados.filter(i => i.consulta.sinHistorial);
  if (sinPrecio.length > 0) {
    alertasGlobales.push(`🔍 ${sinPrecio.length} ítem(s) sin historial de precio: ${sinPrecio.map(i => i.insumo).join(', ')}`);
  }
  // Avisos de la lectura del documento (p. ej. filas en blanco entre los ítems)
  alertasGlobales.push(...(requerimiento.avisos || []));

  return {
    accion: 'GENERAR_OC',
    solicitud: {
      consecutivo:  infoAsunto.consecutivo,
      fechaCorreo:  infoAsunto.fechaTexto,
      proyecto:     codigoFinal,
      zona:         proyectoFinal?.zona || 'No definida',
      responsable:  requerimiento.cabecera.responsable,
      cargo:        requerimiento.cabecera.cargo,
      fechaSolicitud: requerimiento.cabecera.fecha,
    },
    items:            itemsConsultados,
    totalItems:       itemsConsultados.length,
    itemsConPrecio:   itemsConsultados.filter(i => i.consulta.encontrado).length,
    itemsSinPrecio:   itemsConsultados.filter(i => i.consulta.sinHistorial).length,
    alertasGlobales,
  };
}

// ── Captura manual (sin correo ni formato adjunto) ────────────────────────────

/**
 * Arma el resultado GENERAR_OC a partir de ítems digitados a mano en la consola.
 * Aplica la misma resolución de proyecto y consulta de proveedor/precio que el
 * flujo de correo, de modo que el requerimiento resultante es indistinguible.
 *
 * @param {object} datos - { consecutivo, fecha, proyecto, responsable, cargo, items[] }
 * @throws {Error} si no hay proyecto o ningún ítem con insumo diligenciado
 */
async function procesarRequerimientoManual(datos = {}, opts = {}) {
  const proyecto = String(datos.proyecto || '').trim();
  if (!proyecto) throw new Error('El proyecto es obligatorio al crear un requerimiento manualmente.');

  const items = (datos.items || []).map((it, i) => ({
    item:             String(it.item || i + 1),
    insumo:           String(it.insumo || '').trim(),
    cantidad:         parseFloat(it.cantidad) > 0 ? parseFloat(it.cantidad) : 1,
    unidad:           String(it.unidad || '').trim() || 'UND',
    necesidad:        String(it.necesidad || '').trim(),
    posibleProveedor: String(it.posibleProveedor || '').trim(),
  })).filter(it => it.insumo);

  if (items.length === 0) throw new Error('El requerimiento no tiene ítems con insumo diligenciado.');

  const fecha = String(datos.fecha || '').trim();
  const infoAsunto = {
    valido:      true,
    consecutivo: String(datos.consecutivo || '').trim(),
    fechaTexto:  fecha,
    proyecto,
    raw:         'CAPTURA MANUAL',
  };
  const requerimiento = {
    cabecera: {
      proyecto,
      fecha,
      responsable: String(datos.responsable || '').trim(),
      cargo:       String(datos.cargo || '').trim(),
    },
    items,
  };

  return construirResultado(infoAsunto, requerimiento, opts);
}

// ── Punto de entrada principal ────────────────────────────────────────────────

/**
 * @param {string}      asunto      - Asunto completo del correo
 * @param {string|null} rutaAdjunto - Ruta al archivo Excel adjunto, o null si no hay
 * @returns {object}    Resultado con accion, datos de OC o instrucción de respuesta
 */
async function procesarCorreo(asunto, rutaAdjunto, opts = {}) {
  const infoAsunto = parsearAsunto(asunto);

  if (!infoAsunto.valido) {
    // Prefijo correcto pero el resto del asunto no matchea — avisar al remitente para que corrija
    if (infoAsunto.prefijoDetectado) {
      return mensajeFormatoAsuntoInvalido(infoAsunto);
    }
    // Correo ajeno a solicitudes de requerimiento — ignorar silenciosamente
    return {
      accion:  'IGNORAR',
      motivo:  infoAsunto.error,
      asunto,
    };
  }

  // Sin adjunto → respuesta automática
  if (!rutaAdjunto) {
    return mensajeSinAdjunto(infoAsunto);
  }

  // Con adjunto → procesar
  return procesarConAdjunto(infoAsunto, rutaAdjunto, opts);
}

module.exports = {
  procesarCorreo, procesarRequerimientoManual,
  rutaFormatoRequerimiento, NOMBRE_FORMATO,
};