'use strict';
/**
 * modoPrueba.js — Corta las escrituras que salen del equipo.
 *
 * El problema que resuelve: la base es local, pero SharePoint, el buzón y
 * tesorería son los de producción. Aprobar una OC en desarrollo solo toca
 * Postgres —eso es seguro— pero generar su PDF lo sube al Drive real, exportar
 * Control de Costos sobrescribe el libro real, y revisar el buzón responde
 * correos de verdad. Probar el flujo completo sin esto significa ensuciar
 * producción.
 *
 * Con MODO_PRUEBA=1:
 *   · Los PDF y libros se guardan en ./temp/prueba/ en vez de subirse. Quedan
 *     donde se pueden abrir y revisar, que para probar sirve más que el Drive.
 *   · Los correos no se envían; se registra a quién habrían ido.
 *   · Las solicitudes a tesorería se rechazan.
 *
 * Las LECTURAS siguen saliendo: leer el catálogo de SharePoint o un correo no
 * cambia nada de nadie. Lo que se corta es lo que deja rastro.
 *
 * El valor por defecto es apagado, porque un despliegue que no envía correos en
 * silencio sería peor que el problema. Para que el olvido no cueste, avisar() se
 * queja fuerte cuando la combinación es la peligrosa: base local con
 * escrituras externas vivas.
 */

const fs   = require('fs');
const path = require('path');

const activo = /^(1|true|si|sí|on)$/i.test(String(process.env.MODO_PRUEBA || '').trim());

const DIR = path.join(__dirname, '../temp/prueba');

/** Guarda lo que se habría subido, y devuelve la forma que espera el llamador. */
function guardarEnDisco(rutaRelativa, buffer) {
  const limpio = String(rutaRelativa).replace(/^\/+/, '');
  const destino = path.join(DIR, limpio);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buffer);
  console.log(`[MODO_PRUEBA] no se subió a SharePoint → ${destino}`);
  // Los llamadores solo leen webUrl y la guardan en pdf_url / adjuntoUrl. Se
  // marca como prueba para que una fila con esta URL se reconozca de inmediato.
  return {
    id:     'modo-prueba',
    name:   path.basename(destino),
    webUrl: 'prueba-local://' + limpio,
    local:  destino,
  };
}

/**
 * Aviso al arrancar. Distingue los dos casos que importan y no dice nada en el
 * caso normal de producción.
 */
function avisar() {
  const host  = process.env.ERP_DB_HOST || 'localhost';
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host);

  if (activo) {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │  MODO_PRUEBA activo                                     │');
    console.log('  │  Los PDF van a ./temp/prueba/ y no al Drive.            │');
    console.log('  │  No se envían correos ni solicitudes de tesorería.      │');
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('');
    return;
  }

  if (local) {
    console.log('');
    console.log('  ⚠  Base de datos LOCAL con escrituras externas VIVAS.');
    console.log('     Generar un PDF lo sube al Drive real. Exportar Control de');
    console.log('     Costos sobrescribe el libro real. El botón del buzón');
    console.log('     responde correos reales.');
    console.log('     Para probar sin tocar producción:  MODO_PRUEBA=1 en .env');
    console.log('');
  }
}

module.exports = { activo, guardarEnDisco, avisar, DIR };
