-- ═══════════════════════════════════════════════════════════════════════════
-- 001 — Esquema base y funciones auxiliares
--
-- El ERP vive en su propio esquema "erp" para no compartir espacio de nombres
-- con las tablas de tesorería (Cash_Flow) si ambos comparten proyecto Supabase.
-- Ningún objeto del ERP debe crearse en "public".
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS erp;

COMMENT ON SCHEMA erp IS
  'ERP de compras y servicios (oc-automation). Fuente de verdad de las 11 listas que antes vivían en SharePoint.';

-- ── updated_at automático ──────────────────────────────────────────────────
-- En SharePoint la fecha de modificación la ponía la plataforma. Acá la pone
-- un trigger, así ningún camino de escritura puede olvidarla.

CREATE OR REPLACE FUNCTION erp.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── Normalización de texto ─────────────────────────────────────────────────
-- Réplica de norm() en src/db.js y src/servidor-cotizaciones.js: mayúsculas,
-- sin tildes, sin puntuación, espacios colapsados. Se declara IMMUTABLE para
-- poder usarla en índices únicos y de búsqueda.
--
-- Se usa translate() en vez de la extensión unaccent para no depender de que
-- esté instalada y para que la función sea IMMUTABLE de verdad (unaccent es
-- STABLE porque depende de un diccionario, y no sirve en un índice).

CREATE OR REPLACE FUNCTION erp.norm(txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT btrim(
           regexp_replace(
             regexp_replace(
               translate(
                 upper(coalesce(txt, '')),
                 'ÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÝÑÇ',
                 'AAAAAAEEEEIIIIOOOOOUUUUYNC'
               ),
               '[^A-Z0-9/-]+', ' ', 'g'
             ),
             ' {2,}', ' ', 'g'
           )
         );
$$;

COMMENT ON FUNCTION erp.norm(text) IS
  'Normaliza texto para comparación y unicidad: mayúsculas, sin tildes, sin puntuación, espacios colapsados.';

-- ── Normalización de NIT ───────────────────────────────────────────────────
-- Los NIT llegan de tres fuentes con tres formatos: "900.807.426-3",
-- "800,118,549-1" y "811017552.0" (artefacto de Excel leyendo un número como
-- flotante). Sin normalizar, el mismo proveedor entra tres veces al catálogo.
-- El sufijo ".0" se quita ANTES de borrar la puntuación, porque después ya no
-- se distingue de un separador de miles.

CREATE OR REPLACE FUNCTION erp.norm_nit(txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT nullif(
           regexp_replace(
             regexp_replace(coalesce(txt, ''), '\.0+$', ''),
             '[^0-9A-Za-z-]', '', 'g'
           ),
           ''
         );
$$;

COMMENT ON FUNCTION erp.norm_nit(text) IS
  'Normaliza un NIT a dígitos y guion: quita puntos, comas, espacios y el sufijo ".0" que deja Excel.';

-- ── Catálogo de zonas ──────────────────────────────────────────────────────
-- Era un campo choice en tres listas de SharePoint. Como tabla se puede
-- ampliar sin tocar el esquema de las tablas que la referencian.

CREATE TABLE IF NOT EXISTS erp.zonas (
  zona  text PRIMARY KEY,
  orden smallint NOT NULL DEFAULT 0
);

INSERT INTO erp.zonas (zona, orden) VALUES
  ('Centro', 1), ('Caribe', 2), ('Occidente', 3), ('Nororiente', 4),
  ('Sur', 5), ('Llanos', 6), ('Internacional', 7)
ON CONFLICT (zona) DO NOTHING;
