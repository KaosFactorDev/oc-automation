-- ═══════════════════════════════════════════════════════════════════════════
-- El NIT se normaliza a su raíz, sin el dígito de verificación
--
-- ── El problema ────────────────────────────────────────────────────────────
-- El mismo proveedor estaba registrado dos veces, una con dígito de
-- verificación y otra sin él, y erp.norm_nit() los trataba como distintos
-- porque conservaba el guion. Nueve pares en los datos actuales:
--
--   901413646    DISTRIBUCIONES TOOLS MED S.A.S.   66 órdenes
--   901413646-9  DISTRIBUCIONES TOOLS MED SAS       3 órdenes
--
-- No es cosmético: consultaProveedor.js sugiere proveedor y precio a partir del
-- historial, y con la historia partida en dos las sugerencias empeoran.
--
-- ── Por qué es seguro quitarlo ─────────────────────────────────────────────
-- El dígito de verificación es un checksum calculado a partir de la raíz: no
-- lleva información propia, y para una raíz dada solo existe un dígito válido.
-- Eso implica que dos NIT no pueden diferir únicamente en él, así que
-- normalizar a la raíz no puede fusionar dos empresas distintas.
--
-- Se verificó además que los nueve pares tienen razón social coincidente
-- (EUROFIL S.A.S / EUROFIL SAS, DRILLTECH SAS / DRILLTECH SAS, …).
--
-- La forma escrita original se conserva en nit_original, así que no se pierde
-- cómo venía el dato.
--
-- ── Qué hace, en orden ─────────────────────────────────────────────────────
--  1. Repunta los documentos del duplicado hacia la raíz.
--  2. Consolida los campos del duplicado en la fila que sobrevive, con
--     COALESCE: si a la que queda le falta el teléfono, lo toma de la otra.
--  3. Borra el duplicado, que a esa altura ya no lo referencia nadie.
--  4. Renombra los 31 NIT con dígito que no tenían duplicado. La llave foránea
--     es ON UPDATE CASCADE, así que sus documentos siguen el cambio solos.
--  5. Recién al final reemplaza erp.norm_nit(). Va último a propósito: el CHECK
--     proveedores_nit_normalizado se evalúa contra la función vigente, y con la
--     nueva puesta antes de limpiar los datos, cualquier UPDATE sobre una fila
--     que todavía tuviera dígito fallaría.
--
-- Todo dentro de la transacción de la migración: o queda completo, o nada.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Repuntar documentos del duplicado hacia la raíz ──────────────────────
-- Solo cuando la raíz ya existe como proveedor. Si no existe, el paso 4 se
-- encarga renombrando, y las referencias van solas por el CASCADE.

UPDATE erp.ordenes_compra o
   SET proveedor_nit = split_part(o.proveedor_nit, '-', 1)
 WHERE o.proveedor_nit LIKE '%-%'
   AND EXISTS (SELECT 1 FROM erp.proveedores p
                WHERE p.nit = split_part(o.proveedor_nit, '-', 1));

UPDATE erp.ordenes_servicio s
   SET proveedor_nit = split_part(s.proveedor_nit, '-', 1)
 WHERE s.proveedor_nit LIKE '%-%'
   AND EXISTS (SELECT 1 FROM erp.proveedores p
                WHERE p.nit = split_part(s.proveedor_nit, '-', 1));

UPDATE erp.historial_precios h
   SET proveedor_nit = split_part(h.proveedor_nit, '-', 1)
 WHERE h.proveedor_nit LIKE '%-%'
   AND EXISTS (SELECT 1 FROM erp.proveedores p
                WHERE p.nit = split_part(h.proveedor_nit, '-', 1));

-- ── 2. Consolidar los campos del duplicado en la fila que sobrevive ─────────
-- Gana el valor de la raíz cuando lo tiene; si está vacío, se toma el del
-- duplicado. Así ningún dato del que se elimina se pierde.

UPDATE erp.proveedores dst SET
  razon_social      = COALESCE(nullif(dst.razon_social, ''), src.razon_social),
  nombre_comercial  = COALESCE(dst.nombre_comercial, src.nombre_comercial),
  regimen           = COALESCE(dst.regimen,          src.regimen),
  municipio         = COALESCE(dst.municipio,        src.municipio),
  direccion         = COALESCE(dst.direccion,        src.direccion),
  telefono          = COALESCE(dst.telefono,         src.telefono),
  correo            = COALESCE(dst.correo,           src.correo),
  zona              = COALESCE(dst.zona,             src.zona),
  banco             = COALESCE(dst.banco,            src.banco),
  tipo_cuenta       = COALESCE(dst.tipo_cuenta,      src.tipo_cuenta),
  cuenta_bancaria   = COALESCE(dst.cuenta_bancaria,  src.cuenta_bancaria),
  -- Se conserva la forma más completa, que es la que traía el dígito.
  nit_original      = COALESCE(src.nit_original, dst.nit_original),
  sp_id             = COALESCE(dst.sp_id, src.sp_id),
  -- Si cualquiera de las dos estaba activa, la fusionada queda activa.
  activo            = dst.activo OR src.activo,
  -- La revisión pendiente era justamente este duplicado.
  requiere_revision = false
 FROM erp.proveedores src
WHERE src.nit LIKE dst.nit || '-%'
  AND dst.nit NOT LIKE '%-%';

-- ── 3. Borrar los duplicados, ya sin referencias ────────────────────────────
-- Las llaves foráneas son ON DELETE RESTRICT: si algo hubiera quedado
-- apuntando al duplicado, este DELETE falla y la migración se revierte entera.
-- Eso es deliberado — preferimos que falle a que borre en silencio.

DELETE FROM erp.proveedores src
 WHERE src.nit LIKE '%-%'
   AND EXISTS (SELECT 1 FROM erp.proveedores dst
                WHERE dst.nit = split_part(src.nit, '-', 1));

-- ── 4. Renombrar los que no tenían duplicado ────────────────────────────────
-- ON UPDATE CASCADE arrastra las referencias de órdenes e historial.

UPDATE erp.proveedores
   SET nit = split_part(nit, '-', 1)
 WHERE nit LIKE '%-%';

-- ── 5. La función, al final ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION erp.norm_nit(txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT nullif(
           split_part(
             regexp_replace(
               regexp_replace(coalesce(txt, ''), '\.0+$', ''),
               '[^0-9A-Za-z-]', '', 'g'
             ),
             '-', 1
           ),
           ''
         );
$$;

COMMENT ON FUNCTION erp.norm_nit(text) IS
  'Normaliza un NIT a su raíz: quita puntos, comas, espacios, el sufijo ".0" que deja Excel y el dígito de verificación. El dígito es un checksum de la raíz, así que no distingue empresas.';

-- ── Comprobación ────────────────────────────────────────────────────────────
-- Si algo quedó a medias, la migración falla acá y revierte.

DO $$
DECLARE
  v_con_guion int;
  v_documentos int;
BEGIN
  SELECT count(*) INTO v_con_guion FROM erp.proveedores WHERE nit LIKE '%-%';
  IF v_con_guion > 0 THEN
    RAISE EXCEPTION 'Quedaron % proveedores con dígito de verificación', v_con_guion;
  END IF;

  SELECT count(*) INTO v_documentos
    FROM (
      SELECT proveedor_nit FROM erp.ordenes_compra
      UNION ALL SELECT proveedor_nit FROM erp.ordenes_servicio
      UNION ALL SELECT proveedor_nit FROM erp.historial_precios
    ) t
   WHERE proveedor_nit LIKE '%-%';
  IF v_documentos > 0 THEN
    RAISE EXCEPTION 'Quedaron % documentos apuntando a un NIT con dígito', v_documentos;
  END IF;

  RAISE NOTICE 'NIT normalizados a su raíz; no quedan duplicados por dígito de verificación.';
END
$$;
