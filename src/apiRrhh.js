'use strict';
/**
 * apiRrhh.js — La API de órdenes para RRHH (KAOS), bajo /api/*.
 *
 * RRHH registra en el ERP los dos gastos de una contratación:
 *
 *   · los exámenes médicos, como ORDEN DE SERVICIO. RRHH ya eligió la IPS y
 *     tiene su precio; la orden entra aprobada si su total no supera el tope
 *     `rrhhTopeAprobacionOS` de erp.configuracion, y en borrador si lo supera.
 *   · la dotación, como REQUERIMIENTO pendiente, sin precio ni proveedor, igual
 *     al que hoy llega por correo. Compras lo convierte en órdenes de compra.
 *
 * El contrato completo está en docs/contrato-api-rrhh.md. Lo que hay que tener
 * presente al tocar este archivo:
 *
 *  1. Quien llama es un servidor (una Edge Function de KAOS) con la llave
 *     RRHH_API_KEY. La llave se valida en servidor-cotizaciones.js, antes de
 *     llegar acá. Sin la variable, /api/* no existe (404).
 *  2. Lo único que se puede hacer con la llave es crear estos dos documentos y
 *     consultarlos. Ninguna ruta paga, anula, modifica ni aprueba otra cosa.
 *     NO agregar operaciones destructivas: anular desde KAOS es una decisión
 *     aparte, que merece un humano identificable de este lado.
 *  3. El estado, los totales y el número los fija el ERP. Del payload solo se
 *     leen los campos listados acá; cualquier otro se ignora sin guardarse.
 *  4. Sin datos personales del candidato: ni nombre ni cédula. Para saber de
 *     quién es un documento se consulta KAOS con origenSolicitudId.
 *  5. Nada pasa por Gemini, y la orden de servicio no lleva clausulado.
 *  6. Los dos POST son idempotentes por origenSolicitudId: repetir la llamada
 *     devuelve 200 con el documento existente, también si llegan en paralelo.
 */

const configApp      = require('./configApp');
const contador       = require('./contador');
const repoOS         = require('./repo/ordenesServicio');
const repoReq        = require('./repo/requerimientos');
const repoProyecto   = require('./repo/_proyecto');
const bitacora       = require('./bitacora');

const ORIGEN_SISTEMA = 'rrhh-app';
const CLAVE_TOPE     = 'rrhhTopeAprobacionOS';
// Tipo de gasto de los exámenes en Control de Costos. Con esta grafía: es la
// más usada en producción, donde conviven «Opex», «OPEX» y «opex».
const TIPO_GASTO_OS  = 'Opex';
// Igual que MAX_ITEMS_REQ_MANUAL en la captura manual de la consola.
const MAX_ITEMS      = 100;
const MAX_CUERPO     = 256 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Validación ──────────────────────────────────────────────────────────────

/** Errores de validación legibles para una persona, uno por problema. */
class Detalles {
  constructor() { this.lista = []; }
  add(msg) { this.lista.push(msg); }
  get ok() { return this.lista.length === 0; }

  texto(body, campo, { oblig = true, max = 200 } = {}) {
    const v = body[campo];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      if (oblig) this.add(`Falta "${campo}".`);
      return '';
    }
    if (typeof v !== 'string') { this.add(`"${campo}" debe ser texto.`); return ''; }
    const s = v.trim();
    if (s.length > max) this.add(`"${campo}" pasa de ${max} caracteres.`);
    return s;
  }

  uuid(body, campo) {
    const s = this.texto(body, campo, { max: 36 });
    if (s && !UUID.test(s)) this.add(`"${campo}" no es un uuid válido.`);
    return s.toLowerCase();
  }

  numero(obj, campo, donde, { min = null, minExclusivo = false, max = null } = {}) {
    const v = obj[campo];
    if (v == null || v === '') { this.add(`${donde}: falta "${campo}".`); return null; }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.add(`${donde}: "${campo}" debe ser un número.`); return null;
    }
    if (min != null && (minExclusivo ? v <= min : v < min)) {
      this.add(`${donde}: "${campo}" debe ser ${minExclusivo ? 'mayor que' : 'al menos'} ${min}.`); return null;
    }
    if (max != null && v > max) { this.add(`${donde}: "${campo}" no puede pasar de ${max}.`); return null; }
    return v;
  }
}

/** Lo común a las dos rutas: procedencia y proyecto. */
function validarComun(body, d) {
  const origenSistema = d.texto(body, 'origenSistema', { max: 50 });
  if (origenSistema && origenSistema !== ORIGEN_SISTEMA) {
    d.add(`"origenSistema" debe ser "${ORIGEN_SISTEMA}".`);
  }
  return {
    origenSistema,
    origenSolicitudId:         d.uuid(body, 'origenSolicitudId'),
    origenSolicitadoPor:       d.texto(body, 'origenSolicitadoPor'),
    origenSolicitadoPorNombre: d.texto(body, 'origenSolicitadoPorNombre'),
    proyectoKaosId:            d.uuid(body, 'proyectoKaosId'),
    observaciones:             d.texto(body, 'observaciones', { oblig: false, max: 2000 }),
  };
}

function itemsDe(body, d) {
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    d.add('"items" debe ser una lista con al menos un ítem.');
    return [];
  }
  if (items.length > MAX_ITEMS) d.add(`Máximo ${MAX_ITEMS} ítems.`);
  return items.map((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      d.add(`Ítem ${i + 1}: no es un objeto.`);
      return null;
    }
    return it;
  });
}

function unidadDe(it, donde, d) {
  if (it.unidad == null || it.unidad === '') return 'UND';
  if (typeof it.unidad !== 'string') { d.add(`${donde}: "unidad" debe ser texto.`); return 'UND'; }
  const u = it.unidad.trim().toUpperCase();
  if (u.length > 20) d.add(`${donde}: "unidad" pasa de 20 caracteres.`);
  return u || 'UND';
}

function textoItem(it, campo, donde, d, max) {
  const v = it[campo];
  if (typeof v !== 'string' || !v.trim()) { d.add(`${donde}: falta "${campo}".`); return ''; }
  const s = v.trim();
  if (s.length > max) d.add(`${donde}: "${campo}" pasa de ${max} caracteres.`);
  return s;
}

const redondear = (n) => Math.round(n * 100) / 100;

/**
 * Los totales de la orden, calculados acá desde los ítems. Los que traiga el
 * payload (valor, iva, total) no se leen.
 */
function calcularTotales(items) {
  let valor = 0;
  let iva   = 0;
  for (const it of items) {
    const base = redondear(it.cantidad * it.precioUnitario);
    valor += base;
    iva   += redondear(base * it.ivaPct / 100);
  }
  valor = redondear(valor);
  iva   = redondear(iva);
  return { valor, iva, total: redondear(valor + iva) };
}

/**
 * El tope vigente, leído en cada llamada (sin la caché de configApp) para que
 * un cambio en Configuración aplique sin reiniciar. Falla cerrado: si la clave
 * falta o no es un número, devuelve null y nada se aprueba solo.
 */
async function leerTope() {
  const v = await configApp.get(CLAVE_TOPE, null);
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const esDuplicado = (err, constraint) => err && err.code === '23505' && err.constraint === constraint;

/** Errores con status propio (ProyectoInactivo 409, ProyectoNoEncontrado 422). */
function respuestaDeError(err) {
  if (err instanceof repoProyecto.ProyectoInactivo) {
    return { status: 409, body: { error: 'proyecto_inactivo', detalles: [err.message] } };
  }
  if (err instanceof repoOS.ProyectoNoEncontrado) {
    return { status: 422, body: { error: 'payload_invalido', detalles: [err.message] } };
  }
  return null;
}

/** Proyecto por id de KAOS, antes de hacer nada: 422 si no está, 409 si inactivo. */
async function proyectoOError(kaosId) {
  const p = await repoProyecto.porKaosId(kaosId);
  if (!p) return { error: respuestaDeError(new repoOS.ProyectoNoEncontrado(kaosId)) };
  if (!p.activo) return { error: respuestaDeError(new repoProyecto.ProyectoInactivo(p.codigo)) };
  return { proyecto: p };
}

const invalido = (d) => ({ status: 422, body: { error: 'payload_invalido', detalles: d.lista } });

// ── Orden de servicio (exámenes) ────────────────────────────────────────────

function osExistente(f) {
  return {
    creada:           false,
    duplicada:        true,
    erpItemId:        String(f.id),
    erpTipoDocumento: 'OS',
    estado:           f.estado,
    numeroOS:         f.numero_os || null,
    proyecto:         f.proyecto || '',
    valor:            Number(f.valor),
    iva:              Number(f.iva),
    total:            Number(f.total),
  };
}

async function crearOrdenServicio(body) {
  const d = new Detalles();
  const comun = validarComun(body, d);
  const proveedorNit = d.texto(body, 'proveedorNit', { max: 20 });
  if (proveedorNit && !/^\d+$/.test(proveedorNit)) d.add('"proveedorNit" debe traer solo dígitos.');
  const proveedorNombre      = d.texto(body, 'proveedorNombre', { max: 255 });
  const cotizacionReferencia = d.texto(body, 'cotizacionReferencia', { max: 100 });
  const tipoServicio         = d.texto(body, 'tipoServicio');
  const lugarPrestacion      = d.texto(body, 'lugarPrestacion', { oblig: false });

  const items = itemsDe(body, d).map((it, i) => {
    if (!it) return null;
    const donde = `Ítem ${i + 1}`;
    return {
      descripcion:    textoItem(it, 'descripcion', donde, d, 500),
      cantidad:       d.numero(it, 'cantidad', donde, { min: 0, minExclusivo: true }),
      unidad:         unidadDe(it, donde, d),
      precioUnitario: d.numero(it, 'precioUnitario', donde, { min: 0, minExclusivo: true }),
      // Sin valor por defecto: RRHH lo toma de la cotización de la IPS. Un 19 %
      // puesto por omisión se propagaría en silencio al total.
      ivaPct:         d.numero(it, 'ivaPct', donde, { min: 0, max: 100 }),
    };
  });
  if (!d.ok) return { ...invalido(d), log: { origenSolicitudId: comun.origenSolicitudId } };

  const log = { origenSolicitudId: comun.origenSolicitudId };

  // Idempotencia: si ya existe, se devuelve sin crear otra.
  const [existente] = await repoOS.porOrigenSolicitud(comun.origenSolicitudId);
  if (existente) return { status: 200, body: osExistente(existente), log: { ...log, duplicada: true } };

  const { proyecto, error } = await proyectoOError(comun.proyectoKaosId);
  if (error) return { ...error, log };

  const totales = calcularTotales(items);
  const tope    = await leerTope();
  const aprobar = tope != null && totales.total <= tope;

  try {
    const { id, numeroOS } = await repoOS.crearDesdeApi({
      ...comun,
      proveedorNit, proveedorNombre, cotizacionReferencia, tipoServicio, lugarPrestacion,
      ...totales,
      tipoGasto:     TIPO_GASTO_OS,
      // El humano real que pidió la orden en RRHH, no USUARIO_EMAIL ni 'sistema'.
      creadoPor:     comun.origenSolicitadoPor,
      observaciones: comun.observaciones ||
        `[RRHH:${comun.origenSolicitudId.slice(0, 8)}] ${tipoServicio} · solicitó ` +
        `${comun.origenSolicitadoPorNombre} (${comun.origenSolicitadoPor})`,
    }, items, { aprobar, formatear: contador.formatoOS });

    // A la bitácora, con la persona de RRHH que la pidió (no hay sesión de consola).
    const despues = await bitacora.foto('orden_servicio', id).catch(() => null);
    const quien = { usuario: comun.origenSolicitadoPor, usuarioNombre: comun.origenSolicitadoPorNombre, origen: 'api-rrhh' };
    await bitacora.anotar({ tipo: 'orden_servicio', id, accion: 'crear', numero: numeroOS, ...quien,
      motivo: `Solicitud RRHH ${comun.origenSolicitudId}`, antes: null, despues });
    if (aprobar) {
      await bitacora.anotar({ tipo: 'orden_servicio', id, accion: 'aprobar', numero: numeroOS, ...quien,
        motivo: `Aprobación automática: total ${totales.total} ≤ tope ${tope}`, antes: null, despues });
    }

    const cuerpo = {
      creada:                  true,
      erpItemId:               id,
      erpTipoDocumento:        'OS',
      estado:                  aprobar ? 'aprobada' : 'borrador',
      aprobadaAutomaticamente: aprobar,
      numeroOS:                numeroOS || null,
      tope,
      proyecto:                proyecto.etiqueta,
      ...totales,
    };
    if (!aprobar) cuerpo.motivo = tope == null ? 'tope_no_configurado' : 'supera_tope';
    return { status: 201, body: cuerpo, log: { ...log, estado: cuerpo.estado } };
  } catch (err) {
    // Dos POST iguales en paralelo: el segundo choca con el índice único.
    if (esDuplicado(err, 'ordenes_servicio_origen_solicitud_key')) {
      const [f] = await repoOS.porOrigenSolicitud(comun.origenSolicitudId);
      if (f) return { status: 200, body: osExistente(f), log: { ...log, duplicada: true } };
    }
    const r = respuestaDeError(err);
    if (r) return { ...r, log };
    throw err;
  }
}

async function consultarOrdenesServicio(origenSolicitudId) {
  const filas = await repoOS.porOrigenSolicitud(origenSolicitudId);
  return {
    ordenesServicio: filas.map(f => ({
      erpItemId:     String(f.id),
      numeroOS:      f.numero_os || null,
      estado:        f.estado,
      pagado:        f.pagado,
      cumplido:      f.cumplido,
      proyecto:      f.proyecto || '',
      total:         Number(f.total),
      fechaCreacion: f.fecha_creacion ? f.fecha_creacion.toISOString() : null,
    })),
  };
}

// ── Requerimiento (dotación) ────────────────────────────────────────────────

const messageIdDe = (origenSolicitudId) => `rrhh:${origenSolicitudId}`;

function reqExistente(item) {
  return {
    creado:           false,
    duplicado:        true,
    erpItemId:        String(item.id),
    erpTipoDocumento: 'REQ',
    consecutivo:      item.consecutivoSistema || '',
    estado:           item.estado,
  };
}

/** Hoy en Bogotá, como DD/MM/AAAA: el formato de la captura manual. */
function hoyBogota() {
  const p = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const v = (t) => p.find(x => x.type === t).value;
  return `${v('day')}/${v('month')}/${v('year')}`;
}

async function crearRequerimiento(body) {
  const d = new Detalles();
  const comun = validarComun(body, d);

  // procesarRequerimientoManual() es tolerante a propósito (la usa una persona
  // que digita): descarta los ítems sin insumo y convierte en 1 una cantidad
  // inválida. Acá las dos cosas son un 422, así que se validan antes.
  const items = itemsDe(body, d).map((it, i) => {
    if (!it) return null;
    const donde = `Ítem ${i + 1}`;
    return {
      insumo:   textoItem(it, 'insumo', donde, d, 300),
      cantidad: d.numero(it, 'cantidad', donde, { min: 0, minExclusivo: true }),
      unidad:   unidadDe(it, donde, d),
    };
  });
  const log = { origenSolicitudId: comun.origenSolicitudId };
  if (!d.ok) return { ...invalido(d), log };

  const messageId = messageIdDe(comun.origenSolicitudId);
  const ya = await repoReq.porOrigenCorreo(messageId);
  if (ya) return { status: 200, body: reqExistente(ya), log: { ...log, duplicado: true } };

  const { proyecto, error } = await proyectoOError(comun.proyectoKaosId);
  if (error) return { ...error, log };

  // Quien la pidió va en notas; su nombre en `solicitante` (responsable).
  const procedencia = comun.observaciones && comun.observaciones.includes(comun.origenSolicitadoPor)
    ? comun.observaciones
    : [comun.observaciones || `[RRHH:${comun.origenSolicitudId.slice(0, 8)}] Dotación`,
       `solicitó ${comun.origenSolicitadoPorNombre} (${comun.origenSolicitadoPor})`].join(' · ');

  try {
    const { procesarRequerimientoManual } = require('./procesarCorreo');
    const resultado = await procesarRequerimientoManual({
      proyecto:    proyecto.codigo,
      fecha:       hoyBogota(),
      responsable: comun.origenSolicitadoPorNombre,
      items,
    });

    const requerimientos = require('./requerimientos');
    const { item, duplicado, consecutivoSistema } = await requerimientos.crearDesdeCorreo(resultado, {
      messageId, adjuntoUrl: '', notas: procedencia,
    });
    if (duplicado) return { status: 200, body: reqExistente(item), log: { ...log, duplicado: true } };

    return {
      status: 201,
      body: {
        creado:            true,
        erpItemId:         String(item.id),
        erpTipoDocumento:  'REQ',
        consecutivo:       consecutivoSistema || item.consecutivoSistema || '',
        estado:            item.estado,
        proyecto:          proyecto.etiqueta,
        itemsSinHistorial: resultado.itemsSinPrecio || 0,
      },
      log: { ...log, estado: item.estado },
    };
  } catch (err) {
    if (esDuplicado(err, 'requerimientos_origen_correo_key')) {
      const f = await repoReq.porOrigenCorreo(messageId);
      if (f) return { status: 200, body: reqExistente(f), log: { ...log, duplicado: true } };
    }
    const r = respuestaDeError(err);
    if (r) return { ...r, log };
    throw err;
  }
}

async function consultarRequerimientos(origenSolicitudId) {
  const filas = await repoReq.porOrigenConOcs(messageIdDe(origenSolicitudId));
  return {
    requerimientos: filas.map(r => ({
      erpItemId:     String(r.id),
      consecutivo:   r.consecutivo_sistema || '',
      estado:        r.estado,
      proyecto:      r.proyecto || '',
      fechaCreacion: r.created_at ? r.created_at.toISOString() : null,
      ordenesCompra: r.ordenes_compra.map(o => ({
        erpItemId: String(o.id),
        numeroOC:  o.numero_oc || null,
        estado:    o.estado,
        proveedor: o.proveedor || '',
        total:     Number(o.total),
      })),
    })),
  };
}

// ── Enrutamiento ────────────────────────────────────────────────────────────

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let largo = 0;
    req.on('data', (c) => {
      largo += c.length;
      if (largo > MAX_CUERPO) { reject(Object.assign(new Error('cuerpo muy grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const RUTAS = {
  '/api/ordenes-servicio': { crear: crearOrdenServicio, consultar: consultarOrdenesServicio },
  '/api/requerimientos':   { crear: crearRequerimiento, consultar: consultarRequerimientos },
};

/**
 * Atiende una petición a /api/*. La llave ya se validó en el llamador.
 * Registra cada llamada en una línea: método, ruta, resultado y
 * origenSolicitudId; en la orden de servicio, si quedó aprobada o en borrador.
 */
async function atender(req, res, url) {
  const t0 = Date.now();
  const responder = (status, body, log = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    console.log('[api]', JSON.stringify({
      metodo: req.method, ruta: url, status, ms: Date.now() - t0, ...log,
    }));
  };

  const ruta = RUTAS[url];
  if (!ruta) return responder(404, { error: 'not_found' });

  try {
    if (req.method === 'GET') {
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const id = String(qs.get('origenSolicitudId') || '').trim().toLowerCase();
      if (!UUID.test(id)) {
        return responder(422, { error: 'payload_invalido', detalles: ['"origenSolicitudId" no es un uuid válido.'] });
      }
      // Sin resultados: 200 con la lista vacía, nunca 404. KAOS necesita
      // distinguir «no existe» de «falló la consulta».
      return responder(200, await ruta.consultar(id), { origenSolicitudId: id });
    }

    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await leerCuerpo(req) || '{}'); }
      catch (e) {
        if (e.status === 413) return responder(413, { error: 'payload_muy_grande' });
        return responder(422, { error: 'payload_invalido', detalles: ['El cuerpo no es JSON válido.'] });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return responder(422, { error: 'payload_invalido', detalles: ['El cuerpo debe ser un objeto JSON.'] });
      }
      const r = await ruta.crear(body);
      return responder(r.status, r.body, r.log);
    }

    res.setHeader('Allow', 'GET, POST');
    return responder(405, { error: 'method_not_allowed' });
  } catch (err) {
    console.error(`[api] ${req.method} ${url}:`, err);
    return responder(500, { error: 'error_interno' });
  }
}

module.exports = { atender, calcularTotales, leerTope, CLAVE_TOPE };
