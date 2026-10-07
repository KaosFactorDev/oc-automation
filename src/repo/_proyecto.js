'use strict';
/**
 * _proyecto.js — Resolución del proyecto de un documento, en un solo sitio.
 *
 * Los seis módulos de documentos —requerimientos, órdenes de compra y de
 * servicio, remisiones, inventario e historial de precios— reciben el proyecto
 * como texto y tienen que convertirlo en la llave foránea `proyecto_id`.
 *
 * Antes cada uno resolvía por su cuenta y, si no encontraba el proyecto, lo
 * creaba:
 *
 *   INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
 *   VALUES ($1, $1, false, true)
 *
 * Nacía inactivo, así que no aparecía en los desplegables, pero el catálogo
 * crecía con una fila por cada variante mal escrita que entrara por correo.
 * Así aparecieron los 23 proyectos señalados durante la migración.
 *
 * Ahora no se crea nada. Si el texto no resuelve, el documento se guarda
 * igual con `proyecto_id` en NULL y el texto queda en `proyecto_texto`, para
 * que una persona le asigne el proyecto desde la bandeja de pendientes
 * (`erp.vw_documentos_sin_proyecto`).
 *
 * **Por qué el documento no falla.** El proyecto llega en el asunto de un
 * correo que escribe alguien de obra, a mano y abreviado. Rechazar el
 * requerimiento por un código mal tecleado perdería trabajo real; dejarlo sin
 * asignar lo hace visible y reparable en un clic.
 */

const pg = require('../pg');

/** Se intentó usar para algo nuevo un proyecto que KAOS tiene inactivo. */
class ProyectoInactivo extends Error {
  constructor(codigo) {
    super(`El proyecto "${codigo}" está inactivo en KAOS: solo se puede consultar como historial. ` +
          'Para registrarle algo nuevo, reactívalo en KAOS.');
    this.codigo = codigo;
    this.status = 409;
  }
}

/**
 * Resuelve el texto del proyecto contra el catálogo. No crea nada.
 *
 * @param {object} c        cliente dentro de la transacción del llamador
 * @param {string} texto    el proyecto tal como llegó
 * @param {boolean} [opts.exigirActivo]  rechazar un proyecto inactivo. Va en
 *          todo lo que USA la obra para algo nuevo (crear una OS, una remisión,
 *          una salida de almacén, asignarle un documento). No va en lo que solo
 *          deja constancia: un requerimiento que llega por correo nombrando una
 *          obra cerrada se registra igual y queda marcado para reasignarlo.
 * @returns {Promise<{proyectoId: number|null, proyectoTexto: string|null}>}
 *          `proyectoTexto` solo viene cuando NO se pudo resolver: es lo que se
 *          guarda en el documento como pista para quien lo asigne.
 */
async function resolver(c, texto, { exigirActivo = false } = {}) {
  const limpio = String(texto || '').trim();
  if (!limpio) return { proyectoId: null, proyectoTexto: null };

  const hallado = await c.query(
    'SELECT id, codigo, activo FROM erp.proyectos WHERE erp.norm(codigo) = erp.norm($1)',
    [limpio],
  );

  if (hallado.rowCount) {
    const p = hallado.rows[0];
    // Activo lo decide KAOS (kaos:aplicar). Un proyecto inactivo es historial:
    // se consulta, pero no se le registra nada nuevo hasta reactivarlo allá.
    if (exigirActivo && !p.activo) throw new ProyectoInactivo(p.codigo);
    return { proyectoId: p.id, proyectoTexto: null };
  }

  return { proyectoId: null, proyectoTexto: limpio };
}

/**
 * Los documentos que quedaron sin proyecto, de los seis tipos, en una sola
 * lista. Sale de `erp.vw_documentos_sin_proyecto`.
 *
 * `proyecto_texto` es lo que hace útil la bandeja: sin él, quien la abre ve un
 * requerimiento sin proyecto y no tiene con qué decidir cuál asignarle.
 */
async function pendientes({ limite = 200 } = {}) {
  const filas = await pg.rows(
    `SELECT tipo, id, numero, proyecto_texto, created_at, motivo, proyecto
       FROM erp.vw_documentos_sin_proyecto
      ORDER BY created_at DESC
      LIMIT $1`, [limite]);
  const det = await detalles(filas);
  return filas.map((f) => {
    const d = det.get(`${f.tipo}:${f.id}`) || {};
    return {
      tipo:          f.tipo,
      id:            String(f.id),
      numero:        f.numero || '',
      proyectoTexto: f.proyecto_texto || '',
      motivo:        f.motivo,
      proyecto:      f.proyecto || '',
      createdAt:     f.created_at,
      detalle:       d.detalle || '',
      // Proyecto que se deduce del propio documento (la OC de la que salió un
      // movimiento de almacén). Es una pista firme, no un parecido de nombres.
      proyectoDeducido: d.proyecto_deducido || '',
    };
  });
}

/**
 * Qué es cada documento, en una línea, para poder decidir a qué proyecto va:
 * un número suelto («Historial de precios 3861») no le dice nada a nadie.
 * Una consulta por tipo, solo por los ids de la página.
 */
async function detalles(filas) {
  const ids = (tipo) => filas.filter(f => f.tipo === tipo).map(f => Number(f.id));
  const mapa = new Map();
  const peso = (n) => n == null ? '' : '$' + Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  const dia  = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
  const poner = (tipo, rows, fn) => rows.forEach(r => mapa.set(`${tipo}:${r.id}`, fn(r)));

  const consultas = {
    requerimiento: `SELECT r.id, r.solicitante, r.fecha_solicitud AS fecha,
                           (SELECT string_agg(i.insumo, ', ' ORDER BY i.linea)
                              FROM (SELECT * FROM erp.requerimiento_items WHERE requerimiento_id = r.id ORDER BY linea LIMIT 3) i) AS insumos,
                           (SELECT count(*) FROM erp.requerimiento_items WHERE requerimiento_id = r.id) AS n
                      FROM erp.requerimientos r WHERE r.id = ANY($1)`,
    orden_compra:  `SELECT o.id, o.fecha_creacion AS fecha, o.total, o.estado, pv.razon_social AS proveedor
                      FROM erp.ordenes_compra o LEFT JOIN erp.proveedores pv ON pv.nit = o.proveedor_nit
                     WHERE o.id = ANY($1)`,
    orden_servicio:`SELECT s.id, s.fecha_creacion AS fecha, s.total, s.estado, s.tipo_servicio, pv.razon_social AS proveedor
                      FROM erp.ordenes_servicio s LEFT JOIN erp.proveedores pv ON pv.nit = s.proveedor_nit
                     WHERE s.id = ANY($1)`,
    remision:      `SELECT id, fecha, lugar_entrega, responsable_recepcion FROM erp.remisiones WHERE id = ANY($1)`,
    movimiento_inventario:
                   `SELECT m.id, m.tipo, m.fecha, m.insumo, m.cantidad, m.unidad, m.documento_ref,
                           o.numero_oc, po.codigo AS proyecto_oc
                      FROM erp.movimientos_inventario m
                      LEFT JOIN erp.ordenes_compra o ON o.id = m.orden_compra_id
                      LEFT JOIN erp.proyectos po ON po.id = o.proyecto_id
                     WHERE m.id = ANY($1)`,
    historial_precio:
                   `SELECT id, insumo, proveedor_nombre, precio_unitario, fecha, numero_compra
                      FROM erp.historial_precios WHERE id = ANY($1)`,
  };

  for (const [tipo, sql] of Object.entries(consultas)) {
    const lista = ids(tipo);
    if (!lista.length) continue;
    const rows = await pg.rows(sql, [lista]);
    if (tipo === 'requerimiento') poner(tipo, rows, r => ({
      detalle: [r.solicitante, dia(r.fecha), r.n ? `${r.n} ítem(s): ${r.insumos}${r.n > 3 ? '…' : ''}` : ''].filter(Boolean).join(' · ') }));
    if (tipo === 'orden_compra') poner(tipo, rows, r => ({
      detalle: [r.proveedor, peso(r.total), r.estado, dia(r.fecha)].filter(Boolean).join(' · ') }));
    if (tipo === 'orden_servicio') poner(tipo, rows, r => ({
      detalle: [r.proveedor, r.tipo_servicio, peso(r.total), r.estado, dia(r.fecha)].filter(Boolean).join(' · ') }));
    if (tipo === 'remision') poner(tipo, rows, r => ({
      detalle: [dia(r.fecha), r.lugar_entrega, r.responsable_recepcion].filter(Boolean).join(' · ') }));
    if (tipo === 'movimiento_inventario') poner(tipo, rows, r => ({
      detalle: [`${r.tipo} ${r.documento_ref || ''}`.trim(), dia(r.fecha), r.insumo,
                r.cantidad != null ? `${Number(r.cantidad)} ${r.unidad || ''}`.trim() : '',
                r.numero_oc ? `de la OC ${r.numero_oc}${r.proyecto_oc ? ` (${r.proyecto_oc})` : ''}` : ''].filter(Boolean).join(' · '),
      proyecto_deducido: r.proyecto_oc || '' }));
    if (tipo === 'historial_precio') poner(tipo, rows, r => ({
      detalle: [r.insumo, r.proveedor_nombre, peso(r.precio_unitario), dia(r.fecha), r.numero_compra].filter(Boolean).join(' · ') }));
  }
  return mapa;
}

/** Cuántos hay pendientes, para el contador del menú. */
async function contarPendientes() {
  const r = await pg.one('SELECT count(*)::int AS n FROM erp.vw_documentos_sin_proyecto');
  return r ? r.n : 0;
}

// Las tablas que se asignan acá, por el `tipo` de la bandeja. Los
// requerimientos NO: al asignarles proyecto hay que emitirles el consecutivo,
// y eso lo hace repo/requerimientos.actualizar().
const TABLA_POR_TIPO = {
  orden_compra:          'ordenes_compra',
  orden_servicio:        'ordenes_servicio',
  remision:              'remisiones',
  movimiento_inventario: 'movimientos_inventario',
  historial_precio:      'historial_precios',
};

/**
 * Asigna (o reasigna) el proyecto de un documento de la bandeja.
 *
 * @param {string} tipo    uno de TABLA_POR_TIPO
 * @param {string} id      id del documento
 * @param {string} codigo  el proyecto elegido, como lo lista /proyectos
 * @returns {Promise<boolean>} false si el documento no existe
 */
async function asignar(tipo, id, codigo) {
  const tabla = TABLA_POR_TIPO[tipo];
  if (!tabla) throw new Error(`Tipo de documento desconocido: ${tipo}`);

  return pg.tx(async (c) => {
    const { proyectoId } = await resolver(c, codigo, { exigirActivo: true });
    if (!proyectoId) throw new Error(`El proyecto "${codigo}" no está en el catálogo`);

    // proyecto_texto se limpia: era la pista para asignarlo, y ya se asignó.
    const r = await c.query(
      `UPDATE erp.${tabla} SET proyecto_id = $1, proyecto_texto = NULL WHERE id = $2`,
      [proyectoId, id]);
    return r.rowCount > 0;
  });
}

/**
 * Rechaza seguir con un documento cuya obra está inactiva en KAOS.
 *
 * Para los pasos que dan efecto a un documento ya creado —aprobar una OC o una
 * OS—: el borrador pudo nacer con la obra activa y KAOS cerrarla después.
 * Aprobarlo emitiría una orden para una obra cerrada.
 *
 * @param {object} c      cliente dentro de la transacción del llamador
 * @param {string} tabla  'ordenes_compra' | 'ordenes_servicio'
 * @param {string} id     id del documento
 */
async function exigirObraActiva(c, tabla, id) {
  if (!['ordenes_compra', 'ordenes_servicio'].includes(tabla)) {
    throw new Error(`exigirObraActiva: tabla no soportada ${tabla}`);
  }
  const r = await c.query(
    `SELECT p.codigo, p.activo FROM erp.${tabla} d
       JOIN erp.proyectos p ON p.id = d.proyecto_id
      WHERE d.id = $1`, [id]);
  if (r.rowCount && !r.rows[0].activo) throw new ProyectoInactivo(r.rows[0].codigo);
}

module.exports = {
  resolver, pendientes, contarPendientes, asignar, exigirObraActiva,
  TABLA_POR_TIPO, ProyectoInactivo,
};
