-- El espejo de los proyectos de KAOS, y la identidad para cruzarlos.
--
-- KAOS es el dueño del catálogo; el ERP lo consume. Pero no lo consulta en
-- caliente: los proyectos se leen en cada selector, cada PDF y cada consecutivo,
-- y si la API no responde el ERP tiene que seguir facturando. Así que se copia
-- acá y todo lee de Postgres, como ya hace con el resto.
--
-- Esta migración NO cambia comportamiento. Solo crea dónde guardar lo que la
-- API entrega y cómo atarlo al catálogo actual. Sirve para medir la brecha real
-- antes de decidir nada: hoy son 40 proyectos en KAOS contra 52 acá.

-- ─────────────────────────────────────────────────────────────────────────────
-- El espejo: lo que entrega la API, tal cual
-- ─────────────────────────────────────────────────────────────────────────────
-- Se guarda crudo y aparte del catálogo a propósito. Mezclarlos desde el primer
-- día haría imposible responder "¿esto lo dijo KAOS o lo teníamos nosotros?",
-- que es justamente la pregunta de la conciliación.
CREATE TABLE IF NOT EXISTS erp.proyectos_kaos (
  kaos_id       uuid        PRIMARY KEY,
  project_code  text        NOT NULL UNIQUE,
  nombre        text        NOT NULL DEFAULT '',
  descripcion   text,
  estado        text,
  ciudad        text,
  departamento  text,
  pais          text,
  -- Sin llave foránea a erp.zonas a propósito: este espejo refleja lo que KAOS
  -- dijo, aunque algún día diga una zona que acá no existe. La validación va al
  -- copiar al catálogo, no al recibir. Un espejo que rechaza datos deja de ser
  -- un espejo y esconde justo la discrepancia que hay que ver.
  zona          text,
  kaos_creado   timestamptz,
  kaos_actualizado timestamptz NOT NULL,
  visto_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proyectos_kaos_code_no_vacio CHECK (btrim(project_code) <> '')
);

COMMENT ON TABLE erp.proyectos_kaos IS
  'Copia local de lo que entrega kaos-api. Fuente de verdad: KAOS. Nada del ERP escribe acá salvo el sincronizador.';
COMMENT ON COLUMN erp.proyectos_kaos.visto_en IS
  'Cuándo lo trajo la última sincronización. Un valor viejo tras una reconciliación completa significa que el proyecto desapareció de KAOS: la API no emite borrados.';

CREATE INDEX IF NOT EXISTS proyectos_kaos_actualizado_idx
  ON erp.proyectos_kaos (kaos_actualizado DESC);

-- Para cruzar por nombre durante la conciliación inicial, sin tildes ni cajas.
CREATE INDEX IF NOT EXISTS proyectos_kaos_nombre_norm_idx
  ON erp.proyectos_kaos (erp.norm(nombre));

-- ─────────────────────────────────────────────────────────────────────────────
-- La marca de la última sincronización
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp.kaos_sync_estado (
  id                smallint PRIMARY KEY DEFAULT 1,
  ultima_marca      timestamptz,
  ultima_corrida    timestamptz,
  ultimo_resultado  text,
  CONSTRAINT kaos_sync_una_fila CHECK (id = 1)
);

INSERT INTO erp.kaos_sync_estado (id) VALUES (1) ON CONFLICT DO NOTHING;

COMMENT ON COLUMN erp.kaos_sync_estado.ultima_marca IS
  'El updated_at más alto ya procesado. Alimenta updated_since, cuyo filtro es estricto (>), así que no repite la última fila.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Identidad en el catálogo actual
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE erp.proyectos
  ADD COLUMN IF NOT EXISTS kaos_id      uuid,
  ADD COLUMN IF NOT EXISTS kaos_code    text,
  ADD COLUMN IF NOT EXISTS origen       text NOT NULL DEFAULT 'local';

-- Un proyecto de KAOS no puede estar dos veces en el catálogo.
CREATE UNIQUE INDEX IF NOT EXISTS proyectos_kaos_id_key
  ON erp.proyectos (kaos_id) WHERE kaos_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS proyectos_kaos_code_key
  ON erp.proyectos (kaos_code) WHERE kaos_code IS NOT NULL;

ALTER TABLE erp.proyectos
  DROP CONSTRAINT IF EXISTS proyectos_origen_valido;
ALTER TABLE erp.proyectos
  ADD CONSTRAINT proyectos_origen_valido
  CHECK (origen IN ('kaos', 'local', 'huerfano'));

COMMENT ON COLUMN erp.proyectos.kaos_code IS
  'El código corto e inmutable de KAOS (KP-XXXXXX). Es la llave de cruce entre los dos sistemas; `codigo` sigue siendo el texto que se imprime en los documentos.';
COMMENT ON COLUMN erp.proyectos.origen IS
  'kaos = lo administra KAOS y el sincronizador lo pisa. local = de la empresa y no existe en KAOS (centros de costo como BODEGA CIVILTECH). huerfano = lo creó un documento antes de que se cerrara esa puerta.';

-- Los que nacieron de un documento quedan distinguidos de los que alguien dio
-- de alta. `requiere_revision` ya los marcaba; `origen` lo dice sin ambigüedad y
-- sobrevive a que la marca se limpie.
UPDATE erp.proyectos SET origen = 'huerfano'
 WHERE requiere_revision AND origen = 'local';

CREATE INDEX IF NOT EXISTS proyectos_origen_idx ON erp.proyectos (origen);
