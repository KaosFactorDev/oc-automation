# Esquema `erp`

Referencia del esquema de Postgres. La definición vive en
`supabase/migrations/`; esto explica el porqué.

Todo el ERP vive en el esquema `erp`, nunca en `public`. Eso mantiene el espacio
de nombres limpio y permite que la base comparta servidor con otro sistema sin
mezclarse.

## Inventario

18 tablas, 5 vistas, 10 funciones, 78 índices.

| Tabla | Col. | Filas hoy | Lista de SharePoint |
|---|---:|---:|---|
| `proyectos` | 14 | 50 | Proyectos |
| `proveedores` | 18 | 424 | Proveedores |
| `insumos` | 11 | 880 | Insumos |
| `usuarios` | 9 | 6 | UsuariosERP |
| `configuracion` | 6 | 6 | ConfiguracionApp |
| `requerimientos` | 15 | 132 | Requerimientos |
| `requerimiento_items` | 11 | 1.097 | ↳ de `itemsJson` |
| `ordenes_compra` | 37 | 282 | OrdenesCompra |
| `orden_compra_items` | 12 | 1.261 | ↳ de `itemsJson` |
| `ordenes_servicio` | 40 | 147 | OrdenesServicio |
| `orden_servicio_items` | 9 | 185 | ↳ de `itemsJson` |
| `remisiones` | 16 | 130 | Remisiones |
| `remision_items` | 7 | 693 | ↳ de `itemsJson` |
| `remision_ordenes` | 2 | 134 | ↳ de `ocIds` |
| `movimientos_inventario` | 21 | 1.659 | MovimientosInventario |
| `historial_precios` | 19 | 5.496 | HistorialPrecios |
| `contadores` | 3 | 5 | *(nueva)* |
| `zonas` | 2 | 7 | *(nueva)* |

Las tablas de ítems no existían: salen de descomponer la columna `itemsJson`.

## Decisiones de modelado

### Los ítems dejan de ser JSON

En SharePoint —y en el caché SQLite que ya se eliminó— los ítems de cada documento vivían dentro
de un string `itemsJson`. Ahora son tablas hijas. Eso es lo que permite:

- sumar por insumo, proveedor o proyecto sin leer todos los documentos;
- que el control de costos sea una consulta y no un archivo aparte;
- detectar un ítem sin descripción al escribirlo, y no meses después cuando el
  PDF sale con la celda en blanco.

Los totales de línea son **columnas generadas**, no valores guardados:

```sql
valor_bruto numeric(16,2) GENERATED ALWAYS AS
  (round(cantidad * precio_unitario * (1 - descuento_pct / 100), 2)) STORED
```

Antes cada plantilla y cada ruta repetía esa aritmética y podían discrepar.

### `sp_id`: el rastro del origen

Casi todas las tablas guardan el id del item de SharePoint. Sirve para
reconciliar durante la transición y para rastrear de dónde salió una fila. Se
puede borrar cuando SharePoint se apague.

Dos excepciones:

- **`proveedores`**: `sp_id` no es único. Varios items distintos de SharePoint
  traen el mismo NIT y colapsan en una sola fila —cinco pares por puntuación y
  nueve más por el dígito de verificación—. Un índice único ahí haría fallar el
  import.
- **`usuarios`**: el `ON CONFLICT` del import va contra el **correo**, no contra
  `sp_id`, porque el correo es la clave real. Con `sp_id`, reimportar después de
  que una persona cambia de fila choca contra `usuarios_email_key`.

### Números de documento nulos, no vacíos

`numero_oc` y `numero_os` admiten `NULL`. El número solo se asigna al aprobar;
en SharePoint las órdenes sin aprobar guardaban cadena vacía, y sobre eso no se
puede poner un índice único. En Postgres varios `NULL` conviven bajo `UNIQUE`,
así que el índice es parcial:

```sql
CREATE UNIQUE INDEX ordenes_compra_numero_key ON erp.ordenes_compra (numero_oc)
  WHERE numero_oc IS NOT NULL;
```

Y un `CHECK` impide que un documento aprobado se quede sin número, que era
imposible de rastrear en el consecutivo.

### Fechas del historial: las dos versiones

`HistorialPrecios.fecha` es una columna de **texto** en SharePoint, con cuatro
formatos conviviendo sobre las 5.496 filas:

| Formato | Filas |
|---|---:|
| `junio 23, 2026` | 3.721 |
| `23 de junio de 2026` | 1.562 |
| `2026-06-23` | 123 |
| `23/04/2026` | ~66 |

Se guardan las dos: `fecha` (tipo `date`, la interpretación) y `fecha_texto`
(el original sin tocar). Lo que no se pueda interpretar queda en `NULL` y el
dato crudo sigue ahí. En la carga actual se interpretaron las 5.496.

### Normalización

Dos funciones `IMMUTABLE`, para poder usarlas en índices:

- **`erp.norm(text)`** — mayúsculas, sin tildes, sin puntuación, espacios
  colapsados. Da la unicidad de proyectos por
  código e insumos por nombre.
- **`erp.norm_nit(text)`** — quita puntos, comas, espacios, el sufijo `.0` que
  deja Excel al leer un número como flotante, y el **dígito de verificación**.
  El `.0` se quita **antes** de borrar la puntuación, porque después ya no se
  distingue de un separador de miles.

  Quitar el dígito de verificación es seguro: es un checksum calculado de la
  raíz, así que para una raíz dada solo existe un dígito válido y dos NIT no
  pueden diferir únicamente en él. Sin eso, el mismo proveedor entraba dos veces
  —una con dígito y otra sin él— y su historial de compras quedaba partido.

Usa `translate()` y no la extensión `unaccent`, que es `STABLE` y no sirve en un
índice.

> Las mismas normalizaciones están replicadas en JavaScript en
> `revisar-listas.js` e `importar-listas.js`. **Si cambias una, cambia la otra**:
> si divergen, el chequeo previo reportaría cosas que la base no rechaza, o al
> revés. Se verificaron equivalentes sobre 2.137 nombres y 455 NIT reales.

### Llaves foráneas con catálogo tolerante

Los documentos referencian proyectos y proveedores por llave foránea real. Como
23 proyectos y 12 proveedores referenciados no estaban en su catálogo, el import
los crea con `activo = false` y `requiere_revision = true` en vez de fallar o de
perder la referencia.

### Zonas como tabla

Era un campo `choice` en tres listas. Como tabla se amplía sin tocar el esquema
de lo que la referencia. El import resuelve contra ella **sin distinguir
mayúsculas**, porque los proveedores traían `Centro` y `CENTRO` mezclados; lo
que no calce queda en `NULL` en vez de romper la llave.

## Numeración

`erp.contadores` con `UPDATE ... RETURNING`, no una `sequence`.

**Por qué no una sequence:** `nextval()` no es transaccional. Si la transacción
que pidió el número falla, el número queda consumido y el consecutivo salta.
Para una OC eso no sirve: es un documento con efectos contables y la serie debe
ser continua. Con una tabla, la fila queda bloqueada hasta el commit — dos
aprobaciones simultáneas se serializan y, si una falla, su número se devuelve.

Verificado: dos sesiones concurrentes, la segunda esperó 2,7 s al commit de la
primera y obtuvo el número siguiente, no el mismo.

**El bug que arregla:** `contador.js` toma `MAX()` excluyendo los estados
anulados, así que anular el documento más alto deja que el siguiente reutilice
su número. Ya pasó 16 veces. Acá el contador nunca retrocede y anular no libera
un número.

Funciones:

| Función | Devuelve |
|---|---|
| `erp.siguiente_numero_oc()` | `bigint` — el prefijo y el relleno los pone la app (`OC_PREFIX`, `OC_PAD`) |
| `erp.siguiente_numero_os()` | `bigint` |
| `erp.siguiente_numero_remision()` | `text` — `REM-00001` |
| `erp.siguiente_documento_almacen(tipo)` | `text` — `EA-0001` / `SA-0001` |
| `erp.siguiente_consecutivo_req(proyecto_id)` | `text` — el consecutivo del requerimiento **dentro de ese proyecto** |
| `erp.sincronizar_contadores()` | Deja cada contador en el número más alto ya emitido. **Solo se ejecuta una vez, después del import inicial** |

`sincronizar_contadores()` toma el máximo sobre **todos** los números, incluidos
los de documentos anulados. Ahí está la diferencia con `contador.js`.

### El consecutivo por proyecto

Cada proyecto numera sus requerimientos aparte, y ese contador vive en
`erp.proyectos.ultimo_consecutivo_req`. En SharePoint estaba en la columna
`ultimoConsecutivoReq` de la lista Proyectos y se incrementaba con concurrencia
optimista: leer el item con su ETag, escribir valor+1 con `If-Match`, reintentar
en 412, y caer a un contador en el SQLite local si fallaba por otra razón.

Ese respaldo explica por qué las dos fuentes no coincidían: SharePoint decía **9**
para `EQUIPOS GT 2026` cuando los requerimientos de ese proyecto ya llegaban a
**0012**. El contador de la lista se quedó atrás y nadie lo notó.

Por eso la siembra se tomó del máximo `consecutivo_sistema` realmente usado en
cada proyecto, y no del contador de SharePoint: sembrar de un contador atrasado
habría hecho que los siguientes requerimientos repitieran números ya emitidos.

La vista `erp.vw_numeros_duplicados` lista números repetidos. Con los índices
únicos puestos debería estar siempre vacía.

## Vistas de gasto

`Control Costos.xlsx` era una tabla de Excel con una fila por documento aprobado
y búsqueda lineal por número de OC. Los gastos no son un dato aparte —son los
documentos aprobados vistos por otro lado— así que se derivan.

**`erp.vw_gastos`** unifica tres orígenes en una sola forma de fila:

| `origen` | De dónde sale |
|---|---|
| `orden_compra` | `ordenes_compra` en estado aprobado |
| `orden_servicio` | `ordenes_servicio` en estado aprobado |
| `salida_almacen` | `movimientos_inventario` de salida, agrupados por `documento_ref` |

Columnas: `origen`, `origen_id`, `numero`, `fecha_documento`, `proyecto`,
`proveedor_nit`, `proveedor_nombre`, `tipo_gasto`, `subtotal`, `iva`, `total`,
`estado`, `fecha_aprobacion`, `fecha_pago`, `fecha_entrega`, `creado_por`.

Las salidas de almacén se agrupan porque un documento de almacén es un lote de
movimientos: una fila por insumo despachado, un solo gasto. Sin el `GROUP BY`
cada insumo contaría como un gasto propio y el total se inflaría.

Encima hay tres resúmenes, que antes eran hojas del libro calculadas a mano:

| Vista | Agrupa por |
|---|---|
| `erp.vw_gastos_por_proyecto` | proyecto |
| `erp.vw_gastos_por_proveedor` | NIT del proveedor |
| `erp.vw_gastos_por_tipo` | tipo de gasto |

Como son vistas y no tablas, no hay nada que sincronizar: el número que se lee
es el que sale de los documentos en ese momento. `controlCostos.js` reconstruye
el libro completo desde acá y lo sube a SharePoint como entregable.

## Proyectos: el catálogo y sus variantes

En SharePoint el proyecto era **texto libre** en cada documento. El nombre venía
del asunto del correo o de una celda del Excel, escrito a mano en obra, y nada
lo validaba. Así una misma obra llegó a existir con cuatro escrituras distintas.

En Postgres es `proyecto_id`, llave foránea a `erp.proyectos`. Un documento no
puede referenciar un proyecto que no existe — que es lo que permite, más
adelante, que un catálogo externo realmente gobierne.

### Los 23 aceptados

El import marcó 23 proyectos con `requiere_revision`: nombres que aparecían en
documentos y no en el catálogo. Se creó la fila para poder apuntar a algo y se
dejó señalada.

Se decidió **aceptarlos como proyectos propios**, no unificarlos. Dos razones:

- Varios nunca fueron duplicados. `BODEGA CIVILTECH` tiene 1.709 compras propias
  y `SST` 175: son centros de costo reales que nadie dio de alta.
- El catálogo va a venir de una fuente externa, y esa fuente no se ligará al
  histórico. Unificar contra el catálogo viejo sería trabajo que se descarta.

Quedan distinguibles por `sp_id IS NULL` —no venían de SharePoint— y el
histórico sigue ligado a ellos sin cambios.

**Lo que se acepta tiene un precio.** Una misma obra sigue apareciendo como
varias líneas en el informe: `CT26-034 LT Norte` muestra $210.658.038 y gastó
$237.368.780 repartidos en tres escrituras, un 12,7% menos. Y los nombres cortos
ahora ganan el emparejamiento exacto, así que quien escriba `MISTRAL` cae en el
proyecto llamado `mistral`, no en `CT25-134 ANCLAJES MISTRAL`. Son 12 pares así.

Ninguno de los 23 tiene zona, y se quedan sin ella por decisión. Sus documentos
usan historial nacional para sugerir proveedor, y el aviso lo dice.

### Por qué la marca vale más en cero

`requiere_revision` volvió a cero, así que ahora significa «alguien usó un
proyecto que nadie dio de alta». Con 23 filas aceptadas dentro, la marca era
ruido que nadie miraba. `npm run revisar-proyectos` dejó de ser una lista de
pendientes y pasó a ser un monitor.

Por eso la migración limpia una **lista escrita**, no todas las filas marcadas:
al aplicarse en el VPS sobre datos reimportados puede haber variantes nuevas, y
limpiarlas también escondería justo lo que hay que ver.

## Reglas que la base hace cumplir

30 `CHECK`, más las llaves foráneas y los índices únicos. Los que más importan:

| Regla | Constraint |
|---|---|
| Estados dentro de su conjunto | `*_estado_valido` en los 5 tipos de documento |
| Un aprobado tiene número | `ordenes_compra_aprobada_con_numero`, `ordenes_servicio_aprobada_con_numero` |
| Un servicio no termina antes de empezar | `ordenes_servicio_rango_fechas` |
| Ningún ítem sin descripción | `*_items_descripcion_no_vacia` |
| Porcentajes entre 0 y 100 | `orden_compra_items_pct_rango`, `orden_servicio_items_iva_rango` |
| Cantidad de inventario no negativa | `movimientos_cantidad_positiva` — el signo lo lleva `tipo` |
| NIT siempre normalizado | `proveedores_nit_normalizado` |
| Correo en minúsculas y con arroba | `usuarios_email_minuscula`, `usuarios_email_con_arroba` |

`revisar-listas.js` aplica estas mismas reglas contra SharePoint **antes** del
import, para que los rechazos aparezcan como una lista para corregir y no como
un error a mitad de la carga.

## Roles y permisos

Las migraciones las aplica el CLI con el rol `postgres`. La aplicación se
conecta con **`erp_app`**, que puede leer y escribir pero **no alterar el
esquema**: el DDL es exclusivo de las migraciones.

El rol lo crea la migración de permisos con `LOGIN` y **sin contraseña** —una
contraseña en un archivo de migración terminaría en git—. Cada entorno le asigna
la suya:

```sql
ALTER ROLE erp_app PASSWORD '...';
```

o, más simple, `npm run db:clave`, que la toma de `ERP_DB_PASSWORD`.

Verificado: `erp_app` inserta y emite consecutivos, pero recibe *permission
denied* en `CREATE TABLE` y `DROP TABLE`.

## Lo que no se migró, a propósito

| Campo de SharePoint | Por qué |
|---|---|
| `Requerimientos.ocsGeneradas` | Lista de ids en texto separada por comas; ya lo dice `ordenes_compra.requerimiento_id` |
| `Remisiones.ocsAsociadas` | Números en texto para mostrar; se deriva de `remision_ordenes` con un join |
| `@odata.etag`, `ContentType`, `Modified`, `_Compliance*`, … | Metadatos de la plataforma, no datos del negocio |

Y `sesiones` se queda en SQLite: es local y no tiene por qué viajar.
