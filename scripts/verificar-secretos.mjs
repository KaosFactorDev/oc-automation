#!/usr/bin/env node
// verificar-secretos.mjs — que no se suba un .env ni nada sensible (T-264).
//
// El original vive en kaos-webapp (scripts/verificar-secretos.mjs) y es el mismo
// archivo en los cinco repos del ecosistema: si lo cambias, cámbialo allí primero
// y copia el archivo a los demás.
//
// Uso:
//   node scripts/verificar-secretos.mjs            revisa todo lo versionado (CI)
//   node scripts/verificar-secretos.mjs --staged   revisa lo que vas a commitear
//                                                  (gancho .githooks/pre-commit)
//
// Revisa tres cosas y NUNCA imprime un valor, solo archivo, línea y motivo:
//   1. Archivos que no se versionan: .env y .env.* (salvo *.example), .dev.vars,
//      llaves y certificados.
//   2. Plantillas de entorno (*.example): solo nombres y marcadores <...>, nada de
//      datos reales (secretos, correos, UUID, JWT, dominios o IP reales).
//   3. Contenido: llaves privadas y claves con prefijo de proveedor conocido.
//
// Excepciones justificadas: .secretos-permitidos en la raíz, una por línea:
//   ruta                     todo el archivo
//   ruta:CLAVE               una variable de una plantilla
//   ruta:motivo              un tipo de hallazgo (p. ej. ruta:jwt)
// con un comentario (# por qué) que se revisa en el PR.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const STAGED = process.argv.includes('--staged');
const MAX_BYTES = 1024 * 1024;

const git = (args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

function archivos() {
  const out = STAGED
    ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    : git(['ls-files', '-z']);
  return out.toString('utf8').split('\0').filter(Boolean);
}

function contenido(ruta) {
  try {
    if (STAGED) return git(['show', `:${ruta}`]);
    if (!existsSync(ruta) || statSync(ruta).size > MAX_BYTES) return null;
    return readFileSync(ruta);
  } catch {
    return null;
  }
}

// ── Excepciones ─────────────────────────────────────────────────────────────

function leerPermitidos() {
  if (!existsSync('.secretos-permitidos')) return [];
  return readFileSync('.secretos-permitidos', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf(':');
      return i > 0 ? { ruta: l.slice(0, i), sel: l.slice(i + 1) } : { ruta: l, sel: null };
    });
}
const PERMITIDOS = leerPermitidos();
const permitido = (h) =>
  PERMITIDOS.some((p) => p.ruta === h.ruta && (!p.sel || p.sel === h.clave || p.sel === h.motivo));

// ── 1. Archivos que no se versionan ─────────────────────────────────────────

const base = (r) => r.split('/').pop();
function archivoProhibido(ruta) {
  const b = base(ruta).toLowerCase();
  if (/^\.env(\..+)?$/.test(b) && !b.endsWith('.example')) return 'archivo .env versionado';
  if (b === '.dev.vars') return 'archivo .dev.vars versionado';
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(b)) return 'llave o certificado versionado';
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(b)) return 'llave SSH versionada';
  if (/service[-_]?account.*\.json$/.test(b)) return 'credencial de cuenta de servicio versionada';
  return null;
}

// ── 2. Plantillas de entorno ────────────────────────────────────────────────

const esPlantilla = (ruta) => /(^|\/)(\.env[^/]*|[^/]*\.env|\.dev\.vars)\.example$/i.test(ruta);

const CLAVE_SENSIBLE = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|JWT|CLIENT_ID|TENANT_ID|_KEY$|^KEY$|CREDENTIAL)/i;

/**
 * Marcadores: <lo que va>, your_..., tu_..., changeme, o con una racha de x
 * (sk-ant-xxxxxxxx, tkf_live_xxxx...). Números y booleanos no son secretos.
 */
function esMarcador(valor) {
  return /^<[^>]*>$/.test(valor)
    || /^(your|tu|su)[_-]/i.test(valor)
    || /(changeme|placeholder|reemplaza|cambiar)/i.test(valor)
    || /x{6,}|X{6,}/.test(valor)
    || /^(\d+(\.\d+)?|true|false|si|no|on|off)$/i.test(valor);
}
const DOMINIOS_EJEMPLO = /(^|\.)(example\.(com|org|net)|ejemplo\.(com|test)|[a-z0-9-]+\.(test|local|example|invalid|localhost))$/i;
const HOSTS_LOCALES = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal)$/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** JWT de demostración de `supabase start` (iss supabase-demo): no es un secreto. */
function esJwtDemo(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8')).iss === 'supabase-demo';
  } catch {
    return false;
  }
}

function hostDe(valor) {
  const m = valor.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i);
  if (m) return m[1];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(valor)) return valor; // host o IP sueltos
  return null;
}
const hostReal = (h) =>
  h.includes('.') && !HOSTS_LOCALES.test(h) && !DOMINIOS_EJEMPLO.test(h)
  && !/(your|tu)-?(project|proyecto|dominio|domain)|x{4,}/i.test(h);

function revisarPlantilla(ruta, texto, hallazgos) {
  texto.split(/\r?\n/).forEach((linea, i) => {
    const m = linea.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    const clave = m[1];
    const valor = m[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!valor || esMarcador(valor)) return;
    const h = (motivo) => hallazgos.push({ ruta, linea: i + 1, clave, motivo });

    const jwts = valor.match(JWT) || [];
    if (jwts.length) {
      if (!jwts.every(esJwtDemo)) h('jwt');
      return;
    }
    if (CLAVE_SENSIBLE.test(clave)) return h('valor en una variable sensible');
    if (UUID.test(valor)) return h('uuid');
    const correo = valor.match(/[^\s@<>"']+@([^\s@<>"':/]+)/);
    if (correo && hostReal(correo[1])) return h('correo o usuario@host real');
    const host = hostDe(valor);
    if (host && hostReal(host)) return h('dominio o IP real');
  });
}

// ── 3. Contenido ────────────────────────────────────────────────────────────

// Una llave privada de verdad: el encabezado seguido de su contenido en base64, en la
// misma línea (con \n escrito, como en un JSON) o en la siguiente. El encabezado
// solo, como texto en el código que limpia una llave que llega por variable, no.
const LLAVE_PRIVADA = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/;
const CUERPO_LLAVE = /^(?:\\n|\s)*[A-Za-z0-9+/]{40,}/;

// Claves con prefijo de proveedor. Un marcador (sk-ant-xxxx…) no cuenta.
const PATRONES = [
  ['clave de Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['clave de OpenAI', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['clave de AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['token de GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['token de Slack', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['clave de Google', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['clave secreta de Supabase', /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ['token de Supabase', /\bsbp_[a-f0-9]{40}\b/],
];

function revisarContenido(ruta, texto, hallazgos, { jwt = true } = {}) {
  const lineas = texto.split(/\r?\n/);
  lineas.forEach((linea, i) => {
    const pem = linea.match(LLAVE_PRIVADA);
    if (pem) {
      const resto = linea.slice(pem.index + pem[0].length);
      if (CUERPO_LLAVE.test(resto) || CUERPO_LLAVE.test(lineas[i + 1] || '')) {
        hallazgos.push({ ruta, linea: i + 1, motivo: 'llave privada' });
      }
    }
    for (const [motivo, re] of PATRONES) {
      const m = linea.match(re);
      if (m && !/x{6,}|X{6,}/.test(m[0])) hallazgos.push({ ruta, linea: i + 1, motivo });
    }
    if (!jwt) return; // en las plantillas ya lo revisa revisarPlantilla
    for (const token of linea.match(JWT) || []) {
      if (!esJwtDemo(token)) hallazgos.push({ ruta, linea: i + 1, motivo: 'jwt' });
    }
  });
}

// ── Principal ───────────────────────────────────────────────────────────────

const hallazgos = [];
for (const ruta of archivos()) {
  if (ruta === 'scripts/verificar-secretos.mjs') continue; // trae los patrones como texto
  const prohibido = archivoProhibido(ruta);
  if (prohibido) {
    hallazgos.push({ ruta, linea: 0, motivo: prohibido });
    continue;
  }
  const buf = contenido(ruta);
  if (!buf || buf.includes(0)) continue; // binario o ilegible
  const texto = buf.toString('utf8');
  const plantilla = esPlantilla(ruta);
  if (plantilla) revisarPlantilla(ruta, texto, hallazgos);
  revisarContenido(ruta, texto, hallazgos, { jwt: !plantilla });
}

const reales = hallazgos.filter((h) => !permitido(h));
if (reales.length === 0) {
  console.log(`✓ verificar-secretos: sin hallazgos${STAGED ? ' en lo que vas a commitear' : ''}.`);
  process.exit(0);
}

console.error(`✖ verificar-secretos: ${reales.length} hallazgo(s). No se imprime ningún valor.\n`);
for (const h of reales) {
  const donde = h.linea ? `${h.ruta}:${h.linea}` : h.ruta;
  console.error(`  ${donde}  ${h.clave ? `${h.clave}: ` : ''}${h.motivo}`);
}
console.error(`
Qué hacer:
  · Un .env, una llave o un certificado: sácalo del índice (git rm --cached <ruta>);
    el .gitignore ya debería cubrirlo.
  · Una plantilla *.example: deja el nombre y un marcador, p. ej. CLAVE=<qué va acá>.
    El valor real va solo en tu .env local o en los secretos del despliegue.
  · Un secreto que ya se subió: avisa al líder para rotarlo; borrarlo no lo saca del historial.
  · Si es legítimo (un valor de prueba, sin riesgo), agrégalo a .secretos-permitidos
    con un comentario que diga por qué.`);
process.exit(1);
