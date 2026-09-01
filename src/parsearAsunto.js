'use strict';
/**
 * parsearAsunto.js
 * Extrae consecutivo, fecha y proyecto del asunto del correo.
 * Formato: SOLICITUD REQUERIMIENTO {CONS} {YYYYMMDD} {PROYECTO}
 * Ejemplo: SOLICITUD REQUERIMIENTO 0001 20260410 MISTRAL
 */

// Prefijos aceptados (ordenados de más específico a menos para match correcto)
const PREFIJOS = ['SOLICITUD DE REQUERIMIENTO', 'SOLICITUD REQUERIMIENTO'];

function parsearAsunto(asunto) {
  if (!asunto) return { valido: false, error: 'Asunto vacío' };

  const norm = asunto.trim().toUpperCase();

  // Verificar que sea una solicitud de requerimiento (acepta "DE" opcional)
  const prefijo = PREFIJOS.find(p => norm.startsWith(p));
  if (!prefijo) {
    return { valido: false, prefijoDetectado: false, error: 'El asunto no corresponde a una solicitud de requerimiento' };
  }

  // Extraer partes después del prefijo (usando la longitud del prefijo real)
  const resto = asunto.trim().substring(prefijo.length).trim();

  // Patrón: {CONSECUTIVO} [-] {YYYYMMDD} {PROYECTO...}
  // El separador entre consecutivo y fecha acepta guion opcional (ej. "0003 - 20260507")
  const patron = /^(\d{1,6})\s*[-–]?\s*(\d{8})\s+(.+)$/;
  const match  = resto.match(patron);

  if (!match) {
    return {
      valido: false,
      prefijoDetectado: true,
      error:  'Formato de asunto inválido. Se esperaba: SOLICITUD REQUERIMIENTO {CONSECUTIVO} {YYYYMMDD} {PROYECTO}',
      raw:    asunto,
    };
  }

  const [, consecutivoRaw, fechaRaw, proyectoRaw] = match;

  // Parsear fecha YYYYMMDD
  const anio = fechaRaw.substring(0, 4);
  const mes  = fechaRaw.substring(4, 6);
  const dia  = fechaRaw.substring(6, 8);
  const fecha = new Date(`${anio}-${mes}-${dia}`);

  if (isNaN(fecha.getTime())) {
    return { valido: false, error: `Fecha inválida en el asunto: ${fechaRaw}`, raw: asunto };
  }

  return {
    valido:       true,
    consecutivo:  consecutivoRaw.padStart(4, '0'),
    fecha,
    fechaTexto:   `${dia}/${mes}/${anio}`,
    proyecto:     proyectoRaw.trim(),
    raw:          asunto,
  };
}

/**
 * Busca el proyecto del catálogo que corresponde al fragmento del asunto.
 *
 * Devuelve el proyecto con un campo `confianza`, porque no todos los aciertos
 * valen lo mismo y el llamador tiene que poder distinguirlos:
 *
 *   'exacta'    el fragmento ES el código. Se puede usar sin más.
 *   'contenido' el fragmento está dentro de un único código del catálogo
 *               ("MISTRAL" → "CT25-134 ANCLAJES MISTRAL"). Confiable.
 *   'ambigua'   está dentro de VARIOS. "EQUIPOS GT" cabe en "EQUIPOS GT 2025"
 *               y en "EQUIPOS GT 2026", y el año decide a qué ejercicio va la
 *               plata. Se informa y NO se elige.
 *   'palabra'   solo comparten una palabra. Así "CT26-034LT ZIPAQUIRA Norte
 *               230KV - JE Jaimes" emparejaba con "CT26-026 Micropilotes RSO -
 *               JE Jaimes": ambos dicen JAIMES. Se informa y NO se elige.
 *
 * Antes esto devolvía el primer acierto de cualquiera de las tres estrategias,
 * sin decir cuál. Da igual mientras nadie use el resultado —y nadie lo usaba,
 * porque el llamador leía un campo que el objeto no tenía— pero al empezar a
 * usarlo, un acierto por 'palabra' cargaría el gasto a la obra equivocada.
 *
 * `candidatos` trae la lista cuando hay más de uno, para poder mostrarla.
 */
function resolverProyecto(fragmento, proyPorCodigo) {
  if (!fragmento) return null;

  const norm = fragmento.trim().toUpperCase();

  // 1. El fragmento es el código.
  if (proyPorCodigo[norm]) return { ...proyPorCodigo[norm], confianza: 'exacta' };

  // 2. El fragmento está contenido en algún código. Solo sirve si es en uno.
  const dentro = Object.entries(proyPorCodigo).filter(([codigo]) => codigo.includes(norm));
  if (dentro.length === 1) return { ...dentro[0][1], confianza: 'contenido' };
  if (dentro.length > 1) {
    return {
      ...dentro[0][1],
      confianza: 'ambigua',
      candidatos: dentro.map(([codigo]) => codigo),
    };
  }

  // 3. Comparten alguna palabra. Nunca alcanza para decidir.
  const porPalabra = Object.entries(proyPorCodigo).filter(([codigo]) => {
    const palabras = codigo.split(/[\s\-]+/).filter(p => p.length > 3);
    return palabras.some(p => norm.includes(p));
  });
  if (porPalabra.length) {
    return {
      ...porPalabra[0][1],
      confianza: 'palabra',
      candidatos: porPalabra.map(([codigo]) => codigo),
    };
  }

  return null;
}

/** ¿El acierto alcanza para tomar el código canónico del catálogo? */
function esConfiable(resuelto) {
  return resuelto?.confianza === 'exacta' || resuelto?.confianza === 'contenido';
}

module.exports = { parsearAsunto, resolverProyecto, esConfiable };
