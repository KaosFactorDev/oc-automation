'use strict';
/**
 * authService.js — Autenticación Microsoft OAuth 2.0 + gestión de sesiones
 *
 * Flujo Authorization Code (cliente confidencial con client_secret):
 *   1. GET /auth/login-url  → genera URL de login Microsoft + state anti-CSRF
 *   2. Microsoft redirige a GET /auth/callback?code=...&state=...
 *   3. Intercambia code por id_token (server-to-server, no expone secret al cliente)
 *   4. Extrae email del id_token, verifica en tabla `usuarios` (activo=1)
 *   5. Crea sesión en SQLite, devuelve cookie HttpOnly `erp_session`
 *
 * Prerequisito en Azure AD:
 *   Agregar la redirect_uri (AUTH_REDIRECT_URI o http://localhost:{PORT}/auth/callback)
 *   como plataforma "Web" en Autenticación del registro de aplicación.
 */

const crypto = require('crypto');
const https  = require('https');
require('dotenv').config();

const db = require('./db');

// ── Constantes ────────────────────────────────────────────────────────────────

const COOKIE_NAME     = 'erp_session';
const SESSION_TTL_MS  = 8  * 60 * 60 * 1000; // 8 horas
const SESSION_RENEW_MS = 30 * 60 * 1000;      // renovar si quedan < 30 min
const STATE_TTL_MS    = 5  * 60 * 1000;        // 5 min para completar el login

// ── In-memory state store (CSRF) ──────────────────────────────────────────────

const _pendingStates = new Map(); // state → { expiresAt }

function _cleanStates() {
  const now = Date.now();
  for (const [k, v] of _pendingStates) {
    if (v.expiresAt < now) _pendingStates.delete(k);
  }
}

// ── Genera URL de login Microsoft ─────────────────────────────────────────────

function getLoginUrl(redirectUri) {
  const state = crypto.randomBytes(20).toString('hex');
  _cleanStates();
  _pendingStates.set(state, { expiresAt: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id:     process.env.CLIENT_ID    || '',
    response_type: 'code',
    redirect_uri:  redirectUri,
    response_mode: 'query',
    scope:         'openid profile email',
    // Sin esto Microsoft reutiliza en silencio la sesion que ya tenga abierta en
    // el navegador. En equipos con varias cuentas (la corporativa y la personal,
    // o dos correos de Civiltech) eso entra siempre con la ultima usada, y la
    // unica salida era cerrar sesion en Microsoft. select_account fuerza el
    // selector de cuenta en cada login.
    prompt:        'select_account',
    state,
  });
  return `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

// ── Intercambia code por email (server-to-server) ─────────────────────────────

async function exchangeCode(code, state, redirectUri) {
  const entry = _pendingStates.get(state);
  if (!entry || entry.expiresAt < Date.now()) {
    throw new Error('Estado OAuth inválido o expirado. Por favor intenta de nuevo.');
  }
  _pendingStates.delete(state);

  const body = new URLSearchParams({
    client_id:     process.env.CLIENT_ID     || '',
    client_secret: process.env.CLIENT_SECRET || '',
    code,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
    scope:         'openid profile email',
  }).toString();

  const data = await _httpPost(
    `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
    body,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );

  if (data.error) throw new Error(data.error_description || data.error);

  const claims = _decodeJwt(data.id_token);
  const email  = (claims.email || claims.preferred_username || '').toLowerCase().trim();
  const nombre = (claims.name  || email).trim();

  if (!email) throw new Error('El token de Microsoft no contiene un correo válido.');
  return { email, nombre };
}

function _decodeJwt(token) {
  try {
    const payload = (token || '').split('.')[1] || '';
    const padded  = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch { return {}; }
}

function _httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Respuesta inválida del servidor de autenticación')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Sesiones ──────────────────────────────────────────────────────────────────

function createSession(email, nombre, rol) {
  const id         = crypto.randomUUID();
  const expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.upsertSesion({ id, email, nombre, rol, expires_at });
  return id;
}

function validateSession(sessionId) {
  if (!sessionId) return null;
  const s = db.getSesion(sessionId);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    db.deleteSesion(sessionId);
    return null;
  }
  // Sliding window: renovar si quedan menos de 30 min
  if (new Date(s.expires_at) - new Date() < SESSION_RENEW_MS) {
    db.upsertSesion({ ...s, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  }
  return { email: s.email, nombre: s.nombre, rol: s.rol };
}

function deleteSession(sessionId) {
  if (sessionId) db.deleteSesion(sessionId);
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(cookieHeader) {
  const result = {};
  for (const part of (cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    result[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return result;
}

function buildSessionCookie(sessionId, redirectUri = '') {
  const secure = redirectUri.startsWith('https://') ? '; Secure' : '';
  return `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  getLoginUrl,
  exchangeCode,
  createSession,
  validateSession,
  deleteSession,
  parseCookies,
  buildSessionCookie,
  clearSessionCookie,
};
