'use strict';
/**
 * leerCorreos.js
 * Lee el buzón compartido abastecimiento@civiltechic.com,
 * identifica solicitudes de requerimiento y descarga adjuntos Excel.
 *
 * Dos modos de operación:
 *   A) Via MCP (claude.ai)  — usa las herramientas Microsoft 365 del conector
 *   B) Via Graph API REST   — para ejecución autónoma en servidor (cron/Azure Function)
 *
 * El módulo exporta la misma interfaz en ambos modos:
 *   await leerSolicitudesPendientes() → Array de solicitudes listas para procesarCorreo()
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');

// ── Configuración ─────────────────────────────────────────────────────────────
const CONFIG = {
  buzon:         process.env.MAILBOX          || 'abastecimiento@civiltechic.com',
  tenantId:      process.env.TENANT_ID,
  clientId:      process.env.CLIENT_ID,
  clientSecret:  process.env.CLIENT_SECRET,
  dirAdjuntos:   process.env.DIR_ADJUNTOS     || path.join(__dirname, '../temp/adjuntos'),
  carpetaProcesados: 'Procesados_OC',         // carpeta Outlook donde mover correos ya procesados
};

// Acepta tanto "SOLICITUD REQUERIMIENTO" como "SOLICITUD DE REQUERIMIENTO"
const PREFIJOS_ASUNTO = ['SOLICITUD DE REQUERIMIENTO', 'SOLICITUD REQUERIMIENTO'];
const EXTENSIONES_VALIDAS = ['.xlsx', '.xls', '.pdf'];

// ── Utilidades HTTP ───────────────────────────────────────────────────────────

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.toString()}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPatch(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req  = https.request(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        try { resolve(txt ? JSON.parse(txt) : null); } catch { resolve(txt); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpPost(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(bodyObj).toString();
    const req  = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Autenticación OAuth2 (client_credentials) ─────────────────────────────────

let _tokenCache = null;

async function obtenerToken() {
  if (_tokenCache && _tokenCache.expira > Date.now()) return _tokenCache.token;

  const { tenantId, clientId, clientSecret } = CONFIG;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Faltan credenciales Azure AD en las variables de entorno (TENANT_ID, CLIENT_ID, CLIENT_SECRET).');
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const data = await httpPost(url, {}, {
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  if (!data.access_token) throw new Error(`Error al obtener token: ${JSON.stringify(data)}`);

  _tokenCache = {
    token:  data.access_token,
    expira: Date.now() + (data.expires_in - 60) * 1000,
  };
  return _tokenCache.token;
}

// ── Graph API helpers ─────────────────────────────────────────────────────────

async function graphGet(ruta) {
  const token = await obtenerToken();
  const url   = `https://graph.microsoft.com/v1.0${ruta}`;
  const body  = await httpGet(url, {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/json',
  });
  return JSON.parse(body.toString());
}

async function graphGetBytes(ruta) {
  const token = await obtenerToken();
  const url   = `https://graph.microsoft.com/v1.0${ruta}`;
  return httpGet(url, { 'Authorization': `Bearer ${token}` });
}

async function graphPost(ruta, bodyObj) {
  const token = await obtenerToken();
  const url   = `https://graph.microsoft.com/v1.0${ruta}`;
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const reqOpt = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(url, reqOpt, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(txt)); } catch { resolve(txt); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function graphPatch(ruta, bodyObj) {
  const token = await obtenerToken();
  const url   = `https://graph.microsoft.com/v1.0${ruta}`;
  return httpPatch(url, { 'Authorization': `Bearer ${token}` }, bodyObj);
}

// ── Lógica de buzón ───────────────────────────────────────────────────────────

/**
 * Obtiene todos los mensajes del buzón (leídos o no) que tengan el asunto correcto.
 * Se omite isRead eq false porque si el usuario abre el correo antes del ciclo
 * queda como leído y el sistema lo saltaba — la deduplicación en SharePoint y
 * el movimiento a "Procesados_OC" evitan reprocesar correos ya gestionados.
 * @returns {Array} Lista de mensajes de Graph API
 */
async function obtenerMensajesPendientes() {
  const buzon  = CONFIG.buzon;
  const select = 'id,subject,receivedDateTime,from,hasAttachments,isRead';
  const url    = `/users/${buzon}/mailFolders/Inbox/messages?$select=${select}&$top=50`;

  const resp = await graphGet(url);
  const todos = resp.value || [];

  // Filtrar por asunto en memoria (ambas variantes del prefijo)
  const coincidentes = todos.filter(m => {
    if (!m.subject) return false;
    const norm = m.subject.toUpperCase();
    return PREFIJOS_ASUNTO.some(p => norm.startsWith(p));
  });

  console.log(`[leerCorreos] ${todos.length} mensaje(s) en Inbox → ${coincidentes.length} con prefijo "SOLICITUD [DE] REQUERIMIENTO"`);
  return coincidentes;
}

/**
 * Descarga los adjuntos válidos (Excel o PDF del formato) de un mensaje.
 * @returns {Array} [{ nombre, ruta }] de adjuntos guardados
 */
async function descargarAdjuntosExcel(messageId) {
  const buzon = CONFIG.buzon;
  const resp  = await graphGet(`/users/${buzon}/messages/${messageId}/attachments`);
  const adjuntos = resp.value || [];

  if (!fs.existsSync(CONFIG.dirAdjuntos)) {
    fs.mkdirSync(CONFIG.dirAdjuntos, { recursive: true });
  }

  const descargados = [];
  for (const adj of adjuntos) {
    const ext = path.extname(adj.name || '').toLowerCase();
    if (!EXTENSIONES_VALIDAS.includes(ext)) continue;

    // Obtener bytes del adjunto
    const bytesResp = await graphGet(
      `/users/${buzon}/messages/${messageId}/attachments/${adj.id}`
    );
    const contenido = Buffer.from(bytesResp.contentBytes || '', 'base64');
    const nombreArchivo = `${messageId}_${adj.name}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const rutaLocal     = path.join(CONFIG.dirAdjuntos, nombreArchivo);

    fs.writeFileSync(rutaLocal, contenido);
    descargados.push({ nombre: adj.name, ruta: rutaLocal });
  }

  return descargados;
}

/**
 * Marca el mensaje como leído y lo mueve a la carpeta de procesados.
 */
async function marcarComoProcesado(messageId) {
  const buzon = CONFIG.buzon;

  // 1. Marcar como leído (PATCH es el método correcto en Graph API)
  try {
    await graphPatch(`/users/${buzon}/messages/${messageId}`, { isRead: true });
  } catch (e) {
    console.log(`[leerCorreos] Advertencia al marcar como leído: ${e.message}`);
  }

  // 2. Buscar (o crear) carpeta "Procesados_OC"
  const carpetasResp = await graphGet(`/users/${buzon}/mailFolders?$top=50`);
  const carpetas     = carpetasResp.value || [];
  let carpetaId      = carpetas.find(c => c.displayName === CONFIG.carpetaProcesados)?.id;

  if (!carpetaId) {
    const nueva = await graphPost(`/users/${buzon}/mailFolders`, {
      displayName: CONFIG.carpetaProcesados,
    });
    carpetaId = nueva.id;
  }

  // 3. Mover mensaje
  await graphPost(`/users/${buzon}/messages/${messageId}/move`, {
    destinationId: carpetaId,
  });
}

/**
 * Envía respuesta automática al remitente (sin adjunto → pedir formato).
 */
async function responderCorreo(messageOriginal, asunto, cuerpo, rutaAdjunto, nombreAdjunto) {
  const buzon = CONFIG.buzon;

  // Obtener remitente del mensaje original
  const msg = await graphGet(
    `/users/${buzon}/messages/${messageOriginal.id}?$select=from`
  );
  const remitente = msg.from?.emailAddress;
  if (!remitente?.address) {
    console.log('[leerCorreos] Sin remitente — respuesta omitida.');
    return;
  }

  // Construir cuerpo del mensaje
  const mensaje = {
    subject: asunto,
    body:    { contentType: 'Text', content: cuerpo },
    toRecipients: [{ emailAddress: remitente }],
  };

  // Adjuntar archivo si se especificó
  if (rutaAdjunto && fs.existsSync(rutaAdjunto)) {
    const contenido = fs.readFileSync(rutaAdjunto).toString('base64');
    mensaje.attachments = [{
      '@odata.type':  '#microsoft.graph.fileAttachment',
      name:           nombreAdjunto || require('path').basename(rutaAdjunto),
      contentType:    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBytes:   contenido,
    }];
    console.log(`[leerCorreos] Adjuntando formato: ${nombreAdjunto}`);
  }

  const prueba = require('./modoPrueba');
  if (prueba.activo) {
    console.log(`[MODO_PRUEBA] correo NO enviado desde ${buzon}`);
    return { modoPrueba: true };
  }
  await graphPost(`/users/${buzon}/sendMail`, {
    message:         mensaje,
    saveToSentItems: true,
  });
  console.log(`[leerCorreos] Respuesta enviada a ${remitente.address}`);
}

// ── Función principal exportada ───────────────────────────────────────────────

/**
 * Lee el buzón, procesa cada solicitud válida y retorna los resultados
 * listos para pasar a procesarCorreo().
 *
 * @returns {Array} [{
 *   asunto,
 *   rutaAdjunto,   // null si no había adjunto
 *   messageId,
 *   remitente,
 *   respuestaAutomatica  // texto a enviar si no había adjunto
 * }]
 */
async function leerSolicitudesPendientes() {
  const mensajes  = await obtenerMensajesPendientes();
  const resultado = [];

  for (const msg of mensajes) {
    const item = {
      asunto:          msg.subject,
      messageId:       msg.id,
      remitente:       msg.from?.emailAddress?.address || '',
      remitenteNombre: msg.from?.emailAddress?.name    || '',
      rutaAdjunto:          null,
      respuestaAutomatica:  null,
    };

    if (msg.hasAttachments) {
      const adjuntos = await descargarAdjuntosExcel(msg.id);
      if (adjuntos.length > 0) {
        item.rutaAdjunto = adjuntos[0].ruta; // tomar el primer Excel
      }
    }

    resultado.push(item);
  }

  return resultado;
}

// ── Orquestador completo (para uso en servidor) ───────────────────────────────

/**
 * Ciclo completo: leer → procesar → generar OC → mover correo.
 * Diseñado para ser llamado por un cron job o Azure Function.
 *
 * @param {Function} onSolicitud  callback(solicitud) → resultado de procesarCorreo()
 * @param {Function} onOCGenerada callback(resultado, archivosOC)
 * @param {Function} onError      callback(error, asunto)
 */
async function procesarBuzon(onSolicitud, onOCGenerada, onError) {
  let procesados = 0;
  let errores    = 0;

  try {
    const solicitudes = await leerSolicitudesPendientes();
    console.log(`[leerCorreos] ${solicitudes.length} solicitud(es) pendiente(s) en ${CONFIG.buzon}`);

    for (const sol of solicitudes) {
      try {
        const resultado = await onSolicitud(sol.asunto, sol.rutaAdjunto);

        if (resultado.accion === 'RESPONDER_SOLICITAR_ADJUNTO' ||
            resultado.accion === 'RESPONDER_FORMATO_INVALIDO' ||
            resultado.accion === 'RESPONDER_FORMATO_ASUNTO_INVALIDO') {
          try {
            await responderCorreo(
              { id: sol.messageId },
              resultado.asunto,
              resultado.cuerpo,
              resultado.rutaAdjunto   || null,
              resultado.nombreAdjunto || null
            );
          } catch (errResp) {
            console.error(`[leerCorreos] Error al enviar respuesta: ${errResp.message}`);
            console.error('[leerCorreos] Verifica que Mail.Send este en Azure AD con Admin Consent.');
          }
        }

        if (resultado.accion === 'GENERAR_OC') {
          const archivos = await onOCGenerada(resultado, { messageId: sol.messageId, remitente: sol.remitente });
          console.log(`[leerCorreos] Requerimiento registrado para "${sol.asunto}" → ${archivos.length} item(s)`);

          // Confirmar recepción al solicitante con el consecutivo de sistema asignado
          const req = archivos?.[0];
          if (req && !req.duplicado && req.consecutivoSistema) {
            const proyecto = resultado.solicitud?.proyecto || '';
            try {
              await responderCorreo(
                { id: sol.messageId },
                `RE: ${sol.asunto} — Requerimiento Registrado`,
                `Estimado(a) ${sol.remitenteNombre || 'Solicitante'},\n\n` +
                `Su solicitud de requerimiento fue recibida y registrada en el ERP con los siguientes datos:\n\n` +
                `  Número de requerimiento : ${req.consecutivoSistema}\n` +
                `  Proyecto                : ${proyecto}\n` +
                `  Ítems recibidos         : ${req.items}\n\n` +
                `Este número es su referencia oficial para seguimiento ante el área de compras.\n\n` +
                `Saludos,\nSistema de Gestión de Compras – Civiltech`,
                null, null
              );
            } catch (errResp) {
              console.error(`[leerCorreos] Error al enviar confirmación de recepción: ${errResp.message}`);
            }
          }
        }

        // Mover a procesados en cualquier caso (ignorar también se mueve)
        await marcarComoProcesado(sol.messageId);
        procesados++;

      } catch (err) {
        errores++;
        console.error(`[leerCorreos] Error procesando "${sol.asunto}":`, err.message);
        if (onError) await onError(err, sol.asunto);
      }
    }
  } catch (err) {
    console.error('[leerCorreos] Error al leer buzón:', err.message);
    throw err;
  }

  return { procesados, errores };
}

module.exports = {
  leerSolicitudesPendientes,
  procesarBuzon,
  responderCorreo,
  marcarComoProcesado,
  // Exponer config para pruebas
  CONFIG,
};