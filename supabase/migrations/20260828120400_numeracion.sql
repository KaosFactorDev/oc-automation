-- ═══════════════════════════════════════════════════════════════════════════
-- 005 — Numeración de documentos
--
-- Los consecutivos viven en los datos de las listas migradas (numeroOC,
-- numeroOS, numero de remisión, documentoRef del almacén), así que emitirlos
-- es parte de esta migración: sin esto, las tablas de documentos e inventario quedan sin
-- forma de asignar el siguiente número.
--
-- ── Por qué una tabla y no una sequence ────────────────────────────────────
-- nextval() no es transaccional: si la transacción que pidió el número falla,
-- el número queda consumido y el consecutivo salta. Para una OC eso no es
-- aceptable — es un documento con efectos contables y el consecutivo debe ser
-- continuo. Con una tabla y UPDATE ... RETURNING, la fila queda bloqueada
-- hasta el commit: dos aprobaciones simultáneas se serializan y, si una falla,
-- su número se devuelve.
--
-- ── El bug que esto arregla ────────────────────────────────────────────────
-- contador.js calcula el siguiente número como MAX(numeroOC) considerando solo
-- los estados que "consumen número" (aprobada, pagada, entregada, finalizada)
-- y excluyendo las anuladas. Cuando la orden con el número más alto se anula,
-- la siguiente reutiliza ese número.
--
-- No es teórico: en los datos actuales hay 11 números de OC y 5 de OS
-- repetidos, todos con la misma forma (una anulada y su reemplazo con el mismo
-- número). Acá el contador nunca retrocede, y anular no libera un número.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE erp.contadores (
  clave      text        PRIMARY KEY,
  valor      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contadores_valor_no_negativo CHECK (valor >= 0)
);

COMMENT ON TABLE erp.contadores IS
  'Contadores atómicos de documentos. El valor es el último número emitido; nunca decrece, ni al anular un documento.';

INSERT INTO erp.contadores (clave, valor) VALUES
  ('orden_compra',   0),
  ('orden_servicio', 0),
  ('remision',       0),
  ('almacen_EA',     0),
  ('almacen_SA',     0)
ON CONFLICT (clave) DO NOTHING;

-- ── Emisión ────────────────────────────────────────────────────────────────
-- Incrementa y devuelve, todo dentro de la transacción del llamador.

CREATE OR REPLACE FUNCTION erp.siguiente_valor(p_clave text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_nuevo bigint;
BEGIN
  UPDATE erp.contadores
     SET valor = valor + 1,
         updated_at = now()
   WHERE clave = p_clave
  RETURNING valor INTO v_nuevo;

  IF v_nuevo IS NULL THEN
    RAISE EXCEPTION 'Contador "%" no existe en erp.contadores', p_clave
      USING HINT = 'Agrégalo con INSERT INTO erp.contadores (clave, valor) VALUES (..., 0)';
  END IF;

  RETURN v_nuevo;
END;
$$;

-- El prefijo y el relleno los sigue poniendo la aplicación (OC_PREFIX / OC_PAD
-- y OS_PREFIX / OS_PAD en el .env), igual que hoy en contador.js. Estas
-- funciones devuelven el entero, no el texto formateado, para no duplicar esa
-- configuración en la base.

CREATE OR REPLACE FUNCTION erp.siguiente_numero_oc()
RETURNS bigint LANGUAGE sql AS $$ SELECT erp.siguiente_valor('orden_compra'); $$;

CREATE OR REPLACE FUNCTION erp.siguiente_numero_os()
RETURNS bigint LANGUAGE sql AS $$ SELECT erp.siguiente_valor('orden_servicio'); $$;

-- El número de remisión lo calculaba crearRemisionYGuardar() como
-- (cantidad de remisiones existentes + 1). Con eso, borrar una remisión hace
-- que la siguiente repita un número, y dos remisiones creadas en el mismo
-- segundo obtienen el mismo. Las dos cosas ya pasaron: REM-00011 existe dos
-- veces, con un segundo de diferencia entre ambas.
CREATE OR REPLACE FUNCTION erp.siguiente_numero_remision()
RETURNS text LANGUAGE sql AS $$
  SELECT 'REM-' || lpad(erp.siguiente_valor('remision')::text, 5, '0');
$$;

-- Consecutivo del almacén: EA-#### para entradas, SA-#### para salidas.
CREATE OR REPLACE FUNCTION erp.siguiente_documento_almacen(p_tipo text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefijo text;
BEGIN
  v_prefijo := CASE p_tipo
                 WHEN 'entrada' THEN 'EA'
                 WHEN 'salida'  THEN 'SA'
               END;
  IF v_prefijo IS NULL THEN
    RAISE EXCEPTION 'Tipo de movimiento inválido: "%". Se espera "entrada" o "salida".', p_tipo;
  END IF;

  RETURN v_prefijo || '-' ||
         lpad(erp.siguiente_valor('almacen_' || v_prefijo)::text, 4, '0');
END;
$$;

-- ── Sincronización con los datos importados ────────────────────────────────
-- Se ejecuta UNA VEZ después del import, para que el primer documento nuevo
-- continúe la serie en vez de empezar en 1.
--
-- Toma el máximo sobre TODOS los números existentes, incluidos los de
-- documentos anulados. Ahí está la diferencia con contador.js: un número que
-- ya se usó no vuelve a emitirse aunque el documento se haya anulado.

-- Las columnas de salida se llaman "contador" y "ultimo_numero", no "clave" y
-- "valor": en plpgsql los nombres de RETURNS TABLE se vuelven variables y
-- colisionarían con las columnas de erp.contadores dentro del cuerpo.
CREATE OR REPLACE FUNCTION erp.sincronizar_contadores()
RETURNS TABLE (contador text, ultimo_numero bigint)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Se extraen los dígitos finales del número, igual que extraerNumero() en
  -- contador.js, para tolerar prefijos ('OC-0042', 'OS-0130', '0042').
  UPDATE erp.contadores c SET valor = GREATEST(c.valor, sub.maximo), updated_at = now()
    FROM (
      SELECT coalesce(max((regexp_match(numero_oc, '(\d+)\s*$'))[1]::bigint), 0) AS maximo
        FROM erp.ordenes_compra
       WHERE numero_oc IS NOT NULL
    ) sub
   WHERE c.clave = 'orden_compra';

  UPDATE erp.contadores c SET valor = GREATEST(c.valor, sub.maximo), updated_at = now()
    FROM (
      SELECT coalesce(max((regexp_match(numero_os, '(\d+)\s*$'))[1]::bigint), 0) AS maximo
        FROM erp.ordenes_servicio
       WHERE numero_os IS NOT NULL
    ) sub
   WHERE c.clave = 'orden_servicio';

  UPDATE erp.contadores c SET valor = GREATEST(c.valor, sub.maximo), updated_at = now()
    FROM (
      SELECT coalesce(max((regexp_match(numero, '(\d+)\s*$'))[1]::bigint), 0) AS maximo
        FROM erp.remisiones
    ) sub
   WHERE c.clave = 'remision';

  UPDATE erp.contadores c SET valor = GREATEST(c.valor, sub.maximo), updated_at = now()
    FROM (
      SELECT coalesce(max((regexp_match(documento_ref, '(\d+)\s*$'))[1]::bigint), 0) AS maximo
        FROM erp.movimientos_inventario
       WHERE documento_ref LIKE 'EA-%'
    ) sub
   WHERE c.clave = 'almacen_EA';

  UPDATE erp.contadores c SET valor = GREATEST(c.valor, sub.maximo), updated_at = now()
    FROM (
      SELECT coalesce(max((regexp_match(documento_ref, '(\d+)\s*$'))[1]::bigint), 0) AS maximo
        FROM erp.movimientos_inventario
       WHERE documento_ref LIKE 'SA-%'
    ) sub
   WHERE c.clave = 'almacen_SA';

  RETURN QUERY SELECT c.clave, c.valor FROM erp.contadores c ORDER BY c.clave;
END;
$$;

-- ── Verificación de unicidad antes de confiar en los contadores ─────────────
-- Lista los números de documento que aparecen más de una vez. Con las tablas
-- de documentos ya creadas esto no debería devolver nada: los índices únicos lo
-- impiden. Sirve para revisar los datos ANTES de importarlos, corriendo la
-- misma consulta contra una carga de prueba.

CREATE OR REPLACE VIEW erp.vw_numeros_duplicados AS
  SELECT 'orden_compra'   AS documento, numero_oc AS numero, count(*) AS veces
    FROM erp.ordenes_compra WHERE numero_oc IS NOT NULL
   GROUP BY numero_oc HAVING count(*) > 1
  UNION ALL
  SELECT 'orden_servicio' AS documento, numero_os AS numero, count(*) AS veces
    FROM erp.ordenes_servicio WHERE numero_os IS NOT NULL
   GROUP BY numero_os HAVING count(*) > 1
  UNION ALL
  SELECT 'remision'       AS documento, numero    AS numero, count(*) AS veces
    FROM erp.remisiones
   GROUP BY numero HAVING count(*) > 1;

COMMENT ON FUNCTION erp.sincronizar_contadores() IS
  'Deja cada contador en el número más alto ya emitido, incluyendo documentos anulados. Ejecutar una vez después del import inicial.';
