-- ═══════════════════════════════════════════════════════════════════════════
-- 002 — Catálogos
--
-- Cubre 5 de las 11 listas de SharePoint:
--   Proyectos · Proveedores · Insumos · UsuariosERP · ConfiguracionApp
--
-- Convención en todas las tablas:
--   id      → identidad propia de Postgres, nunca el id de SharePoint
--   sp_id   → id del item en SharePoint. Se conserva para poder reconciliar
--             durante la doble escritura y para rastrear el origen de una
--             fila después. Se puede borrar cuando SharePoint se apague.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Proyectos (lista "Proyectos") ──────────────────────────────────────────
-- En SharePoint la columna se llama "codigo" y es lo que el resto del sistema
-- guarda como texto en el campo "proyecto" de cada documento (ej.
-- "CT25-134 ANCLAJES MISTRAL"). Acá es la clave natural del proyecto.

CREATE TABLE erp.proyectos (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo        text        NOT NULL,
  nombre        text        NOT NULL DEFAULT '',
  tipo          text,
  ciudad        text,
  departamento  text,
  zona          text        REFERENCES erp.zonas(zona) ON UPDATE CASCADE,
  activo        boolean     NOT NULL DEFAULT true,
  notas         text,
  -- Marca las filas que el import creó solo para no perder la referencia de un
  -- documento cuyo proyecto no estaba en el catálogo. Hay que revisarlas a mano.
  requiere_revision boolean NOT NULL DEFAULT false,
  sp_id         text        UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proyectos_codigo_no_vacio CHECK (btrim(codigo) <> '')
);

-- Unicidad por código normalizado: evita que "LT NORTE 230KV" y
-- "LT  Norte 230kv" entren como dos proyectos distintos.
CREATE UNIQUE INDEX proyectos_codigo_norm_key ON erp.proyectos (erp.norm(codigo));
CREATE INDEX proyectos_activo_idx ON erp.proyectos (activo) WHERE activo;

CREATE TRIGGER proyectos_updated_at BEFORE UPDATE ON erp.proyectos
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Proveedores (lista "Proveedores") ──────────────────────────────────────
-- El NIT es la clave natural y es como lo referencian las OC y las OS. Se
-- guarda ya normalizado; el valor tal como venía queda en nit_original para
-- poder auditar la conversión.

CREATE TABLE erp.proveedores (
  nit               text        PRIMARY KEY,
  nit_original      text,
  razon_social      text        NOT NULL DEFAULT '',
  nombre_comercial  text,
  regimen           text,
  municipio         text,
  direccion         text,
  telefono          text,
  correo            text,
  zona              text        REFERENCES erp.zonas(zona) ON UPDATE CASCADE,
  banco             text,
  tipo_cuenta       text,
  cuenta_bancaria   text,
  activo            boolean     NOT NULL DEFAULT true,
  requiere_revision boolean     NOT NULL DEFAULT false,
  -- A diferencia del resto de las tablas, acá sp_id NO es único: en SharePoint
  -- hay 4 pares de items distintos que traen el mismo NIT (el mismo proveedor
  -- dado de alta dos veces). Al normalizar colapsan en una sola fila, así que
  -- un sp_id único haría fallar el import. Se guarda el del primero que entra.
  sp_id             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proveedores_nit_normalizado CHECK (nit = erp.norm_nit(nit))
);

CREATE INDEX proveedores_razon_norm_idx ON erp.proveedores (erp.norm(razon_social));
CREATE INDEX proveedores_zona_idx       ON erp.proveedores (zona);
CREATE INDEX proveedores_sp_id_idx      ON erp.proveedores (sp_id) WHERE sp_id IS NOT NULL;

CREATE TRIGGER proveedores_updated_at BEFORE UPDATE ON erp.proveedores
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Insumos (lista "Insumos") ──────────────────────────────────────────────
-- nombre_normalizado en SharePoint era una columna que el código mantenía a
-- mano y podía quedar desincronizada del nombre. Acá es una columna generada:
-- no puede mentir.

CREATE TABLE erp.insumos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre         text        NOT NULL,
  nombre_norm    text        GENERATED ALWAYS AS (erp.norm(nombre)) STORED,
  categoria      text,
  subcategoria   text,
  unidad         text,
  -- En SharePoint era un texto largo con los sinónimos separados por coma.
  sinonimos      text[]      NOT NULL DEFAULT '{}',
  activo         boolean     NOT NULL DEFAULT true,
  sp_id          text        UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insumos_nombre_no_vacio CHECK (btrim(nombre) <> '')
);

CREATE UNIQUE INDEX insumos_nombre_norm_key ON erp.insumos (nombre_norm);
CREATE INDEX insumos_categoria_idx ON erp.insumos (categoria, subcategoria);
CREATE INDEX insumos_sinonimos_idx ON erp.insumos USING gin (sinonimos);

CREATE TRIGGER insumos_updated_at BEFORE UPDATE ON erp.insumos
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Usuarios (lista "UsuariosERP") ─────────────────────────────────────────
-- Esta lista se autoaprovisionaba en servidor-cotizaciones.js
-- (asegurarListaUsuariosERP). El correo es la clave y se guarda en minúsculas,
-- porque el login de Microsoft compara así.

CREATE TABLE erp.usuarios (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text        NOT NULL,
  nombre      text        NOT NULL DEFAULT '',
  cargo       text        NOT NULL DEFAULT '',
  rol         text        NOT NULL DEFAULT 'operador',
  activo      boolean     NOT NULL DEFAULT false,
  sp_id       text        UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_rol_valido CHECK (rol IN ('admin', 'operador')),
  CONSTRAINT usuarios_email_minuscula CHECK (email = lower(btrim(email))),
  CONSTRAINT usuarios_email_con_arroba CHECK (email LIKE '%@%')
);

CREATE UNIQUE INDEX usuarios_email_key ON erp.usuarios (email);

CREATE TRIGGER usuarios_updated_at BEFORE UPDATE ON erp.usuarios
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

-- ── Configuración (lista "ConfiguracionApp") ───────────────────────────────
-- Clave-valor. El valor se queda como text y no como jsonb a propósito: hoy
-- guarda tanto JSON (emisor, firmante) como texto plano gigante (el logo es un
-- data-URL base64), y configApp.js hace JSON.parse con fallback al string
-- crudo. Cambiarlo a jsonb obligaría a reescribir ese contrato.

CREATE TABLE erp.configuracion (
  clave        text        PRIMARY KEY,
  valor        text        NOT NULL DEFAULT '',
  descripcion  text,
  sp_id        text        UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER configuracion_updated_at BEFORE UPDATE ON erp.configuracion
  FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();

COMMENT ON COLUMN erp.configuracion.valor IS
  'Texto plano o JSON serializado, igual que la columna valorJson de SharePoint. El logo se guarda acá como data-URL.';
