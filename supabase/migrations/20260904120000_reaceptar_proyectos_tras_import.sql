-- Vuelve a aceptar los 23 proyectos, ahora que los datos existen.
--
-- ── Qué pasó ───────────────────────────────────────────────────────────────
-- La migración 20260901160000 quitaba la marca requiere_revision de una lista
-- escrita de 23 proyectos. En el equipo local funcionó, porque los datos ya
-- estaban cargados cuando se aplicó.
--
-- En el VPS el orden fue el contrario, y es el orden natural de un entorno
-- nuevo:
--
--   1. se levanta la base            (vacía)
--   2. se aplican las migraciones    ← el UPDATE afecta 0 filas
--   3. se importan los datos         ← el import crea los 23 con la marca puesta
--
-- Resultado: la migración se registró como aplicada sin haber hecho nada, y los
-- 23 proyectos volvieron a quedar marcados. Se descubrió auditando producción,
-- no por ningún error: la aplicación funciona igual: la marca solo sirve para
-- que alguien mire.
--
-- ── La lección ─────────────────────────────────────────────────────────────
-- Una migración que corrige DATOS es dependiente del orden, y en un entorno
-- nuevo las migraciones siempre corren antes de que haya datos. Las que
-- cambian el ESQUEMA no tienen ese problema.
--
-- La otra migración de datos —20260828120600, la que fusionaba proveedores
-- partidos por dígito de verificación— también corrió en vacío, pero se curó
-- sola: además del UPDATE reemplazaba erp.norm_nit(), y el import normaliza con
-- esa función, así que la fusión ocurrió al cargar. Comprobado: no quedó ningún
-- par NIT/NIT-DV en producción.
--
-- Para la próxima: si una migración tiene que arreglar datos que llegan
-- después, el arreglo va en el import o en un script aparte, no en una
-- migración que se marca aplicada una sola vez.

BEGIN;

CREATE TEMP TABLE _aceptados (codigo text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO _aceptados (codigo) VALUES
    ('ADMINISTRATIVO'),
    ('BODEGA AUXILIAR'),
    ('BODEGA CIVILTECH'),
    ('CAMPAMENTO'),
    ('CONCONCRETO'),
    ('CT26-034 LT Norte 230 KV-JE Jaimes'),
    ('CT26-034LT ZIPAQUIRA Norte 230KV - JE Jaimes'),
    ('CT26-041 Micropilotes IZZI96-COALA'),
    ('EQUIPOS GT'),
    ('EQUIPOS GT 20026'),
    ('IZZI96'),
    ('IZZY 96'),
    ('IZZY 96 2'),
    ('LT NORTE 230KV'),
    ('LT RSO - JE JAIMES'),
    ('MISTRA'),
    ('MPLT NORTE'),
    ('REACTIVACION DE CLIENTES COLPREVENCIO'),
    ('RSO PALMIRA'),
    ('SIN_PROYECTO'),
    ('SST'),
    ('Solei'),
    ('mistral');

UPDATE erp.proyectos p
   SET requiere_revision = false,
       updated_at        = now()
  FROM _aceptados a
 WHERE erp.norm(p.codigo) = erp.norm(a.codigo)
   AND p.requiere_revision;

DO $$
DECLARE
  pendientes int;
BEGIN
  SELECT count(*) INTO pendientes FROM erp.proyectos WHERE requiere_revision;
  IF pendientes > 0 THEN
    RAISE NOTICE 'Quedan % proyecto(s) marcados: son posteriores a esta decisión. Revísalos con: npm run revisar-proyectos', pendientes;
  ELSE
    RAISE NOTICE 'Sin proyectos pendientes de revisión.';
  END IF;
END $$;

COMMIT;
