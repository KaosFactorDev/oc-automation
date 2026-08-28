-- ═══════════════════════════════════════════════════════════════════════════
-- Rol de la aplicación y sus permisos
--
-- Las migraciones las aplica el CLI con el rol "postgres". La aplicación NO
-- debe usar ese rol: se conecta con "erp_app", que solo puede tocar el esquema
-- erp y no puede alterar el esquema.
--
-- ── El rol se crea acá, sin contraseña ─────────────────────────────────────
-- La contraseña NO va en este archivo: iría a git. El rol se crea con LOGIN
-- pero sin contraseña, así que todavía no puede conectarse. La contraseña se
-- pone aparte, una vez por entorno:
--
--   ALTER ROLE erp_app PASSWORD 'la-clave-de-este-entorno';
--
-- Antes esta migración se saltaba los permisos si el rol no existía. Estaba
-- mal: quedaba registrada como aplicada y nunca volvía a correr, así que crear
-- el rol después dejaba una base con el esquema puesto y sin permisos, sin que
-- nada lo avisara. Ahora la migración crea el rol y aplica los permisos
-- siempre, y su resultado no depende de nada externo.
--
-- ── Por qué no hace falta RLS acá ──────────────────────────────────────────
-- PostgREST solo expone los esquemas listados en config.toml ([api] schemas),
-- que son public y graphql_public — y en este montaje no hay PostgREST del
-- todo. El esquema erp no tiene superficie pública que proteger.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    -- LOGIN sin PASSWORD: el rol existe y es dueño de sus permisos, pero no
    -- puede autenticarse hasta que se le asigne una contraseña.
    CREATE ROLE erp_app LOGIN;
    RAISE NOTICE 'Rol erp_app creado sin contraseña. Asígnala con: ALTER ROLE erp_app PASSWORD ''...''';
  ELSE
    RAISE NOTICE 'El rol erp_app ya existía; se actualizan sus permisos.';
  END IF;
END
$$;

-- Entrar al esquema, pero no crear objetos en él: el DDL es exclusivo de las
-- migraciones, así que la app no puede alterar el esquema por accidente.
GRANT USAGE ON SCHEMA erp TO erp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA erp TO erp_app;

-- Las columnas GENERATED ALWAYS AS IDENTITY usan una secuencia por detrás:
-- sin USAGE sobre ellas, todo INSERT falla.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA erp TO erp_app;

-- Incluye erp.siguiente_numero_oc(), erp.siguiente_valor(), etc.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA erp TO erp_app;

-- Para que las tablas y funciones que creen las migraciones futuras queden
-- accesibles sin repetir estos GRANT en cada una.
ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT EXECUTE ON FUNCTIONS TO erp_app;

-- El esquema public queda fuera de alcance de forma explícita, para que se lea
-- como una decisión y no como un olvido. Cuando esto viva junto a otro sistema
-- en la misma base, es lo que lo mantiene aislado.
REVOKE ALL ON SCHEMA public FROM erp_app;
