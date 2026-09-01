-- ═══════════════════════════════════════════════════════════════════════════
-- Consecutivo de requerimientos, por proyecto
--
-- Cada proyecto numera sus requerimientos aparte: REQ 0001, 0002… dentro de
-- "CT26-034 LT Norte 230KV", independiente de los de otro proyecto.
--
-- ── Cómo funcionaba ────────────────────────────────────────────────────────
-- El contador vivía en la columna ultimoConsecutivoReq de la lista Proyectos de
-- SharePoint, y requerimientos.js lo incrementaba con concurrencia optimista:
-- leía el item con su ETag, escribía valor+1 con If-Match y, si recibía 412
-- porque otro llegó primero, reintentaba. Cuando eso fallaba por cualquier otra
-- razón, caía a un contador en el SQLite local.
--
-- Ese fallback es la razón de que las dos fuentes no coincidan hoy: SharePoint
-- dice 9 para EQUIPOS GT 2026 mientras los requerimientos de ese proyecto ya
-- llegan a 0012. El contador de la lista se quedó atrás y nadie lo notó.
--
-- ── Cómo funciona ahora ────────────────────────────────────────────────────
-- Una columna en erp.proyectos y un UPDATE ... RETURNING. La fila queda
-- bloqueada hasta el commit del llamador, así que dos requerimientos
-- simultáneos del mismo proyecto se serializan sin reintentos, sin ETags y sin
-- fallback: no hay una segunda fuente que pueda desalinearse.
--
-- ── La siembra ─────────────────────────────────────────────────────────────
-- Se toma del máximo consecutivo_sistema realmente usado en cada proyecto, no
-- del contador de SharePoint, precisamente porque ese venía atrasado. Sembrar
-- del contador habría hecho que los siguientes requerimientos repitieran
-- números ya emitidos.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE erp.proyectos
  ADD COLUMN ultimo_consecutivo_req integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN erp.proyectos.ultimo_consecutivo_req IS
  'Último consecutivo de requerimiento emitido para este proyecto. Lo incrementa erp.siguiente_consecutivo_req(); nunca decrece.';

ALTER TABLE erp.proyectos
  ADD CONSTRAINT proyectos_consecutivo_req_no_negativo
  CHECK (ultimo_consecutivo_req >= 0);

-- ── Siembra desde los requerimientos existentes ─────────────────────────────

UPDATE erp.proyectos p
   SET ultimo_consecutivo_req = sub.maximo
  FROM (
    SELECT r.proyecto_id,
           max((regexp_match(r.consecutivo_sistema, '(\d+)\s*$'))[1]::int) AS maximo
      FROM erp.requerimientos r
     WHERE r.proyecto_id IS NOT NULL
       AND r.consecutivo_sistema IS NOT NULL
       AND r.consecutivo_sistema ~ '\d'
     GROUP BY r.proyecto_id
  ) sub
 WHERE p.id = sub.proyecto_id
   AND sub.maximo > p.ultimo_consecutivo_req;

-- ── Emisión ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION erp.siguiente_consecutivo_req(p_proyecto_id bigint)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_nuevo integer;
BEGIN
  IF p_proyecto_id IS NULL THEN
    -- Un requerimiento sin proyecto no numera: devolver cadena vacía es lo que
    -- hacía requerimientos.js y la consola ya lo tolera.
    RETURN '';
  END IF;

  UPDATE erp.proyectos
     SET ultimo_consecutivo_req = ultimo_consecutivo_req + 1
   WHERE id = p_proyecto_id
  RETURNING ultimo_consecutivo_req INTO v_nuevo;

  IF v_nuevo IS NULL THEN
    RAISE EXCEPTION 'El proyecto con id % no existe', p_proyecto_id;
  END IF;

  RETURN lpad(v_nuevo::text, 4, '0');
END;
$$;

COMMENT ON FUNCTION erp.siguiente_consecutivo_req(bigint) IS
  'Emite el siguiente consecutivo de requerimiento del proyecto, con relleno a 4 dígitos. Atómico dentro de la transacción del llamador.';

DO $$
DECLARE
  v_sembrados int;
BEGIN
  SELECT count(*) INTO v_sembrados FROM erp.proyectos WHERE ultimo_consecutivo_req > 0;
  RAISE NOTICE 'Consecutivo de requerimiento sembrado en % proyecto(s).', v_sembrados;
END
$$;
