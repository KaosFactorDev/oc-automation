'use strict';
/**
 * servidor-cotizaciones.js
 * App web local para cargar cotizaciones y actualizar precios en compras.csv
 * Puerto: 3001 — abrir en navegador: http://localhost:3001
 *
 * Endpoints:
 *   GET  /               → UI principal
 *   POST /extraer        → recibe archivo, extrae precios con Gemini API
 *   POST /confirmar      → guarda filas confirmadas en compras.csv
 *   GET  /proveedores    → lista de proveedores activos para autocompletado
 *   GET  /insumos        → lista de insumos históricos para autocompletado
 *   GET  /proyectos      → lista de proyectos activos
 */

require('dotenv').config();

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { execSync } = require('child_process');

const g          = require('./graphStorage');
const cc         = require('./controlCostos');
const ocTemplate       = require('./ocTemplate');
const remisionTemplate = require('./remisionTemplate');
const osTemplate       = require('./osTemplate');
const configApp        = require('./configApp');
const localDb          = require('./db');
const syncService      = require('./syncService');
const auth             = require('./authService');
const pdfGenerator     = require('./pdfGenerator');
const tesoreria        = require('./tesoreriaClient');

// Sobreescribe cfg.firmante con el usuario de la sesión activa.
// La configuración de empresa (logo, emisor, IVA) sigue viniendo de SharePoint.
function cfgConFirmante(cfg, sesion) {
  const nombre = (sesion?.nombre || '').trim();
  if (!nombre) return cfg;
  const usuario = localDb.getUsuarioByEmail(sesion.email) || {};
  const cargo = (usuario.cargo || '').trim();
  return { ...cfg, firmante: { nombre, cargo } };
}

// Construye un OC a partir del item de SharePoint (hidratando itemsJson).
// Acepta id = "preview" para renderizar un OC de muestra sin tocar SharePoint.
async function ocDesdeSharePoint(itemId) {
  if (itemId === 'preview') {
    return {
      numeroOC: 'OC-0042',
      fecha: new Date().toLocaleDateString('es-CO'),
      proyecto: 'INGENIERÍA, CONSTRUCCIÓN Y MONTAJE DE REDES ELÉCTRICAS',
      proveedor: {
        nombre: 'PROVEEDOR DE MUESTRA S.A.S.',
        nit: '901.234.567-8',
        direccion: 'Cra 10 # 20-30',
        municipio: 'Bogotá D.C.',
        telefono: '(+57) 601 234 5678',
        correo: 'ventas@proveedor.com',
      },
      lugarEntrega: 'Bodega del proyecto — Km 12 vía Guasca',
      fechaEntrega: new Date().toLocaleDateString('es-CO'),
      requerimientoOrigen: '',
      condicionesComerciales: 'Pago a 30 días. Transporte incluido hasta sitio.',
      observaciones: 'Verificar estado y cantidades antes de firmar recibido.',
      items: [
        { descripcion: 'CABLE ENCAUCHETADO 3X12 AWG', unidad: 'MT',  cantidad: 200, precioUnitario: 8500, descuentoPct: 0,  ivaPct: 19 },
        { descripcion: 'ABRAZADERA METÁLICA 1/2"',    unidad: 'UND', cantidad: 50,  precioUnitario: 2300, descuentoPct: 5,  ivaPct: 19 },
        { descripcion: 'TUBO CONDUIT PVC 3/4" X 3M',  unidad: 'UND', cantidad: 30,  precioUnitario: 12500, descuentoPct: 0,  ivaPct: 19 },
        { descripcion: 'CAJA OCTOGONAL PVC 4"',       unidad: 'UND', cantidad: 40,  precioUnitario: 3200, descuentoPct: 0,  ivaPct: 19 },
      ],
    };
  }
  const ctx = await ctxSharePoint();
  if (!ctx.OrdenesCompra) throw new Error('Lista OrdenesCompra no existe');
  const item = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, itemId);
  const f = item.fields || {};
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
      nombre: f.proveedorNombre || '',
      nit:    f.proveedorNit    || '',
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

// Genera el PDF de la OC (mismo motor que /oc/:id.html) y lo sube a SharePoint,
// guardando el link en el campo pdfUrl. Se relee el item fresco de Graph para
// tener itemsJson completo (actualizado.fields del PATCH no lo incluye).
async function guardarPdfOCEnSharePoint(ctx, itemId, sesion) {
  const oc  = await ocDesdeSharePoint(itemId);
  const cfg = cfgConFirmante(await configApp.getConfig(), sesion);
  const html   = ocTemplate.generarHTML(oc, cfg);
  const buffer = await pdfGenerator.htmlAPdf(html);
  const nombre = `${oc.numeroOC || itemId}_${oc.proyecto || 'SIN-PROYECTO'}`.replace(/[\\/:*?"<>|]/g, '-');
  const driveItem = await g.uploadFileToSite(ctx.siteId, `/OrdenesCompraPDF/${nombre}.pdf`, buffer, 'application/pdf');
  await g.updateListItem(ctx.siteId, ctx.OrdenesCompra, itemId, { pdfUrl: driveItem.webUrl });
  return driveItem.webUrl;
}

// Arma el objeto de remisión a partir de un requerimiento en SharePoint.
// Solo permitida cuando el requerimiento está gestionado/parcial/cerrado:
// se listan los ítems del requerimiento y (si hay) las OC asociadas.
async function remisionDesdeRequerimiento(itemId) {
  const ctx = await ctxSharePoint();
  if (!ctx.Requerimientos) throw new Error('Lista Requerimientos no existe');
  const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, itemId);
  const f = reqItem.fields || {};

  let items = [];
  try { items = JSON.parse(f.itemsJson || '[]'); } catch { items = []; }

  const ocs = (f.ocsGeneradas || '').split(',').map(s => s.trim()).filter(Boolean);
  const itemsRemision = items.map(it => ({
    descripcion: it.insumo || it.descripcion || '',
    unidad:      it.unidad || 'UND',
    cantidad:    Number(it.cantidad || 0),
    observacion: it.necesidad || '',
  }));

  return {
    numero:         f.consecutivo || reqItem.id,
    consecutivoReq: f.consecutivo || reqItem.id,
    fecha:          new Date().toLocaleDateString('es-CO'),
    proyecto:       f.proyecto || '',
    lugarEntrega:   f.lugarEntrega || '',
    solicitante:    f.solicitante || '',
    cargo:          f.cargoSolicitante || '',
    observaciones:  f.notas || '',
    responsableEntrega:   '',
    responsableRecepcion: '',
    ocsAsociadas:   ocs.join(', '),
    items:          itemsRemision,
  };
}

// Arma la remisión a partir de una o varias OC (mismo proyecto).
// Los ítems se consolidan por descripción+unidad sumando cantidades.
async function remisionDesdeOCs(ocIds, extra = {}) {
  const ctx = await ctxSharePoint();
  if (!ctx.OrdenesCompra) throw new Error('Lista OrdenesCompra no existe');
  if (!Array.isArray(ocIds) || !ocIds.length) throw new Error('Debe indicar al menos una OC');

  const ocsRaw = [];
  for (const id of ocIds) {
    const it = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, id);
    ocsRaw.push(it);
  }
  const proyectos = [...new Set(ocsRaw.map(o => (o.fields?.proyecto || '').trim()).filter(Boolean))];
  if (proyectos.length > 1) {
    throw new Error('Las OC seleccionadas deben pertenecer al mismo proyecto: ' + proyectos.join(' / '));
  }
  const estadosInvalidos = ocsRaw.filter(o => ['borrador','anulada'].includes(o.fields?.estado));
  if (estadosInvalidos.length) {
    const nums = estadosInvalidos.map(o => o.fields?.numeroOC || o.id).join(', ');
    throw new Error(`No se pueden incluir OC en borrador o anuladas: ${nums}`);
  }

  const numerosOC = ocsRaw.map(o => o.fields?.numeroOC).filter(Boolean);
  const consolidados = new Map();
  for (const oc of ocsRaw) {
    let items = [];
    try { items = JSON.parse(oc.fields?.itemsJson || '[]'); } catch { items = []; }
    for (const it of items) {
      const desc = (it.descripcion || it.insumo || '').trim();
      const unidad = (it.unidad || 'UND').trim();
      const key = `${desc}||${unidad}`;
      const prev = consolidados.get(key) || { descripcion: desc, unidad, cantidad: 0, observacion: '' };
      prev.cantidad += Number(it.cantidad || 0);
      consolidados.set(key, prev);
    }
  }

  const primer = ocsRaw[0].fields || {};
  return {
    numero:               extra.numero || '',
    fecha:                extra.fecha ? new Date(extra.fecha).toLocaleDateString('es-CO') : new Date().toLocaleDateString('es-CO'),
    proyecto:             primer.proyecto || '',
    lugarEntrega:         extra.lugarEntrega || primer.lugarEntrega || '',
    solicitante:          primer.creadoPor || '',
    cargo:                '',
    observaciones:        extra.observaciones || '',
    responsableEntrega:   extra.responsableEntrega || '',
    responsableRecepcion: extra.responsableRecepcion || '',
    ocsAsociadas:         numerosOC.join(', '),
    items:                [...consolidados.values()],
  };
}

// Arma la remisión (remisionDesdeOCs), le asigna consecutivo y la guarda en
// SharePoint + SQLite. Reutilizada por POST /remisiones y por la generación
// automática al marcar una OC como entregada.
async function crearRemisionYGuardar(ctx, ocIds, extra, usuario) {
  const rem = await remisionDesdeOCs(ocIds, extra);

  const now = new Date().toISOString();
  const existentes = await g.getListItems(ctx.siteId, ctx.Remisiones);
  const numero = 'REM-' + String((existentes?.length || 0) + 1).padStart(5, '0');
  rem.numero = numero;

  const creado = await g.addListItem(ctx.siteId, ctx.Remisiones, {
    numero,
    fecha:                extra.fecha || now,
    proyecto:             rem.proyecto,
    ocIds:                JSON.stringify(ocIds),
    ocsAsociadas:         rem.ocsAsociadas,
    itemsJson:            JSON.stringify(rem.items),
    observaciones:        rem.observaciones,
    responsableEntrega:   rem.responsableEntrega,
    responsableRecepcion: rem.responsableRecepcion,
    lugarEntrega:         rem.lugarEntrega,
    creadoPor:            usuario,
    fechaCreacion:        now,
    estado:               'activa',
  });

  if (creado?.id) localDb.upsertDocumento('remisiones', creado);
  return { id: creado.id, numero, rem };
}

// Al anular una OC, propaga el cambio a las remisiones que la incluyan.
// - Si la remisión tenía SOLO esa OC → estado='anulada'.
// - Si tenía varias OC → estado='requiere-reemplazo' + alerta para generar nueva remisión con las OC restantes.
// Devuelve el listado de remisiones afectadas para que el UI pueda avisar.
async function cascadaAnulacionRemisiones(ctx, ocIdAnulada, ocFields, usuario, now) {
  if (!ctx.Remisiones) return [];
  const remisiones = await g.getListItems(ctx.siteId, ctx.Remisiones);
  const afectadas = [];
  const numOCAnulada = ocFields.numeroOC || `id:${ocIdAnulada}`;

  for (const rem of remisiones) {
    const f = rem.fields || {};
    if (f.estado === 'anulada') continue;
    let ids = [];
    try { ids = JSON.parse(f.ocIds || '[]'); } catch { ids = []; }
    if (!ids.map(String).includes(String(ocIdAnulada))) continue;

    const quedanIds = ids.map(String).filter(id => id !== String(ocIdAnulada));
    const fechaStr = new Date(now).toLocaleDateString('es-CO');

    if (quedanIds.length === 0) {
      // Única OC en la remisión → se anula completa
      await g.updateListItem(ctx.siteId, ctx.Remisiones, rem.id, {
        estado: 'anulada',
        motivoAnulacion: `OC ${numOCAnulada} anulada por ${usuario} el ${fechaStr}`,
      });
      localDb.upsertDocumento('remisiones', { id: rem.id, fields: { ...f, estado: 'anulada',
        motivoAnulacion: `OC ${numOCAnulada} anulada por ${usuario} el ${fechaStr}` } });
      afectadas.push({ id: rem.id, numero: f.numero, accion: 'anulada' });
    } else {
      // Remisión multi-OC → mantiene estado pero queda marcada con alerta
      let numerosRestantes = [];
      try {
        for (const id of quedanIds) {
          const oc = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, id);
          if (oc?.fields?.numeroOC) numerosRestantes.push(oc.fields.numeroOC);
          else numerosRestantes.push(`id:${id}`);
        }
      } catch {}
      const alerta = `⚠ OC ${numOCAnulada} fue anulada el ${fechaStr}. Se requiere generar una nueva remisión para las OC restantes: ${numerosRestantes.join(', ')}`;
      const alertasPrev = f.alertas || '';
      await g.updateListItem(ctx.siteId, ctx.Remisiones, rem.id, {
        estado: 'requiere-reemplazo',
        alertas: alertasPrev ? `${alertasPrev}\n${alerta}` : alerta,
      });
      localDb.upsertDocumento('remisiones', { id: rem.id, fields: { ...f, estado: 'requiere-reemplazo',
        alertas: alertasPrev ? `${alertasPrev}\n${alerta}` : alerta } });
      afectadas.push({ id: rem.id, numero: f.numero, accion: 'requiere-reemplazo', ocRestantes: numerosRestantes });
    }
  }
  return afectadas;
}

// Recorre todos los requerimientos y recalcula su estado según las OC vigentes.
// Útil para reparar requerimientos que quedaron 'gestionado' después de anular OCs
// antes de que existiera la cascada de re-evaluación. Llamado desde GET /requerimientos.
async function reconciliarRequerimientosVsOCs(ctx) {
  if (!ctx.Requerimientos || !ctx.OrdenesCompra) return 0;
  const reqs = await g.getListItems(ctx.siteId, ctx.Requerimientos);
  let cambios = 0;
  for (const r of reqs) {
    const f = r.fields || {};
    if (f.estado === 'anulado' || f.estado === 'cerrado') continue;
    try {
      const nuevo = await calcularEstadoRequerimiento(ctx, r);
      if (nuevo && nuevo !== f.estado) {
        await g.updateListItem(ctx.siteId, ctx.Requerimientos, r.id, { estado: nuevo });
        localDb.upsertDocumento('requerimientos', { id: r.id, fields: { ...f, estado: nuevo } });
        cambios++;
      }
    } catch (e) { console.warn(`Reconcilia req ${r.id}:`, e.message); }
  }
  return cambios;
}

// Recorre todas las remisiones y actualiza su estado según el estado actual de las OC.
// Útil para reparar remisiones que quedaron activas después de anular OCs antes de que
// existiera la cascada. Llamado desde GET /remisiones para auto-corrección continua.
async function reconciliarRemisionesVsOCs(ctx) {
  if (!ctx.Remisiones || !ctx.OrdenesCompra) return 0;
  const remisiones = await g.getListItems(ctx.siteId, ctx.Remisiones);
  let cambios = 0;
  for (const rem of remisiones) {
    const f = rem.fields || {};
    if (f.estado === 'anulada') continue;
    let ids = [];
    try { ids = JSON.parse(f.ocIds || '[]').map(String); } catch { ids = []; }
    if (!ids.length) continue;

    const estadosOCs = [];
    for (const id of ids) {
      try {
        const oc = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, id);
        estadosOCs.push({ id, numero: oc.fields?.numeroOC || `id:${id}`, estado: oc.fields?.estado || 'borrador' });
      } catch { estadosOCs.push({ id, numero: `id:${id}`, estado: 'desconocida' }); }
    }
    const anuladas = estadosOCs.filter(o => o.estado === 'anulada');
    const vigentes = estadosOCs.filter(o => o.estado !== 'anulada');
    if (!anuladas.length) continue;

    if (!vigentes.length) {
      const motivo = `OCs anuladas: ${anuladas.map(o => o.numero).join(', ')}`;
      const motivoFinal = f.motivoAnulacion ? f.motivoAnulacion : motivo;
      await g.updateListItem(ctx.siteId, ctx.Remisiones, rem.id, {
        estado: 'anulada',
        motivoAnulacion: motivoFinal,
      });
      localDb.upsertDocumento('remisiones', { id: rem.id, fields: { ...f, estado: 'anulada', motivoAnulacion: motivoFinal } });
      cambios++;
    } else if (f.estado !== 'requiere-reemplazo') {
      const alerta = `⚠ OCs anuladas: ${anuladas.map(o => o.numero).join(', ')}. Generar nueva remisión para OCs vigentes: ${vigentes.map(o => o.numero).join(', ')}`;
      const alertasFinal = f.alertas ? `${f.alertas}\n${alerta}` : alerta;
      await g.updateListItem(ctx.siteId, ctx.Remisiones, rem.id, {
        estado: 'requiere-reemplazo',
        alertas: alertasFinal,
      });
      localDb.upsertDocumento('remisiones', { id: rem.id, fields: { ...f, estado: 'requiere-reemplazo', alertas: alertasFinal } });
      cambios++;
    }
  }
  return cambios;
}

// Normaliza el nombre del insumo para comparar entre OC y requerimiento
function claveInsumo(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// Calcula el estado del requerimiento según cobertura por OCs existentes.
// - 'gestionado' : todos los ítems con OC que cubre >= cantidad solicitada
// - 'parcial'    : al menos un ítem tiene OC pero hay faltantes
// - 'pendiente'  : ningún ítem cubierto
// Las OCs en estado 'anulada' no cuentan hacia la cobertura.
async function calcularEstadoRequerimiento(ctx, reqItem) {
  const reqF = reqItem.fields || {};
  let itemsReq = [];
  try { itemsReq = JSON.parse(reqF.itemsJson || '[]'); } catch { itemsReq = []; }
  if (!itemsReq.length) return reqF.estado || 'pendiente';

  // Obtener todas las OC de este requerimiento
  const ocsAll = await g.getListItems(ctx.siteId, ctx.OrdenesCompra, {
    filter: `fields/requerimientoId eq '${String(reqItem.id).replace(/'/g,"''")}'`,
  });

  // Acumular cantidades por insumo (ignorando OC anuladas)
  const cubierto = {};
  for (const oc of ocsAll) {
    const ocF = oc.fields || {};
    if (ocF.estado === 'anulada') continue;
    let items = [];
    try { items = JSON.parse(ocF.itemsJson || '[]'); } catch { continue; }
    for (const it of items) {
      const k = claveInsumo(it.descripcion || it.insumo);
      cubierto[k] = (cubierto[k] || 0) + Number(it.cantidad || 0);
    }
  }

  const itemsActivos = itemsReq.filter(it => !it.descartado);
  let cubiertos = 0, total = 0;
  for (const it of itemsActivos) {
    const k     = claveInsumo(it.homologadoCon || it.insumo);
    const kOrig = claveInsumo(it.insumo);
    const req   = Number(it.cantidad || 0);
    total++;
    const cantCubierta = (cubierto[k] || 0) + (k !== kOrig ? cubierto[kOrig] || 0 : 0);
    if (cantCubierta + 1e-9 >= req) cubiertos++;
  }
  if (cubiertos === 0) return 'pendiente';
  if (cubiertos < total) return 'parcial';
  return 'gestionado';
}

// Cache de IDs de listas SharePoint para no resolverlas en cada request
const _listCache = {}; // { siteId, Requerimientos, OrdenesCompra, Insumos, Proveedores }
let _columnasMigradas     = false;
let _osListProvisioned    = false;
let _hpListProvisioned    = false;
let _miListProvisioned    = false;
let _carpetaPdfReqUrl     = null; // cache del webUrl de RequerimientosPDF
let _carpetaPdfOCUrl      = null; // cache del webUrl de OrdenesCompraPDF
let _carpetaPdfOSUrl      = null; // cache del webUrl de OrdenesServicioPDF
let _usrListProvisioned   = false;

async function asegurarListaOS(siteId) {
  // Intenta obtener la lista; si no existe, la crea con todas las columnas del esquema
  const { OrdenesServicio: schema } = require('./scripts/esquemas');
  let listId;
  try {
    const lst = await g.getListByName(siteId, 'OrdenesServicio');
    listId = lst?.id;
  } catch {}

  if (!listId) {
    try {
      const created = await g.post(`/sites/${siteId}/lists`, {
        displayName: schema.displayName,
        description: schema.description || '',
        list: schema.list,
      });
      listId = created?.id;
      console.log('[asegurarListaOS] Lista OrdenesServicio creada:', listId);
    } catch (e) {
      if (!String(e.message).includes('409')) {
        console.warn('[asegurarListaOS] No se pudo crear lista:', e.message);
        return;
      }
      // Ya existe — reintentar GET
      try { const lst = await g.getListByName(siteId, 'OrdenesServicio'); listId = lst?.id; } catch {}
    }
  }

  if (!listId) return;
  _listCache.OrdenesServicio = listId;

  // Agregar columnas (ignora 409 = ya existe)
  for (const col of schema.columns) {
    const { name, required, ...tipo } = col;
    const body = { name, ...tipo };
    if (required) body.required = true;
    try {
      await g.post(`/sites/${siteId}/lists/${listId}/columns`, body);
    } catch (e) {
      if (!String(e.message).includes('409')) {
        console.warn(`[asegurarListaOS] Col "${name}":`, e.message);
      }
    }
  }
}

async function asegurarListaHP(siteId) {
  const { HistorialPrecios: schema } = require('./scripts/esquemas');
  let listId;
  try { const lst = await g.getListByName(siteId, 'HistorialPrecios'); listId = lst?.id; } catch {}
  if (!listId) {
    try {
      const created = await g.post(`/sites/${siteId}/lists`, {
        displayName: schema.displayName,
        description: schema.description || '',
        list: schema.list,
      });
      listId = created?.id;
      console.log('[asegurarListaHP] Lista HistorialPrecios creada:', listId);
    } catch (e) {
      if (!String(e.message).includes('409')) { console.warn('[asegurarListaHP]', e.message); return; }
      try { const lst = await g.getListByName(siteId, 'HistorialPrecios'); listId = lst?.id; } catch {}
    }
  }
  if (!listId) return;
  _listCache.HistorialPrecios = listId;
  for (const col of schema.columns) {
    const { name, required, ...tipo } = col;
    const body = { name, ...tipo };
    if (required) body.required = true;
    try { await g.post(`/sites/${siteId}/lists/${listId}/columns`, body); }
    catch (e) { if (!String(e.message).includes('409')) console.warn(`[asegurarListaHP] Col "${name}":`, e.message); }
  }
}

async function asegurarListaMI(siteId) {
  const { MovimientosInventario: schema } = require('./scripts/esquemas');
  let listId;
  try { const lst = await g.getListByName(siteId, 'MovimientosInventario'); listId = lst?.id; } catch {}
  if (!listId) {
    try {
      const created = await g.post(`/sites/${siteId}/lists`, {
        displayName: schema.displayName,
        description: schema.description || '',
        list: schema.list,
      });
      listId = created?.id;
      console.log('[asegurarListaMI] Lista MovimientosInventario creada:', listId);
    } catch (e) {
      if (!String(e.message).includes('409')) { console.warn('[asegurarListaMI]', e.message); return; }
      try { const lst = await g.getListByName(siteId, 'MovimientosInventario'); listId = lst?.id; } catch {}
    }
  }
  if (!listId) return;
  _listCache.MovimientosInventario = listId;
  for (const col of schema.columns) {
    const { name, required, ...tipo } = col;
    const body = { name, ...tipo };
    if (required) body.required = true;
    try { await g.post(`/sites/${siteId}/lists/${listId}/columns`, body); }
    catch (e) { if (!String(e.message).includes('409')) console.warn(`[asegurarListaMI] Col "${name}":`, e.message); }
  }
}

async function migrarColumnasOC(siteId, listId) {
  const columnas = [
    { name: 'requerimientoOrigen',  text: { maxLength: 50 } },
    { name: 'fechaEntregaPrevista', dateTime: {} },
    // Solicitud de pago en tesorería (Pagos Diarios). Se guardan acá y no solo
    // en SQLite porque upsertDocumento() reescribe el JSON local con lo que
    // venga de SharePoint en cada sync.
    { name: 'solicitudTesoreriaId',    text: { maxLength: 50 } },  // egreso_id CE-YYMMNNNN
    { name: 'fechaSolicitudTesoreria', dateTime: {} },
    { name: 'solicitudTesoreriaPor',   text: { maxLength: 200 } },
  ];
  for (const col of columnas) {
    try {
      await g.post(`/sites/${siteId}/lists/${listId}/columns`, col);
    } catch (e) {
      // 409 = columna ya existe — es el estado normal en ejecuciones subsiguientes
      if (!String(e.message).includes('409')) {
        console.warn(`[migrarColumnasOC] No se pudo agregar columna "${col.name}":`, e.message);
      }
    }
  }
}

async function asegurarListaUsuariosERP(siteId) {
  const columns = [
    { name: 'email',  text: { maxLength: 200 }, required: true },
    { name: 'nombre', text: { maxLength: 200 } },
    { name: 'cargo',  text: { maxLength: 200 } },
    { name: 'rol',    choice: { choices: ['admin', 'operador'], displayAs: 'dropDownMenu' } },
    { name: 'activo', boolean: {} },
  ];
  let listId;
  try { const lst = await g.getListByName(siteId, 'UsuariosERP'); listId = lst?.id; } catch {}
  if (!listId) {
    try {
      const created = await g.post(`/sites/${siteId}/lists`, {
        displayName: 'UsuariosERP',
        description: 'Usuarios habilitados para acceder al ERP',
        list: { template: 'genericList' },
      });
      listId = created?.id;
      console.log('[asegurarListaUsuariosERP] Lista creada:', listId);
    } catch (e) {
      if (!String(e.message).includes('409')) { console.warn('[asegurarListaUsuariosERP]', e.message); return; }
      try { const lst = await g.getListByName(siteId, 'UsuariosERP'); listId = lst?.id; } catch {}
    }
  }
  if (!listId) return;
  _listCache.UsuariosERP = listId;
  for (const col of columns) {
    const { required, ...body } = col;
    if (required) body.required = true;
    try { await g.post(`/sites/${siteId}/lists/${listId}/columns`, body); }
    catch (e) { if (!String(e.message).includes('409')) console.warn(`[asegurarListaUsuariosERP] Col "${col.name}":`, e.message); }
  }
}

async function bootstrapAdmin() {
  if (localDb.countUsuarios() > 0) return;
  const email = (process.env.USUARIO_EMAIL || '').trim().toLowerCase();
  if (!email) return;

  const ctx = await ctxSharePoint();
  let listId = ctx.UsuariosERP;

  if (!listId) {
    // Esperar hasta 15s a que la lista sea aprovisionada en segundo plano
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const lst = await g.getListByName(ctx.siteId, 'UsuariosERP');
        if (lst?.id) { listId = lst.id; _listCache.UsuariosERP = listId; break; }
      } catch {}
    }
  }
  if (!listId) { console.warn('[bootstrap] Lista UsuariosERP no disponible'); return; }

  const adminData = {
    email,
    nombre: email,
    cargo:  'Administrador',
    rol:    'admin',
    activo: true,
  };
  try {
    const item = await g.addListItem(ctx.siteId, listId, adminData);
    localDb.upsertUsuario({ sp_id: String(item.id), ...adminData });
    console.log(`[bootstrap] Admin inicial creado: ${email}`);
  } catch (e) {
    console.warn('[bootstrap] Error al crear admin:', e.message);
  }
}

async function ctxSharePoint() {
  if (_listCache.siteId) return _listCache;
  const host = process.env.SHAREPOINT_HOSTNAME;
  const sitePath = process.env.SHAREPOINT_SITE_PATH;
  if (!host || !sitePath) throw new Error('SHAREPOINT_HOSTNAME / SHAREPOINT_SITE_PATH no configurados');
  const site = await g.getSite(host, sitePath);
  _listCache.siteId = site.id;
  for (const nombre of ['Requerimientos','OrdenesCompra','Insumos','Proveedores','Remisiones','Proyectos','OrdenesServicio','HistorialPrecios','MovimientosInventario','UsuariosERP']) {
    try {
      const lst = await g.getListByName(site.id, nombre);
      if (lst) _listCache[nombre] = lst.id;
    } catch { /* lista no existe todavía */ }
  }
  // Migrar columnas nuevas a la lista OrdenesCompra (solo una vez por proceso)
  if (!_columnasMigradas && _listCache.OrdenesCompra) {
    _columnasMigradas = true;
    migrarColumnasOC(_listCache.siteId, _listCache.OrdenesCompra).catch(() => {});
  }
  // Aprovisionar lista OrdenesServicio si no existe (solo una vez por proceso)
  if (!_osListProvisioned) {
    _osListProvisioned = true;
    asegurarListaOS(_listCache.siteId).catch(() => {});
  }
  // Aprovisionar lista HistorialPrecios si no existe (solo una vez por proceso)
  if (!_hpListProvisioned) {
    _hpListProvisioned = true;
    asegurarListaHP(_listCache.siteId).catch(() => {});
  }
  // Aprovisionar lista MovimientosInventario si no existe (solo una vez por proceso)
  if (!_miListProvisioned) {
    _miListProvisioned = true;
    asegurarListaMI(_listCache.siteId).catch(() => {});
  }
  // Aprovisionar lista UsuariosERP si no existe (solo una vez por proceso)
  if (!_usrListProvisioned) {
    _usrListProvisioned = true;
    asegurarListaUsuariosERP(_listCache.siteId).catch(() => {});
  }
  return _listCache;
}

const PORT         = process.env.PUERTO_COTIZACIONES || 3001;
const PATH_COMPRAS = process.env.PATH_COMPRAS     || path.join(__dirname, '../data/compras.csv');
const PATH_PROV    = process.env.PATH_PROVEEDORES || path.join(__dirname, '../data/proveedores_depurados_final.csv');
const PATH_PROY    = process.env.PATH_PROYECTOS   || path.join(__dirname, '../data/tabla_proyectos.csv');
const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';
const MODELO_GEMINI = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TEMP_DIR     = path.join(__dirname, '../temp/cotizaciones');
const AUTH_REDIRECT_URI = process.env.AUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

// Rutas que no requieren sesión activa
const RUTAS_PUBLICAS = ['/', '/legacy', '/auth/login-url', '/auth/callback', '/auth/logout', '/me'];

// Tope de ítems al crear un requerimiento digitándolo en la consola
const MAX_ITEMS_REQ_MANUAL = 100;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── CSV helpers ───────────────────────────────────────────────────────────────

function leerCSV(rutaArchivo) {
  const XLSX = require('xlsx');
  const content = fs.readFileSync(rutaArchivo, 'utf-8');
  const wb = XLSX.read(content, { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// ── HistorialPrecios — lee de SQLite (sin latencia de red) ───────────────────
// forceRefresh dispara un sync en segundo plano pero retorna SQLite inmediatamente.
async function getHistorialPrecios(_ctx, { forceRefresh = false } = {}) {
  if (forceRefresh) syncService.syncAll().catch(() => {});
  return localDb.getHistorialPrecios();
}

function invalidarHistorialCache() { /* SQLite siempre está actualizado */ }

async function agregarFilasCompras(filas, ctx) {
  if (!ctx) { try { ctx = await ctxSharePoint(); } catch {} }
  if (!ctx || !ctx.HistorialPrecios) {
    console.warn('[agregarFilasCompras] Lista HistorialPrecios no disponible — datos no guardados');
    return 0;
  }
  let guardadas = 0;
  for (const f of filas) {
    const nit    = String(f.nitProveedor ?? f.nit ?? '').trim().replace(/\.0$/, '');
    const nombre = String(f.nombreProveedor ?? f.proveedor ?? '').trim();
    const precio = parseFloat(f.precio) || 0;
    const cant   = parseFloat(f.cantidad) || 1;
    const fecha  = f.fechaVigencia || new Date().toLocaleDateString('es-CO', { year:'numeric', month:'long', day:'numeric' });
    const campos = {
      proyecto:        String(f.proyecto || '').trim(),
      numeroCompra:    String(f.numCotizacion || 'COT-MANUAL').trim(),
      tipoCompra:      'Cotización',
      insumo:          String(f.insumo || '').trim().toUpperCase(),
      cantidad:        cant,
      precioUnitario:  precio,
      valorTotal:      precio * cant,
      fecha,
      nitProveedor:    nit,
      nombreProveedor: nombre,
      estadoCompra:    'Aprobada',
      formaPago:       'Cotización',
      anticipo:        0,
    };
    try {
      const nuevo = await g.addListItem(ctx.siteId, ctx.HistorialPrecios, campos);
      // Reflejar en SQLite inmediatamente (sin esperar al próximo sync)
      localDb.upsertHistorialFila({ id: nuevo?.id || String(Date.now()), ...campos });
      guardadas++;
    } catch (e) {
      console.warn('[agregarFilasCompras] Error guardando fila:', e.message);
    }
  }
  return guardadas;
}

// ── Extracción con Gemini API ─────────────────────────────────────────────────

// Ejecuta un POST contra la API de Gemini y devuelve el cuerpo de respuesta ya
// parseado. Centraliza tres garantías que antes faltaban en varios llamadores:
//  - timeout: evita que un socket colgado deje la petición sin resolver (spinner infinito).
//  - reintento: ante errores transitorios (HTTP 503 / status UNAVAILABLE) o cortes de red,
//    reintenta con backoff exponencial (1s, 2s, ...). `reintentos: 0` = sin reintentos.
//  - error legible: lanza un Error con el código HTTP y el mensaje crudo de Gemini.
async function postGemini(url, bodyStr, { timeoutMs = 60000, reintentos = 0 } = {}) {
  const https = require('https');
  let ultimoError;
  for (let intento = 0; intento <= reintentos; intento++) {
    try {
      const resp = await new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch (e) { reject(new Error(`Respuesta de Gemini ilegible (HTTP ${res.statusCode})`)); }
          });
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Gemini timeout tras ${Math.round(timeoutMs / 1000)}s`)); });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });

      const err = resp.body?.error;
      const esTransitorio = resp.status === 503 || err?.status === 'UNAVAILABLE' || err?.code === 503;
      if (esTransitorio && intento < reintentos) {
        const espera = 1000 * Math.pow(2, intento);
        console.warn(`[postGemini] ${err?.status || 'HTTP ' + resp.status} — reintento ${intento + 1}/${reintentos} en ${espera}ms`);
        ultimoError = new Error(`Gemini no disponible (HTTP ${err?.code || resp.status}): ${err?.message || 'UNAVAILABLE'}`);
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      if (err) throw new Error(`Gemini error (HTTP ${err.code || resp.status}): ${err.message}`);
      return resp.body;
    } catch (e) {
      ultimoError = e;
      // Reintenta solo timeouts / cortes de red; los errores ya lanzados por la API no.
      const reintentable = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(e.message);
      if (reintentable && intento < reintentos) {
        const espera = 1000 * Math.pow(2, intento);
        console.warn(`[postGemini] ${e.message} — reintento ${intento + 1}/${reintentos} en ${espera}ms`);
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      throw e;
    }
  }
  throw ultimoError || new Error('Gemini: fallo desconocido');
}

function parsearJSONGemini(str) {
  // 1. Parseo limpio (caso normal)
  try { return JSON.parse(str); } catch {}

  const inicio = str.indexOf('[');
  if (inicio < 0) return [];
  const fragmento = str.slice(inicio);

  // 2. Recuperar objetos completos aunque el array esté truncado
  const items = [];
  const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
  let match;
  while ((match = objRegex.exec(fragmento)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.insumo) items.push(obj); // solo ítems válidos (descarta bloque totales)
    } catch {}
  }
  if (items.length > 0) {
    console.warn(`[extraerConGemini] JSON truncado — recuperados ${items.length} ítems parciales`);
    return items;
  }

  console.warn('[extraerConGemini] JSON truncado sin recuperación. Fragmento:', str.slice(0, 200));
  return [];
}

async function extraerConGemini(contenidoBase64, mimeType, nombreArchivo) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada en .env');

  const MODELO = MODELO_GEMINI;
  const URL    = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`;

  const PROMPT = `Analiza este documento de cotización y extrae TODOS los ítems cotizados.
Para cada ítem devuelve SOLO un JSON array con este formato exacto (sin texto adicional, sin markdown):
[
  {
    "insumo": "nombre exacto del producto",
    "cantidad": 1,
    "unidad": "UND",
    "precio": 12345.00,
    "ivaPct": 19,
    "proveedor": "nombre del proveedor",
    "nit": "NIT si está visible",
    "fechaVigencia": "DD/MM/YYYY si está visible",
    "proyecto": "proyecto si está mencionado",
    "observaciones": "condiciones comerciales relevantes"
  }
]
Reglas:
- El precio debe ser el precio UNITARIO SIN IVA. Si el documento trae precios con IVA incluido, réstale el IVA para entregar el valor sin IVA.
- "ivaPct" es el porcentaje de IVA aplicado a ese ítem (ej: 19, 5, 0). Si la cotización dice "IVA incluido del 19%" → ivaPct=19. Si dice "excluido de IVA" o "Régimen simplificado" → ivaPct=0. Si no es explícito pero hay un valor total con IVA del X%, usa X. Si no logras determinarlo, déjalo vacío.
- Si no encuentras un campo déjalo vacío.`;

  const esTexto = !mimeType.startsWith('image/') && mimeType !== 'application/pdf';

  let partes;
  if (esTexto) {
    // Excel/CSV convertido a texto
    const texto = Buffer.from(contenidoBase64, 'base64').toString('utf-8');
    partes = [
      { text: `Aquí está el contenido de la cotización "${nombreArchivo}":

${texto}

${PROMPT}` }
    ];
  } else {
    // PDF o imagen — Gemini acepta inline_data con base64
    partes = [
      { inline_data: { mime_type: mimeType, data: contenidoBase64 } },
      { text: PROMPT }
    ];
  }

  const body = JSON.stringify({
    contents: [{ parts: partes }],
    generationConfig: { temperature: 0, maxOutputTokens: 32768 },
  });

  const respuesta = await postGemini(URL, body, { timeoutMs: 60000, reintentos: 2 });

  const texto = respuesta.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const jsonLimpio = texto.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  return parsearJSONGemini(jsonLimpio);
}

// ── Gemini texto (prompt puro, sin documento adjunto) ─────────────────────────

async function geminiTexto(prompt, timeoutMs = 5000, extraConfig = {}) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada en .env');
  const MODELO = MODELO_GEMINI;
  const URL    = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`;
  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096, ...extraConfig },
  });
  const respuesta = await postGemini(URL, bodyStr, { timeoutMs });
  return (respuesta.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

// ── OS helpers ────────────────────────────────────────────────────────────────

function osDesdeFields(item) {
  // Compatible con objeto SP {id, fields} y con objeto plano SQLite {id, ...campos}
  const f = item.fields || item;
  let items = [];
  try { items = JSON.parse(f.itemsJson || '[]'); } catch {}
  return {
    id:                     item.id || f.id,
    numeroOS:               f.numeroOS || '',
    fecha:                  f.fechaCreacion ? new Date(f.fechaCreacion).toLocaleDateString('es-CO') : '',
    proyecto:               f.proyecto || '',
    proveedorNit:           f.proveedorNit || '',
    proveedorNombre:        f.proveedorNombre || '',
    tipoServicio:           f.tipoServicio || '',
    clausulas:              f.clausulas || '',
    ofertaEconomicaRef:     f.ofertaEconomicaRef || '',
    ofertaEconomicaCondiciones: f.ofertaEconomicaCondiciones || '',
    tipoContrato:           f.tipoContrato || 'IVA_PLENO',
    items,
    aiuA:                   Number(f.aiuA || 0),
    aiuI:                   Number(f.aiuI || 0),
    aiuU:                   Number(f.aiuU || 0),
    valor:                  Number(f.valor || 0),
    iva:                    Number(f.iva || 0),
    total:                  Number(f.total || 0),
    estado:                 f.estado || 'borrador',
    lugarPrestacion:        f.lugarPrestacion || '',
    fechaInicio:            f.fechaInicio ? new Date(f.fechaInicio).toLocaleDateString('es-CO') : '',
    fechaFin:               f.fechaFin ? new Date(f.fechaFin).toLocaleDateString('es-CO') : '',
    condicionesComerciales: f.condicionesComerciales || '',
    observaciones:          f.observaciones || '',
    tipoGasto:              f.tipoGasto || '',
    pagado:                 !!f.pagado,
    pagadoPor:              f.pagadoPor || '',
    fechaPago:              f.fechaPago ? new Date(f.fechaPago).toLocaleDateString('es-CO') : '',
    cumplido:               !!f.cumplido,
    cumplidoPor:            f.cumplidoPor || '',
    fechaCumplido:          f.fechaCumplido ? new Date(f.fechaCumplido).toLocaleDateString('es-CO') : '',
  };
}

// Genera el PDF de la OS (mismo motor que /os/:id/html) y lo sube a SharePoint,
// guardando el link en el campo pdfUrl.
async function guardarPdfOSEnSharePoint(ctx, osId, sesion) {
  const item = await g.getListItem(ctx.siteId, ctx.OrdenesServicio, osId);
  const os   = osDesdeFields(item);
  const cfg  = cfgConFirmante(await configApp.getConfig(), sesion);
  const html   = osTemplate.generarHTML(os, cfg);
  const buffer = await pdfGenerator.htmlAPdf(html);
  const nombre = `${os.numeroOS || osId}_${os.proyecto || 'SIN-PROYECTO'}`.replace(/[\\/:*?"<>|]/g, '-');
  const driveItem = await g.uploadFileToSite(ctx.siteId, `/OrdenesServicioPDF/${nombre}.pdf`, buffer, 'application/pdf');
  await g.updateListItem(ctx.siteId, ctx.OrdenesServicio, osId, { pdfUrl: driveItem.webUrl });
  return driveItem.webUrl;
}

// ── Parsear multipart manualmente (sin dependencias extra) ────────────────────

function parsearMultipart(body, boundary) {
  const sep    = Buffer.from('--' + boundary);
  const parts  = [];
  let start    = body.indexOf(sep) + sep.length + 2; // saltar \r\n

  while (start < body.length) {
    const end = body.indexOf(sep, start);
    if (end === -1) break;
    const part    = body.slice(start, end - 2); // quitar \r\n
    const divider = part.indexOf('\r\n\r\n');
    if (divider === -1) { start = end + sep.length + 2; continue; }

    const headersTxt = part.slice(0, divider).toString();
    const content    = part.slice(divider + 4);

    const nameM    = headersTxt.match(/name="([^"]+)"/);
    const fileNameM = headersTxt.match(/filename="([^"]+)"/);
    const typeM    = headersTxt.match(/Content-Type:\s*([^\r\n]+)/i);

    parts.push({
      name:     nameM?.[1] || '',
      fileName: fileNameM?.[1] || '',
      mimeType: typeM?.[1]?.trim() || 'text/plain',
      content,
    });

    start = end + sep.length + 2;
  }
  return parts;
}

// ── Rutas de datos para autocompletado ───────────────────────────────────────

async function obtenerProveedores(_ctx) {
  const rows = localDb.getProveedores();
  if (rows.length) return rows.map(r => ({ nit: r.nit, nombre: r.nombre, zona: r.zona }));
  // Fallback CSV si SQLite aún no se ha sincronizado
  try {
    return leerCSV(PATH_PROV).map(p => ({
      nit:    String(p['Identificacion'] || '').trim().replace(/\.0$/, ''),
      nombre: p['Razon social'] || '',
      zona:   p['zona'] || '',
    })).filter(p => p.nit);
  } catch { return []; }
}

// Match fuzzy de un nombre libre contra el catálogo de Insumos.
// Devuelve { nombre, categoria, subcategoria, score } del mejor candidato o null si no alcanza umbral.
function mejorMatchInsumo(query, catalogo) {
  const norm = (s) => String(s || '').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9\s\/\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = (s) => norm(s).split(' ').filter(t => t.length >= 3);
  const qNorm = norm(query);
  const qTok  = new Set(tokens(query));
  if (!qNorm) return null;

  let mejor = null;
  for (const it of catalogo) {
    const campos = [it.nombre, it.nombreNormalizado, it.sinonimos].filter(Boolean).join(' ');
    const cNorm = norm(campos);
    const cTok  = new Set(tokens(campos));
    // Score: tokens compartidos + bonus por substring completa
    let score = 0;
    for (const t of qTok) if (cTok.has(t)) score += 2;
    if (cNorm.includes(qNorm) || qNorm.includes(cNorm)) score += 3;
    if (norm(it.nombre) === qNorm) score += 10;
    if (score > (mejor?.score || 0)) {
      mejor = {
        id: it.id,
        nombre:       it.nombre,
        categoria:    it.categoria || '',
        subcategoria: it.subcategoria || '',
        unidadEstandar: it.unidadEstandar || '',
        score,
      };
    }
  }
  if (!mejor || mejor.score < 2) return null;
  return mejor;
}

function obtenerInsumosCSV() {
  try {
    const rows = leerCSV(PATH_COMPRAS);
    return rows.map(r => r['Suministro'] || r['Insumo'] || '').filter(Boolean);
  } catch { return []; }
}

async function obtenerInsumosHistorial(ctx) {
  try {
    const rows = await getHistorialPrecios(ctx);
    return rows.map(r => String(r.insumo || '').trim()).filter(Boolean);
  } catch { return obtenerInsumosCSV(); }
}

// Busca los mejores candidatos de homologación para un insumo sin historial,
// buscando contra todos los nombres únicos en compras.csv.
// Si GEMINI_KEY está disponible y el score del top candidato es bajo, usa Gemini para reordenar.
async function sugerirHomologacionCSV(query) {
  const norm = (s) => String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s\/\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = (s) => norm(s).split(' ').filter(t => t.length >= 2);

  const qNorm = norm(query);
  const qTok  = new Set(tokens(query));
  if (!qNorm) return [];

  // Nombres únicos del historial desde SQLite
  const rawNombres = await obtenerInsumosHistorial(null);
  const nombres = [...new Set(rawNombres.map(n => String(n).trim()).filter(Boolean))];

  const scored = nombres.map(nombre => {
    const cNorm = norm(nombre);
    const cTok  = new Set(tokens(nombre));
    let score = 0;
    for (const t of qTok) if (cTok.has(t)) score += 2;
    if (cNorm.includes(qNorm) || qNorm.includes(cNorm)) score += 3;
    if (cNorm === qNorm) score += 10;
    return { nombre, score };
  }).filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (!scored.length) return [];

  const top5 = scored.slice(0, 5);
  const mejorScore = top5[0]?.score || 0;

  // Si hay clave Gemini y el mejor score es ambiguo, pedir reordenamiento (timeout 5 s)
  if (GEMINI_KEY && mejorScore < 6 && scored.length > 1) {
    try {
      const candidatos = scored.slice(0, 10).map(c => c.nombre);
      const prompt = `Dado el insumo de construcción "${query}", ¿cuál de estas opciones del catálogo de compras corresponde mejor? Devuelve SOLO un JSON array con los nombres reordenados del mejor al peor match (sin texto adicional, sin markdown):\n${JSON.stringify(candidatos)}`;
      const texto = await geminiTexto(prompt, 5000);
      const reordenados = JSON.parse(texto.replace(/```json[\s\S]*?/g, '').replace(/```/g, '').trim());
      if (Array.isArray(reordenados) && reordenados.length) {
        return reordenados.slice(0, 5).map((nombre, i) => ({
          nombre: String(nombre),
          score: scored.find(c => c.nombre === nombre)?.score ?? (10 - i),
          porIA: true,
        }));
      }
    } catch { /* fallback al orden por tokens */ }
  }

  return top5.map(c => ({ nombre: c.nombre, score: c.score, porIA: false }));
}

// Devuelve catálogo de insumos en MAYÚSCULAS, dedupe.
async function obtenerInsumos() {
  const set = new Set();
  const rows = localDb.getInsumos({ soloActivos: true });
  for (const r of rows) if (r.nombre) set.add(r.nombre.toUpperCase());
  if (!set.size) {
    // Fallback CSV si SQLite aún no tiene datos
    for (const n of obtenerInsumosCSV()) set.add(String(n).trim().toUpperCase());
  }
  return [...set].filter(Boolean).sort();
}

function obtenerProyectos() {
  try {
    return leerCSV(PATH_PROY).map(p => p['codigo_proyecto'] || '').filter(Boolean);
  } catch { return []; }
}

// Lee proyectos desde SQLite (sin latencia). Fallback a CSV si está vacío.
async function obtenerProyectosSP({ soloActivos = true } = {}) {
  const rows = localDb.getProyectos({ soloActivos });
  if (rows.length) return rows.map(r => ({ id: r.sp_id, codigo: r.nombre, nombre: r.nombre, zona: r.zona, activo: r.activo !== 0 }));
  return obtenerProyectos().map(c => ({ codigo: c, nombre: c, activo: true }));
}

// ── Servidor HTTP ─────────────────────────────────────────────────────────────

const servidor = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const html = (contenido) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(contenido);
  };

  // ── Middleware de autenticación ──────────────────────────────────────────
  const esPublica = RUTAS_PUBLICAS.includes(url);
  const cookies   = auth.parseCookies(req.headers.cookie);
  const sesion    = auth.validateSession(cookies[auth.COOKIE_NAME]);

  if (!esPublica && !sesion) {
    return json({ error: 'no_session' }, 401);
  }
  req._sesion = sesion; // disponible en todos los handlers

  // ── GET / → Consola nueva (4 módulos) ───────────────────────────────────
  if (req.method === 'GET' && url === '/') {
    html(fs.readFileSync(path.join(__dirname, '../ui/consola.html'), 'utf-8'));
    return;
  }

  // ── GET /legacy → UI anterior (antes de la refactorización) ─────────────
  if (req.method === 'GET' && url === '/legacy') {
    html(fs.readFileSync(path.join(__dirname, '../ui/cotizaciones.html'), 'utf-8'));
    return;
  }

  // ── GET /me → info de la sesión activa ──────────────────────────────────
  if (req.method === 'GET' && url === '/me') {
    if (!sesion) return json({ error: 'no_session' }, 401);
    return json({ email: sesion.email, nombre: sesion.nombre, rol: sesion.rol });
  }

  // ── GET /auth/login-url → URL de login Microsoft ─────────────────────────
  if (req.method === 'GET' && url === '/auth/login-url') {
    return json({ url: auth.getLoginUrl(AUTH_REDIRECT_URI) });
  }

  // ── GET /auth/callback → intercambia code, crea sesión ───────────────────
  if (req.method === 'GET' && url === '/auth/callback') {
    const qs    = new URLSearchParams(req.url.split('?')[1] || '');
    const code  = qs.get('code')  || '';
    const state = qs.get('state') || '';
    const error = qs.get('error') || '';

    if (error) {
      res.writeHead(302, { 'Location': `/?auth_error=${encodeURIComponent(qs.get('error_description') || error)}` });
      res.end();
      return;
    }

    try {
      const { email, nombre } = await auth.exchangeCode(code, state, AUTH_REDIRECT_URI);

      // Verificar que el usuario esté registrado y activo
      let usuario = localDb.getUsuarioByEmail(email);
      if (!usuario) {
        // Auto-registrar como pendiente de aprobación
        try {
          const ctx = await ctxSharePoint();
          if (ctx.UsuariosERP) {
            const item = await g.addListItem(ctx.siteId, ctx.UsuariosERP, {
              email, nombre, cargo: '', rol: 'operador', activo: false,
            });
            localDb.upsertUsuario({ sp_id: String(item.id), email, nombre, cargo: '', rol: 'operador', activo: false });
          }
        } catch {}
        res.writeHead(302, { 'Location': '/?auth_error=pendiente' });
        res.end();
        return;
      }
      if (!usuario.activo) {
        // Puede que la aprobación vino de otro equipo y aún no sincronizó — forzar sync
        await syncService.syncAll().catch(() => {});
        usuario = localDb.getUsuarioByEmail(email);
        if (!usuario?.activo) {
          res.writeHead(302, { 'Location': '/?auth_error=pendiente' });
          res.end();
          return;
        }
      }

      const sessionId = auth.createSession(email, nombre, usuario.rol);
      res.writeHead(302, {
        'Set-Cookie': auth.buildSessionCookie(sessionId, AUTH_REDIRECT_URI),
        'Location':   '/',
      });
      res.end();
    } catch (e) {
      console.warn('[auth/callback]', e.message);
      res.writeHead(302, { 'Location': `/?auth_error=${encodeURIComponent(e.message)}` });
      res.end();
    }
    return;
  }

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/auth/logout') {
    auth.deleteSession(cookies[auth.COOKIE_NAME]);
    res.writeHead(200, {
      'Set-Cookie':   auth.clearSessionCookie(),
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /proveedores → lista completa desde SQLite ──────────────────────
  if (req.method === 'GET' && url === '/proveedores') {
    return json(localDb.getProveedores());
  }

  // ── GET /proveedores/:id ─────────────────────────────────────────────────
  const mProvId = url.match(/^\/proveedores\/([^\/]+)$/);
  if (req.method === 'GET' && mProvId) {
    const p = localDb.getProveedores().find(x => String(x.id) === mProvId[1]);
    return p ? json(p) : json({ error: 'Proveedor no encontrado' }, 404);
  }

  // ── POST /proveedores → inscribir proveedor nuevo ────────────────────────
  if (req.method === 'POST' && url === '/proveedores') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const normalize = s => String(s || '').trim().toUpperCase();
        const nit    = String(body.nit || '').trim().replace(/[^0-9\-]/g, '');
        const nombre = normalize(body.nombre);
        if (!nit)    return json({ error: 'El NIT es obligatorio.' }, 400);
        if (!nombre) return json({ error: 'La razón social es obligatoria.' }, 400);
        const campos = {
          nit,
          razonSocial: nombre,   // nombre del campo en SharePoint
          zona:        normalize(body.zona),
          municipio:   normalize(body.municipio),
          telefono:    String(body.telefono || '').trim(),
          correo:      String(body.correo || '').trim().toLowerCase(),
          activo:      true,
        };
        const ctx = await ctxSharePoint();
        if (!ctx.Proveedores) return json({ error: 'Lista Proveedores no disponible en SharePoint.' }, 500);
        const creado = await g.addListItem(ctx.siteId, ctx.Proveedores, campos);
        if (creado?.id) localDb.upsertProveedor({ id: creado.id, fields: { nombre, ...campos, ...(creado.fields || {}) } });
        return json({ ok: true, id: creado?.id });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── PATCH /proveedores/:id → editar proveedor ────────────────────────────
  if (req.method === 'PATCH' && mProvId) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const normalize = s => String(s || '').trim().toUpperCase();
        const cambios = {};
        if (body.nit      != null) cambios.nit         = String(body.nit).trim().replace(/[^0-9\-]/g, '');
        if (body.nombre   != null) cambios.razonSocial  = normalize(body.nombre);
        if (body.zona     != null) cambios.zona         = normalize(body.zona);
        if (body.municipio!= null) cambios.municipio    = normalize(body.municipio);
        if (body.telefono != null) cambios.telefono     = String(body.telefono).trim();
        if (body.correo   != null) cambios.correo       = String(body.correo).trim().toLowerCase();
        if (body.activo   != null) cambios.activo       = !!body.activo;
        const ctx = await ctxSharePoint();
        if (!ctx.Proveedores) return json({ error: 'Lista Proveedores no disponible.' }, 500);
        await g.updateListItem(ctx.siteId, ctx.Proveedores, mProvId[1], cambios);
        const actual = localDb.getProveedores().find(x => String(x.id) === mProvId[1]) || {};
        // incluir nombre en SQLite para que getProveedores() lo resuelva correctamente
        const cambosSQLite = { ...cambios };
        if (cambios.razonSocial) cambosSQLite.nombre = cambios.razonSocial;
        localDb.upsertProveedor({ id: mProvId[1], fields: { ...actual, ...cambosSQLite } });
        return json({ ok: true });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── GET /insumos ────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/insumos') {
    try { return json(await obtenerInsumos()); }
    catch (err) { return json({ error: err.message }, 500); }
  }

  // ── GET /insumos/buscar?q=texto → top coincidencias para modal de homologación ──
  if (req.method === 'GET' && url.startsWith('/insumos/buscar')) {
    const q = new URL('http://x' + req.url).searchParams.get('q') || '';
    if (!q.trim()) return json([]);
    try {
      const norm = s => String(s || '').toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Z0-9\s\/\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const tokens = s => norm(s).split(' ').filter(t => t.length >= 2);
      const qNorm = norm(q);
      const qTok  = new Set(tokens(q));
      const rawBuscar = await obtenerInsumosHistorial(null);
      const nombres = [...new Set(rawBuscar.map(n => String(n).trim()).filter(Boolean))];
      const scored = nombres
        .map(nombre => {
          const cNorm = norm(nombre);
          const cTok  = new Set(tokens(nombre));
          let score = 0;
          for (const t of qTok) if (cTok.has(t)) score += 2;
          if (cNorm.includes(qNorm) || qNorm.includes(cNorm)) score += 3;
          if (cNorm === qNorm) score += 10;
          return { nombre, score };
        })
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      return json(scored.map(r => ({ nombre: r.nombre, score: r.score })));
    } catch (err) { return json([]); }
  }

  // ── GET /precios/buscar?q=&zona=&proveedor=&incluirOS=true ─────────────────
  if (req.method === 'GET' && url.startsWith('/precios/buscar')) {
    try {
      const sp       = new URL('http://x' + req.url).searchParams;
      const q        = sp.get('q') || '';
      const zona     = sp.get('zona') || '';
      const provFilt = (sp.get('proveedor') || '').toUpperCase().trim();
      const inclOC   = sp.get('incluirOC') !== 'false';
      const inclOS   = sp.get('incluirOS') !== 'false';

      const norm = s => String(s || '').toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Z0-9\s\/\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const tokens = s => norm(s).split(' ').filter(t => t.length >= 3);
      const qTok = new Set(tokens(q));
      const matches = s => {
        if (!q) return true;
        const n = norm(s);
        if (n.includes(norm(q))) return true;
        const qTokArr = [...qTok];
        if (!qTokArr.length) return true;
        const cTok = new Set(tokens(s));
        return qTokArr.every(t => cTok.has(t));
      };

      const proyectos = await obtenerProyectosSP({ soloActivos: false });
      const zonaDeProyecto = {};
      for (const p of proyectos) zonaDeProyecto[String(p.codigo || '').trim().toUpperCase()] = p.zona || '';

      // — Matching semántico con Gemini —
      const historial = await getHistorialPrecios(null);
      let nombresAprobados = null;
      if (q && GEMINI_KEY && historial.length) {
        const nombresUnicos = [...new Set(historial.map(r => String(r.insumo || '').trim()).filter(Boolean))];
        try {
          const prompt = `Lista de suministros de construcción:\n${nombresUnicos.join('\n')}\n\nDevuelve SOLO los nombres de esa lista que correspondan, sean variantes, sinónimos, plural/singular o compuestos del término "${q}". JSON array de strings exactos de la lista. Si ninguno corresponde: [].`;
          const respGemini = await geminiTexto(prompt, 10000);
          const parsed = JSON.parse(respGemini.replace(/```json|```/g, '').trim());
          if (Array.isArray(parsed) && parsed.length) {
            const normSet = new Set(parsed.map(n => norm(n)));
            nombresAprobados = new Set(nombresUnicos.filter(n => normSet.has(norm(n))));
          }
        } catch (e) { console.warn('[/precios/buscar] Gemini fallback:', e.message); }
      }

      const matchesConGemini = s => {
        if (!q) return true;
        if (nombresAprobados) return nombresAprobados.has(s);
        return matches(s);
      };

      const resultados = [];

      // — Fuente OC: HistorialPrecios SP —
      if (inclOC) {
        for (const fila of historial) {
          const insumo    = String(fila.insumo          || '').trim();
          const proyecto  = String(fila.proyecto        || '').trim();
          const proveedor = String(fila.proveedor || fila.nombreProveedor || '').trim();
          const precio    = parseFloat(fila.precio || fila.precioUnitario) || null;
          const fecha     = String(fila.fecha           || '').trim();
          const zonaFila  = zonaDeProyecto[proyecto.toUpperCase()] || '';

          if (!matchesConGemini(insumo)) continue;
          if (zona && zonaFila && norm(zonaFila) !== norm(zona)) continue;
          if (provFilt && !norm(proveedor).includes(provFilt)) continue;
          resultados.push({ fuente: 'OC', insumo, proveedor, zona: zonaFila, precio, fecha, proyecto });
        }
      }

      // — Fuente OS: OrdenesServicio SQLite —
      if (inclOS) {
        const osItems = localDb.getOrdenesServicio();
        for (const os of osItems) {
          const proyecto  = String(os.proyecto          || '').trim();
          const proveedor = String(os.proveedorNombre   || os.proveedorNit || '').trim();
          const zonaFila  = zonaDeProyecto[proyecto.toUpperCase()] || '';
          const precio    = parseFloat(os.valor)        || null;
          const fecha     = String(os.fecha || os.fechaCreacion || '').slice(0, 10);
          const numeroOS  = os.numeroOS || '';

          const items = Array.isArray(os.items) ? os.items : [];

          if (items.length) {
            for (const it of items) {
              const insumo   = String(it.descripcion || it.insumo || '').trim();
              const precioIt = parseFloat(it.precioUnitario || it.valorUnitario || it.valor) || precio;
              if (!matchesConGemini(insumo)) continue;
              if (zona && zonaFila && norm(zonaFila) !== norm(zona)) continue;
              if (provFilt && !norm(proveedor).includes(provFilt)) continue;
              resultados.push({ fuente: 'OS', insumo, proveedor, zona: zonaFila, precio: precioIt, fecha, proyecto, numeroOS });
            }
          } else {
            const insumo = String(os.tipoServicio || '').trim();
            if (!matchesConGemini(insumo)) continue;
            if (zona && zonaFila && norm(zonaFila) !== norm(zona)) continue;
            if (provFilt && !norm(proveedor).includes(provFilt)) continue;
            resultados.push({ fuente: 'OS', insumo, proveedor, zona: zonaFila, precio, fecha, proyecto, numeroOS });
          }
        }
      }

      const parseFechaSort = f => {
        if (!f) return 0;
        if (/^\d{4}-\d{2}-\d{2}/.test(f)) return new Date(f.slice(0, 10)).getTime();
        const meses = { enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5,
          julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11 };
        const m = f.trim().toLowerCase().match(/^(\w+)\s+(\d+),?\s+(\d{4})$/);
        if (m) return new Date(+m[3], meses[m[1]] ?? 0, +m[2]).getTime();
        const m2 = f.trim().toLowerCase().match(/^(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})$/);
        if (m2) return new Date(+m2[3], meses[m2[2]] ?? 0, +m2[1]).getTime();
        const d = new Date(f); return isNaN(d) ? 0 : d.getTime();
      };
      resultados.sort((a, b) => parseFechaSort(b.fecha) - parseFechaSort(a.fecha));
      return json(resultados.slice(0, 200));
    } catch (err) {
      console.error('[/precios/buscar]', err);
      return json({ error: err.message }, 500);
    }
  }

  // ── POST /insumos/sugerir → para cada nombre, sugiere el match del catálogo ──
  if (req.method === 'POST' && url === '/insumos/sugerir') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { nombres } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!Array.isArray(nombres)) return json({ error: 'nombres debe ser un array' }, 400);
        const ctx = await ctxSharePoint();
        if (!ctx.Insumos) return json({ sugerencias: nombres.map(() => null) });
        const items = await g.getListItems(ctx.siteId, ctx.Insumos);
        const catalogo = items
          .map(it => ({ id: it.id, ...(it.fields || {}) }))
          .filter(i => i.activo !== false && (i.nombre || '').trim());
        const sugerencias = nombres.map(n => mejorMatchInsumo(String(n || ''), catalogo));
        return json({ sugerencias });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── GET /proyectos → lista de códigos activos (usado por selectores) ────
  if (req.method === 'GET' && url === '/proyectos') {
    try {
      const lst = await obtenerProyectosSP({ soloActivos: true });
      return json(lst.map(p => p.codigo).filter(Boolean));
    } catch (err) { return json(obtenerProyectos()); }
  }

  // ── GET /proyectos/admin → lista completa (incluye inactivos) para la UI de configuración
  if (req.method === 'GET' && url === '/proyectos/admin') {
    try {
      const lst = await obtenerProyectosSP({ soloActivos: false });
      return json(lst);
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── GET /proyectos/:id → datos completos del proyecto (para edición) ────
  const mProyId = url.match(/^\/proyectos\/([^\/]+)$/);
  if (req.method === 'GET' && mProyId) {
    try {
      const ctx = await ctxSharePoint();
      const item = await g.getListItem(ctx.siteId, ctx.Proyectos, mProyId[1]);
      return json(item?.fields || {});
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── PATCH /proyectos/:id → actualizar datos del proyecto ────────────────
  if (req.method === 'PATCH' && mProyId) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ctx  = await ctxSharePoint();
        const campos = {};
        if (body.codigo       !== undefined) campos.codigo       = String(body.codigo).trim();
        if (body.nombre       !== undefined) campos.nombre       = String(body.nombre).trim();
        if (body.tipo         !== undefined) campos.tipo         = String(body.tipo).trim();
        if (body.ciudad       !== undefined) campos.ciudad       = String(body.ciudad).trim();
        if (body.zona         !== undefined) campos.zona         = String(body.zona).trim();
        if (body.departamento !== undefined) campos.departamento = String(body.departamento).trim();
        await g.updateListItem(ctx.siteId, ctx.Proyectos, mProyId[1], campos);
        localDb.bulkUpsertProyectos([{
          id:         mProyId[1],
          codigo:     campos.codigo || '',
          nombre:     campos.nombre || campos.codigo || '',
          zona:       campos.zona   || 'Centro',
          updated_at: new Date().toISOString(),
        }]);
        return json({ ok: true });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── POST /proyectos → crear nuevo proyecto ──────────────────────────────
  if (req.method === 'POST' && url === '/proyectos') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const codigo = String(body.codigo || '').trim();
        if (!codigo) return json({ error: 'codigo requerido' }, 400);
        const ctx = await ctxSharePoint();
        if (!ctx.Proyectos) return json({ error: 'Lista Proyectos no existe — ejecuta provisionar-proyectos.js' }, 500);
        const existentes = await g.getListItems(ctx.siteId, ctx.Proyectos);
        if (existentes.some(it => String(it.fields?.codigo || '').trim().toUpperCase() === codigo.toUpperCase())) {
          return json({ error: `Proyecto "${codigo}" ya existe` }, 400);
        }
        const creado = await g.addListItem(ctx.siteId, ctx.Proyectos, {
          codigo,
          nombre:       String(body.nombre || codigo).trim(),
          tipo:         String(body.tipo || '').trim(),
          ciudad:       String(body.ciudad || '').trim(),
          departamento: String(body.departamento || '').trim(),
          zona:         String(body.zona || 'Centro').trim(),
          activo:       true,
          notas:        String(body.notas || '').trim(),
        });
        if (creado?.id) {
          localDb.bulkUpsertProyectos([{
            id:         creado.id,
            codigo:     codigo,
            nombre:     String(body.nombre || codigo).trim(),
            zona:       String(body.zona || 'Centro').trim(),
            activo:     true,
            updated_at: new Date().toISOString(),
          }]);
        }
        return json({ ok: true, id: creado.id });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── POST /proyectos/:id/toggle → activar/inactivar ──────────────────────
  const mToggle = url.match(/^\/proyectos\/([^\/]+)\/toggle$/);
  if (req.method === 'POST' && mToggle) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ctx = await ctxSharePoint();
        if (!ctx.Proyectos) return json({ error: 'Lista Proyectos no existe' }, 500);
        const activo = body.activo === undefined ? null : !!body.activo;
        const item = await g.getListItem(ctx.siteId, ctx.Proyectos, mToggle[1]);
        const nuevo = activo === null ? !(item.fields?.activo !== false) : activo;
        await g.updateListItem(ctx.siteId, ctx.Proyectos, mToggle[1], { activo: nuevo });
        localDb.bulkUpsertProyectos([{
          id:         mToggle[1],
          codigo:     item.fields?.codigo || '',
          nombre:     item.fields?.nombre || item.fields?.codigo || '',
          zona:       item.fields?.zona   || 'Centro',
          activo:     nuevo,
          updated_at: new Date().toISOString(),
        }]);
        return json({ ok: true, activo: nuevo });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── GET /requerimientos/:id/comparativa → tabla de proveedores por ítem ──
  const mComp = url.match(/^\/requerimientos\/([^\/]+)\/comparativa$/);
  if (req.method === 'GET' && mComp) {
    try {
      // Leer requerimiento desde SQLite (sin llamada a SharePoint)
      const todosReqs = localDb.getRequerimientos();
      const itemData  = todosReqs.find(r => String(r.id) === mComp[1]);
      if (!itemData) return json({ error: 'Requerimiento no encontrado' }, 404);
      const f = itemData;
      let items = [];
      try { items = JSON.parse(f.itemsJson || '[]').filter(it => !it.descartado); } catch {}

      const { consultarProveedor } = require('./consultaProveedor');

      // Pre-cargar historial, proveedores y proyectos desde SQLite
      const [historialSP, proveedoresSP, todosProyectos] = await Promise.all([
        getHistorialPrecios(null).catch(() => []),
        obtenerProveedores().catch(() => []),
        obtenerProyectosSP({ soloActivos: false }).catch(() => []),
      ]);
      const proyComp = todosProyectos.find(p =>
        String(p.codigo || '').trim().toUpperCase() === String(f.proyecto || '').trim().toUpperCase()
      );
      const zonaProyectoComp = proyComp?.zona || '';

      // Calcular cobertura desde SQLite (sin llamada a SharePoint)
      const cubiertoPorInsumo = {};
      try {
        const todasOCs = localDb.getOrdenesCompra();
        const ocsPrevias = todasOCs.filter(oc => oc.requerimientoId === String(f.id || mComp[1]));
        for (const ocF of ocsPrevias) {
          if (ocF.estado === 'anulada') continue;
          let ocItems = [];
          try { ocItems = JSON.parse(ocF.itemsJson || '[]'); } catch { continue; }
          for (const ocIt of ocItems) {
            const k = claveInsumo(ocIt.descripcion || ocIt.insumo);
            cubiertoPorInsumo[k] = (cubiertoPorInsumo[k] || 0) + Number(ocIt.cantidad || 0);
          }
        }
      } catch (e) { /* si no hay OCs, seguimos sin cobertura */ }

      const comparativa = await Promise.all(items.map(async it => {
        const c = consultarProveedor(it.insumo, f.proyecto || '', { historialSP, proveedoresSP, zonaProyecto: zonaProyectoComp });
        // Agrupar historial por NIT (un renglón por proveedor con precio más reciente y mínimo)
        const porNit = {};
        (c.historial || []).forEach(h => {
          const nit = (h.nit || '').trim().replace(/\.0$/, '') || h.proveedor;
          if (!porNit[nit]) porNit[nit] = { nit, nombre: h.proveedor, precios: [] };
          porNit[nit].precios.push({ precio: h.precio, fecha: h.fecha, documento: h.compra, proyecto: h.proyecto });
        });
        const proveedores = Object.values(porNit).map(p => {
          const precios = p.precios.sort((a, b) => b.precio - a.precio);
          return {
            nit: p.nit, nombre: p.nombre,
            ultimoPrecio:  precios[0]?.precio || 0,
            precioMinimo:  Math.min(...precios.map(x => x.precio)),
            fechaUltima:   precios[0]?.fecha || '',
            documento:     precios[0]?.documento || '',
            cantidadCompras: precios.length,
          };
        }).sort((a, b) => a.ultimoPrecio - b.ultimoPrecio);

        const cantidadSolicitada = Number(it.cantidad || 0);
        const kC   = claveInsumo(it.homologadoCon || it.insumo);
        const kCOr = claveInsumo(it.insumo);
        const cantidadCubierta   = (cubiertoPorInsumo[kC] || 0) + (kC !== kCOr ? cubiertoPorInsumo[kCOr] || 0 : 0);
        const cantidadRestante   = Math.max(0, cantidadSolicitada - cantidadCubierta);
        const yaGestionado       = cantidadCubierta + 1e-9 >= cantidadSolicitada && cantidadSolicitada > 0;

        // Para ítems sin historial, calcular sugerencias de homologación
        const candidatosHomologacion = c.sinHistorial
          ? await sugerirHomologacionCSV(it.insumo).catch(() => [])
          : [];

        return {
          insumo:     it.insumo,
          cantidad:   it.cantidad,
          unidad:     it.unidad,
          cantidadCubierta,
          cantidadRestante,
          yaGestionado,
          sinHistorial: c.sinHistorial,
          recomendado:  c.proveedor ? { nit: c.proveedor.nit, nombre: c.proveedor.nombre, precio: c.precio } : null,
          alertas:      c.alertas || [],
          proveedores,
          candidatosHomologacion,
        };
      }));

      return json({
        requerimiento: { id: f.id || mComp[1], ...f },
        items: comparativa,
      });
    } catch (err) {
      const code = /itemNotFound|404/i.test(err.message) ? 404 : 500;
      return json({ error: code === 404 ? 'Requerimiento no encontrado' : err.message }, code);
    }
  }

  // ── POST /requerimientos/:id/reconsultar-item → homologa un ítem y retorna su comparativa ──
  const mRecons = url.match(/^\/requerimientos\/([^\/]+)\/reconsultar-item$/);
  if (req.method === 'POST' && mRecons) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { insumoOriginal, nombreHomologado } = JSON.parse(Buffer.concat(chunks).toString());
        if (!nombreHomologado) return json({ error: 'nombreHomologado requerido' }, 400);

        const ctx = await ctxSharePoint();
        const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, mRecons[1]);
        const f = reqItem.fields || {};

        const { consultarProveedor } = require('./consultaProveedor');

        // Pre-cargar historial y proveedores SP
        const [historialSPr, proveedoresSPr, todosProySPr] = await Promise.all([
          getHistorialPrecios(ctx).catch(() => []),
          obtenerProveedores(ctx).catch(() => []),
          obtenerProyectosSP({ soloActivos: false }).catch(() => []),
        ]);
        const proyRecons = todosProySPr.find(p =>
          String(p.codigo || '').trim().toUpperCase() === String(f.proyecto || '').trim().toUpperCase()
        );
        const zonaProyRecons = proyRecons?.zona || '';

        // Calcular cobertura previa para este ítem
        const cubiertoPorInsumo = {};
        try {
          const ocsPrevias = await g.getListItems(ctx.siteId, ctx.OrdenesCompra, {
            filter: `fields/requerimientoId eq '${String(reqItem.id).replace(/'/g,"''")}'`,
          });
          for (const oc of ocsPrevias) {
            const ocF = oc.fields || {};
            if (ocF.estado === 'anulada') continue;
            let ocItems = [];
            try { ocItems = JSON.parse(ocF.itemsJson || '[]'); } catch { continue; }
            for (const ocIt of ocItems) {
              const k = claveInsumo(ocIt.descripcion || ocIt.insumo);
              cubiertoPorInsumo[k] = (cubiertoPorInsumo[k] || 0) + Number(ocIt.cantidad || 0);
            }
          }
        } catch {}

        // Buscar items originales para obtener cantidad/unidad
        let itemsReq = [];
        try { itemsReq = JSON.parse(f.itemsJson || '[]'); } catch {}
        const itOrig = itemsReq.find(i => claveInsumo(i.insumo) === claveInsumo(insumoOriginal || nombreHomologado)) || {};

        // Persistir homologación en el requerimiento
        let itemsActualizados = itemsReq;
        if (insumoOriginal && claveInsumo(insumoOriginal) !== claveInsumo(nombreHomologado)) {
          itemsActualizados = itemsReq.map(it =>
            claveInsumo(it.insumo) === claveInsumo(insumoOriginal)
              ? { ...it, homologadoCon: nombreHomologado }
              : it
          );
          f.itemsJson = JSON.stringify(itemsActualizados); // actualizar en memoria para calcularEstadoRequerimiento
        }

        const c = consultarProveedor(nombreHomologado, f.proyecto || '', { historialSP: historialSPr, proveedoresSP: proveedoresSPr, zonaProyecto: zonaProyRecons });
        const porNit = {};
        (c.historial || []).forEach(h => {
          const nit = (h.nit || '').trim().replace(/\.0$/, '') || h.proveedor;
          if (!porNit[nit]) porNit[nit] = { nit, nombre: h.proveedor, precios: [] };
          porNit[nit].precios.push({ precio: h.precio, fecha: h.fecha, documento: h.compra, proyecto: h.proyecto });
        });
        const proveedores = Object.values(porNit).map(p => {
          const precios = p.precios.sort((a, b) => b.precio - a.precio);
          return {
            nit: p.nit, nombre: p.nombre,
            ultimoPrecio:  precios[0]?.precio || 0,
            precioMinimo:  Math.min(...precios.map(x => x.precio)),
            fechaUltima:   precios[0]?.fecha || '',
            documento:     precios[0]?.documento || '',
            cantidadCompras: precios.length,
          };
        }).sort((a, b) => a.ultimoPrecio - b.ultimoPrecio);

        const cantidadSolicitada = Number(itOrig.cantidad || 0);
        const cantidadCubierta   = cubiertoPorInsumo[claveInsumo(nombreHomologado)] || 0;
        const cantidadRestante   = Math.max(0, cantidadSolicitada - cantidadCubierta);
        const yaGestionado       = cantidadCubierta + 1e-9 >= cantidadSolicitada && cantidadSolicitada > 0;

        // Guardar en SharePoint y recalcular estado del requerimiento
        let estadoReq = null;
        if (insumoOriginal && claveInsumo(insumoOriginal) !== claveInsumo(nombreHomologado)) {
          estadoReq = await calcularEstadoRequerimiento(ctx, reqItem);
          await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, {
            itemsJson: JSON.stringify(itemsActualizados),
            estado: estadoReq,
          });
        }

        const alertas = [...(c.alertas || [])];
        if (insumoOriginal && insumoOriginal !== nombreHomologado)
          alertas.unshift(`🔗 Homologado desde: "${insumoOriginal}"`);

        return json({
          insumo:            c.coincidenciaUsada || nombreHomologado,
          coincidenciaUsada: c.coincidenciaUsada || null,
          insumoOriginal:    insumoOriginal || nombreHomologado,
          cantidad:   itOrig.cantidad,
          unidad:     itOrig.unidad,
          cantidadCubierta,
          cantidadRestante,
          yaGestionado,
          sinHistorial: c.sinHistorial,
          recomendado: c.proveedor ? { nit: c.proveedor.nit, nombre: c.proveedor.nombre, precio: c.precio } : null,
          alertas,
          proveedores,
          candidatosHomologacion: [],
          estadoRequerimiento: estadoReq,
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── POST /requerimientos/:id/generar-oc → crea borrador(es) desde selección ──
  const mGenReq = url.match(/^\/requerimientos\/([^\/]+)\/generar-oc$/);
  if (req.method === 'POST' && mGenReq) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { selecciones } = JSON.parse(Buffer.concat(chunks).toString());
        // selecciones = [ { insumo, insumoOriginal, cantidad, unidad, precioUnitario, proveedorNit, proveedorNombre, descuentoPct, ivaPct } ]
        if (!Array.isArray(selecciones) || !selecciones.length) return json({ error: 'Sin selecciones' }, 400);
        const itemsSinPrecio = selecciones.filter(it => !(Number(it.precioUnitario) > 0));
        if (itemsSinPrecio.length) {
          return json({ error: `Los siguientes ítems no tienen precio unitario: ${itemsSinPrecio.map(it => it.insumo || it.descripcion).join(', ')}` }, 400);
        }

        const ctx = await ctxSharePoint();
        const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, mGenReq[1]);
        const reqF = reqItem.fields || {};

        // Parsear ítems del requerimiento para registrar homologaciones
        let itemsReq = [];
        try { itemsReq = JSON.parse(reqF.itemsJson || '[]'); } catch {}

        // Agrupar por proveedor → una OC por proveedor
        const porProv = {};
        for (const s of selecciones) {
          const k = (s.proveedorNit || '').trim().replace(/\.0$/, '') || 'sin-proveedor';
          if (!porProv[k]) porProv[k] = { nit: s.proveedorNit, nombre: s.proveedorNombre, items: [] };
          porProv[k].items.push(s);
        }

        const creadas = [];
        for (const [, grupo] of Object.entries(porProv)) {
          const subtotal = grupo.items.reduce((s, it) => s + (Number(it.cantidad) * Number(it.precioUnitario) * (1 - Number(it.descuentoPct || 0)/100)), 0);
          const iva      = grupo.items.reduce((s, it) => s + (Number(it.cantidad) * Number(it.precioUnitario) * (1 - Number(it.descuentoPct || 0)/100) * Number(it.ivaPct || 0)/100), 0);
          const total    = subtotal + iva;

          const oc = await g.addListItem(ctx.siteId, ctx.OrdenesCompra, {
            numeroOC:            '',                      // se asigna al aprobar
            requerimientoId:     reqItem.id,
            requerimientoOrigen: `REQ-${reqF.consecutivo || reqItem.id}`,
            proveedorNit:        grupo.nit || '',
            proveedorNombre:     grupo.nombre || '',
            proyecto:            reqF.proyecto || '',
            itemsJson:           JSON.stringify(grupo.items),
            subtotal, iva, total,
            estado:              'borrador',
            creadoPor:           process.env.USUARIO_EMAIL || 'sistema',
            fechaCreacion:       new Date().toISOString(),
          });
          if (oc?.id) localDb.upsertDocumento('ordenes_compra', oc);
          creadas.push({ id: oc.id, proveedor: grupo.nombre, total });
        }

        // Registrar homologaciones en itemsReq para que el cálculo de cobertura funcione
        const selHomologadas = selecciones.filter(s =>
          s.insumoOriginal && claveInsumo(s.insumoOriginal) !== claveInsumo(s.insumo)
        );
        if (selHomologadas.length) {
          itemsReq = itemsReq.map(it => {
            const sel = selHomologadas.find(s => claveInsumo(s.insumoOriginal) === claveInsumo(it.insumo));
            return sel ? { ...it, homologadoCon: sel.insumo } : it;
          });
          reqF.itemsJson = JSON.stringify(itemsReq); // actualizar en memoria para calcularEstadoRequerimiento
        }

        // Determinar cobertura: el requerimiento solo pasa a 'gestionado'
        // cuando la totalidad de ítems tiene OC que cubra la cantidad solicitada.
        // Mientras queden ítems sin cubrir completamente → 'parcial'.
        const estadoReq = await calcularEstadoRequerimiento(ctx, reqItem);
        const idsNuevos = creadas.map(c => c.id);
        const ocsExistentes = (reqF.ocsGeneradas || '').split(',').map(s => s.trim()).filter(Boolean);
        const ocsTodas = [...new Set([...ocsExistentes, ...idsNuevos])];
        await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, {
          estado: estadoReq,
          ocsGeneradas: ocsTodas.join(', '),
          ...(selHomologadas.length ? { itemsJson: JSON.stringify(itemsReq) } : {}),
        });

        return json({ ok: true, creadas, estadoRequerimiento: estadoReq });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── POST /requerimientos/cargar-manual → carga manual desde formato Excel ──
  if (req.method === 'POST' && url === '/requerimientos/cargar-manual') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const bodyBuffer  = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryM   = contentType.match(/boundary=([^\s;]+)/);
        if (!boundaryM) return json({ error: 'Formato de subida inválido' }, 400);

        const parts   = parsearMultipart(bodyBuffer, boundaryM[1]);
        const archivo = parts.find(p => p.fileName);
        if (!archivo) return json({ error: 'No se encontró archivo en la solicitud' }, 400);

        // Campos del formulario
        const getField = n => {
          const p = parts.find(x => x.name === n && !x.fileName);
          return p ? p.content.toString('utf8').trim() : '';
        };
        const consecutivoManual = getField('consecutivo');
        const proyectoManual    = getField('proyecto');
        const responsableManual = getField('responsable');
        const fechaManual       = getField('fecha');  // DD/MM/YYYY opcional

        // Guardar el adjunto en TEMP_DIR para que leerRequerimiento lo procese
        const ext = path.extname(archivo.fileName).toLowerCase();
        if (!['.xlsx', '.xls', '.pdf'].includes(ext)) {
          return json({ error: 'Formato no soportado. Sube Excel (.xlsx/.xls) o PDF del formato CT-ADMIN-FO-002.' }, 400);
        }
        const tmpPath = path.join(TEMP_DIR, `req_${Date.now()}_${crypto.randomUUID()}${ext}`);
        fs.writeFileSync(tmpPath, archivo.content);

        try {
          // Construir asunto sintético para que procesarCorreo lo parsee igual que un correo
          let fechaAsunto;
          const m = fechaManual.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (m) {
            fechaAsunto = `${m[3]}${m[2].padStart(2,'0')}${m[1].padStart(2,'0')}`;
          } else {
            const hoy  = new Date();
            fechaAsunto = `${hoy.getFullYear()}${String(hoy.getMonth()+1).padStart(2,'0')}${String(hoy.getDate()).padStart(2,'0')}`;
          }
          // Si el usuario no escribió proyecto, intentar detectarlo del documento
          let proyectoParaAsunto = proyectoManual;
          let proyectoAutoDetectado = '';
          if (!proyectoManual) {
            if (['.xlsx', '.xls'].includes(ext)) {
              try {
                const { leerRequerimiento } = require('./leerRequerimiento');
                const docData = leerRequerimiento(tmpPath);
                proyectoParaAsunto = (docData.cabecera?.proyecto || '').trim();
                proyectoAutoDetectado = proyectoParaAsunto;
              } catch {}
            }
            // PDF: marcador especial; procesarCorreo.js usará cabecera.proyecto (Gemini)
            if (!proyectoParaAsunto) proyectoParaAsunto = '__AUTO__';
          }

          const asuntoSintetico =
            `SOLICITUD REQUERIMIENTO ${consecutivoManual || '0000'} ${fechaAsunto} ${proyectoParaAsunto}`;

          const { procesarCorreo } = require('./procesarCorreo');
          const proyectosSP = await obtenerProyectosSP({ soloActivos: false }).catch(() => []);
          const resultado = await procesarCorreo(asuntoSintetico, tmpPath, { proyectosExternos: proyectosSP });

          if (resultado.accion !== 'GENERAR_OC') {
            return json({
              error: `No se pudo procesar el archivo: ${resultado.accion}`,
              detalle: resultado.error || resultado.motivo || '',
            }, 400);
          }

          // Si el usuario escribió responsable manual, sobreescribir
          if (responsableManual) resultado.solicitud.responsable = responsableManual;

          // Guardar en SharePoint
          const requerimientos = require('./requerimientos');
          const { item, duplicado, consecutivoSistema } = await requerimientos.crearDesdeCorreo(resultado, {
            messageId:  `manual:${process.env.USUARIO_EMAIL || 'sistema'}:${Date.now()}`,
            adjuntoUrl: '',
          });
          if (!duplicado && item?.id) localDb.upsertDocumento('requerimientos', item);

          return json({
            ok: true,
            duplicado,
            id: item.id,
            consecutivo:        resultado.solicitud.consecutivo,
            consecutivoSistema: consecutivoSistema || '',
            proyecto:           resultado.solicitud.proyecto,
            proyectoDetectado:  proyectoAutoDetectado || resultado.solicitud.proyecto || '',
            proyectoEsAuto:     !proyectoManual,
            items:              resultado.items.length,
            itemsSinPrecio:     resultado.itemsSinPrecio,
            alertasGlobales:    resultado.alertasGlobales || [],
          });
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } catch (err) {
        console.error('POST /requerimientos/cargar-manual:', err);
        return json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── POST /requerimientos/crear-manual → captura de ítems sin archivo ───────
  if (req.method === 'POST' && url === '/requerimientos/crear-manual') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body  = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const items = Array.isArray(body.items) ? body.items : [];

        if (!String(body.proyecto || '').trim()) return json({ error: 'Selecciona el proyecto del requerimiento.' }, 400);
        if (items.length === 0) return json({ error: 'Agrega al menos un ítem al requerimiento.' }, 400);
        if (items.length > MAX_ITEMS_REQ_MANUAL) {
          return json({ error: `Máximo ${MAX_ITEMS_REQ_MANUAL} ítems por requerimiento.` }, 400);
        }
        const fecha = String(body.fecha || '').trim();
        if (fecha && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(fecha)) {
          return json({ error: 'La fecha de solicitud debe tener formato DD/MM/AAAA.' }, 400);
        }

        // Misma resolución de proyecto y consulta de precios que el flujo de correo
        const { procesarRequerimientoManual } = require('./procesarCorreo');
        const proyectosSP = await obtenerProyectosSP({ soloActivos: false }).catch(() => []);
        let resultado;
        try {
          resultado = procesarRequerimientoManual(body, { proyectosExternos: proyectosSP });
        } catch (e) {
          return json({ error: e.message }, 400);  // validación de negocio → 400
        }

        const requerimientos = require('./requerimientos');
        const { item, consecutivoSistema } = await requerimientos.crearDesdeCorreo(resultado, {
          messageId:  `manual:${sesion?.email || process.env.USUARIO_EMAIL || 'sistema'}:${Date.now()}`,
          adjuntoUrl: '',
        });
        if (item?.id) localDb.upsertDocumento('requerimientos', item);

        return json({
          ok: true,
          id:                 item.id,
          consecutivo:        resultado.solicitud.consecutivo || '',
          consecutivoSistema: consecutivoSistema || '',
          proyecto:           resultado.solicitud.proyecto,
          items:              resultado.items.length,
          itemsSinPrecio:     resultado.itemsSinPrecio,
          alertasGlobales:    resultado.alertasGlobales || [],
        });
      } catch (err) {
        console.error('POST /requerimientos/crear-manual:', err);
        return json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── GET /requerimientos → lista desde SharePoint ────────────────────────
  // ── GET /requerimientos/:id/remision.(html|pdf|xlsx) ──────────────────────
  const mRem = url.match(/^\/requerimientos\/([^\/]+)\/remision\.(html|pdf|xlsx)$/);
  if (req.method === 'GET' && mRem) {
    const [, reqId, fmt] = mRem;
    try {
      const rem = await remisionDesdeRequerimiento(reqId);
      const cfg = cfgConFirmante(await configApp.getConfig(), req._sesion);
      if (fmt === 'xlsx') {
        const buffer = await remisionTemplate.generarExcelBuffer(rem, cfg);
        res.writeHead(200, {
          'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="Remision_${String(rem.numero).replace(/[^\w-]/g,'_')}.xlsx"`,
          'Content-Length':      buffer.length,
        });
        return res.end(Buffer.from(buffer));
      }
      // html o pdf → mismo HTML (el navegador imprime a PDF)
      return html(remisionTemplate.generarHTML(rem, cfg));
    } catch (err) {
      const code = /itemNotFound|404/i.test(err.message) ? 404 : 500;
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(code === 404 ? 'Requerimiento no encontrado' : 'Error generando remisión: ' + err.message);
    }
  }

  // ── POST /remisiones → crea una remisión a partir de OCs seleccionadas ──
  if (req.method === 'POST' && url === '/remisiones') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const ocIds = Array.isArray(body.ocIds) ? body.ocIds.map(String) : [];
        if (ocIds.length < 1) return json({ error: 'Debe seleccionar al menos una OC' }, 400);

        const ctx = await ctxSharePoint();
        if (!ctx.Remisiones) return json({ error: 'Lista Remisiones no existe. Ejecute el setup de SharePoint.' }, 500);

        const usuario = process.env.USUARIO_EMAIL || 'sistema';
        const { id, numero } = await crearRemisionYGuardar(ctx, ocIds, {
          observaciones:        body.observaciones,
          responsableEntrega:   body.responsableEntrega,
          responsableRecepcion: body.responsableRecepcion,
          lugarEntrega:         body.lugarEntrega,
          fecha:                body.fecha,
        }, usuario);
        return json({ ok: true, id, numero });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    });
    return;
  }

  // ── GET /remisiones → lista remisiones (desde SQLite, reconciliación en background)
  if (req.method === 'GET' && url === '/remisiones') {
    json(localDb.getRemisiones());
    ctxSharePoint().then(ctx => {
      if (ctx.Remisiones)
        reconciliarRemisionesVsOCs(ctx).catch(e => console.warn('[reconciliar remisiones]', e.message));
    }).catch(() => {});
    return;
  }

  // ── GET /remisiones/:id/view.(html|pdf|xlsx) ────────────────────────────
  const mRemView = url.match(/^\/remisiones\/([^\/]+)\/view\.(html|pdf|xlsx)$/);
  if (req.method === 'GET' && mRemView) {
    const [, remId, fmt] = mRemView;
    try {
      const ctx = await ctxSharePoint();
      if (!ctx.Remisiones) return json({ error: 'Lista Remisiones no existe' }, 500);
      const it = await g.getListItem(ctx.siteId, ctx.Remisiones, remId);
      const f = it.fields || {};
      let items = [];
      try { items = JSON.parse(f.itemsJson || '[]'); } catch {}
      const rem = {
        numero:               f.numero || it.id,
        consecutivoReq:       '',
        fecha:                f.fecha ? new Date(f.fecha).toLocaleDateString('es-CO') : '',
        proyecto:             f.proyecto || '',
        lugarEntrega:         f.lugarEntrega || '',
        solicitante:          f.creadoPor || '',
        cargo:                '',
        observaciones:        f.observaciones || '',
        responsableEntrega:   f.responsableEntrega || '',
        responsableRecepcion: f.responsableRecepcion || '',
        ocsAsociadas:         f.ocsAsociadas || '',
        estado:               f.estado || 'activa',
        motivoAnulacion:      f.motivoAnulacion || '',
        alertas:              f.alertas || '',
        items,
      };
      const cfg = cfgConFirmante(await configApp.getConfig(), req._sesion);
      if (fmt === 'xlsx') {
        const buffer = await remisionTemplate.generarExcelBuffer(rem, cfg);
        res.writeHead(200, {
          'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="Remision_${String(rem.numero).replace(/[^\w-]/g,'_')}.xlsx"`,
          'Content-Length':      buffer.length,
        });
        return res.end(Buffer.from(buffer));
      }
      return html(remisionTemplate.generarHTML(rem, cfg));
    } catch (err) {
      const code = /itemNotFound|404/i.test(err.message) ? 404 : 500;
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(code === 404 ? 'Remisión no encontrada' : 'Error: ' + err.message);
    }
  }

  // ── POST /requerimientos/:id/anular ─────────────────────────────────────
  const mAnulReq = url.match(/^\/requerimientos\/([^\/]+)\/anular$/);
  if (req.method === 'POST' && mAnulReq) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const motivo = (body.motivo || '').toString().trim();
        const ctx = await ctxSharePoint();
        if (!ctx.Requerimientos) return json({ error: 'Lista Requerimientos no existe' }, 500);
        const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, mAnulReq[1]);
        const estadoActual = reqItem.fields?.estado;
        if (estadoActual === 'anulado')   return json({ error: 'Ya está anulado' }, 400);
        if (estadoActual === 'gestionado') return json({ error: 'No se puede anular un requerimiento ya gestionado' }, 400);
        const notasPrev = reqItem.fields?.notas || '';
        const usuario   = process.env.USUARIO_EMAIL || 'sistema';
        const notasNuevas = (notasPrev ? notasPrev + ' | ' : '') +
          `ANULADO por ${usuario} el ${new Date().toLocaleDateString('es-CO')}${motivo ? ` — ${motivo}` : ''}`;
        await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, {
          estado: 'anulado',
          notas:  notasNuevas,
        });
        // Actualizar SQLite inmediatamente para que GET /requerimientos refleje el cambio
        localDb.upsertDocumento('requerimientos', {
          id:     reqItem.id,
          fields: { ...reqItem.fields, estado: 'anulado', notas: notasNuevas },
        });
        return json({ ok: true });
      } catch (err) {
        const code = /itemNotFound|404/i.test(err.message) ? 404 : 500;
        return json({ error: code === 404 ? 'Requerimiento no encontrado' : err.message }, code);
      }
    });
    return;
  }

  // ── PATCH /requerimientos/:id/editar → cambiar proyecto y/o descartar ítems ─
  const mEditReq = url.match(/^\/requerimientos\/([^\/]+)\/editar$/);
  if (req.method === 'PATCH' && mEditReq) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const ctx = await ctxSharePoint();
        if (!ctx.Requerimientos) return json({ error: 'Lista Requerimientos no existe' }, 500);
        const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, mEditReq[1]);
        const estadoActual = reqItem.fields?.estado;
        if (estadoActual === 'gestionado') return json({ error: 'No se puede editar un requerimiento ya gestionado' }, 400);
        if (estadoActual === 'anulado')    return json({ error: 'No se puede editar un requerimiento anulado' }, 400);

        const campos = {};
        if (body.proyecto !== undefined && body.proyecto !== null) {
          campos.proyecto = String(body.proyecto).trim();
        }
        if (Array.isArray(body.itemsJson)) {
          campos.itemsJson = JSON.stringify(body.itemsJson);
        }
        if (!Object.keys(campos).length) return json({ error: 'Nada que actualizar' }, 400);

        await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, campos);

        // Recalcular estado (los ítems descartados ya se excluyen dentro de calcularEstadoRequerimiento)
        const reqActualizado = await g.getListItem(ctx.siteId, ctx.Requerimientos, reqItem.id);
        const nuevoEstado = await calcularEstadoRequerimiento(ctx, reqActualizado);
        if (nuevoEstado !== estadoActual) {
          await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, { estado: nuevoEstado });
          reqActualizado.fields.estado = nuevoEstado;
        }

        // Sincronizar SQLite inmediatamente para que /comparativa vea los ítems descartados
        if (reqActualizado?.id) localDb.upsertDocumento('requerimientos', reqActualizado);

        return json({ ok: true, estado: nuevoEstado, requerimiento: { id: reqItem.id, ...(reqActualizado.fields || {}) } });
      } catch (err) {
        const code = /itemNotFound|404/i.test(err.message) ? 404 : 500;
        return json({ error: code === 404 ? 'Requerimiento no encontrado' : err.message }, code);
      }
    });
    return;
  }

  // ── GET /requerimientos/carpeta-pdf → link a la carpeta SharePoint con los PDFs ──
  if (req.method === 'GET' && url === '/requerimientos/carpeta-pdf') {
    try {
      if (!_carpetaPdfReqUrl) {
        const ctx    = await ctxSharePoint();
        const folder = await g.getDriveItemByPath(ctx.siteId, '/RequerimientosPDF');
        _carpetaPdfReqUrl = folder.webUrl;
      }
      return json({ url: _carpetaPdfReqUrl });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ── GET /ordenes/carpeta-pdf → link a la carpeta SharePoint con los PDF de OC ──
  if (req.method === 'GET' && url === '/ordenes/carpeta-pdf') {
    try {
      if (!_carpetaPdfOCUrl) {
        const ctx    = await ctxSharePoint();
        const folder = await g.getDriveItemByPath(ctx.siteId, '/OrdenesCompraPDF');
        _carpetaPdfOCUrl = folder.webUrl;
      }
      return json({ url: _carpetaPdfOCUrl });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ── GET /os/carpeta-pdf → link a la carpeta SharePoint con los PDF de OS ──
  if (req.method === 'GET' && url === '/os/carpeta-pdf') {
    try {
      if (!_carpetaPdfOSUrl) {
        const ctx    = await ctxSharePoint();
        const folder = await g.getDriveItemByPath(ctx.siteId, '/OrdenesServicioPDF');
        _carpetaPdfOSUrl = folder.webUrl;
      }
      return json({ url: _carpetaPdfOSUrl });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (req.method === 'GET' && url === '/requerimientos') {
    try {
      // Reconciliación en segundo plano (no bloquea la respuesta)
      ctxSharePoint()
        .then(ctx => reconciliarRequerimientosVsOCs(ctx))
        .catch(e  => console.warn('Reconciliación reqs falló:', e.message));
      return json(localDb.getRequerimientos());
    } catch (err) {
      console.error('GET /requerimientos:', err.message);
      return json([], 200);
    }
  }

  // ── GET /ordenes → lista desde SQLite ───────────────────────────────────
  if (req.method === 'GET' && url === '/ordenes') {
    try {
      return json(localDb.getOrdenesCompra()
        .sort((a, b) => (b.fechaCreacion || b.updated_at || '').localeCompare(a.fechaCreacion || a.updated_at || '')));
    } catch (err) {
      console.error('GET /ordenes:', err.message);
      return json([], 200);
    }
  }

  // ── GET /ordenes/registro.xlsx → descarga de registro filtrado ──────────
  if (req.method === 'GET' && url.startsWith('/ordenes/registro.xlsx')) {
    try {
      const qs = require('url').parse(req.url, true).query;
      const filtroEstado   = String(qs.estado   || '').trim().toLowerCase();
      const filtroProyecto = String(qs.proyecto || '').trim();
      const filtroTexto    = String(qs.q        || '').trim().toLowerCase();

      const ctx = await ctxSharePoint();
      if (!ctx.OrdenesCompra) return json({ error: 'Lista OrdenesCompra no existe' }, 500);
      const items = await g.getListItems(ctx.siteId, ctx.OrdenesCompra);
      let rows = items.map(it => ({ id: it.id, ...(it.fields || {}) }));

      if (filtroEstado === 'pagada')         rows = rows.filter(o => o.pagado);
      else if (filtroEstado === 'entregada') rows = rows.filter(o => o.entregado);
      else if (filtroEstado)                 rows = rows.filter(o => (o.estado || '').toLowerCase() === filtroEstado);
      if (filtroProyecto) rows = rows.filter(o => (o.proyecto || '') === filtroProyecto);
      if (filtroTexto)    rows = rows.filter(o =>
        (o.numeroOC || '').toLowerCase().includes(filtroTexto) ||
        (o.proyecto || '').toLowerCase().includes(filtroTexto) ||
        (o.proveedorNombre || '').toLowerCase().includes(filtroTexto)
      );
      rows.sort((a, b) => String(b.fechaCreacion || '').localeCompare(String(a.fechaCreacion || '')));

      const XLSX = require('xlsx');
      const data = rows.map(o => ({
        'Número OC':      o.numeroOC || '',
        'Fecha':          o.fechaOC || (o.fechaCreacion || '').slice(0,10),
        'Proyecto':       o.proyecto || '',
        'Proveedor':      o.proveedorNombre || '',
        'NIT':            o.proveedorNit || '',
        'Requerimiento':  o.requerimientoId || '',
        'Cotización':     o.cotizacionId || '',
        'Estado':         o.estado || '',
        'Subtotal':       Number(o.subtotal || 0),
        'IVA':            Number(o.iva || 0),
        'Total':          Number(o.total || 0),
        'Fecha pago':     o.fechaPago || '',
        'Fecha entrega':  o.fechaEntrega || '',
        'Creado por':     o.creadoPor || '',
        'Fecha creación': o.fechaCreacion || '',
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [
        {wch:14},{wch:12},{wch:16},{wch:30},{wch:14},{wch:14},{wch:14},
        {wch:12},{wch:14},{wch:14},{wch:14},{wch:12},{wch:12},{wch:22},{wch:22},
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Registro OCs');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const ts = new Date().toISOString().slice(0,10);
      res.writeHead(200, {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="RegistroOCs_${ts}.xlsx"`,
        'Content-Length':      buffer.length,
      });
      return res.end(Buffer.from(buffer));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Error generando Excel: ' + err.message);
    }
  }

  // ── GET /oc/:id.html → vista imprimible (PDF vía Ctrl+P) ────────────────
  const mOcHtml = url.match(/^\/oc\/([^\/]+)\.html$/);
  if (req.method === 'GET' && mOcHtml) {
    try {
      const oc  = await ocDesdeSharePoint(mOcHtml[1]);
      const cfg = cfgConFirmante(await configApp.getConfig(), req._sesion);
      return html(ocTemplate.generarHTML(oc, cfg));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Error generando OC: ' + err.message);
    }
  }

  // ── GET /oc/:id.xlsx → descarga Excel ───────────────────────────────────
  const mOcXlsx = url.match(/^\/oc\/([^\/]+)\.xlsx$/);
  if (req.method === 'GET' && mOcXlsx) {
    try {
      const oc  = await ocDesdeSharePoint(mOcXlsx[1]);
      const cfg = cfgConFirmante(await configApp.getConfig(), req._sesion);
      const buffer = await ocTemplate.generarExcelBuffer(oc, cfg);
      res.writeHead(200, {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="OC_${(oc.numeroOC || 'draft').replace(/[^\w-]/g,'_')}.xlsx"`,
        'Content-Length':      buffer.length,
      });
      return res.end(Buffer.from(buffer));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Error generando Excel: ' + err.message);
    }
  }

  // ── GET /config → configuración actual (logo, emisor, firmante, etc.) ───
  if (req.method === 'GET' && url === '/config') {
    try { return json(await configApp.getConfig()); }
    catch (err) { return json({ error: err.message }, 500); }
  }

  // ── POST /config/:clave → actualizar (body = JSON { valor }) ────────────
  const mConf = url.match(/^\/config\/(logo|emisor|firmante|observacionesDefault|ivaDefault)$/);
  if (req.method === 'POST' && mConf) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { valor } = JSON.parse(Buffer.concat(chunks).toString());
        await configApp.set(mConf[1], valor);
        json({ ok: true });
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ── GET /tesoreria/proyectos → desplegable + bandera de habilitado ───────
  // Un solo endpoint sirve para las dos cosas: la UI lo pide al cargar y así
  // sabe si mostrar la columna y el botón. Sin credenciales → habilitado:false
  // y la integración queda oculta en vez de dar errores.
  if (req.method === 'GET' && url === '/tesoreria/proyectos') {
    try {
      if (!tesoreria.habilitado()) return json({ habilitado: false, proyectos: [] });
      const proyectos = await tesoreria.listarProyectos();
      return json({ habilitado: true, proyectos });
    } catch (err) {
      console.error('GET /tesoreria/proyectos:', err.message);
      return json({ habilitado: true, proyectos: [], error: err.message }, 502);
    }
  }

  // ── GET /tesoreria/enviadas?ocs=OC-0041,OC-0042 → estado actual ──────────
  // Best-effort por diseño: si tesorería no responde, devuelve {} con 200 y la
  // UI sigue mostrando lo que ya tiene guardado en cada OC.
  if (req.method === 'GET' && url === '/tesoreria/enviadas') {
    try {
      if (!tesoreria.habilitado()) return json({ enviadas: {} });
      const qs  = require('url').parse(req.url, true).query;
      const ocs = String(qs.ocs || '').split(',').map(s => s.trim()).filter(Boolean);
      return json({ enviadas: await tesoreria.consultarEnviadas(ocs) });
    } catch (err) {
      console.warn('GET /tesoreria/enviadas:', err.message);
      return json({ enviadas: {} });
    }
  }

  // ── GET /tesoreria/mapeo?proyecto=CT25-202… → última elección humana ──────
  // Lee de SQLite, sin salir a la red. Solo es una sugerencia para preseleccionar
  // el desplegable: el usuario puede cambiarla siempre.
  if (req.method === 'GET' && url === '/tesoreria/mapeo') {
    try {
      const qs = require('url').parse(req.url, true).query;
      return json({ mapeo: localDb.getMapeoTesoreria(String(qs.proyecto || '').trim()) });
    } catch (err) {
      console.warn('GET /tesoreria/mapeo:', err.message);
      return json({ mapeo: null });
    }
  }

  // ── POST /ordenes/:id/solicitud-tesoreria → crear solicitud de pago ──────
  // El flujo no es automático a propósito: proyecto de tesorería y concepto los
  // decide una persona, y queda registrada en solicitado_por.
  const mSolTes = url.match(/^\/ordenes\/([^\/]+)\/solicitud-tesoreria$/);
  if (req.method === 'POST' && mSolTes) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const itemId = mSolTes[1];
        if (!tesoreria.habilitado()) {
          return json({ error: 'Integración con tesorería no configurada' }, 503);
        }

        let body = {};
        if (chunks.length) {
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
        }

        const oc = localDb.getOrdenesCompra().find(o => String(o.id) === String(itemId));
        if (!oc) return json({ error: 'OC no encontrada' }, 404);

        // El documento pide validar 'aprobada'; se acepta también 'finalizada'
        // (pagada + entregada) porque una compra ya cerrada puede legalizarse
        // después. Lo que no se puede enviar es un borrador: no tiene número.
        if (!['aprobada', 'finalizada'].includes(oc.estado)) {
          return json({ error: `La OC está en estado "${oc.estado || 'borrador'}"; solo se pueden enviar OC aprobadas o finalizadas` }, 409);
        }
        const numeroOC = String(oc.numeroOC || '').trim();
        if (!numeroOC) {
          return json({ error: 'La OC no tiene número asignado; apruébala primero' }, 409);
        }

        const proyectoId = String(body.proyecto_id || '').trim();
        const concepto   = String(body.concepto    || '').trim();
        const detalles = [];
        if (!proyectoId) detalles.push('Falta el proyecto de tesorería');
        if (!concepto)   detalles.push('Falta el concepto');
        if (concepto.length > 1000) detalles.push('El concepto no puede pasar de 1000 caracteres');
        if (!(Number(oc.total) > 0)) detalles.push(`El total de la OC debe ser mayor a 0 (es ${oc.total})`);
        if (detalles.length) return json({ error: 'Datos incompletos', detalles }, 422);

        // El NIT va tal cual: la Edge Function lo normaliza (quita puntos y
        // descarta el dígito de verificación). Normalizarlo acá también crearía
        // dos verdades sobre el mismo dato.
        const resultado = await tesoreria.crearSolicitud({
          proyecto_id:    proyectoId,
          nombre:         String(oc.proveedorNombre || '').trim(),
          nit:            String(oc.proveedorNit    || '').trim(),
          concepto,
          total:          Number(oc.total),
          orden_compra:   numeroOC,
          solicitado_por: req._sesion?.email || undefined,
        });

        // De acá en adelante la solicitud YA existe en tesorería. Nada que falle
        // debe tumbar la respuesta: perder el egreso_id de vista es menos grave
        // que hacer creer al usuario que el envío falló (y un reintento es
        // seguro, la Edge Function es idempotente).
        //
        // Los dos registros van en try/catch separados a propósito: si
        // SharePoint no responde, la elección de proyecto igual se recuerda.
        try {
          const ctx = await ctxSharePoint();
          if (ctx.OrdenesCompra) {
            const actualizado = await g.updateListItem(ctx.siteId, ctx.OrdenesCompra, itemId, {
              solicitudTesoreriaId:    resultado.egreso_id || '',
              fechaSolicitudTesoreria: new Date().toISOString(),
              solicitudTesoreriaPor:   req._sesion?.email || '',
            });
            if (actualizado?.id) localDb.upsertDocumento('ordenes_compra', actualizado);
          }
        } catch (e) {
          console.warn(`[OC ${numeroOC}] Solicitud ${resultado.egreso_id} creada, pero no se pudo marcar la OC en SharePoint:`, e.message);
        }

        // Recordar la elección humana de proyecto para preseleccionarla luego
        try {
          localDb.setMapeoTesoreria({
            proyecto:        oc.proyecto || '',
            tesoreriaId:     proyectoId,
            tesoreriaNombre: String(body.proyecto_nombre || '').trim(),
            actualizadoPor:  req._sesion?.email || '',
          });
        } catch (e) {
          console.warn(`[OC ${numeroOC}] No se pudo recordar el mapeo de proyecto:`, e.message);
        }

        return json({
          egreso_id: resultado.egreso_id,
          estado:    resultado.estado,
          duplicado: !!resultado.duplicado,
        });
      } catch (err) {
        console.error('POST /ordenes/:id/solicitud-tesoreria:', err.message);
        const status = err.status === 422 || err.status === 403 ? err.status : 502;
        return json({ error: err.message, ...(err.detalles ? { detalles: err.detalles } : {}) }, status);
      }
    });
    return;
  }

  // ── POST /ordenes/:id/:accion → aprobar, anular, pagar, entregar ────────
  const mAccion = url.match(/^\/ordenes\/([^\/]+)\/(aprobar|anular|pagar|entregar)$/);
  if (req.method === 'POST' && mAccion) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
    try {
      const [, itemId, accion] = mAccion;
      let body = {};
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
      }
      const ctx = await ctxSharePoint();
      if (!ctx.OrdenesCompra) return json({ error: 'Lista OrdenesCompra no existe' }, 500);

      const now = new Date().toISOString();
      const usuario = process.env.USUARIO_EMAIL || 'sistema';
      const cambios = {};

      if (accion === 'aprobar')  {
        // Asignar número real solo al aprobar (el contador avanza aquí, no antes)
        const contador = require('./contador');
        const siguiente = await contador.siguienteNumeroSP(ctx.siteId, ctx.OrdenesCompra);
        cambios.numeroOC = contador.formato(siguiente);
        cambios.estado = 'aprobada';
        cambios.aprobadoPor = usuario;
        cambios.fechaAprobacion = now;
        // Condiciones comerciales estructuradas (tipo + días si aplica) + observaciones separadas
        if (body.condicionesComerciales != null) cambios.condicionesComerciales = String(body.condicionesComerciales).trim();
        if (body.observaciones != null)          cambios.observaciones          = String(body.observaciones).trim();
        if (body.fechaEntregaPrevista)           cambios.fechaEntregaPrevista   = String(body.fechaEntregaPrevista).trim();
      }
      if (accion === 'anular')   { cambios.estado = 'anulada';   cambios.anuladoPor  = usuario; cambios.fechaAnulacion  = now; }
      if (accion === 'pagar')    { cambios.pagado = true;    cambios.pagadoPor    = usuario; cambios.fechaPago    = now; }
      if (accion === 'entregar') { cambios.entregado = true; cambios.entregadoPor = usuario; cambios.fechaEntrega = now; }

      // Auto-finalizar: si tras este cambio quedan pago + entrega completos → estado 'finalizada'
      if (accion === 'pagar' || accion === 'entregar') {
        const actual = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, itemId);
        const f = actual.fields || {};
        const pagado    = accion === 'pagar'    ? true : !!f.pagado;
        const entregado = accion === 'entregar' ? true : !!f.entregado;
        if (pagado && entregado && f.estado === 'aprobada') {
          cambios.estado = 'finalizada';
        }
      }

      // Leer OC de SQLite ANTES del PATCH para preservar itemsJson y requerimientoId
      const ocLocalPre = accion === 'aprobar'
        ? localDb.getOrdenesCompra().find(o => String(o.id) === String(itemId))
        : null;

      const actualizado = await g.updateListItem(ctx.siteId, ctx.OrdenesCompra, itemId, cambios);
      if (actualizado?.id) localDb.upsertDocumento('ordenes_compra', actualizado);

      // Si se aprueba → ejecutar tareas secundarias en segundo plano (no bloquean la respuesta)
      if (accion === 'aprobar') {
        const oc = actualizado || {};
        const itemsJson = ocLocalPre?.itemsJson || oc.itemsJson || '[]';
        (async () => {
          try {
            await cc.registrarGasto({
              fechaOC:         (oc.fechaCreacion || now).slice(0,10),
              numeroOC:        oc.numeroOC,        proyecto:        oc.proyecto,
              proveedorNit:    oc.proveedorNit,    proveedorNombre: oc.proveedorNombre,
              tipoGasto:       oc.tipoGasto || '', subtotal:        oc.subtotal,
              iva:             oc.iva,             total:           oc.total,
              estado:          'aprobada',         fechaAprobacion: now.slice(0,10),
              creadoPor:       usuario,
            });
          } catch (e) { console.warn('No se pudo registrar en Control Costos:', e.message); }

          try {
            let itemsOC = [];
            try { itemsOC = JSON.parse(itemsJson); } catch {}
            const filasHist = itemsOC
              .filter(it => Number(it.precioUnitario || it.precio || 0) > 0)
              .map(it => {
                const base = Number(it.precioUnitario || it.precio || 0);
                const precioFinal = base * (1 + Number(it.ivaPct || 0) / 100);
                return {
                  proyecto:        oc.proyecto || '',
                  numCotizacion:   oc.numeroOC || '',
                  nitProveedor:    oc.proveedorNit || '',
                  nombreProveedor: oc.proveedorNombre || '',
                  fechaVigencia:   new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' }),
                  insumo:          it.descripcion || it.insumo || '',
                  cantidad:        Number(it.cantidad || 1),
                  precio:          precioFinal,
                };
              });
            if (filasHist.length) {
              const n = await agregarFilasCompras(filasHist, ctx);
              console.log(`[OC ${oc.numeroOC}] ${n} precios añadidos a HistorialPrecios SP`);
            }
          } catch (e) { console.warn('No se pudo actualizar histórico de precios:', e.message); }

          // Recalcular estado del requerimiento de origen (la aprobación no lo hacía)
          try {
            const reqId = oc.requerimientoId || ocLocalPre?.requerimientoId;
            if (reqId && ctx.Requerimientos) {
              const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, reqId);
              const nuevoEstado = await calcularEstadoRequerimiento(ctx, reqItem);
              const estadoPrev  = (reqItem.fields || {}).estado || 'pendiente';
              if (nuevoEstado !== estadoPrev) {
                await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqId, { estado: nuevoEstado });
                localDb.upsertDocumento('requerimientos', {
                  id: reqId,
                  fields: { ...(reqItem.fields || {}), estado: nuevoEstado },
                });
                console.log(`[OC ${oc.numeroOC}] Req ${reqId}: ${estadoPrev} → ${nuevoEstado}`);
              }
            }
          } catch (e) { console.warn('No se pudo recalcular estado del requerimiento:', e.message); }
        })();
      }
      // Si cambia estado de pago/entrega → actualizar fila en Control Costos (async)
      if (accion === 'pagar' || accion === 'entregar') {
        (async () => {
          try {
            const numOC = (actualizado.fields || {}).numeroOC;
            if (numOC) {
              const c = {};
              if (accion === 'pagar')    c.fechaPago    = now.slice(0,10);
              if (accion === 'entregar') c.fechaEntrega = now.slice(0,10);
              await cc.actualizarFila(numOC, c);
            }
          } catch (e) { console.warn('No se pudo actualizar Control Costos:', e.message); }
        })();
      }

      // Auto-entrada/salida de inventario al marcar como Entregada
      const autoRefs = {};
      if (accion === 'entregar' && (body.autoEntrada || body.autoSalida)) {
        // Leer datos completos de SQLite (actualizado.fields no incluye itemsJson)
        const ocLocal    = localDb.getOrdenesCompra().find(oc => String(oc.id) === String(itemId));
        const ocFields   = ocLocal || actualizado.fields || {};
        const ocProyecto = ocFields.proyecto || '';
        let itemsOC = [];
        try { itemsOC = JSON.parse(ocFields.itemsJson || '[]'); } catch {}
        if (itemsOC.length && ctx.MovimientosInventario) {
          const batchIdEntrada = `BORR-EA-${Date.now()}`;
          const batchIdSalida  = `BORR-SA-${Date.now() + 1}`;
          const movPromises = [];
          for (const it of itemsOC) {
            const base         = Number(it.precioUnitario || it.precio || 0);
            const ivaPct       = Number(it.ivaPct || 0);
            const precioConIva = base * (1 + ivaPct / 100);
            const cant         = Number(it.cantidad || 0);
            if (!cant || precioConIva <= 0) continue;
            const movBase = {
              proyecto:       ocProyecto,
              ocId:           String(itemId),
              numeroOC:       ocFields.numeroOC || '',
              insumo:         it.descripcion || it.insumo || '',
              unidad:         it.unidad || 'UND',
              cantidad:       cant,
              precioUnitario: precioConIva,
              valorTotal:     cant * precioConIva,
              responsable:    usuario,
              creadoPor:      usuario,
              fechaCreacion:  now,
              fecha:          now,
              notas:          '',
              estado:         'activo',
              documentoRef:   null,
              estadoDoc:      'borrador',
            };
            if (body.autoEntrada) {
              const entradaFields = { ...movBase, tipo: 'entrada', batchId: batchIdEntrada };
              movPromises.push(
                g.addListItem(ctx.siteId, ctx.MovimientosInventario, entradaFields)
                  .then(item => {
                    if (item?.id) {
                      const spFields = item.fields || item;
                      localDb.upsertDocumento('movimientos_inventario', {
                        id: item.id,
                        fields: { ...entradaFields, ...spFields, batchId: batchIdEntrada, estadoDoc: 'borrador', documentoRef: null },
                      });
                    }
                  })
                  .catch(e => console.warn('[inventario entrada]', e.message))
              );
            }
            if (body.autoSalida) {
              const salidaFields = { ...movBase, tipo: 'salida', batchId: batchIdSalida };
              movPromises.push(
                g.addListItem(ctx.siteId, ctx.MovimientosInventario, salidaFields)
                  .then(item => {
                    if (item?.id) {
                      const spFields = item.fields || item;
                      localDb.upsertDocumento('movimientos_inventario', {
                        id: item.id,
                        fields: { ...salidaFields, ...spFields, batchId: batchIdSalida, estadoDoc: 'borrador', documentoRef: null },
                      });
                    }
                  })
                  .catch(e => console.warn('[inventario salida]', e.message))
              );
            }
          }
          await Promise.allSettled(movPromises);
          // Aprobar los documentos creados para que afecten el stock inmediatamente
          const hayItems = itemsOC.some(it => Number(it.cantidad || 0) > 0);
          async function aprobarBatchInline(batchId, tipo, proyecto) {
            const docRef = localDb.getNextDocRef(tipo, proyecto);
            const movs = localDb.db().prepare(
              "SELECT data FROM movimientos_inventario WHERE json_extract(data,'$.batchId')=?"
            ).all(batchId).map(r => JSON.parse(r.data));
            if (!movs.length) return { docRef, actualizados: 0 };
            for (const m of movs) {
              const updated = { ...m, documentoRef: docRef, estadoDoc: 'aprobado' };
              await g.updateListItem(ctx.siteId, ctx.MovimientosInventario, m.id, { documentoRef: docRef, estadoDoc: 'aprobado' });
              localDb.upsertDocumento('movimientos_inventario', { id: m.id, fields: updated });
            }
            if (tipo === 'salida' && movs.length > 0) {
              const totalSalida = movs.reduce((s, m) => s + (Number(m.valorTotal) || 0), 0);
              if (totalSalida > 0) {
                cc.registrarGasto({
                  fechaOC:   new Date().toISOString().slice(0, 10),
                  numeroOC:  docRef, proyecto,
                  tipoGasto: 'Salida Almacén',
                  subtotal:  totalSalida, iva: 0, total: totalSalida,
                  estado:    'ejecutado',
                  creadoPor: movs[0].creadoPor || process.env.USUARIO_EMAIL || 'sistema',
                }).catch(e => console.warn('[inventario aprobar] Control Costos:', e.message));
              }
            }
            return { docRef, actualizados: movs.length };
          }
          if (body.autoEntrada && hayItems) {
            try {
              const r = await aprobarBatchInline(batchIdEntrada, 'entrada', ocProyecto);
              if (r.actualizados > 0) autoRefs.entrada = r.docRef;
            } catch(e) { console.warn('[entregar] aprobar entrada:', e.message); }
          }
          if (body.autoSalida && hayItems) {
            try {
              const r = await aprobarBatchInline(batchIdSalida, 'salida', ocProyecto);
              if (r.actualizados > 0) autoRefs.salida = r.docRef;
            } catch(e) { console.warn('[entregar] aprobar salida:', e.message); }
          }
        }
      }

      // Generación automática de remisión individual al marcar la OC como entregada
      let remisionGenerada = null;
      if (accion === 'entregar' && ctx.Remisiones) {
        try {
          const yaTieneRemision = localDb.getRemisiones().some(r => {
            if (r.estado === 'anulada') return false;
            let ids = [];
            try { ids = JSON.parse(r.ocIds || '[]'); } catch { ids = []; }
            return ids.map(String).includes(String(itemId));
          });
          const ocLocal = localDb.getOrdenesCompra().find(oc => String(oc.id) === String(itemId));
          let itemsOC = [];
          try { itemsOC = JSON.parse((ocLocal || {}).itemsJson || '[]'); } catch {}
          if (!yaTieneRemision && itemsOC.length) {
            const { id, numero } = await crearRemisionYGuardar(ctx, [itemId], {
              fecha: now, responsableEntrega: usuario,
            }, usuario);
            remisionGenerada = { id, numero };
          }
        } catch (e) { console.warn('No se pudo generar remisión automática:', e.message); }
      }

      // Generar y subir el PDF de la OC entregada a SharePoint (best-effort)
      let pdfOCGenerado = null;
      if (accion === 'entregar') {
        try {
          pdfOCGenerado = await guardarPdfOCEnSharePoint(ctx, itemId, req._sesion);
        } catch (e) { console.warn('No se pudo generar/subir el PDF de la OC:', e.message); }
      }

      // Cascada de anulación sobre remisiones
      let remisionesAfectadas = [];
      if (accion === 'anular' && ctx.Remisiones) {
        try {
          remisionesAfectadas = await cascadaAnulacionRemisiones(ctx, itemId, actualizado.fields || {}, usuario, now);
        } catch (e) { console.warn('No se pudo propagar anulación a remisiones:', e.message); }
      }

      // Cascada de re-evaluación del requerimiento origen (liberar cantidades, volver a habilitar)
      let requerimientoRecalculado = null;
      if (accion === 'anular' && ctx.Requerimientos) {
        try {
          const reqId = (actualizado?.fields || actualizado || {}).requerimientoId;
          if (reqId) {
            const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, reqId);
            const nuevoEstado = await calcularEstadoRequerimiento(ctx, reqItem);
            const estadoPrev  = (reqItem.fields || {}).estado || 'pendiente';
            if (nuevoEstado !== estadoPrev) {
              await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqId, { estado: nuevoEstado });
              localDb.upsertDocumento('requerimientos', {
                id: reqId,
                fields: { ...(reqItem.fields || {}), estado: nuevoEstado },
              });
              requerimientoRecalculado = { id: reqId, estadoPrev, estadoNuevo: nuevoEstado };
            }
          }
        } catch (e) { console.warn('No se pudo recalcular estado del requerimiento:', e.message); }
      }

      return json({ ok: true, remisionesAfectadas, requerimientoRecalculado, autoRefs, remisionGenerada, pdfOCGenerado });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
    });
    return;
  }

  // ── POST /extraer → procesar archivo cotización ─────────────────────────
  if (req.method === 'POST' && url === '/extraer') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const bodyBuffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryM   = contentType.match(/boundary=([^\s;]+)/);
        if (!boundaryM) return json({ error: 'Formato de subida inválido' }, 400);

        const parts    = parsearMultipart(bodyBuffer, boundaryM[1]);
        const archivo  = parts.find(p => p.fileName);
        if (!archivo)  return json({ error: 'No se encontró archivo en la solicitud' }, 400);

        const base64   = archivo.content.toString('base64');
        const ext      = path.extname(archivo.fileName).toLowerCase();

        // Para Excel: convertir a texto primero
        let mimeType = archivo.mimeType;
        let datos    = base64;

        if (['.xlsx', '.xls', '.csv'].includes(ext)) {
          // Guardar temporalmente y leer como texto
          const tmpPath = path.join(TEMP_DIR, `tmp_${Date.now()}_${crypto.randomUUID()}${ext}`);
          fs.writeFileSync(tmpPath, archivo.content);
          try {
            const XLSX = require('xlsx');
            const wb   = XLSX.readFile(tmpPath);
            let texto  = '';
            for (const nombre of wb.SheetNames) {
              const ws  = wb.Sheets[nombre];
              texto += `\n=== Hoja: ${nombre} ===\n`;
              texto += XLSX.utils.sheet_to_csv(ws);
            }
            datos    = Buffer.from(texto).toString('base64');
            mimeType = 'text/plain';
          } finally {
            fs.unlinkSync(tmpPath);
          }
        }

        const items = await extraerConGemini(datos, mimeType, archivo.fileName);
        json({ ok: true, items, archivo: archivo.fileName });

      } catch (err) {
        console.error('[/extraer] Error extracción IA:', err.message);
        json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── POST /confirmar → guardar en compras.csv + upsert catálogo Insumos ──
  if (req.method === 'POST' && url === '/confirmar') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { filas } = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(filas) || filas.length === 0) {
          return json({ error: 'No se recibieron filas para guardar' }, 400);
        }
        // Normalizar nombres a MAYÚSCULAS antes de cualquier persistencia
        for (const f of filas) f.insumo = String(f.insumo || '').trim().toUpperCase();

        const ctx = await ctxSharePoint();
        const guardadas = await agregarFilasCompras(filas, ctx);

        // Upsert en lista SharePoint "Insumos" para futuras sugerencias/autocompletado
        let insumosNuevos = 0;
        try {
          if (ctx.Insumos) {
            const existentes = await g.getListItems(ctx.siteId, ctx.Insumos);
            const yaEnCatalogo = new Set(
              existentes.map(it => String(it.fields?.nombre || '').trim().toUpperCase()).filter(Boolean)
            );
            const unicosNuevos = [...new Set(filas.map(f => f.insumo).filter(Boolean))]
              .filter(nom => !yaEnCatalogo.has(nom));
            for (const nom of unicosNuevos) {
              try {
                const filaFuente = filas.find(f => f.insumo === nom) || {};
                await g.addListItem(ctx.siteId, ctx.Insumos, {
                  nombre:             nom,
                  nombreNormalizado:  nom.normalize('NFD').replace(/[̀-ͯ]/g, ''),
                  unidadEstandar:     String(filaFuente.unidad || '').trim().toUpperCase(),
                  activo:             true,
                });
                insumosNuevos++;
              } catch (e) { console.warn(`Insumo "${nom}" no se pudo registrar:`, e.message); }
            }
          }
        } catch (e) { console.warn('Upsert Insumos falló:', e.message); }

        json({ ok: true, guardadas, insumosNuevos });
      } catch (err) {
        json({ error: err.message }, 500);
      }
    });
    return;
  }


  // ── POST /generar-oc-cotizacion → crea OC (borrador) en SharePoint desde cotización ──
  if (req.method === 'POST' && url === '/generar-oc-cotizacion') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { proyecto, fecha, numCotizacion, proveedor, nit, items, requerimientoId: reqId } = JSON.parse(Buffer.concat(chunks).toString());
        if (!items?.length) return json({ error: 'No hay ítems' }, 400);

        const ctx = await ctxSharePoint();
        if (!ctx.OrdenesCompra) return json({ error: 'Lista OrdenesCompra no existe' }, 500);

        // Si se vincula a un requerimiento, validar que existe
        let reqItem = null;
        if (reqId && ctx.Requerimientos) {
          try { reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, reqId); } catch {}
        }

        // Agrupar por NIT → una OC por proveedor
        const porProv = {};
        for (const it of items) {
          const insumo    = String(it.insumo || '').trim();
          const cantidad  = Number(it.cantidad) || 1;
          const precio    = Number(it.precio) || 0;
          if (!insumo) continue;
          const itemNit    = (it.nit || nit || '').toString().trim();
          const itemNombre = (it.proveedor || proveedor || '').toString().trim();
          const k = itemNit || `sinNit:${itemNombre.toUpperCase()}`;
          if (!porProv[k]) porProv[k] = { nit: itemNit, nombre: itemNombre, items: [] };
          porProv[k].items.push({
            descripcion:     insumo.toUpperCase(),
            cantidad,
            unidad:          (it.unidad || 'UND').toUpperCase(),
            precioUnitario:  precio,
            descuentoPct:    Number(it.descuentoPct || 0),
            ivaPct:          it.ivaPct != null ? Number(it.ivaPct) : 19,
          });
        }

        const creadas = [];
        for (const grupo of Object.values(porProv)) {
          const subtotal = grupo.items.reduce((s, it) =>
            s + (it.cantidad * it.precioUnitario * (1 - it.descuentoPct/100)), 0);
          const iva = grupo.items.reduce((s, it) =>
            s + (it.cantidad * it.precioUnitario * (1 - it.descuentoPct/100) * it.ivaPct/100), 0);
          const total = subtotal + iva;

          const oc = await g.addListItem(ctx.siteId, ctx.OrdenesCompra, {
            numeroOC:         '',
            requerimientoId:  reqItem ? String(reqItem.id) : '',
            cotizacionId:     String(numCotizacion || '').trim(),
            proveedorNit:     grupo.nit || '',
            proveedorNombre:  grupo.nombre || '',
            proyecto:         proyecto || '',
            itemsJson:        JSON.stringify(grupo.items),
            subtotal, iva, total,
            estado:           'borrador',
            creadoPor:        process.env.USUARIO_EMAIL || 'sistema',
            fechaCreacion:    new Date().toISOString(),
          });
          if (oc?.id) localDb.upsertDocumento('ordenes_compra', oc);
          creadas.push({ id: oc.id, proveedor: grupo.nombre, total });
        }

        // Si se vinculó a un requerimiento, actualizar su estado y lista de OCs
        let estadoRequerimiento = null;
        if (reqItem) {
          estadoRequerimiento = await calcularEstadoRequerimiento(ctx, reqItem);
          const reqF = reqItem.fields || {};
          const ocsExistentes = (reqF.ocsGeneradas || '').split(',').map(s => s.trim()).filter(Boolean);
          const ocsTodas = [...new Set([...ocsExistentes, ...creadas.map(c => c.id)])];
          await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, {
            estado: estadoRequerimiento,
            ocsGeneradas: ocsTodas.join(', '),
          });
        }

        return json({ ok: true, creadas, archivos: creadas, estadoRequerimiento });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── POST /ordenes/:id/vincular-requerimiento → enlaza OC existente con un requerimiento ──
  const mVincular = url.match(/^\/ordenes\/([^\/]+)\/vincular-requerimiento$/);
  if (req.method === 'POST' && mVincular) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { requerimientoId: reqId } = JSON.parse(Buffer.concat(chunks).toString());
        if (!reqId) return json({ error: 'requerimientoId requerido' }, 400);

        const ctx = await ctxSharePoint();
        const ocItem  = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, mVincular[1]);
        const reqItem = await g.getListItem(ctx.siteId, ctx.Requerimientos, reqId);

        // Actualizar OC con el requerimientoId
        await g.updateListItem(ctx.siteId, ctx.OrdenesCompra, ocItem.id, {
          requerimientoId: String(reqItem.id),
        });

        // Recalcular estado del requerimiento
        const estadoRequerimiento = await calcularEstadoRequerimiento(ctx, reqItem);
        const reqF = reqItem.fields || {};
        const ocsExistentes = (reqF.ocsGeneradas || '').split(',').map(s => s.trim()).filter(Boolean);
        const ocsTodas = [...new Set([...ocsExistentes, ocItem.id])];
        await g.updateListItem(ctx.siteId, ctx.Requerimientos, reqItem.id, {
          estado: estadoRequerimiento,
          ocsGeneradas: ocsTodas.join(', '),
        });

        return json({ ok: true, estadoRequerimiento });
      } catch (err) {
        const code = /itemNotFound|404/i.test(err.message) ? 404 : 500;
        return json({ error: err.message }, code);
      }
    });
    return;
  }

  // ── OS: extraer datos de cotización / oferta económica con Gemini ─────────────
  if (req.method === 'POST' && url === '/os/extraer') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const bodyBuffer  = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryM   = contentType.match(/boundary=([^\s;]+)/);
        if (!boundaryM) return json({ error: 'Formato de subida inválido' }, 400);

        const parts   = parsearMultipart(bodyBuffer, boundaryM[1]);
        const archivo = parts.find(p => p.fileName);
        if (!archivo) return json({ error: 'No se encontró archivo en la solicitud' }, 400);

        const proveedorHint = (parts.find(p => p.name === 'proveedor')?.content?.toString() || '').trim();
        const proyectoHint  = (parts.find(p => p.name === 'proyecto')?.content?.toString() || '').trim();

        const ext = path.extname(archivo.fileName).toLowerCase();
        let mimeType = archivo.mimeType;
        let datos    = archivo.content.toString('base64');

        if (['.xlsx', '.xls', '.csv'].includes(ext)) {
          const tmpPath = path.join(TEMP_DIR, `tmp_os_${Date.now()}_${crypto.randomUUID()}${ext}`);
          require('fs').writeFileSync(tmpPath, archivo.content);
          try {
            const XLSX = require('xlsx');
            const wb   = XLSX.readFile(tmpPath);
            let texto  = '';
            for (const nombre of wb.SheetNames) {
              texto += `\n=== Hoja: ${nombre} ===\n`;
              texto += XLSX.utils.sheet_to_csv(wb.Sheets[nombre]);
            }
            datos    = Buffer.from(texto).toString('base64');
            mimeType = 'text/plain';
          } finally { try { require('fs').unlinkSync(tmpPath); } catch {} }
        }

        if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada en .env');
        const MODELO = MODELO_GEMINI;
        const GURL   = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`;

        const PROMPT = `Analiza este documento que es una cotización o propuesta económica de servicios.
Extrae los datos Y redacta el clausulado jurídico. Devuelve SOLO un JSON con este formato exacto (sin texto adicional, sin markdown, sin bloques de código):
{
  "proveedorNombre": "razón social del proveedor",
  "proveedorNit": "NIT si está visible",
  "proyecto": "${proyectoHint || 'detectar del documento o vacío'}",
  "tipoServicio": "descripción completa del servicio, objeto del contrato o alcance (varias oraciones)",
  "lugarPrestacion": "lugar donde se presta el servicio",
  "condicionesComerciales": "forma de pago, garantías, vigencia y demás condiciones tal como están en el documento",
  "items": [
    {
      "descripcion": "nombre o descripción del ítem",
      "unidad": "GLB|ML|M2|M3|UND|HR|etc",
      "cantidad": 1,
      "precioUnitario": 0.00,
      "ivaPct": 19
    }
  ],
  "clausulas": "PRIMERA - OBJETO: [texto]\\n\\nSEGUNDA - ALCANCE Y EXCLUSIONES: [texto]\\n\\nTERCERA - OBLIGACIONES DEL CONTRATISTA: [texto]\\n\\nCUARTA - VALOR Y FORMA DE PAGO: [valor REAL del documento en letras y números; cantidades ejecutadas en obra; sin adicionales ni reevaluación]\\n\\nQUINTA - PLAZO: [plazo REAL del documento; fechas fijas; prórroga solo por acuerdo escrito]\\n\\nSEXTA - RIESGOS Y RESPONSABILIDADES: [riesgos asignados al CONTRATISTA; daños a infraestructura existente]\\n\\nSÉPTIMA - GARANTÍAS Y CALIDAD: [texto]\\n\\nOCTAVA - TERMINACIÓN ANTICIPADA: [causales de terminación; terminación por conveniencia del CONTRATANTE]\\n\\nNOVENA - CONFIDENCIALIDAD Y CESIÓN: [texto]"
}
Reglas para los items:
- Si el servicio es global (valor total sin desglose), crea un ítem con unidad "GLB" y cantidad 1.
- precioUnitario es el precio SIN IVA. Si los precios incluyen IVA, réstale el IVA.
- ivaPct es el porcentaje (19, 5 o 0). Si no es explícito pero hay IVA del 19%, usa 19. Si excluido o régimen simplificado, usa 0.
- Proveedor: ${proveedorHint ? `el usuario indica que es "${proveedorHint}"` : 'detectar del documento'}.
Reglas para el clausulado (CRÍTICO — aplica todos sin excepción):
- Eres un ingeniero civil senior en contratación que actúa en representación del CONTRATANTE. Tu objetivo es blindar los riesgos económicos y técnicos del CONTRATANTE, no describir obligaciones técnicas neutras.
- CANTIDADES: El CONTRATANTE paga solo las cantidades efectivamente ejecutadas y verificadas en obra. No se reconocen cantidades estimadas. Usa el valor REAL de este documento.
- SIN SOBRECOSTOS: No hay lugar a reconocer valores adicionales por rendimientos del CONTRATISTA, equipos subutilizados, mano de obra adicional, condiciones de terreno previsibles ni ningún otro costo operativo del CONTRATISTA.
- SIN REEVALUACIÓN: Los precios unitarios son fijos e inamovibles durante la vigencia del contrato.
- RESIDUOS Y LIMPIEZA: El CONTRATISTA debe recoger y disponer residuos, escombros y materiales generados en el lugar que disponga el CONTRATANTE o el director de obra. La generación de residuos es inherente a la actividad; la obligación es el manejo, no evitar la generación.
- RIESGOS DEL CONTRATISTA: Condiciones del sitio previsibles, rendimientos de equipos, disponibilidad de personal, clima y fallas mecánicas son riesgo exclusivo del CONTRATISTA.
- El PLAZO debe usar la duración REAL que aparece en el documento.
- Lenguaje jurídico colombiano formal, párrafos corridos sin viñetas ni markdown.
- En el campo "clausulas" usa \\n\\n para separar cláusulas. NO uses **, *, # ni markdown.`;

        const esTexto = mimeType === 'text/plain';
        const partes = esTexto
          ? [{ text: `${Buffer.from(datos, 'base64').toString('utf-8')}\n\n${PROMPT}` }]
          : [{ inline_data: { mime_type: mimeType, data: datos } }, { text: PROMPT }];

        const gBody = JSON.stringify({
          contents: [{ parts: partes }],
          generationConfig: { temperature: 0, maxOutputTokens: 32768 },
        });

        const gResp = await postGemini(GURL, gBody, { timeoutMs: 60000, reintentos: 2 });
        const raw = gResp.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const clean = raw.replace(/```json[\s\S]*?/g, '').replace(/```/g, '').trim();
        const extraido = JSON.parse(clean);
        // Strip any markdown from clausulas
        if (extraido.clausulas) {
          extraido.clausulas = extraido.clausulas
            .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/#+\s*/g, '');
        }
        json({ ok: true, ...extraido });
      } catch (err) {
        console.error('[/os/extraer] Error extracción IA:', err.message);
        json({ error: err.message }, 500);
      }
    });
    return;
  }

  // ── OS: generar cláusulas con Gemini ─────────────────────────────────────────
  if (req.method === 'POST' && url === '/os/generar-clausulas') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { tipoServicio, ofertaCondiciones } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!tipoServicio) return json({ error: 'tipoServicio requerido' }, 400);
        const prompt = `Eres un ingeniero civil senior colombiano con amplia experiencia en contratación y abastecimiento de proyectos de construcción. Actúas exclusivamente en representación del CONTRATANTE (la empresa que subcontrata) y tu objetivo es redactar un clausulado que blindé al máximo los riesgos económicos, técnicos y legales del CONTRATANTE.

OBJETO DEL SERVICIO A SUBCONTRATAR:
${tipoServicio}
${ofertaCondiciones ? `\nCONDICIONES ECONÓMICAS DE REFERENCIA:\n${ofertaCondiciones}` : ''}

PRINCIPIOS RECTORES DEL CLAUSULADO (aplica todos sin excepción):
1. CANTIDADES A PRECIO UNITARIO: El CONTRATANTE paga únicamente las cantidades efectivamente ejecutadas y verificadas en obra. No se reconocen cantidades estimadas ni proyectadas por el CONTRATISTA.
2. SIN RECONOCIMIENTO DE SOBRECOSTOS: No hay lugar al reconocimiento de valores adicionales por rendimientos mal calculados, equipos subutilizados, condiciones de terreno previsibles, mano de obra adicional o cualquier otro costo que sea riesgo propio de la operación del CONTRATISTA.
3. SIN REEVALUACIÓN DE OFERTA: Los precios unitarios pactados son fijos e inamovibles durante la vigencia del contrato. No hay lugar a revisión de precios ni reajustes.
4. MANEJO DE RESIDUOS Y ORDEN DE OBRA: El CONTRATISTA asume la responsabilidad de recoger, clasificar y disponer todos los materiales sobrantes, escombros, residuos y elementos generados por su actividad en el lugar que disponga el CONTRATANTE o el director de obra. La generación de residuos es inherente a la actividad; la obligación del CONTRATISTA es su manejo adecuado, no evitar su generación.
5. RIESGOS DEL CONTRATISTA: El CONTRATISTA asume todos los riesgos inherentes a su actividad: condiciones del sitio, rendimientos de equipos, disponibilidad de personal, fallas mecánicas, clima y cualquier circunstancia técnica previsible dentro del alcance del servicio.
6. TERMINACIÓN POR INCUMPLIMIENTO: El CONTRATANTE puede terminar unilateralmente el contrato por incumplimiento del CONTRATISTA sin lugar a indemnización, con simple comunicación escrita.
7. RESPONSABILIDAD POR DAÑOS: El CONTRATISTA responde por todos los daños a infraestructura existente, redes, estructuras o terceros causados durante la ejecución de sus actividades.

ESTRUCTURA REQUERIDA (redacta exactamente estas cláusulas en este orden):
CERO - OBJETO
PRIMERA - ALCANCE Y EXCLUSIONES (qué incluye y qué NO cubre el contrato; deja claro que condiciones imprevisibles previsibles son riesgo del CONTRATISTA)
SEGUNDA - OBLIGACIONES DEL CONTRATISTA (obligaciones operativas que protejan al CONTRATANTE: manejo de residuos en sitio designado, seguridad, señalización, limpieza, entrega de zona limpia, reporte de avance)
TERCERA - VALOR Y FORMA DE PAGO (cantidades ejecutadas en obra, precio unitario fijo, sin adicionales, sin reevaluación; forma de pago vinculada a entrega satisfactoria)
CUARTA - PLAZO (fecha de inicio y terminación fijas; prórrogas solo con acuerdo escrito previo del CONTRATANTE; mora genera descuentos o terminación)
QUINTA - RIESGOS Y RESPONSABILIDADES (asignación explícita de riesgos al CONTRATISTA; daños a infraestructura; responsabilidad frente a terceros)
SEXTA - GARANTÍAS Y CALIDAD (el trabajo ejecutado debe cumplir especificaciones técnicas; el CONTRATISTA repara defectos sin costo adicional dentro del plazo de garantía)
SÉPTIMA - TERMINACIÓN ANTICIPADA (causales de terminación por incumplimiento del CONTRATISTA; terminación por conveniencia del CONTRATANTE sin penalidad)
OCTAVA - CONFIDENCIALIDAD Y CESIÓN (prohibición de revelar información del proyecto; no puede ceder el contrato sin autorización escrita del CONTRATANTE)

FORMATO:
- Lenguaje jurídico colombiano formal, redacción en tercera persona
- Sin viñetas ni markdown; usa solo párrafos de texto corrido bajo el título de cada cláusula
- Devuelve SOLO el clausulado numerado, sin introducciones, encabezados ni comentarios adicionales`;
        const clausulas = await geminiTexto(prompt, 30000, {
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 2048,
        });
        json({ ok: true, clausulas });
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ── OS: preview HTML (POST con datos del formulario) ──────────────────────────
  if (req.method === 'POST' && url === '/os/preview') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const osData = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const cfg = cfgConFirmante(await configApp.getConfig(), req._sesion);
        const htmlStr = osTemplate.generarHTML(osData, cfg);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlStr);
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ── OS: crear nueva OS ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/os/crear') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const osData = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ctx = await ctxSharePoint();
        if (!ctx.OrdenesServicio) throw new Error('Lista OrdenesServicio no disponible — espere unos segundos y reintente');
        const usuario = process.env.USUARIO_EMAIL || 'sistema';
        const now = new Date().toISOString();

        const fields = {
          numeroOS:                   '',          // se asigna al aprobar
          proyecto:                   String(osData.proyecto || '').trim(),
          proveedorNit:               String(osData.proveedorNit || '').trim(),
          proveedorNombre:            String(osData.proveedorNombre || '').trim(),
          tipoServicio:               String(osData.tipoServicio || '').trim(),
          clausulas:                  String(osData.clausulas || '').trim(),
          ofertaEconomicaRef:         String(osData.ofertaEconomicaRef || '').trim(),
          ofertaEconomicaCondiciones: String(osData.ofertaEconomicaCondiciones || '').trim(),
          tipoContrato:               String(osData.tipoContrato || 'IVA_PLENO'),
          itemsJson:                  JSON.stringify(osData.items || []),
          aiuA:                       Number(osData.aiuA || 0),
          aiuI:                       Number(osData.aiuI || 0),
          aiuU:                       Number(osData.aiuU || 0),
          valor:                      Number(osData.valor || 0),
          iva:                        Number(osData.iva || 0),
          total:                      Number(osData.total || 0),
          estado:                     'borrador',
          lugarPrestacion:            String(osData.lugarPrestacion || '').trim(),
          condicionesComerciales:     String(osData.condicionesComerciales || '').trim(),
          observaciones:              String(osData.observaciones || '').trim(),
          tipoGasto:                  String(osData.tipoGasto || '').trim(),
          creadoPor:                  usuario,
          fechaCreacion:              now,
        };
        if (osData.fechaInicio) fields.fechaInicio = new Date(osData.fechaInicio).toISOString();
        if (osData.fechaFin)    fields.fechaFin    = new Date(osData.fechaFin).toISOString();

        const created = await g.addListItem(ctx.siteId, ctx.OrdenesServicio, fields);
        if (created?.id) localDb.upsertDocumento('ordenes_servicio', created);
        json({ ok: true, id: created.id, numeroOS: fields.numeroOS });
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ── OS: listar órdenes de servicio ───────────────────────────────────────────
  if (req.method === 'GET' && url === '/os/ordenes') {
    try {
      const lista = localDb.getOrdenesServicio()
        .sort((a, b) => (b.fechaCreacion || b.updated_at || '').localeCompare(a.fechaCreacion || a.updated_at || ''))
        .map(osDesdeFields);
      json(lista);
    } catch (err) { json({ error: err.message }, 500); }
    return;
  }

  // ── GET /os/registro.xlsx → descarga de registro filtrado ───────────────────
  if (req.method === 'GET' && url.startsWith('/os/registro.xlsx')) {
    try {
      const qs = require('url').parse(req.url, true).query;
      const filtroEstado   = String(qs.estado   || '').trim().toLowerCase();
      const filtroProyecto = String(qs.proyecto || '').trim();
      const filtroTexto    = String(qs.q        || '').trim().toLowerCase();

      let rows = localDb.getOrdenesServicio()
        .map(osDesdeFields)
        .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));

      if (filtroEstado)   rows = rows.filter(o => (o.estado || '').toLowerCase() === filtroEstado);
      if (filtroProyecto) rows = rows.filter(o => (o.proyecto || '') === filtroProyecto);
      if (filtroTexto)    rows = rows.filter(o =>
        (o.numeroOS || '').toLowerCase().includes(filtroTexto) ||
        (o.proyecto || '').toLowerCase().includes(filtroTexto) ||
        (o.proveedorNombre || '').toLowerCase().includes(filtroTexto) ||
        (o.tipoServicio || '').toLowerCase().includes(filtroTexto)
      );

      const XLSX = require('xlsx');
      const data = rows.map(o => ({
        'N° OS':             o.numeroOS || '',
        'Fecha':             o.fecha || '',
        'Proyecto':          o.proyecto || '',
        'Proveedor':         o.proveedorNombre || '',
        'NIT':               o.proveedorNit || '',
        'Tipo de servicio':  o.tipoServicio || '',
        'Tipo contrato':     o.tipoContrato || '',
        'Lugar prestación':  o.lugarPrestacion || '',
        'Fecha inicio':      o.fechaInicio || '',
        'Fecha fin':         o.fechaFin || '',
        'Valor directo':     Number(o.valor || 0),
        'IVA':               Number(o.iva || 0),
        'Total':             Number(o.total || 0),
        'Estado':            o.estado || '',
        'Pago':              o.estado === 'borrador' ? '' : (o.pagado ? 'Pagada' : 'Pendiente'),
        'Fecha pago':        o.fechaPago || '',
        'Fecha cumplido':    o.fechaCumplido || '',
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [
        {wch:14},{wch:12},{wch:16},{wch:30},{wch:14},{wch:35},
        {wch:14},{wch:20},{wch:12},{wch:12},{wch:14},{wch:14},{wch:14},{wch:12},
        {wch:12},{wch:14},{wch:14},
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Registro OSs');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const ts = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="RegistroOSs_${ts}.xlsx"`,
        'Content-Length':      buffer.length,
      });
      return res.end(Buffer.from(buffer));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Error generando Excel: ' + err.message);
    }
  }

  // ── OS: HTML de una OS por ID ─────────────────────────────────────────────────
  const mOsHtml = url.match(/^\/os\/(\w+)\/html$/);
  if (req.method === 'GET' && mOsHtml) {
    try {
      const ctx = await ctxSharePoint();
      if (!ctx.OrdenesServicio) throw new Error('Lista OrdenesServicio no disponible');
      const item = await g.getListItem(ctx.siteId, ctx.OrdenesServicio, mOsHtml[1]);
      const os  = osDesdeFields(item);
      const cfg = cfgConFirmante(await configApp.getConfig(), req._sesion);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(osTemplate.generarHTML(os, cfg));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    }
    return;
  }

  // ── OS: Excel de una OS por ID ────────────────────────────────────────────────
  const mOsXlsx = url.match(/^\/os\/(\w+)\/xlsx$/);
  if (req.method === 'GET' && mOsXlsx) {
    try {
      const ctx = await ctxSharePoint();
      if (!ctx.OrdenesServicio) throw new Error('Lista OrdenesServicio no disponible');
      const item  = await g.getListItem(ctx.siteId, ctx.OrdenesServicio, mOsXlsx[1]);
      const os    = osDesdeFields(item);
      const cfg   = cfgConFirmante(await configApp.getConfig(), req._sesion);
      const buffer = await osTemplate.generarExcelBuffer(os, cfg);
      res.writeHead(200, {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${(os.numeroOS || 'OS-' + item.id).replace(/[^\w-]/g,'_')}.xlsx"`,
      });
      res.end(buffer);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    }
    return;
  }

  // ── OS: aprobar / anular ──────────────────────────────────────────────────────
  const mOsAccion = url.match(/^\/os\/(\w+)\/(aprobar|anular|pagar|cumplir)$/);
  if (req.method === 'POST' && mOsAccion) {
    const [, osId, accion] = mOsAccion;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ctx = await ctxSharePoint();
        if (!ctx.OrdenesServicio) throw new Error('Lista OrdenesServicio no disponible');
        const usuario = process.env.USUARIO_EMAIL || 'sistema';
        const now = new Date().toISOString();
        const cambios = {};

        if (accion === 'aprobar') {
          const contador = require('./contador');
          const siguiente = await contador.siguienteNumeroOS(ctx.siteId, ctx.OrdenesServicio);
          cambios.numeroOS       = contador.formatoOS(siguiente);
          cambios.estado         = 'aprobada';
          cambios.aprobadoPor    = usuario;
          cambios.fechaAprobacion = now;
        } else if (accion === 'anular') {
          cambios.estado          = 'anulada';
          cambios.anuladoPor      = usuario;
          cambios.fechaAnulacion  = now;
          cambios.motivoAnulacion = String(body.motivo || '').trim();
        } else if (accion === 'pagar') {
          cambios.pagado     = true;
          cambios.pagadoPor  = usuario;
          cambios.fechaPago  = now;
        } else if (accion === 'cumplir') {
          cambios.cumplido      = true;
          cambios.cumplidoPor   = usuario;
          cambios.fechaCumplido = now;
        }

        // Auto-finalizar: si tras este cambio quedan pago + cumplido completos → 'finalizada'
        if (accion === 'pagar' || accion === 'cumplir') {
          const actual = await g.getListItem(ctx.siteId, ctx.OrdenesServicio, osId);
          const f = actual.fields || {};
          const pagado   = accion === 'pagar'   ? true : !!f.pagado;
          const cumplido = accion === 'cumplir' ? true : !!f.cumplido;
          if (pagado && cumplido && f.estado === 'aprobada') {
            cambios.estado = 'finalizada';
          }
        }

        const actualizado = await g.updateListItem(ctx.siteId, ctx.OrdenesServicio, osId, cambios);
        if (actualizado?.id) localDb.upsertDocumento('ordenes_servicio', actualizado);

        // Al aprobar → registrar la OS como gasto en Control de Costos (async, no bloquea)
        if (accion === 'aprobar') {
          const os = actualizado?.fields || {};
          (async () => {
            try {
              await cc.registrarGasto({
                fechaOC:         (os.fechaCreacion || now).slice(0, 10),
                numeroOC:        os.numeroOS,          proyecto:        os.proyecto,
                proveedorNit:    os.proveedorNit,      proveedorNombre: os.proveedorNombre,
                tipoGasto:       os.tipoGasto || '',   subtotal:        os.valor,
                iva:             os.iva,               total:           os.total,
                estado:          'aprobada',           fechaAprobacion: now.slice(0, 10),
                creadoPor:       usuario,
              });
              console.log(`[OS ${os.numeroOS}] gasto registrado en Control Costos`);
            } catch (e) { console.warn('No se pudo registrar OS en Control Costos:', e.message); }
          })();
        }

        // Al pagar/cumplir → actualizar fecha en la fila de Control de Costos (async)
        if (accion === 'pagar' || accion === 'cumplir') {
          (async () => {
            try {
              const numOS = (actualizado.fields || {}).numeroOS;
              if (numOS) {
                const c = {};
                if (accion === 'pagar')   c.fechaPago    = now.slice(0, 10);
                if (accion === 'cumplir') c.fechaEntrega = now.slice(0, 10);
                await cc.actualizarFila(numOS, c);
              }
            } catch (e) { console.warn('No se pudo actualizar Control Costos (OS):', e.message); }
          })();
        }

        // Generar y subir el PDF de la OS pagada a SharePoint (best-effort)
        let pdfOSGenerado = null;
        if (accion === 'pagar') {
          try {
            pdfOSGenerado = await guardarPdfOSEnSharePoint(ctx, osId, req._sesion);
          } catch (e) { console.warn('No se pudo generar/subir el PDF de la OS:', e.message); }
        }

        json({ ok: true, numeroOS: actualizado?.fields?.numeroOS || cambios.numeroOS || '', pdfOSGenerado });
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ── PATCH /ordenes/:id/editar ─────────────────────────────────────────────
  const mOCEditar = url.match(/^\/ordenes\/([^\/]+)\/editar$/);
  if (req.method === 'PATCH' && mOCEditar) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const ctx  = await ctxSharePoint();
        const ocId = mOCEditar[1];
        const item = await g.getListItem(ctx.siteId, ctx.OrdenesCompra, ocId);
        const f    = item?.fields || {};
        if (f.estado !== 'borrador') return json({ error: 'Solo se pueden editar borradores' }, 400);

        const items = (body.items || []).map(it => ({
          descripcion:    String(it.descripcion || '').trim(),
          cantidad:       Number(it.cantidad || 0),
          unidad:         String(it.unidad || '').trim(),
          precioUnitario: Number(it.precioUnitario || 0),
          descuentoPct:   Number(it.descuentoPct || 0),
          ivaPct:         it.ivaPct != null ? Number(it.ivaPct) : 19,
        }));
        const sinPrecio = items.filter(it => !(it.precioUnitario > 0));
        if (sinPrecio.length) {
          return json({ error: `Todos los ítems deben tener precio mayor a cero. Sin precio: ${sinPrecio.map(it => it.descripcion).join(', ')}` }, 400);
        }
        const subtotal = items.reduce((s, it) => s + it.cantidad * it.precioUnitario * (1 - it.descuentoPct / 100), 0);
        const iva      = items.reduce((s, it) => s + it.cantidad * it.precioUnitario * (1 - it.descuentoPct / 100) * it.ivaPct / 100, 0);
        const total    = subtotal + iva;

        const cambios = { itemsJson: JSON.stringify(items), subtotal, iva, total };
        const cc  = body.condicionesComerciales != null ? String(body.condicionesComerciales) : f.condicionesComerciales;
        const obs = body.observaciones          != null ? String(body.observaciones)          : f.observaciones;
        const le  = body.lugarEntrega           != null ? String(body.lugarEntrega)           : f.lugarEntrega;
        const fep = body.fechaEntregaPrevista   != null ? String(body.fechaEntregaPrevista)   : f.fechaEntregaPrevista;
        if (cc  != null) cambios.condicionesComerciales = cc;
        if (obs != null) cambios.observaciones          = obs;
        if (le  != null) cambios.lugarEntrega           = le;
        if (fep)         cambios.fechaEntregaPrevista   = fep; // dateTime — no enviar string vacío
        const actualizado = await g.updateListItem(ctx.siteId, ctx.OrdenesCompra, ocId, cambios);
        if (actualizado?.id) localDb.upsertDocumento('ordenes_compra', actualizado);
        json({ ok: true, oc: actualizado?.fields || {} });
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ── PATCH /os/:id/editar ──────────────────────────────────────────────────
  const mOSEditar = url.match(/^\/os\/([^\/]+)\/editar$/);
  if (req.method === 'PATCH' && mOSEditar) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const ctx  = await ctxSharePoint();
        const osId = mOSEditar[1];
        const item = await g.getListItem(ctx.siteId, ctx.OrdenesServicio, osId);
        const f    = item?.fields || {};
        if (f.estado !== 'borrador') return json({ error: 'Solo se pueden editar borradores' }, 400);

        const items = (body.items || []).map(it => ({
          descripcion:    String(it.descripcion || '').trim(),
          cantidad:       Number(it.cantidad || 0),
          unidad:         String(it.unidad || '').trim(),
          precioUnitario: Number(it.precioUnitario || 0),
          ivaPct:         it.ivaPct != null ? Number(it.ivaPct) : 0,
        }));
        const cambios = {
          itemsJson:              JSON.stringify(items),
          valor:                  Number(body.valor  || 0),
          iva:                    Number(body.iva    || 0),
          total:                  Number(body.total  || 0),
          tipoContrato:           body.tipoContrato  != null ? String(body.tipoContrato)  : f.tipoContrato,
          aiuA:                   body.aiuA          != null ? Number(body.aiuA)          : f.aiuA,
          aiuI:                   body.aiuI          != null ? Number(body.aiuI)          : f.aiuI,
          aiuU:                   body.aiuU          != null ? Number(body.aiuU)          : f.aiuU,
          tipoServicio:           body.tipoServicio  != null ? String(body.tipoServicio)  : f.tipoServicio,
          clausulas:              body.clausulas     != null ? String(body.clausulas)     : f.clausulas,
          condicionesComerciales: body.condicionesComerciales != null ? String(body.condicionesComerciales) : f.condicionesComerciales,
          observaciones:          body.observaciones != null          ? String(body.observaciones)          : f.observaciones,
        };
        const actualizado = await g.updateListItem(ctx.siteId, ctx.OrdenesServicio, osId, cambios);
        if (actualizado?.id) localDb.upsertDocumento('ordenes_servicio', actualizado);
        json({ ok: true, os: actualizado?.fields || {} });
      } catch (err) { json({ error: err.message }, 500); }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MÓDULO INVENTARIOS
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /inventario/ocs-sin-entrada → OC entregadas sin entrada registrada
  if (req.method === 'GET' && url === '/inventario/ocs-sin-entrada') {
    try {
      const ocs = localDb.getOrdenesCompra()
        .filter(oc => oc.entregado && oc.estado !== 'anulada')
        .sort((a, b) => (b.fechaCreacion || '').localeCompare(a.fechaCreacion || ''));
      const conEntrada = localDb.getOcIdsConEntrada();
      const sinEntrada = ocs.filter(oc => !conEntrada.has(String(oc.id)));
      return json(sinEntrada);
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── GET /inventario/stock → stock unificado por insumo ──────────────────
  if (req.method === 'GET' && url.startsWith('/inventario/stock')) {
    try {
      const qp      = new URL(req.url, 'http://x').searchParams;
      const proyecto = qp.get('proyecto') || null;
      return json(localDb.getStock(proyecto));
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── GET /inventario/documentos → documentos agrupados ───────────────────
  if (req.method === 'GET' && url.startsWith('/inventario/documentos')) {
    try {
      const qp   = new URL(req.url, 'http://x').searchParams;
      const tipo = qp.get('tipo') || null;
      return json(localDb.getDocumentosInventario({ tipo }));
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── GET /inventario/movimientos → lista de movimientos ──────────────────
  if (req.method === 'GET' && url.startsWith('/inventario/movimientos')) {
    try {
      const qp   = new URL(req.url, 'http://x').searchParams;
      const proy = qp.get('proyecto') || null;
      const tipo = qp.get('tipo')     || null;
      let movs = localDb.getMovimientosInventario({ proyecto: proy });
      if (tipo) movs = movs.filter(m => m.tipo === tipo);
      movs.sort((a, b) => (b.fechaCreacion || '').localeCompare(a.fechaCreacion || ''));
      return json(movs);
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── POST /inventario/entradas → registrar entrada(s) de almacén ─────────
  if (req.method === 'POST' && url === '/inventario/entradas') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        // body: { items: [{ proyecto, ocId, numeroOC, insumo, unidad, cantidad, precioUnitario, notas }] }
        const items   = Array.isArray(body.items) ? body.items : [body];
        // Idempotencia: rechazar si ya existe una entrada para la misma OC en los últimos 30 s
        if (items.length > 0 && items[0].ocId) {
          const ventana = new Date(Date.now() - 30000).toISOString();
          const reciente = localDb.db().prepare(
            "SELECT COUNT(*) AS n FROM movimientos_inventario WHERE json_extract(data,'$.ocId')=? AND json_extract(data,'$.tipo')='entrada' AND json_extract(data,'$.fechaCreacion')>?"
          ).get(items[0].ocId, ventana);
          if (reciente?.n > 0) {
            return json({ error: 'Ya existe una entrada registrada para esta OC en los últimos 30 segundos. Espera y recarga antes de intentar de nuevo.' }, 409);
          }
        }
        const ctx = await ctxSharePoint();
        if (!ctx.MovimientosInventario) return json({ error: 'Lista MovimientosInventario no disponible' }, 503);
        const usuario = process.env.USUARIO_EMAIL || 'sistema';
        const now     = new Date().toISOString();
        const creados = [];
        const batchId = `BORR-EA-${Date.now()}`;
        for (const it of items) {
          const cant  = Number(it.cantidad) || 0;
          const precio = Number(it.precioUnitario) || 0;
          if (!cant || !it.insumo) continue;
          const fields = {
            tipo:           'entrada',
            fecha:          now,
            proyecto:       String(it.proyecto || ''),
            ocId:           String(it.ocId || ''),
            numeroOC:       String(it.numeroOC || ''),
            insumo:         String(it.insumo || ''),
            unidad:         String(it.unidad || 'UND'),
            cantidad:       cant,
            precioUnitario: precio,
            valorTotal:     cant * precio,
            responsable:    String(it.responsable || usuario),
            creadoPor:      usuario,
            fechaCreacion:  now,
            notas:          String(it.notas || ''),
            estado:         'activo',
            documentoRef:   null,
            estadoDoc:      'borrador',
            batchId,
          };
          const item = await g.addListItem(ctx.siteId, ctx.MovimientosInventario, fields);
          if (item?.id) {
            const spFields = item.fields || item;
            localDb.upsertDocumento('movimientos_inventario', {
              id: item.id,
              fields: { ...fields, ...spFields, batchId: fields.batchId, estadoDoc: fields.estadoDoc, documentoRef: fields.documentoRef },
            });
            creados.push({ id: item.id, ...fields });
          }
        }
        return json({ ok: true, creados, batchId });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── POST /inventario/salidas → registrar salida(s) de almacén (bulk) ──────
  if (req.method === 'POST' && url === '/inventario/salidas') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body    = JSON.parse(Buffer.concat(chunks).toString());
        const ctx     = await ctxSharePoint();
        if (!ctx.MovimientosInventario) return json({ error: 'Lista MovimientosInventario no disponible' }, 503);
        const usuario = process.env.USUARIO_EMAIL || 'sistema';
        const now     = new Date().toISOString();
        // Aceptar tanto { items: [...] } como objeto simple (retrocompat)
        const items   = Array.isArray(body.items) ? body.items : [body];
        if (!items.length) return json({ error: 'items requeridos' }, 400);

        const proyecto = String(items[0]?.proyecto || '');
        const batchId  = `BORR-SA-${Date.now()}`;
        const stock    = localDb.getStock();
        const creados  = [];

        for (const it of items) {
          const cant  = Number(it.cantidad) || 0;
          if (!cant || !it.insumo) continue;
          const fila  = stock.find(s => s.insumo === it.insumo);
          if (fila && fila.stock < cant) {
            return json({ error: `Stock insuficiente para "${it.insumo}". Disponible: ${fila.stock} ${fila.unidad}` }, 400);
          }
          const precioUnit = Number(it.precioUnitario) || fila?.precioUnitario || 0;
          const fields = {
            tipo:           'salida',
            fecha:          now,
            proyecto:       String(it.proyecto || proyecto),
            ocId:           '',
            numeroOC:       '',
            insumo:         String(it.insumo),
            unidad:         String(it.unidad || fila?.unidad || 'UND'),
            cantidad:       cant,
            precioUnitario: precioUnit,
            valorTotal:     cant * precioUnit,
            responsable:    String(it.responsable || usuario),
            creadoPor:      usuario,
            fechaCreacion:  now,
            notas:          String(it.notas || ''),
            estado:         'activo',
            documentoRef:   null,
            estadoDoc:      'borrador',
            batchId,
          };
          const item = await g.addListItem(ctx.siteId, ctx.MovimientosInventario, fields);
          if (item?.id) {
            const spFields = item.fields || item;
            localDb.upsertDocumento('movimientos_inventario', {
              id: item.id,
              fields: { ...fields, ...spFields, batchId: fields.batchId, estadoDoc: fields.estadoDoc, documentoRef: fields.documentoRef },
            });
            creados.push({ id: item.id, ...fields });
          }
        }

        return json({ ok: true, creados, batchId });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── POST /inventario/devoluciones → registrar devolución de materiales ──
  if (req.method === 'POST' && url === '/inventario/devoluciones') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const ctx  = await ctxSharePoint();
        if (!ctx.MovimientosInventario) return json({ error: 'Lista no disponible' }, 503);
        const usuario  = process.env.USUARIO_EMAIL || 'sistema';
        const now      = new Date().toISOString();
        const devBatchId = `BORR-DEV-${Date.now()}`;
        const creados  = [];
        for (const it of (body.items || [])) {
          const cant = Number(it.cantidad) || 0;
          if (!cant || !it.insumo) continue;
          const precio = Number(it.precioUnitario) || 0;
          const fields = {
            tipo: 'salida', fecha: now,
            proyecto:       String(body.proyecto || ''),
            ocId: '', numeroOC: '',
            insumo:         String(it.insumo),
            unidad:         String(it.unidad || 'UND'),
            cantidad:       cant,
            precioUnitario: precio,
            valorTotal:     cant * precio,
            responsable:    usuario,
            creadoPor:      usuario,
            fechaCreacion:  now,
            notas:          `DEVOLUCION:${body.docRef || body.batchId || ''}`,
            estado:         'activo',
            documentoRef:   null,
            estadoDoc:      'borrador',
            batchId:        devBatchId,
          };
          const item = await g.addListItem(ctx.siteId, ctx.MovimientosInventario, fields);
          if (item?.id) {
            const spFields = item.fields || item;
            localDb.upsertDocumento('movimientos_inventario', {
              id: item.id,
              fields: { ...fields, ...spFields, batchId: devBatchId, estadoDoc: 'borrador', documentoRef: null },
            });
            creados.push({ id: item.id, ...fields });
          }
        }
        return json({ ok: true, creados, batchId: devBatchId });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── PATCH /inventario/documentos/:batchId/aprobar ───────────────────────
  const mDocAprobar = url.match(/^\/inventario\/documentos\/([^\/]+)\/aprobar$/);
  if (req.method === 'PATCH' && mDocAprobar) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const batchId = decodeURIComponent(mDocAprobar[1]);
        const body    = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const proyecto = String(body.proyecto || '');
        const tipo     = String(body.tipo || 'entrada');
        const ctx = await ctxSharePoint();
        if (!ctx.MovimientosInventario) return json({ error: 'Lista MovimientosInventario no disponible' }, 503);

        const docRef = localDb.getNextDocRef(tipo, proyecto);
        let movs = localDb.db().prepare(
          "SELECT data FROM movimientos_inventario WHERE json_extract(data,'$.batchId')=?"
        ).all(batchId).map(r => JSON.parse(r.data));
        // Fallback for legacy records without batchId (grouped by documentoRef)
        if (!movs.length) {
          movs = localDb.db().prepare(
            "SELECT data FROM movimientos_inventario WHERE json_extract(data,'$.documentoRef')=?"
          ).all(batchId).map(r => JSON.parse(r.data));
        }

        if (!movs.length) return json({ ok: false, error: 'Documento no encontrado' }, 404);

        let actualizados = 0;
        for (const m of movs) {
          const updated = { ...m, documentoRef: docRef, estadoDoc: 'aprobado' };
          await g.updateListItem(ctx.siteId, ctx.MovimientosInventario, m.id, { documentoRef: docRef, estadoDoc: 'aprobado' });
          localDb.upsertDocumento('movimientos_inventario', { id: m.id, fields: updated });
          actualizados++;
        }
        // Registrar salida aprobada en Control Costos (en segundo plano)
        if (tipo === 'salida' && movs.length > 0) {
          const totalSalida = movs.reduce((s, m) => s + (Number(m.valorTotal) || 0), 0);
          if (totalSalida > 0) {
            (async () => {
              try {
                await cc.registrarGasto({
                  fechaOC:    new Date().toISOString().slice(0, 10),
                  numeroOC:   docRef,
                  proyecto,
                  tipoGasto:  'Salida Almacén',
                  subtotal:   totalSalida,
                  iva:        0,
                  total:      totalSalida,
                  estado:     'ejecutado',
                  creadoPor:  movs[0].creadoPor || process.env.USUARIO_EMAIL || 'sistema',
                });
              } catch (e) { console.warn('[inventario aprobar] Control Costos:', e.message); }
            })();
          }
        }
        return json({ ok: true, documentoRef: docRef, actualizados });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── PATCH /inventario/documentos/:batchId/anular ─────────────────────────
  const mDocAnular = url.match(/^\/inventario\/documentos\/([^\/]+)\/anular$/);
  if (req.method === 'PATCH' && mDocAnular) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const batchId = decodeURIComponent(mDocAnular[1]);
        const ctx = await ctxSharePoint();
        if (!ctx.MovimientosInventario) return json({ error: 'Lista MovimientosInventario no disponible' }, 503);

        let movs = localDb.db().prepare(
          "SELECT data FROM movimientos_inventario WHERE json_extract(data,'$.batchId')=?"
        ).all(batchId).map(r => JSON.parse(r.data));
        if (!movs.length) {
          movs = localDb.db().prepare(
            "SELECT data FROM movimientos_inventario WHERE json_extract(data,'$.documentoRef')=?"
          ).all(batchId).map(r => JSON.parse(r.data));
        }

        if (!movs.length) return json({ ok: false, error: 'Documento no encontrado' }, 404);

        // Actualizar todos en paralelo en vez de secuencialmente (reduce N×150ms → ~150ms)
        await Promise.all(movs.map(m => {
          const updated = { ...m, estado: 'anulado', estadoDoc: 'anulado' };
          return g.updateListItem(ctx.siteId, ctx.MovimientosInventario, m.id, { estado: 'anulado', estadoDoc: 'anulado' })
            .then(() => localDb.upsertDocumento('movimientos_inventario', { id: m.id, fields: updated }));
        }));
        return json({ ok: true, anulados: movs.length });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── POST /inventario/analisis-ia → análisis Gemini vs APU ───────────────
  if (req.method === 'POST' && url === '/inventario/analisis-ia') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        // body: { proyecto, pregunta, apuData (tabla extraída del Excel), historial (turns previos) }
        const { proyecto, pregunta, apuData, historial = [] } = body;

        const stock = localDb.getStock(proyecto || null);
        const movs  = localDb.getMovimientosInventario({ proyecto: proyecto || null });
        const salidas = movs.filter(m => m.tipo === 'salida');

        // Construir contexto de consumos reales
        const resumenConsumos = stock.map(s =>
          `• ${s.insumo} (${s.unidad}): entradas=${s.entradas}, salidas=${s.salidas}, stock=${s.stock}` +
          (s.stock > 0
            ? `, valor en inventario=$${s.valorInventario.toFixed(0)}`
            : `, AGOTADO — valor consumido=$${(s.valorGastado || 0).toFixed(0)}`)
        ).join('\n');

        const apuTexto = apuData ? `\n\nRENDIMIENTOS APU PROPORCIONADOS:\n${apuData}` : '';

        const proyectoLabel = proyecto ? `el proyecto "${proyecto}"` : 'todos los proyectos activos';
        const scopeNote = proyecto
          ? `Los datos que siguen corresponden EXCLUSIVAMENTE a "${proyecto}". Son completos para ese proyecto.`
          : `Los datos que siguen corresponden a TODOS los proyectos combinados (no se aplicó filtro de proyecto).`;

        const prompt = `Eres un ingeniero senior de control de presupuestos de construcción, con amplia experticia en la detección y análisis de desviaciones de consumos de materiales en proyectos de ingeniería civil. Tu enfoque es práctico y orientado a alertas tempranas: identificas sobreconsumos, desperdicios, inconsistencias entre entradas y salidas de almacén, y proyectas el impacto presupuestal de las tendencias observadas.

ALCANCE DE LOS DATOS: ${scopeNote}
PROYECTO: ${proyecto || 'Todos los proyectos'}

INVENTARIO ACTUAL (${new Date().toLocaleDateString('es-CO')}):
${resumenConsumos || `Sin movimientos registrados para ${proyectoLabel}.`}
${apuTexto}

INSTRUCCIÓN: Los datos anteriores son la totalidad de lo disponible para el filtro aplicado. Si no hay datos, infórmalo directamente sin mencionar restricciones de acceso. Nunca digas que "no tienes acceso" a información — si no hay datos es porque no hay movimientos registrados.

PREGUNTA DEL USUARIO: ${pregunta || 'Analiza los consumos y detecta posibles sobreconsumos o anomalías.'}

${historial.length > 0 ? 'CONVERSACIÓN PREVIA:\n' + historial.map(h => `${h.role === 'user' ? 'Usuario' : 'Asistente'}: ${h.content}`).join('\n') + '\n' : ''}
Responde en español, de forma concisa y práctica. Señala alertas de sobreconsumo, proyecciones y recomendaciones.`;

        const respuesta = await geminiTexto(prompt, 15000);
        return json({ ok: true, respuesta });
      } catch (err) { return json({ error: err.message }, 500); }
    });
    return;
  }

  // ── GET /usuarios → lista de usuarios (solo admin) ──────────────────────
  if (req.method === 'GET' && url === '/usuarios') {
    if (req._sesion?.rol !== 'admin') return json({ error: 'Acceso denegado' }, 403);
    syncService.syncAll().catch(() => {}); // actualiza en segundo plano para la próxima carga
    return json(localDb.getUsuarios());
  }

  // ── PATCH /usuarios/:id → actualizar rol/activo (solo admin) ─────────────
  const mUsrId = url.match(/^\/usuarios\/([^\/]+)$/);
  if (req.method === 'PATCH' && mUsrId) {
    if (req._sesion?.rol !== 'admin') return json({ error: 'Acceso denegado' }, 403);
    const spId = mUsrId[1];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ctx = await ctxSharePoint();
        if (!ctx.UsuariosERP) return json({ error: 'Lista UsuariosERP no disponible' }, 503);

        const fields = {};
        if (data.activo !== undefined) fields.activo = Boolean(data.activo);
        if (data.rol    !== undefined) fields.rol    = String(data.rol);
        if (data.nombre !== undefined) fields.nombre = String(data.nombre);
        if (data.cargo  !== undefined) fields.cargo  = String(data.cargo);

        await g.updateListItem(ctx.siteId, ctx.UsuariosERP, spId, fields);
        const existing = localDb.getUsuarios().find(u => u.sp_id === spId) || {};
        localDb.upsertUsuario({ ...existing, sp_id: spId, ...fields });
        return json({ ok: true });
      } catch (e) { return json({ error: e.message }, 500); }
    });
    return;
  }

  // ── GET /sync → fuerza resync SharePoint → SQLite ───────────────────────
  if (req.method === 'GET' && url === '/sync') {
    try {
      const resultado = await syncService.syncAll();
      return json({ ok: resultado.ok, duracion: resultado.duracion, conteos: localDb.counts(), lastSync: syncService.lastSync() });
    } catch (err) { return json({ error: err.message }, 500); }
  }

  // ── GET /sync/estado → estado actual del caché ───────────────────────────
  if (req.method === 'GET' && url === '/sync/estado') {
    return json({ lastSync: syncService.lastSync(), syncing: syncService.isSyncing(), conteos: localDb.counts(), estados: localDb.getAllSyncState() });
  }

  res.writeHead(404);
  res.end('No encontrado');

});

servidor.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ App de cotizaciones corriendo en http://localhost:${PORT}`);
  console.log('  Abre esa URL en tu navegador para cargar cotizaciones.\n');
  // Sincronización SharePoint → SQLite en segundo plano
  syncService.init(ctxSharePoint)
    .catch(e => console.warn('[syncService] No se pudo inicializar:', e.message));
  // Crear admin inicial si la base de usuarios está vacía
  bootstrapAdmin()
    .catch(e => console.warn('[bootstrap]', e.message));
  // Limpiar sesiones expiradas cada hora
  const _sesionTimer = setInterval(() => localDb.cleanExpiredSesiones(), 60 * 60 * 1000);
  if (_sesionTimer.unref) _sesionTimer.unref();
});