-- Acepta como proveedores propios los 5 que el import marcó para revisión.
--
-- Decisión de negocio, la misma que se tomó con los proyectos: no se unifican.
-- Si dos filas tienen NIT distinto, se tratan como proveedores distintos.
--
-- ── Qué NO cambia ──────────────────────────────────────────────────────────
-- erp.norm_nit() sigue fusionando cuando el NIT es el MISMO número escrito de
-- dos formas:
--
--   901413646-9   →  901413646    se fusiona: el guion prueba que el 9 es el
--   901.413.646-9 →  901413646    dígito de verificación del mismo NIT
--
-- Y sigue NO fusionando cuando los números son distintos de verdad:
--
--   105591903     →  105591903    dos proveedores, aunque sea la misma persona
--   1055919031    →  1055919031   en el registro de la empresa
--
-- Esa pareja es genuinamente ambigua: un NIT de 9 dígitos más su verificador da
-- 10, pero una cédula de 10 dígitos también, y sin el guion no hay forma de
-- distinguirlas. Recortar el último dígito a todo número de 10 sería adivinar —
-- ya se intentó en el verificador de la migración y reportaba como ausentes dos
-- proveedores que estaban.
--
-- ── Por qué estaban marcados ───────────────────────────────────────────────
-- El import los creó porque un documento los nombraba y no estaban en el
-- catálogo de SharePoint. Ninguno tiene órdenes de compra; los que tienen
-- historial de precios lo tienen por cotizaciones cargadas a mano.
--
-- ── Sobre el orden ─────────────────────────────────────────────────────────
-- Esta migración corrige DATOS, así que en un entorno nuevo —donde las
-- migraciones corren antes del import— no hará nada. Es el mismo caso que
-- 20260901160000 y está documentado en 20260904120000. Hoy no importa: un
-- entorno nuevo se llena con "npm run db:clonar", que copia de producción con
-- la marca ya quitada. El único camino que la resucitaría es db:importar contra
-- SharePoint, que quedó retirado con el corte.

BEGIN;

CREATE TEMP TABLE _aceptados (nit text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO _aceptados (nit) VALUES
    ('901393376'),   -- CORDLESS S.A.S.
    ('105591903'),   -- Cristian Camilo Tejada Bello
    ('911201116'),   -- LENE (TIANJIN) I...
    ('830001445'),   -- AGROINSUMOS ALFA SAS
    ('901564110');   -- COLPREVENCIÓN

UPDATE erp.proveedores p
   SET requiere_revision = false,
       updated_at        = now()
  FROM _aceptados a
 WHERE p.nit = erp.norm_nit(a.nit)
   AND p.requiere_revision;

DO $$
DECLARE
  pendientes int;
BEGIN
  SELECT count(*) INTO pendientes FROM erp.proveedores WHERE requiere_revision;
  IF pendientes > 0 THEN
    RAISE NOTICE 'Quedan % proveedor(es) marcados: son posteriores a esta decisión.', pendientes;
  ELSE
    RAISE NOTICE 'Sin proveedores pendientes de revisión.';
  END IF;
END $$;

COMMIT;
