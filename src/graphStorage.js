'use strict';
/**
 * graphStorage.js
 * Wrapper unificado sobre Microsoft Graph API para:
 *   - Autenticación OAuth2 client_credentials (app-only) con cache de token
 *   - SharePoint Sites / Lists (CRUD con soporte de ETags para concurrencia)
 *   - OneDrive / SharePoint Workbook API (lectura y escritura de Excel como DB)
 *
 * Requiere en .env:
 *   TENANT_ID, CLIENT_ID, CLIENT_SECRET
 *
 * Permisos Azure AD (application):
 *   Sites.ReadWrite.All, Files.ReadWrite.All  (con admin consent)
 */

const fetch = require('node-fetch');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

// ── Auth ──────────────────────────────────────────────────────────────────────

let _tokenCache = null;

async function getToken() {
  if (_tokenCache && _tokenCache.expira > Date.now()) return _tokenCache.token;

  const tenantId     = process.env.TENANT_ID;
  const clientId     = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Faltan TENANT_ID / CLIENT_ID / CLIENT_SECRET en .env');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  const res  = await fetch(LOGIN(tenantId), { method: 'POST', body });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Error al obtener token: ${JSON.stringify(data)}`);
  }

  _tokenCache = {
    token:  data.access_token,
    expira: Date.now() + (data.expires_in - 60) * 1000,
  };
  return _tokenCache.token;
}

// ── HTTP genéricos ────────────────────────────────────────────────────────────

async function request(method, path, { body, etag, extraHeaders } = {}) {
  const token = await getToken();
  const url   = path.startsWith('http') ? path : `${GRAPH}${path}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(etag ? { 'If-Match': etag } : {}),
    ...extraHeaders,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }

  if (!res.ok) {
    const err = new Error(`Graph ${method} ${path} → ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
    err.status   = res.status;
    err.response = json;
    throw err;
  }

  return json;
}

const get    = (p, opts)       => request('GET',    p, opts);
const post   = (p, body, opts) => request('POST',   p, { ...opts, body });
const patch  = (p, body, opts) => request('PATCH',  p, { ...opts, body });
const del    = (p, opts)       => request('DELETE', p, opts);

// ── SharePoint Sites ──────────────────────────────────────────────────────────

/**
 * Resuelve un sitio por hostname + ruta relativa.
 * Ej: getSite('civiltechic.sharepoint.com', '/sites/Gestion-de-Proyectos')
 */
async function getSite(hostname, relativePath) {
  const p = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return get(`/sites/${hostname}:/${p}`);
}

async function getSiteById(siteId) {
  return get(`/sites/${siteId}`);
}

// ── SharePoint Lists ──────────────────────────────────────────────────────────

async function getLists(siteId) {
  const data = await get(`/sites/${siteId}/lists`);
  return data.value;
}

async function getListByName(siteId, displayName) {
  const data = await get(`/sites/${siteId}/lists?$filter=displayName eq '${encodeURIComponent(displayName)}'`);
  return (data.value && data.value[0]) || null;
}

async function createList(siteId, spec) {
  return post(`/sites/${siteId}/lists`, spec);
}

async function deleteList(siteId, listId) {
  return del(`/sites/${siteId}/lists/${listId}`);
}

// ── List Items ────────────────────────────────────────────────────────────────

/**
 * Retorna todos los items (paginado automático).
 * opts: { filter, orderby, top, select, expand }
 */
async function getListItems(siteId, listId, opts = {}) {
  const params = new URLSearchParams();
  params.set('expand', opts.expand || 'fields');
  if (opts.filter)  params.set('$filter',  opts.filter);
  if (opts.orderby) params.set('$orderby', opts.orderby);
  if (opts.top)     params.set('$top',     String(opts.top));
  if (opts.select)  params.set('$select',  opts.select);

  let url    = `/sites/${siteId}/lists/${listId}/items?${params.toString()}`;
  const reqOpts = opts.prefer ? { extraHeaders: { Prefer: opts.prefer } } : undefined;
  const all  = [];
  while (url) {
    const data = await get(url, reqOpts);
    all.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
    if (url && url.startsWith(GRAPH)) url = url.substring(GRAPH.length);
  }
  return all;
}

async function getListItem(siteId, listId, itemId) {
  return get(`/sites/${siteId}/lists/${listId}/items/${itemId}?$expand=fields`);
}

async function addListItem(siteId, listId, fields) {
  return post(`/sites/${siteId}/lists/${listId}/items`, { fields });
}

/**
 * Actualización con ETag opcional para concurrencia optimista.
 * Si dos usuarios editan el mismo item, el que llegue segundo recibe 412.
 */
async function updateListItem(siteId, listId, itemId, fields, { etag } = {}) {
  return patch(`/sites/${siteId}/lists/${listId}/items/${itemId}/fields`, fields, { etag });
}

async function deleteListItem(siteId, listId, itemId) {
  return del(`/sites/${siteId}/lists/${listId}/items/${itemId}`);
}

// ── Drive / Workbook API (para Excel de control de costos, punto 2.2) ────────

async function getDriveItemByPath(siteId, relativePath) {
  const p = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return get(`/sites/${siteId}/drive/root:/${p}`);
}

async function ensureWorkbookSession(siteId, driveItemId) {
  // Sesión persistente acelera múltiples operaciones sobre el mismo libro
  const data = await post(`/sites/${siteId}/drive/items/${driveItemId}/workbook/createSession`, {
    persistChanges: true,
  });
  return data.id;
}

async function closeWorkbookSession(siteId, driveItemId, sessionId) {
  return post(`/sites/${siteId}/drive/items/${driveItemId}/workbook/closeSession`, null, {
    extraHeaders: { 'workbook-session-id': sessionId },
  });
}

async function appendRowToTable(siteId, driveItemId, tableName, values, { sessionId } = {}) {
  const headers = sessionId ? { 'workbook-session-id': sessionId } : {};
  return request('POST', `/sites/${siteId}/drive/items/${driveItemId}/workbook/tables/${tableName}/rows/add`, {
    body: { values: [values] },
    extraHeaders: headers,
  });
}

async function uploadFileToSite(siteId, relativePath, buffer, contentType = 'application/octet-stream') {
  const p     = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  // En modo prueba el archivo se guarda en disco. Los llamadores solo leen
  // webUrl, así que la forma devuelta les sirve igual.
  const prueba = require('./modoPrueba');
  if (prueba.activo) return prueba.guardarEnDisco(p, buffer);
  const token = await getToken();
  const url   = `${GRAPH}/sites/${siteId}/drive/root:/${p}:/content`;
  const res   = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body:   buffer,
  });
  if (!res.ok) throw new Error(`Upload ${p} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Columnas de lista ─────────────────────────────────────────────────────────

async function addListColumn(siteId, listId, columnDef) {
  return post(`/sites/${siteId}/lists/${listId}/columns`, columnDef);
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  // auth
  getToken,
  // HTTP
  get, post, patch, del,
  // sites
  getSite, getSiteById,
  // lists
  getLists, getListByName, createList, deleteList,
  // items
  getListItems, getListItem, addListItem, updateListItem, deleteListItem,
  // columns
  addListColumn,
  // drive / workbook
  getDriveItemByPath, ensureWorkbookSession, closeWorkbookSession,
  appendRowToTable, uploadFileToSite,
};
