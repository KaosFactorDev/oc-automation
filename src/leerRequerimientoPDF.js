'use strict';
/**
 * leerRequerimientoPDF.js
 * Extrae {cabecera, items} desde un PDF del formato CT-ADMIN-FO-002
 * usando Gemini (vision). Devuelve la misma estructura que leerRequerimiento.js
 * para que el resto del pipeline (procesarCorreo) no cambie.
 */

const fs    = require('fs');
const https = require('https');

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// Saneado y validado en geminiConfig.js (compartido con el servidor web).
const MODELO     = require('./geminiConfig').MODELO;

const PROMPT = `Este PDF es el formato oficial de SOLICITUD DE REQUERIMIENTO (CT-ADMIN-FO-002) de Civiltech.
Extrae la información y devuelve SOLO un JSON (sin markdown, sin comentarios) con esta estructura EXACTA:

{
  "cabecera": {
    "proyecto":    "código o nombre exacto del proyecto",
    "fecha":       "DD/MM/YYYY (fecha de la solicitud)",
    "responsable": "nombre completo de quien solicita",
    "cargo":       "cargo del responsable"
  },
  "items": [
    {
      "item":             "1",
      "insumo":           "descripción exacta del insumo tal como aparece",
      "cantidad":         1,
      "unidad":           "UND | PAR | KG | M | GL | ...",
      "necesidad":        "fecha de necesidad o texto descriptivo si existe",
      "posibleProveedor": "proveedor sugerido si aparece, si no deja vacío"
    }
  ]
}

Reglas:
- Respeta mayúsculas/minúsculas y tildes del insumo original.
- Si la cantidad viene como texto (p.ej. "cinco"), conviértela a número.
- Si no hay unidad explícita usa "UND".
- Incluye SOLO filas con insumo y cantidad válidos — omite filas vacías o de encabezado.
- Si un campo no aparece en el PDF, déjalo como cadena vacía "".
- Devuelve al menos 1 ítem si el formato está diligenciado. Si no hay ítems, devuelve items: [].`;

// POST a Gemini con timeout y reintento ante 503/UNAVAILABLE o cortes de red.
// Espejo del helper en servidor-cotizaciones.js (este módulo corre en el pipeline
// de correos, fuera del servidor web).
async function postGemini(url, bodyStr, { timeoutMs = 60000, reintentos = 2 } = {}) {
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
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          // Ver la nota en servidor-cotizaciones.js: este timeout es un techo al
          // tiempo de generacion, y la generacion ya ocurrio del lado de Google.
          const err = new Error(`Gemini timeout tras ${Math.round(timeoutMs / 1000)}s`);
          err.generacionEnVuelo = true;
          reject(err);
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });
      const err = resp.body?.error;
      const esTransitorio = resp.status === 503 || err?.status === 'UNAVAILABLE' || err?.code === 503;
      if (esTransitorio && intento < reintentos) {
        const espera = 1000 * Math.pow(2, intento);
        console.warn(`[leerRequerimientoPDF] Gemini ${err?.status || resp.status} — reintento ${intento + 1}/${reintentos} en ${espera}ms`);
        ultimoError = new Error(`Gemini no disponible (HTTP ${err?.code || resp.status}): ${err?.message || 'UNAVAILABLE'}`);
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      if (err) throw new Error(`Gemini error (HTTP ${err.code || resp.status}): ${err.message}`);
      return resp.body;
    } catch (e) {
      ultimoError = e;
      const reintentable = !e.generacionEnVuelo &&
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(e.message);
      if (reintentable && intento < reintentos) {
        const espera = 1000 * Math.pow(2, intento);
        console.warn(`[leerRequerimientoPDF] ${e.message} — reintento ${intento + 1}/${reintentos} en ${espera}ms`);
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      throw e;
    }
  }
  throw ultimoError || new Error('Gemini: fallo desconocido');
}

async function leerRequerimientoPDF(rutaPDF) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada en .env');
  if (!fs.existsSync(rutaPDF)) throw new Error(`No existe el archivo: ${rutaPDF}`);

  const pdfBase64 = fs.readFileSync(rutaPDF).toString('base64');

  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      temperature: 0,
      // 8192 y no 4096: en los modelos 3.x los tokens de razonamiento se descuentan
      // de este presupuesto. Con 4096 el razonamiento se lo comia casi entero y la
      // respuesta volvia con finishReason MAX_TOKENS y texto truncado — con HTTP 200,
      // asi que no lanzaba error: fallaba mas abajo en el JSON.parse.
      maxOutputTokens: 8192,
      // Leer campos de un requerimiento es extraccion, no razonamiento.
      thinkingConfig: { thinkingLevel: 'low' },
    },
  });

  const resp = await postGemini(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
    body,
    { timeoutMs: 120000, reintentos: 2 },
  );

  const texto = resp.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const limpio = texto.replace(/```json|```/g, '').trim();

  let data;
  try { data = JSON.parse(limpio); }
  catch (e) { throw new Error(`Respuesta de Gemini no es JSON válido: ${limpio.slice(0, 200)}`); }

  const cabecera = {
    proyecto:    String(data.cabecera?.proyecto    || '').trim(),
    fecha:       String(data.cabecera?.fecha       || '').trim(),
    responsable: String(data.cabecera?.responsable || '').trim(),
    cargo:       String(data.cabecera?.cargo       || '').trim(),
  };

  const items = (Array.isArray(data.items) ? data.items : [])
    .map((it, i) => ({
      item:             String(it.item || (i + 1)),
      insumo:           String(it.insumo || '').trim(),
      cantidad:         Number(it.cantidad) || 0,
      unidad:           String(it.unidad || 'UND').trim().toUpperCase(),
      necesidad:        String(it.necesidad || '').trim(),
      posibleProveedor: String(it.posibleProveedor || '').trim(),
    }))
    .filter(it => it.insumo && it.cantidad > 0);

  if (items.length === 0) {
    throw new Error('El PDF no contiene ítems diligenciados. Verifique que el formato esté completo.');
  }

  return { cabecera, items };
}

module.exports = { leerRequerimientoPDF };
