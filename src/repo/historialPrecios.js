'use strict';
/**
 * repo/historialPrecios.js — Historial transaccional de precios pagados.
 *
 * Es lo que alimenta el Buscador de Precios y la sugerencia de proveedor de
 * consultaProveedor.js. El último documento en bajar a Postgres.
 *
 * ── Sobre la fecha ─────────────────────────────────────────────────────────
 * En SharePoint era una columna de TEXTO con cuatro formatos conviviendo
 * ("junio 23, 2026", "23 de junio de 2026", "2026-06-23", "23/04/2026"). El
 * esquema guarda las dos versiones: `fecha` como date y `fecha_texto` con el
 * original. Acá se devuelve la fecha en ISO cuando se pudo interpretar, y el
 * texto crudo si no — parseDate() en consultaProveedor.js maneja las dos.
 *
 * Eso también arregla el ordenamiento: ordenar por una columna de texto ponía
 * "23 de junio" antes que "3 de julio", y el criterio de "las 3 compras más
 * recientes" quedaba mal.
 *
 * ── Sobre los nombres de campo ─────────────────────────────────────────────
 * normalizarHistorialSP() acepta tanto los nombres de SharePoint
 * (nitProveedor, precioUnitario, numeroCompra) como los del caché SQLite
 * (nit, precio, documento). Se devuelven los del caché, que es lo que recibía.
 */

const pg = require('../pg');
const { fk } = require('./_valores');

const CAMPOS = `
  h.id, h.insumo, h.cantidad, h.precio_unitario, h.valor_total,
  h.fecha, h.fecha_texto, h.numero_compra, h.tipo_compra,
  h.proveedor_nit, h.proveedor_nombre, h.estado_compra, h.forma_pago,
  h.anticipo, h.zona, h.sp_id,
  p.codigo AS proyecto`;

const DESDE = `FROM erp.historial_precios h
  LEFT JOIN erp.proyectos p ON p.id = h.proyecto_id`;

function mapear(h) {
  return {
    sp_id:      h.sp_id,
    id:         String(h.id),
    insumo:     h.insumo,
    // La consola y consultaProveedor.js normalizan por su cuenta; se expone
    // por compatibilidad con la forma que devolvía el caché.
    insumoNorm: h.insumo_norm ?? undefined,
    proveedor:  h.proveedor_nombre || '',
    nit:        h.proveedor_nit || '',
    precio:     Number(h.precio_unitario),
    cantidad:   Number(h.cantidad),
    valorTotal: Number(h.valor_total),
    // ISO si se pudo interpretar; el texto original si no.
    fecha:      h.fecha ? h.fecha.toISOString().slice(0, 10) : (h.fecha_texto || ''),
    fechaTexto: h.fecha_texto || '',
    zona:       h.zona || '',
    proyecto:   h.proyecto || '',
    documento:  h.numero_compra || '',
    tipoCompra: h.tipo_compra || '',
    estadoCompra: h.estado_compra || '',
    formaPago:  h.forma_pago || '',
    anticipo:   Number(h.anticipo),
    unidad:     '',   // no existe como columna; se mantiene por compatibilidad
  };
}

/**
 * Todo el historial, de la compra más reciente a la más antigua. Las filas sin
 * fecha interpretable van al final: no pueden competir por "más reciente".
 */
async function listar({ insumo = null, proveedorNit = null, limite = null } = {}) {
  const cond = [];
  const vals = [];
  if (insumo)       { vals.push(insumo);       cond.push(`erp.norm(h.insumo) = erp.norm($${vals.length})`); }
  if (proveedorNit) { vals.push(proveedorNit); cond.push(`h.proveedor_nit = erp.norm_nit($${vals.length})`); }

  let sql = `SELECT ${CAMPOS} ${DESDE}
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY h.fecha DESC NULLS LAST, h.id DESC`;
  if (limite) { vals.push(limite); sql += ` LIMIT $${vals.length}`; }

  return (await pg.rows(sql, vals)).map(mapear);
}

/**
 * Alta de filas al confirmar una cotización. Todas en una transacción: antes
 * era una llamada a Graph por fila, y un fallo a la mitad dejaba la cotización
 * parcialmente registrada.
 */
async function agregar(filas) {
  if (!filas.length) return 0;

  return pg.tx(async (c) => {
    let guardadas = 0;
    for (const f of filas) {
      const insumo = String(f.insumo || '').trim();
      if (!insumo) continue;

      const proyectoId = await resolverProyecto(c, f.proyecto);
      const nit        = await resolverProveedor(c, f.nitProveedor ?? f.nit, f.nombreProveedor ?? f.proveedor);

      const precio = Number(f.precioUnitario ?? f.precio) || 0;
      const cant   = Number(f.cantidad) || 0;
      const texto  = String(f.fecha || '').trim() || null;

      await c.query(
        `INSERT INTO erp.historial_precios
           (proyecto_id, numero_compra, tipo_compra, insumo, cantidad,
            precio_unitario, valor_total, fecha, fecha_texto,
            proveedor_nit, proveedor_nombre, estado_compra, forma_pago, anticipo, zona)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          proyectoId,
          f.numeroCompra ?? f.documento ?? null,
          f.tipoCompra ?? null,
          insumo.toUpperCase(), cant, precio,
          f.valorTotal !== undefined ? Number(f.valorTotal) : precio * cant,
          // Si la fecha ya viene en ISO se guarda tipada; si no, queda solo el
          // texto y una corrida posterior puede interpretarla.
          /^\d{4}-\d{2}-\d{2}/.test(texto || '') ? texto.slice(0, 10) : null,
          texto,
          nit, f.nombreProveedor ?? f.proveedor ?? null,
          f.estadoCompra ?? null, f.formaPago ?? null,
          Number(f.anticipo) || 0,
          fk(f.zona),   // la caja la resuelve erp.zona_canonica() en el SQL
        ]);
      guardadas++;
    }
    return guardadas;
  });
}

async function resolverProyecto(c, texto) {
  const s = String(texto || '').trim();
  if (!s) return null;
  const hallado = await c.query(
    'SELECT id FROM erp.proyectos WHERE erp.norm(codigo) = erp.norm($1)', [s]);
  if (hallado.rowCount) return hallado.rows[0].id;
  const creado = await c.query(
    `INSERT INTO erp.proyectos (codigo, nombre, activo, requiere_revision)
     VALUES ($1, $1, false, true) RETURNING id`, [s]);
  return creado.rows[0].id;
}

async function resolverProveedor(c, nit, nombre) {
  const s = String(nit || '').trim();
  if (!s) return null;
  const clave = (await c.query('SELECT erp.norm_nit($1) AS n', [s])).rows[0].n;
  if (!clave) return null;
  const hallado = await c.query('SELECT nit FROM erp.proveedores WHERE nit = $1', [clave]);
  if (hallado.rowCount) return clave;
  await c.query(
    `INSERT INTO erp.proveedores (nit, nit_original, razon_social, activo, requiere_revision)
     VALUES ($1, $2, $3, false, true) ON CONFLICT (nit) DO NOTHING`,
    [clave, s, String(nombre || '').trim() || '(sin nombre)']);
  return clave;
}

module.exports = { listar, agregar };
