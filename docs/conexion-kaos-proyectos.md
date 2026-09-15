# Conectar el catálogo de proyectos a KAOS

KAOS pasa a ser el dueño de los proyectos y el ERP solo los consume. Este
documento es el procedimiento del corte en producción y la operación posterior.

El cambio de fondo, en una línea: **el ERP dejó de crear, editar y activar
proyectos.** Todo eso se hace en KAOS y llega por sincronización.

---

## 1 · Lo que cambia para quien usa el ERP

| Antes | Ahora |
|---|---|
| El proyecto se escribía a mano en la carga manual | Se elige de una lista cerrada |
| Un proyecto desconocido se creaba solo, inactivo y marcado | El documento se guarda **sin proyecto** y queda en una bandeja |
| Se daban de alta proyectos desde Configuración | Se dan de alta en KAOS |
| Se activaban e inactivaban desde Configuración | Lo decide KAOS |
| Una OC podía salir sin proyecto | No sale sin proyecto **activo** |

**Documentos sin proyecto** (Configuración → *Documentos sin proyecto*) es la
pantalla nueva. Muestra lo que no puede convertirse en orden de compra, por dos
motivos distintos:

- **Sin proyecto** — el correo traía un nombre que no está en el catálogo. Se
  asigna desde ahí.
- **Obra cerrada** — el proyecto es correcto pero está inactivo. Se reasigna, o
  se reabre la obra en KAOS.

Un requerimiento que entra nombrando una obra cerrada **sí se registra y sí se
ata a ella**: el dato es correcto y así conserva su zona, que es la que elige
proveedor. Lo que se bloquea es la orden de compra.

---

## 2 · Antes del corte

**El `.env` del VPS necesita dos variables nuevas.** No las lleva el deploy: el
rsync excluye el `.env` a propósito.

```bash
KAOS_API_URL=https://huvfuqqlmjodksfidkeq.supabase.co/functions/v1/kaos-api
KAOS_API_KEY=kaos_...
```

Sin prefijo `VITE_` ni `NEXT_PUBLIC_`: cualquiera de esos mandaría la clave al
navegador, donde es pública. Esta API se llama servidor a servidor.

**La clave se emite en el proyecto de Supabase que corresponda**, y no cruza de
uno a otro — una clave de otro tenant da `401 invalid_key`, con el mismo mensaje
que una inexistente:

```sql
SELECT public.mint_integration_api_key('oc-automation', ARRAY['projects:read'],
                                        now() + interval '1 year');
```

**Prueba de humo, sin credenciales**, para confirmar que le estás pegando al
proyecto correcto:

```bash
curl -s "$KAOS_API_URL/projects"
# {"error":"missing_key"}   → la función está desplegada ahí. Correcto.
# {"code":"NOT_FOUND"}      → no está desplegada en ese proyecto.
```

---

## 3 · Los PR, y en qué orden

El despliegue al VPS se dispara con un **push a `main`**, así que el último PR de
la lista es el que pone todo esto en producción. Los anteriores no despliegan
nada.

| # | PR | Desde → hacia | Por qué va ahí |
|---|---|---|---|
| 1 | Sincronizar `develop` con `main` | `main` → `develop` | `develop` está 2 commits atrás: le falta el que documentó el corte a Postgres. Sin esto, mergear encima arrastra un CONTRIBUTING que todavía dice que SharePoint es la fuente de verdad |
| 2 | Conexión con KAOS | `fix/documents-keep-unassigned-project` → `develop` | Es una funcionalidad, y el CONTRIBUTING reserva la ruta directa a `main` para incidentes en producción |
| 3 | Release | `develop` → `main` | **Este despliega.** Recién acá hay que estar listo para el corte |

**El paso 1 no es opcional ni cosmético.** Es el back-merge que el propio
CONTRIBUTING exige el mismo día de un hotfix, y quedó pendiente del 8 de
septiembre. Mientras no se haga, cada rama que salga de `develop` nace con
documentación que miente sobre dónde viven los datos.

**Y entre el paso 3 y el corte no hay espera.** El deploy sube el código y
reinicia los contenedores, pero no aplica migraciones ni corre ningún comando:
hasta que se ejecute lo de la sección siguiente, el ERP queda con el código nuevo
y el catálogo viejo. Eso funciona —nada se rompe— pero la conexión no existe
todavía.

---

## 4 · El corte

Después del PR 3 y de que el deploy termine. **El deploy no aplica migraciones ni
corre ninguno de estos comandos**: hay que entrar al VPS.

```bash
ssh <vps>
cd <ruta-del-erp>

# ── 1. Las migraciones ────────────────────────────────────────────────────
npm run db:push -- --dry-run     # ver cuáles faltan
npm run db:push

# ── 2. Traer el catálogo de KAOS al espejo ────────────────────────────────
#     No toca nada del catálogo: llena erp.proyectos_kaos y mide la brecha.
npm run kaos:sync -- --todo

# ── 3. Ligar lo que es la misma obra ──────────────────────────────────────
#     Solo cuando el nombre es idéntico salvo mayúsculas y tildes, ambos lados
#     están activos, y no hay ambigüedad. Ensayo primero.
npm run kaos:ligar
npm run kaos:ligar -- --si

# ── 4. Volcar el espejo sobre el catálogo ─────────────────────────────────
#     Acá KAOS pasa a mandar. Mirar el ensayo ANTES: dice cuántos proyectos
#     entrarían y cuáles.
npm run kaos:aplicar
npm run kaos:aplicar -- --si

# ── 5. Cerrar lo que quedó del ERP ────────────────────────────────────────
#     Todo lo que no viene de KAOS pasa a histórico. El ensayo avisa cuántos
#     requerimientos abiertos quedarían bloqueados por cada cierre.
npm run kaos:cerrar-legado
npm run kaos:cerrar-legado -- --si
```

**El orden no es indiferente.** Ligar antes de aplicar es lo que evita que una
obra viva en los dos sistemas se parta en dos filas: el histórico de un lado y
las órdenes nuevas del otro. Y cerrar el legado antes de aplicar dejaría a los
compradores sin ningún proyecto seleccionable.

### Verificación

```bash
npm run kaos:diff     # el informe, sin traer nada
```

```sql
-- Todo lo seleccionable debe venir de KAOS.
SELECT origen, count(*) AS filas, count(*) FILTER (WHERE activo) AS activas
  FROM erp.proyectos GROUP BY origen;

-- El histórico intacto: ninguna de estas dos debe cambiar respecto de antes.
SELECT count(*) FROM erp.vw_gastos;
SELECT count(*) FROM erp.ordenes_compra o
  LEFT JOIN erp.proyectos p ON p.id = o.proyecto_id
 WHERE o.proyecto_id IS NOT NULL AND p.id IS NULL;   -- debe dar 0
```

### Si algo sale mal

Ninguno de los cuatro comandos borra nada. `kaos:aplicar` y `kaos:cerrar-legado`
solo escriben columnas, y las seis llaves foráneas están en `RESTRICT`, así que
un proyecto con documentos **no se puede borrar** ni por accidente.

La vuelta atrás de un `cerrar-legado` es un `UPDATE` sobre `activo`. La de un
`aplicar` es más trabajo —hay filas nuevas— pero esas filas no tienen documentos
todavía, así que se pueden borrar.

---

## 5 · La operación de todos los días

**`kaos:sync` no corre solo.** Hay que engancharlo al ciclo del mailer o a un
cron del host. Mientras sea manual, un proyecto creado en KAOS no aparece en el
ERP hasta que alguien lo ejecute.

| Comando | Cuándo |
|---|---|
| `npm run kaos:sync` | seguido: trae solo lo modificado |
| `npm run kaos:sync -- --todo` | cada tanto: es el único que detecta borrados |
| `npm run kaos:aplicar -- --si` | después de un sync, para que el catálogo lo tome |
| `npm run kaos:ligar -- --si` | cuando aparezca una obra que ya existía acá |

**Por qué la reconciliación completa hace falta.** La API no emite borrados: un
proyecto borrado en KAOS simplemente deja de aparecer, así que el incremental
nunca se entera. `--todo` refresca `visto_en` de todo lo vivo, y lo que quede con
marca vieja es lo que se fue.

---

## 6 · Lo que queda en manos de los administradores

El ERP ya no corrige nada del catálogo, a propósito. Estas cosas se resuelven en
KAOS:

- **Proyectos de prueba.** Si en KAOS hay filas como `Ejemplo` o `Prueba`, entran
  al ERP como proyectos reales. Inactivarlas allá las saca solas.
- **Duplicados.** La misma obra escrita de dos formas son dos proyectos: el ERP
  no adivina cuál es. `kaos:aplicar` avisa cuando un nombre de KAOS choca con una
  fila del catálogo y no inserta ninguno de los dos.
- **Ubicación.** La zona sale del departamento, y el departamento de la dirección
  que se elige en la ficha del proyecto en KAOS. Un proyecto sin ubicación llega
  sin zona, y su sugerencia de proveedor cae a historial nacional.
- **Obras que siguen en uso y no están en KAOS.** Tras el corte quedan inactivas
  en el ERP. Si hacen falta, se dan de alta allá.
