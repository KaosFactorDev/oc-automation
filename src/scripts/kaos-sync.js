'use strict';
/**
 * kaos-sync.js — Trae los proyectos de KAOS al espejo local, y mide la brecha.
 *
 *   npm run kaos:sync              incremental: solo lo modificado desde la última vez
 *   npm run kaos:sync -- --todo    reconciliación completa (detecta bajas)
 *   npm run kaos:diff              solo el informe, sin traer nada
 *
 * NO CAMBIA NADA del catálogo. Llena `erp.proyectos_kaos` y muestra en qué se
 * diferencian los dos sistemas. Es el paso que convierte las estimaciones en
 * datos antes de decidir cómo unirlos.
 *
 * Por qué existe la reconciliación completa: la API no emite borrados. Un
 * proyecto borrado en KAOS simplemente deja de aparecer, así que el incremental
 * nunca se entera. Con `--todo` se refresca `visto_en` de todo lo que sigue
 * vivo, y lo que quede con una marca vieja es lo que se fue.
 */

require('dotenv').config();

const kaos = require('../kaosClient');
const repo = require('../repo/proyectosKaos');
const pg   = require('../pg');

// Se traen TODOS los proyectos, activos e inactivos.
//
// El ERP no esconde los inactivos: los muestra en /proyectos/admin, la
// resolución del correo los consulta a propósito —un correo que nombra una obra
// terminada tiene que poder reconocerla— y los documentos históricos apuntan a
// ellos. Lo que filtra por activo es la LECTURA, en
// getProyectos({ soloActivos: true }), que es lo que alimenta los selectores de
// creación de requerimientos y órdenes.
//
// Filtrar acá ponía la regla en la capa equivocada y además rompía dos cosas:
// un proyecto que pasara a inactivo en KAOS dejaba de llegar y el espejo se
// quedaba con la copia vieja diciendo que seguía activo, y la reconciliación
// completa no podía distinguir un borrado de un cambio de estado.
//
// El `estado` de KAOS se traduce a `activo` al copiar al catálogo, no al
// recibir.

const TODO = process.argv.includes('--todo');
const SOLO_INFORME = process.argv.includes('--solo-informe');

const n = (x) => String(x).padStart(3);

function seccion(titulo) {
  console.log(`\n${titulo}\n${'─'.repeat(titulo.length)}`);
}

async function informe() {
  const d = await repo.discrepancias();

  seccion('Resumen');
  console.log(`  ${n(d.ligados.length)}  ya ligados por kaos_id`);
  console.log(`  ${n(d.porNombre.length)}  coinciden por nombre exacto — candidatos a ligar`);
  console.log(`  ${n(d.soloKaos.length)}  solo en KAOS — el espejo los traería como nuevos`);
  console.log(`  ${n(d.soloErp.length)}  solo en el ERP — hay que decidir uno por uno`);

  if (d.sinZona) {
    console.log(`\n  Zona: ${d.sinZona.sin} de ${d.sinZona.total} proyectos de KAOS llegan sin zona.`);
    if (Number(d.sinZona.sin) > 0) {
      console.log('  Sin zona, la sugerencia de proveedor cae a historial nacional.');
      console.log('  Se arregla poniéndoles la ubicación en KAOS, no acá.');
    }
  }

  if (d.porNombre.length) {
    seccion('Coinciden por nombre exacto');
    for (const r of d.porNombre) {
      console.log(`  ${r.project_code}  ${r.codigo}${r.zona ? `  [${r.zona}]` : '  [sin zona]'}`);
    }
  }

  if (d.soloKaos.length) {
    seccion('Solo en KAOS');
    for (const r of d.soloKaos) {
      console.log(`  ${r.project_code}  ${r.nombre}  (${r.estado || 'sin estado'})`);
    }
  }

  if (d.soloErp.length) {
    seccion('Solo en el ERP — con cuántos documentos los usan');
    for (const r of d.soloErp) {
      const marca = r.origen === 'huerfano' ? '⚠ huérfano' : r.origen;
      console.log(`  ${n(r.documentos)} doc  ${r.codigo}  (${marca}${r.activo ? '' : ', inactivo'})`);
    }
    console.log('\n  Los de muchos documentos suelen ser centros de costo reales, no errores:');
    console.log('  no van a KAOS y se quedan como origen=local.');
  }

  return d;
}

(async () => {
  try {
    if (!SOLO_INFORME) {
      if (!kaos.habilitado()) {
        console.error('Falta KAOS_API_URL o KAOS_API_KEY en el .env.');
        process.exit(1);
      }

      const desde = TODO ? null : await repo.marcaGuardada();
      console.log(TODO
        ? 'Reconciliación completa: trayendo el catálogo entero.'
        : `Incremental desde ${desde || 'el principio (primera corrida)'}.`);

      const proyectos = await kaos.listarProyectos({ desde });
      const guardados = await repo.volcar(proyectos);

      // La marca se mueve solo con lo que realmente llegó. Si la corrida no
      // trajo nada, dejarla igual es correcto: la siguiente vuelve a preguntar
      // desde el mismo punto.
      const marca = proyectos.reduce(
        (max, p) => (!max || p.updated_at > max ? p.updated_at : max), null);
      await repo.guardarMarca(marca, `${guardados} proyectos`);

      console.log(`Traídos ${guardados} proyectos.`);

      if (TODO) {
        const idos = await pg.rows(
          `SELECT project_code, nombre FROM erp.proyectos_kaos
            WHERE visto_en < now() - interval '1 minute' ORDER BY nombre`);
        if (idos.length) {
          seccion('Ya no están en KAOS');
          for (const r of idos) console.log(`  ${r.project_code}  ${r.nombre}`);
          console.log('\n  Se borraron: la API no lista los borrados, y los inactivos sí llegan.');
          console.log('  No se tocan acá; el espejo no decide bajas.');
        }
      }
    }

    await informe();
    console.log('\nNada del catálogo fue modificado.');
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pg.cerrar();
  }
})();
