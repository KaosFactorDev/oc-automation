-- erp.zona_canonica(): resuelve el nombre de una zona sin importar la caja.
--
-- El bug que arregla: la ruta POST /proveedores pasaba la zona por un
-- normalize() que la pone en MAYÚSCULAS, pensado para la razón social y el
-- municipio. Pero erp.zonas guarda "Centro", "Caribe", "Occidente"…, así que
-- "Centro" llegaba como "CENTRO" y dejaba de existir:
--
--   ERROR:  ... violates foreign key constraint "proveedores_zona_fkey"
--   DETAIL: Key (zona)=(CENTRO) is not present in table "zonas".
--
-- El mensaje señala la llave foránea, no la caja, así que parecía que faltara
-- una zona en el catálogo. Inscribir un proveedor era imposible: en blanco
-- fallaba por la cadena vacía y con zona elegida fallaba por las mayúsculas.
--
-- Se arregla acá y no solo en la ruta porque la caja del texto no es asunto de
-- quien llama: "CENTRO", "centro" y "Centro" son la misma zona, y cualquier
-- pantalla nueva volvería a tropezar con lo mismo.
--
-- Lo que NO hace: inventar zonas. Si el valor no corresponde a ninguna, se
-- devuelve tal cual para que la llave foránea lo rechace nombrándolo. Convertir
-- lo desconocido en NULL escondería un dato mal escrito, que es peor que el
-- error.

CREATE OR REPLACE FUNCTION erp.zona_canonica(p_zona text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    -- Vacío o en blanco significa "sin asignar", y la columna admite NULL.
    WHEN p_zona IS NULL OR btrim(p_zona) = '' THEN NULL
    ELSE COALESCE(
      (SELECT z.zona FROM erp.zonas z WHERE upper(z.zona) = upper(btrim(p_zona))),
      btrim(p_zona)   -- sin coincidencia: que falle la FK, con el valor a la vista
    )
  END;
$$;

COMMENT ON FUNCTION erp.zona_canonica(text) IS
  'Devuelve el nombre de la zona tal como está en erp.zonas, comparando sin '
  'distinguir mayúsculas. NULL si viene vacío. Si no coincide con ninguna, '
  'devuelve el valor recibido para que la llave foránea lo rechace.';

-- Deja consistentes las filas que ya tuvieran la caja equivocada. Hoy no hay
-- ninguna —la FK lo impedía— pero el import y futuras cargas pasan por acá.
UPDATE erp.proveedores SET zona = erp.zona_canonica(zona)
 WHERE zona IS NOT NULL AND zona <> erp.zona_canonica(zona);

UPDATE erp.proyectos SET zona = erp.zona_canonica(zona)
 WHERE zona IS NOT NULL AND zona <> erp.zona_canonica(zona);

UPDATE erp.historial_precios SET zona = erp.zona_canonica(zona)
 WHERE zona IS NOT NULL AND zona <> erp.zona_canonica(zona);

GRANT EXECUTE ON FUNCTION erp.zona_canonica(text) TO erp_app;
