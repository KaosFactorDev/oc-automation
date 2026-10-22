-- Seed LOCAL de desarrollo (P0-c). Datos ficticios, sin nombres ni NIT reales.
--
-- Un solo proyecto: el «Proyecto Local P0» del seed local de kaos-webapp, con
-- su mismo uuid y código de KAOS, para que la API de RRHH (/api/*) lo encuentre
-- por proyectoKaosId cuando crear-orden-erp local llame a este ERP.
--
-- No lo aplica nada automáticamente: no es supabase/seed.sql (el que leería
-- `supabase db reset`), deploy/aplicar-migraciones.sh solo aplica
-- supabase/migrations/ y db:push no lleva --include-seed. Se aplica a mano,
-- solo contra el Postgres de docker-compose.dev.yml:
--
--   docker exec -i oc-automation-db-dev psql -U postgres -d erp -v ON_ERROR_STOP=1 < supabase/seeds/local-p0.sql
--
-- Es reejecutable, y aborta si la base tiene datos que no son de prueba: otros
-- proyectos, o proveedores con un NIT que no empiece por 0000. Los proveedores
-- ficticios llevan ese prefijo, que no usa ningún NIT real; el POST de prueba de
-- /api/ordenes-servicio registra su IPS como proveedor, así que tiene que
-- usarlo también (por ejemplo 0000000301).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM erp.proyectos
              WHERE kaos_id IS DISTINCT FROM '00000000-0000-4000-a000-000000000101') THEN
    RAISE EXCEPTION 'Seed local: erp.proyectos tiene otros proyectos; no es una base local recién migrada.';
  END IF;
  IF EXISTS (SELECT 1 FROM erp.proveedores WHERE nit NOT LIKE '0000%') THEN
    RAISE EXCEPTION 'Seed local: erp.proveedores tiene NIT que no empiezan por 0000; no son datos de prueba.';
  END IF;
END $$;

-- ── Espejo de KAOS ──────────────────────────────────────────────────────────
INSERT INTO erp.proyectos_kaos
  (kaos_id, project_code, nombre, descripcion, estado, ciudad, departamento, pais, zona, kaos_actualizado)
VALUES
  ('00000000-0000-4000-a000-000000000101', 'KP-XJPQNZ', 'Proyecto Local P0',
   'Proyecto ficticio del seed local', 'Activo', 'Bogotá', 'Cundinamarca', 'Colombia', 'Centro', now())
ON CONFLICT (kaos_id) DO NOTHING;

-- ── Catálogo ────────────────────────────────────────────────────────────────
INSERT INTO erp.proyectos
  (codigo, nombre, ciudad, departamento, zona, activo, kaos_id, kaos_code, origen, notas)
VALUES
  ('LOCAL-P0', 'Proyecto Local P0', 'Bogotá', 'Cundinamarca', 'Centro', true,
   '00000000-0000-4000-a000-000000000101', 'KP-XJPQNZ', 'kaos', 'Seed local P0 (ficticio)')
ON CONFLICT (kaos_id) WHERE kaos_id IS NOT NULL DO NOTHING;

-- ── Tope de aprobación automática de órdenes de servicio de RRHH ────────────
-- La migración 20261009120000 ya lo crea en 500000; se deja explícito.
INSERT INTO erp.configuracion (clave, valor, descripcion)
VALUES ('rrhhTopeAprobacionOS', '500000',
        'Tope en COP (total con IVA) hasta el cual una orden de servicio creada por RRHH vía API entra aprobada. Por encima entra en borrador.')
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;

COMMIT;

SELECT
  (SELECT count(*) FROM erp.proyectos)                                    AS proyectos,
  (SELECT count(*) FROM erp.proyectos_kaos)                               AS espejo_kaos,
  (SELECT codigo FROM erp.proyectos
    WHERE kaos_id = '00000000-0000-4000-a000-000000000101')               AS codigo,
  (SELECT valor FROM erp.configuracion WHERE clave = 'rrhhTopeAprobacionOS') AS tope_os,
  (SELECT count(*) FROM erp.proveedores)                                  AS proveedores;
