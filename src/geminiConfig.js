'use strict';
/**
 * geminiConfig.js
 * Resuelve y valida el modelo de Gemini una sola vez, para el servidor web y para
 * el pipeline de correos.
 *
 * Por que existe este archivo
 * ---------------------------
 * El .env de produccion se edita a mano por SSH en el VPS (el deploy lo excluye a
 * proposito), y un typo ahi no se notaba hasta que un usuario subia un archivo y
 * Gemini respondia 400 "unexpected model name format". Paso de verdad: la linea
 * quedo como
 *
 *   GEMINI_MODEL=GEMINI_MODEL=gemini-3.5-flash
 *
 * al pegar el valor sobre una linea que ya tenia el nombre. La extraccion quedo
 * caida hasta que alguien lo reporto, y el mensaje de error no apuntaba al .env.
 *
 * Aca se sanean los tres errores de tipeo que de verdad ocurren y se avisa en el
 * log al arrancar, para que el problema se vea al levantar el contenedor y no en
 * la cara del usuario.
 */

const https = require('https');

// Version concreta, nunca un alias movil como gemini-flash-latest: Google los
// reapunta y el cambio llega a produccion sin pasar por un deploy. Ver .env.example.
const MODELO_POR_DEFECTO = 'gemini-3.5-flash';

function normalizarModelo(valor) {
  const crudo = String(valor ?? '').trim();
  const limpio = crudo
    .replace(/^GEMINI_MODEL\s*=\s*/i, '')   // nombre de la variable pegado por error
    .replace(/^["']+|["']+$/g, '')          // comillas: docker compose las pasa literales
    .replace(/^models\//, '')               // el prefijo models/ lo agrega la URL
    .trim();

  if (!limpio) {
    if (crudo) console.error(`[geminiConfig] GEMINI_MODEL quedo vacio tras limpiar ${JSON.stringify(crudo)} — se usa ${MODELO_POR_DEFECTO}`);
    return MODELO_POR_DEFECTO;
  }

  // Los nombres de modelo de Google son letras, digitos, puntos y guiones. Cualquier
  // otra cosa es un typo, no un modelo nuevo.
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(limpio)) {
    console.error(`[geminiConfig] GEMINI_MODEL invalido: ${JSON.stringify(crudo)} — se usa ${MODELO_POR_DEFECTO}`);
    return MODELO_POR_DEFECTO;
  }

  if (limpio !== crudo) {
    console.warn(`[geminiConfig] GEMINI_MODEL saneado: ${JSON.stringify(crudo)} -> ${limpio}. Corrige el .env.`);
  }
  return limpio;
}

const MODELO = normalizarModelo(process.env.GEMINI_MODEL);

/**
 * Comprueba contra la API que el modelo configurado exista. Se llama al arrancar y
 * nunca lanza: solo escribe en el log. La idea es que un modelo mal escrito o
 * retirado por Google se vea al levantar el contenedor.
 *
 * Usa ListModels, que NO consume la cuota de generateContent — importante, porque en
 * free tier son 20 requests/dia por modelo y no se puede gastar uno en cada reinicio.
 */
function verificarModelo(apiKey, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!apiKey) {
      console.warn('[geminiConfig] GEMINI_API_KEY no configurada — no se puede verificar el modelo');
      return resolve(false);
    }
    const req = https.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, (res) => {
      const trozos = [];
      res.on('data', c => trozos.push(c));
      res.on('end', () => {
        try {
          const cuerpo = JSON.parse(Buffer.concat(trozos).toString());
          if (cuerpo.error) {
            console.warn(`[geminiConfig] No se pudo verificar el modelo (HTTP ${cuerpo.error.code}): ${cuerpo.error.message}`);
            return resolve(false);
          }
          const nombres = (cuerpo.models || []).map(m => String(m.name || '').replace(/^models\//, ''));
          if (nombres.includes(MODELO)) {
            console.log(`[geminiConfig] Modelo Gemini: ${MODELO} (verificado)`);
            return resolve(true);
          }
          const flash = nombres.filter(n => n.includes('flash') && !n.includes('latest')).slice(0, 6);
          console.error(`[geminiConfig] El modelo "${MODELO}" NO existe en la API. Corrige GEMINI_MODEL en el .env.`);
          if (flash.length) console.error(`[geminiConfig] Disponibles (flash): ${flash.join(', ')}`);
          resolve(false);
        } catch (e) {
          console.warn(`[geminiConfig] Respuesta ilegible al verificar el modelo: ${e.message}`);
          resolve(false);
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); console.warn('[geminiConfig] Timeout verificando el modelo'); resolve(false); });
    req.on('error', (e) => { console.warn(`[geminiConfig] Error de red verificando el modelo: ${e.message}`); resolve(false); });
  });
}

module.exports = { MODELO, MODELO_POR_DEFECTO, normalizarModelo, verificarModelo };
