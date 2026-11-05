'use strict';
/**
 * eslint.config.js — Linter del repositorio (npm run lint).
 *
 * Reglas recomendadas de ESLint, sin estilo: el formato sigue siendo el que ya
 * está escrito (ver CONTRIBUTING.md, «Estilo de código»).
 *
 * Cuando se creó el chequeo de los PR, el código ya tenía 125 avisos (bloques
 * vacíos, variables y asignaciones sin usar, escapes de más en regex, errores
 * relanzados sin `cause` y un return seguido de código). Arreglarlos tocaba 20
 * archivos de producción sin pruebas que los cubrieran, así que quedaron
 * congelados en eslint-suppressions.json: ESLint
 * los tolera y falla con cualquier error nuevo. Si arreglas uno de esos,
 * ESLint también falla hasta que bajes la lista con
 *   npx eslint . --prune-suppressions
 * No agregues errores nuevos a la lista: arréglalos.
 */

const js      = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Carpetas que no son código del repo (están en .gitignore), por si existen
  // en el equipo de quien corre el linter.
  { ignores: ['temp/', 'data/', 'logs/', 'respaldos/', '_archivo/', 'graphify-out/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType:  'commonjs',
      globals:     globals.node,
    },
  },
];
