-- Acepta como proyectos propios los 23 que el import marcó para revisión.
--
-- Decisión de negocio: no se unifican. Varios nunca fueron duplicados de nada
-- —BODEGA CIVILTECH tiene 1.709 compras propias, SST 175— y los que sí son la
-- misma obra escrita distinto se dejan igual, porque el catálogo de proyectos
-- va a venir de una fuente externa y esa fuente no se ligará al histórico. El
-- histórico queda ligado a estas filas, tal como está hoy.
--
-- Por qué la lista va escrita y no un "UPDATE ... WHERE requiere_revision":
-- esta migración se aplica más tarde en el VPS, sobre datos reimportados. Para
-- entonces pueden haber aparecido variantes NUEVAS, y limpiarlas a todas
-- escondería justo lo que la marca sirve para mostrar. Con la lista explícita,
-- lo que se aceptó queda aceptado y lo nuevo sigue visible.
--
-- Efecto secundario buscado: al quedar en cero, requiere_revision vuelve a
-- significar "apareció un proyecto que nadie dio de alta", y
-- "npm run revisar-proyectos" pasa a ser un monitor en vez de una lista de 23
-- pendientes que nadie mira.

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

-- Informe, no validación: si el import corrió distinto, conviene verlo en el
-- log del despliegue en vez de que la migración falle por algo cosmético.
DO $$
DECLARE
  pendientes int;
  no_hallados text;
BEGIN
  SELECT count(*) INTO pendientes FROM erp.proyectos WHERE requiere_revision;

  SELECT string_agg(a.codigo, ', ') INTO no_hallados
    FROM _aceptados a
   WHERE NOT EXISTS (SELECT 1 FROM erp.proyectos p
                      WHERE erp.norm(p.codigo) = erp.norm(a.codigo));

  IF no_hallados IS NOT NULL THEN
    RAISE NOTICE 'Aceptados que ya no existen en el catálogo: %', no_hallados;
  END IF;

  IF pendientes > 0 THEN
    RAISE NOTICE 'Quedan % proyecto(s) marcados: son variantes nuevas, posteriores a esta decisión. Revísalos con: npm run revisar-proyectos', pendientes;
  ELSE
    RAISE NOTICE 'Sin proyectos pendientes de revisión.';
  END IF;
END $$;

COMMIT;
