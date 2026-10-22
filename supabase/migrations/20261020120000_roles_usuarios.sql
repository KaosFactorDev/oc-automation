-- Roles de usuario: catálogo y asignación (una persona, varios roles).
--
-- Hasta ahora erp.usuarios.rol era texto con un CHECK ('admin' | 'operador').
-- Los roles pasan a ser datos:
--   · erp.roles          catálogo (código, nombre, descripción, orden)
--   · erp.usuario_roles  quién tiene qué; llave foránea al catálogo
--
-- Lo que se aplica HOY con estos roles es una sola regla: solo un
-- administrador administra usuarios y cambia la configuración de la empresa
-- (papelera y corregir ya eran solo de administrador). Compras, aprobador,
-- almacén, pagos y consulta quedan asignables y visibles, pero todavía no
-- restringen acciones: eso se activa después, ruta por ruta.
--
-- Los usuarios actuales conservan exactamente lo que pueden hacer hoy:
--   admin    → administrador
--   operador → compras + aprobador + almacén + pagos

CREATE TABLE erp.roles (
  codigo      text PRIMARY KEY CHECK (codigo ~ '^[a-z_]+$'),
  nombre      text NOT NULL,
  descripcion text NOT NULL,
  orden       smallint NOT NULL UNIQUE
);

INSERT INTO erp.roles (codigo, nombre, descripcion, orden) VALUES
  ('admin',     'Administrador', 'Todo, incluidos usuarios y roles, configuración de la empresa, papelera y corregir órdenes emitidas.', 1),
  ('compras',   'Compras',       'Requerimientos, cotizaciones, borradores de OC y OS, proveedores e insumos.', 2),
  ('aprobador', 'Aprobador',     'Aprueba OC y OS (les asigna número y compromete el dinero) y anula órdenes.', 3),
  ('almacen',   'Almacén',       'Entradas, salidas y devoluciones; documentos de almacén; entregas y remisiones.', 4),
  ('pagos',     'Pagos',         'Marca órdenes como pagadas y envía solicitudes de pago a tesorería.', 5),
  ('consulta',  'Consulta',      'Ve todo y exporta (registros, PDF, Control de Costos). No cambia nada.', 6);

CREATE TABLE erp.usuario_roles (
  usuario_id   bigint      NOT NULL REFERENCES erp.usuarios(id) ON DELETE CASCADE,
  rol          text        NOT NULL REFERENCES erp.roles(codigo) ON UPDATE CASCADE ON DELETE RESTRICT,
  asignado_en  timestamptz NOT NULL DEFAULT now(),
  asignado_por text,
  PRIMARY KEY (usuario_id, rol)
);

CREATE INDEX usuario_roles_rol ON erp.usuario_roles (rol);

-- Equivalencia con lo de hoy: nadie gana ni pierde nada con el despliegue.
INSERT INTO erp.usuario_roles (usuario_id, rol, asignado_por)
SELECT u.id, 'admin', 'migracion'
  FROM erp.usuarios u WHERE u.rol = 'admin';

INSERT INTO erp.usuario_roles (usuario_id, rol, asignado_por)
SELECT u.id, r.rol, 'migracion'
  FROM erp.usuarios u
 CROSS JOIN (VALUES ('compras'), ('aprobador'), ('almacen'), ('pagos')) AS r(rol)
 WHERE u.rol = 'operador';

-- La columna vieja deja de ser la fuente: el código nuevo ya no la lee ni la
-- escribe. NO se borra en esta migración porque el deploy migra ANTES de
-- reconstruir la imagen, y durante esos minutos la versión anterior la sigue
-- leyendo (login, papelera). Se borra en una migración posterior.
COMMENT ON COLUMN erp.usuarios.rol IS
  'OBSOLETA desde 20261020120000: los roles están en erp.usuario_roles. Se borra en una migración posterior.';

-- La app (erp_app) ya tiene SELECT/INSERT/UPDATE/DELETE sobre las tablas nuevas
-- del esquema por los DEFAULT PRIVILEGES de 20260828120500_permisos_erp_app.
