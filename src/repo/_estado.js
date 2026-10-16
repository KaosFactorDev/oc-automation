'use strict';
/**
 * _estado.js — El error de «esta acción no corresponde al estado del documento».
 *
 * Las reglas de qué se puede hacer en cada estado vivían solo en la consola, que
 * esconde los botones. Por HTTP se podía pagar un borrador, anular una orden
 * finalizada o aprobar dos veces. Ahora el servidor las comprueba y responde 409
 * con este error; la consola sigue escondiendo los botones, pero ya no es la única
 * defensa.
 */

class EstadoInvalido extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

module.exports = { EstadoInvalido };
