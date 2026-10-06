-- El empalme del catálogo del ERP con KAOS, decidido fila por fila.
--
-- KAOS es la única fuente de proyectos. El espejo (20260911120000) dejó dónde
-- guardar la identidad —kaos_id, kaos_code, origen— y kaos:ligar ataba solo lo
-- que tuviera el MISMO nombre. Eso ya no alcanza: KAOS renombró sus proyectos
-- con el código contable al final («… (0380)»), y el ERP arrastra variantes
-- escritas a mano de una misma obra («mistral», «MISTRA», «CT125-134 …») que
-- entraron por correo antes de que se cerrara esa puerta.
--
-- Las 53 filas de producción se revisaron con Julian el 2026-10-06:
--
--   · 29 se ATAN a su proyecto de KAOS. `codigo` no se toca: es lo que va
--     impreso en los PDF y en el control de costos de toda la historia.
--   · 21 son VARIANTES: sus documentos pasan a la fila de su obra y la fila
--     se borra. kaos_id es único, así que dos filas no pueden ser la misma obra.
--   · SIN_PROYECTO no es una obra: sus documentos quedan sin proyecto, con el
--     texto como pista, en la bandeja para asignarlos a mano.
--   · TALENTO HUMANO no tiene nada y se borra.
--   · REACTIVACION DE CLIENTES COLPREVENCIO no existe en KAOS: queda como
--     historial local (origen 'local', inactiva). No se toca.
--
-- Es la misma correspondencia que ya usa Cash_Flow: cada obra apunta al mismo
-- kaos_id en los dos sistemas.
--
-- No borra ni un documento: solo cambia a qué proyecto apuntan. Lo que se
-- mueve queda anotado en erp.empalme_kaos_documentos con su proyecto anterior,
-- y las filas borradas en erp.empalme_kaos_proyectos.
--
-- Corre en una transacción: si cualquier verificación falla, no aplica nada.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0 · Las decisiones
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ligar (codigo text PRIMARY KEY, kaos_id uuid NOT NULL UNIQUE, kaos_code text NOT NULL);
INSERT INTO _ligar (codigo, kaos_id, kaos_code) VALUES
  ('ADMINISTRACION CT 2026',                                      '59641dd8-edc9-4036-ae6a-e49cdeaaa939', 'KP-VQG7GQ'), -- ADMINISTRACION CT 2026 (0101)
  ('ADMINISTRATIVO 2025',                                         '9e77910a-f1ae-4bf7-a4ba-e438353a19e2', 'KP-MPJ4W2'),
  ('BODEGA AUXILIAR',                                             '434b4254-2dae-486c-a69a-e7fb96879caa', 'KP-KUNTDD'),
  ('BODEGA CIVILTECH',                                            '47433761-c58b-45c3-9e99-ce5816d0fb2e', 'KP-KMV2NY'),
  ('CAMPAMENTO',                                                  'ec7c4aec-ebc3-4e15-951f-0f211e9e1076', 'KP-EE3UQ8'),
  ('EQUIPO MENOR',                                                'ef5a84c2-8f2c-4854-a153-ccf167829138', 'KP-5DTYD3'),
  ('HERRAMIENTA DE PERFORACION 2025',                             'b6bf2566-3dee-4630-9647-0af507b1b360', 'KP-KVXZZC'),
  ('SST',                                                         '62d7c70c-a3e3-4fab-808d-45f449cca0e7', 'KP-KXJNWA'),
  ('SUMINISTRO DE MATERIALES PT',                                 '38890a6a-74a6-4ee1-a06f-edf863eb90be', 'KP-RMEWBT'),
  ('CT23-205 ESTABILIZACION DE TALUDES - CERREJON',               '61ad9d6d-20f7-4b9f-ab9c-5b79212c3139', 'KP-Z3EVTX'), -- (0360)
  ('CT24-052 Perforación y tesado de barras Cll 6 - PTCC2021',    'aac66144-e62e-4748-ad54-4d8c4476aff6', 'KP-AWTVYR'), -- (0235)
  ('CT24-131 Puentes Peatonales Transversal del Sisga',           'ad7631fc-c9e1-404b-906d-1a9443f8e4e4', 'KP-Z3PHW4'), -- (0366)
  ('CT24-291 PT Puente Cesar',                                    '3e1da6ba-67e5-4eef-ae70-5a9a5e46c8a0', 'KP-DH7TDW'), -- (0372)
  ('CT24-328 Inclusiones - CONSORCIO VIAL SOACHA',                'e1d2bd82-ba74-4264-9e44-718a6d4096f0', 'KP-963SEX'), -- (0367)
  ('CT25-014 Tensionamientos UF7 - CONSORCIO FERROCOL SANTANDER', 'a83b722f-1eaf-4e0a-85fe-bdceb01d24f1', 'KP-R9XRWA'), -- (0244)
  ('CT25-034 ANCLAJES SOLEI',                                     '1894155c-e363-4c02-b1f2-d39d8e4576f1', 'KP-E9WA78'), -- (0368)
  ('CT25-034 ANCLAJES SOLEI V2',                                  '78d50e5f-0dc6-42ae-9204-9b0b95eeb334', 'KP-PJRVQ2'), -- (0375)
  ('CT25-075 ESTABILIZACION TALUDES - POLANCO',                   'c9768361-bdf0-4002-b4b9-5098a243d1bf', 'KP-6UKHXU'), -- (0371)
  ('CT25-076 Micropilotes Red Matriz - CONCONCRETO',              '53cc62dc-9aa8-4650-9af9-cf1a627983fc', 'KP-KSUH3W'), -- (0379)
  ('CT25-134 ANCLAJES MISTRAL',                                   'd3c3d9cd-2954-40e3-89a7-1bb776e6e052', 'KP-CRCEXU'), -- (0376)
  ('CT25-162 Micropilotes Guarne',                                '3419f135-ca26-4311-b0bd-2b2049ccad69', 'KP-JKKTJG'), -- (0373)
  ('CT25-172 Micropilotes Teatro Mcdouell',                       '5123c769-e8cc-40f0-8def-384b87739fb4', 'KP-RSMAKR'), -- (0374)
  ('CT25-202 Micropilotes IZZI 96',                               '713a875f-6434-46fd-95fa-bbd892d6ab3e', 'KP-DZRREB'), -- IZZI 96 (0378)
  ('CT26-041 Micropilotes IZZI96-COALA',                          '87789b72-2f08-41d2-9d6b-2bf60ec1ab1c', 'KP-2YZZJ3'), -- IZZI 96 COALA (0378)
  ('CT26-041 Micropilotes IZZI96-COALA 2',                        '92064826-1cfa-4348-aa39-6aa249df549f', 'KP-TX9FYE'), -- IZZI 96 COALA V2 (0382)
  ('CT26-026 Micropilotes RSO - JE Jaimes',                       '7f0c10b9-fc5a-4bb2-82f8-d7a90c5298ab', 'KP-3XYAZY'), -- (0380)
  ('CT26-034 LT Norte 230KV - JE Jaimes',                         'cce63e59-151e-4c60-ba30-6612ee93d017', 'KP-2F3BQ9'), -- (0381)
  ('EQUIPOS GT 2026',                                             'd74ba2a7-92b7-435c-80e8-cbb9e0161c32', 'KP-2TKBF6'), -- EQUIPOS CIVILTECH GT (0402)
  ('EQUIPOS PT 2025',                                             '949f150f-cad3-4d85-9447-39fb415325d6', 'KP-5KSK7R'); -- EQUIPOS PT (0502)

-- variante → la fila de su obra (que tiene que estar en _ligar)
CREATE TEMP TABLE _fusionar (variante text PRIMARY KEY, obra text NOT NULL);
INSERT INTO _fusionar (variante, obra) VALUES
  ('mistral',                                       'CT25-134 ANCLAJES MISTRAL'),
  ('MISTRA',                                        'CT25-134 ANCLAJES MISTRAL'),
  ('CT 25-134 ANCLAJES MISTRAL',                    'CT25-134 ANCLAJES MISTRAL'),
  ('CT125-134 ANCLAJES MISTRAL',                    'CT25-134 ANCLAJES MISTRAL'),
  ('CT26-034 LT Norte 230 KV-JE Jaimes',            'CT26-034 LT Norte 230KV - JE Jaimes'),
  ('CT26-034LT ZIPAQUIRA Norte 230KV - JE Jaimes',  'CT26-034 LT Norte 230KV - JE Jaimes'),
  ('LT NORTE 230KV',                                'CT26-034 LT Norte 230KV - JE Jaimes'),
  ('LT Norte',                                      'CT26-034 LT Norte 230KV - JE Jaimes'),
  ('MPLT NORTE',                                    'CT26-034 LT Norte 230KV - JE Jaimes'),
  ('RSO PALMIRA',                                   'CT26-026 Micropilotes RSO - JE Jaimes'),
  ('LT RSO - JE JAIMES',                            'CT26-026 Micropilotes RSO - JE Jaimes'),
  ('CT25-200 Micropilotes RSO Palmira',             'CT26-026 Micropilotes RSO - JE Jaimes'),
  ('CONCONCRETO',                                   'CT25-076 Micropilotes Red Matriz - CONCONCRETO'),
  ('EQUIPOS GT',                                    'EQUIPOS GT 2026'),
  ('EQUIPOS GT 20026',                              'EQUIPOS GT 2026'),
  ('EQUIPOS GT 2025',                               'EQUIPOS GT 2026'),
  ('IZZI96',                                        'CT26-041 Micropilotes IZZI96-COALA 2'),
  ('IZZY 96',                                       'CT26-041 Micropilotes IZZI96-COALA 2'),
  ('IZZY 96 2',                                     'CT26-041 Micropilotes IZZI96-COALA 2'),
  ('Solei',                                         'CT25-034 ANCLAJES SOLEI'),
  ('ADMINISTRATIVO',                                'ADMINISTRACION CT 2026');

-- documentos a la bandeja, sin proyecto
CREATE TEMP TABLE _desasignar (codigo text PRIMARY KEY);
INSERT INTO _desasignar VALUES ('SIN_PROYECTO');

-- se borra (sin un solo documento)
CREATE TEMP TABLE _borrar (codigo text PRIMARY KEY);
INSERT INTO _borrar VALUES ('TALENTO HUMANO');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Resolver cada nombre a su fila, o no seguir
-- ─────────────────────────────────────────────────────────────────────────────
-- Por erp.norm(), la misma llave del índice único del catálogo: ignora
-- mayúsculas y tildes, y garantiza que a lo sumo hay una fila por nombre.
CREATE TEMP TABLE _filas AS
SELECT x.codigo, x.papel, p.id
  FROM (SELECT codigo, 'ligar' AS papel FROM _ligar
        UNION ALL SELECT variante, 'fusionar' FROM _fusionar
        UNION ALL SELECT codigo, 'desasignar' FROM _desasignar
        UNION ALL SELECT codigo, 'borrar' FROM _borrar) x
  LEFT JOIN erp.proyectos p ON erp.norm(p.codigo) = erp.norm(x.codigo);

DO $$
DECLARE
  faltan text;
  ya_ligados text;
BEGIN
  -- Base recién creada (db:reset): no hay catálogo, no hay nada que empalmar.
  IF NOT EXISTS (SELECT 1 FROM erp.proyectos) THEN
    RAISE NOTICE 'Empalme: erp.proyectos está vacía, no hay nada que hacer.';
    RETURN;
  END IF;

  SELECT string_agg(codigo, ', ') INTO faltan FROM _filas WHERE id IS NULL;
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Empalme: no se encontraron en erp.proyectos: %', faltan;
  END IF;

  -- Cada obra destino de una fusión tiene que ser una de las que se atan.
  SELECT string_agg(f.obra, ', ') INTO faltan
    FROM _fusionar f WHERE NOT EXISTS (SELECT 1 FROM _ligar l WHERE l.codigo = f.obra);
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Empalme: fusiones hacia una fila que no se ata a KAOS: %', faltan;
  END IF;

  -- Un kaos_id que ya esté en otra fila (un kaos:ligar o kaos:aplicar corrido
  -- antes) chocaría con el índice único. Mejor decirlo que fallar a medias.
  SELECT string_agg(p.codigo || ' → ' || p.kaos_id, ', ') INTO ya_ligados
    FROM erp.proyectos p JOIN _ligar l ON l.kaos_id = p.kaos_id
   WHERE erp.norm(p.codigo) <> erp.norm(l.codigo);
  IF ya_ligados IS NOT NULL THEN
    RAISE EXCEPTION 'Empalme: estos kaos_id ya están en otra fila: %', ya_ligados;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Respaldo de lo que se toca
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp.empalme_kaos_proyectos (LIKE erp.proyectos);
COMMENT ON TABLE erp.empalme_kaos_proyectos IS
  'Copia de las filas de erp.proyectos que el empalme con KAOS (20261006120000) fusionó, desasignó o borró. Solo para auditoría o reversión.';

CREATE TABLE IF NOT EXISTS erp.empalme_kaos_documentos (
  tabla             text   NOT NULL,
  documento_id      bigint NOT NULL,
  proyecto_antes    bigint NOT NULL,
  codigo_antes      text   NOT NULL,
  proyecto_despues  bigint,
  consecutivo_antes text,
  PRIMARY KEY (tabla, documento_id)
);
COMMENT ON TABLE erp.empalme_kaos_documentos IS
  'Cada documento que el empalme con KAOS (20261006120000) cambió de proyecto, con el proyecto y el código que tenía antes. proyecto_despues NULL = quedó en la bandeja. consecutivo_antes: el número que tenía un requerimiento mandado a la bandeja, que se le quitó.';

INSERT INTO erp.empalme_kaos_proyectos
SELECT p.* FROM erp.proyectos p JOIN _filas f ON f.id = p.id WHERE f.papel <> 'ligar';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Mover los documentos
-- ─────────────────────────────────────────────────────────────────────────────
-- id de la fila vieja → id de la fila destino (NULL = a la bandeja)
CREATE TEMP TABLE _mover AS
SELECT v.id AS desde, o.id AS hacia, v.codigo
  FROM _fusionar fu
  JOIN _filas v ON v.codigo = fu.variante AND v.papel = 'fusionar'
  JOIN _filas o ON o.codigo = fu.obra     AND o.papel = 'ligar'
UNION ALL
SELECT d.id, NULL, d.codigo FROM _filas d WHERE d.papel = 'desasignar';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['requerimientos', 'ordenes_compra', 'ordenes_servicio',
                           'remisiones', 'movimientos_inventario', 'historial_precios'] LOOP
    EXECUTE format(
      'INSERT INTO erp.empalme_kaos_documentos (tabla, documento_id, proyecto_antes, codigo_antes, proyecto_despues)
       SELECT %L, x.id, x.proyecto_id, m.codigo, m.hacia
         FROM erp.%I x JOIN _mover m ON m.desde = x.proyecto_id', t, t);

    -- A la bandeja: sin proyecto y con el texto que tenía, que es la única
    -- pista de quien lo asigne. A una obra: proyecto_texto no se toca.
    EXECUTE format(
      'UPDATE erp.%I x
          SET proyecto_id    = m.hacia,
              proyecto_texto = CASE WHEN m.hacia IS NULL THEN m.codigo ELSE x.proyecto_texto END
         FROM _mover m
        WHERE x.proyecto_id = m.desde', t);
  END LOOP;
END $$;

-- Un requerimiento que va a la bandeja pierde el número que le dio SIN_PROYECTO:
-- era el contador de un comodín, no de una obra. Si lo conservara, al
-- asignarlo quedaría con un número que ya existe en su obra; sin número,
-- repoRequerimientos.actualizar() le emite el siguiente de la obra al asignarlo.
-- El número viejo queda en el respaldo.
UPDATE erp.empalme_kaos_documentos d
   SET consecutivo_antes = r.consecutivo_sistema
  FROM erp.requerimientos r
 WHERE d.tabla = 'requerimientos' AND d.documento_id = r.id AND d.proyecto_despues IS NULL;

UPDATE erp.requerimientos r
   SET consecutivo_sistema = NULL
  FROM erp.empalme_kaos_documentos d
 WHERE d.tabla = 'requerimientos' AND d.documento_id = r.id AND d.proyecto_despues IS NULL;

-- El consecutivo de requerimientos va por proyecto, y erp.siguiente_consecutivo_req()
-- da contador + 1. Cada obra queda con el MAYOR entre su contador, el de sus
-- variantes y el número más alto ya emitido en sus requerimientos (que ahora
-- incluyen los de las variantes).
--
-- Lo último no es solo por la fusión: en producción varios contadores ya
-- estaban por detrás de lo emitido (CT26-026 decía 11 con el 0015 usado;
-- EQUIPOS GT 2026, 0 con el 0012), así que el siguiente requerimiento habría
-- repetido un número existente. Solo sube, nunca baja.
UPDATE erp.proyectos o
   SET ultimo_consecutivo_req = sub.maximo
  FROM (SELECT f.id,
               greatest(
                 (SELECT coalesce(max(v.ultimo_consecutivo_req), 0)
                    FROM _mover m JOIN erp.proyectos v ON v.id = m.desde
                   WHERE m.hacia = f.id),
                 (SELECT coalesce(max(r.consecutivo_sistema::int), 0)
                    FROM erp.requerimientos r
                   WHERE r.proyecto_id = f.id AND r.consecutivo_sistema ~ '^[0-9]+$')
               ) AS maximo
          FROM _filas f WHERE f.papel = 'ligar' AND f.id IS NOT NULL) sub
 WHERE o.id = sub.id AND sub.maximo > o.ultimo_consecutivo_req;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Atar a KAOS y retirar las filas que sobran
-- ─────────────────────────────────────────────────────────────────────────────
-- Solo la identidad. Nombre, ciudad, zona y si está activo los trae
-- kaos:aplicar desde el espejo, igual que para cualquier proyecto de KAOS.
UPDATE erp.proyectos p
   SET kaos_id = l.kaos_id, kaos_code = l.kaos_code, origen = 'kaos',
       requiere_revision = false, updated_at = now()
  FROM _ligar l JOIN _filas f ON f.codigo = l.codigo AND f.papel = 'ligar'
 WHERE p.id = f.id;

-- Las seis llaves foráneas están en RESTRICT: si a alguna de estas filas le
-- quedara un documento, este DELETE falla y la transacción entera se deshace.
DELETE FROM erp.proyectos p USING _filas f
 WHERE p.id = f.id AND f.papel IN ('fusionar', 'desasignar', 'borrar');

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _filas WHERE id IS NOT NULL) THEN RETURN; END IF;

  SELECT count(*) INTO n FROM erp.proyectos WHERE kaos_id IN (SELECT kaos_id FROM _ligar);
  IF n <> (SELECT count(*) FROM _ligar) THEN
    RAISE EXCEPTION 'Empalme: quedaron % filas atadas, se esperaban %', n, (SELECT count(*) FROM _ligar);
  END IF;

  SELECT count(*) INTO n FROM erp.proyectos p JOIN _filas f ON f.id = p.id WHERE f.papel <> 'ligar';
  IF n > 0 THEN
    RAISE EXCEPTION 'Empalme: % filas que debían retirarse siguen en el catálogo', n;
  END IF;
END $$;

DROP TABLE _mover;
DROP TABLE _filas;
DROP TABLE _borrar;
DROP TABLE _desasignar;
DROP TABLE _fusionar;
DROP TABLE _ligar;
