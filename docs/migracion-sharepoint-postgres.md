# Migración de SharePoint a Postgres

## Por qué

El ERP tenía cinco fuentes de datos repartidas: once listas de SharePoint, un
libro de Excel (`Control Costos.xlsx`), tres CSV en `data/`, y un SQLite local
que hacía de caché de lectura. SharePoint era la fuente de verdad y el SQLite
existía únicamente porque leer por Microsoft Graph tarda cientos de
milisegundos y la consola no podía esperar eso en cada pantalla.

Ese montaje tiene tres problemas de fondo:

- **SharePoint no valida nada.** No hay unicidad, ni llaves foráneas, ni tipos
  estrictos. Los datos se degradan sin que nada avise.
- **La aplicación no puede consultar.** Sumar por insumo o por proveedor obliga
  a bajar todos los documentos y recorrerlos en memoria, porque los ítems viven
  dentro de un string JSON.
- **El caché puede quedar viejo** y nadie se entera hasta que una cuenta no da.

## Alcance

Se migran **los datos**. Los archivos no: los PDF de respaldo de OC, OS y
requerimientos siguen subiéndose al Drive de SharePoint, que es donde la gente
ya los busca.

Conviene distinguir qué es fuente de datos y qué no, porque no todo el Excel
del sistema desaparece:

| No es fuente de datos | Qué es |
|---|---|
| El requerimiento que llega por correo | Formato de **entrada**. La gente de obra seguirá llenándolo en Excel |
| `data/CT-ADMIN-FO-002...xlsx`, `plantilla_oc.xlsx` | Plantillas |
| Los `.xlsx` que generan `ocTemplate.js` y compañía | **Salida**, entregables |
| Los PDF en `/OrdenesCompraPDF/` | Archivos, no datos |

De `graphStorage.js` sobreviven tres cosas: la autenticación, el Drive y la
lectura del buzón.

## Decisiones

### Postgres autoalojado en Docker

Se descartó Supabase alojado por límite de espacio en la cuenta. La base corre
en Docker: en el equipo local con `docker-compose.dev.yml`, y en el VPS como un
servicio más del `docker-compose.yml`.

En el VPS no publica puertos y vive en una red interna, así que solo la app y el
mailer la alcanzan. Sus datos van a un volumen con nombre (`oc-automation-pgdata`)
y no a `./data`, que es lo que el workflow de despliegue sincroniza con rsync.

Del CLI de Supabase se conserva **solo el motor de migraciones**: funciona
contra cualquier Postgres con `--db-url`, mantiene su tabla de rastreo y evita
escribir un runner propio. Queda fijado como `devDependency`.

### El caché SQLite se eliminó

Consecuencia de autoalojar. `db.js` y `syncService.js` eran 893 líneas que
existían para esquivar la latencia de SharePoint. Con Postgres en el mismo host
—localhost en desarrollo, la red interna de Docker en el VPS— una consulta tarda
menos de un milisegundo.

**Hecho.** `syncService.js` se borró completo y `db.js` pasó de 737 líneas y 43
funciones a 124 y 6: solo queda lo que tiene sentido guardar en la máquina, que
son las sesiones y el mapeo de proyectos hacia tesorería.

Lo que decidió borrarlo en vez de dejarlo «por seguridad» fueron las cifras: el
sync bajaba ~10.500 filas cada 2 minutos —32 segundos por ciclo— hacia diez
tablas con **cero lectores**. Código que se ejecuta no es una red de seguridad,
es un segundo sistema: los nombres de `db.js` seguían funcionando, así que
escribir `localDb.getOrdenesCompra()` por costumbre habría devuelto datos viejos
sin ningún error.

Peores eran las cuatro `asegurarLista*()`, que no estaban inertes: **creaban
listas y columnas en SharePoint en cada arranque del servidor**, en el sistema
del que estamos saliendo.

Con ellos se fueron el sync cada 2 minutos, la ventana en que el caché quedaba
viejo, las rutas `/sync` y `/sync/estado`, y el `syncAll()` que `contador.js`
llamaba antes de leer el consecutivo. El arranque del servidor quedó en tres
líneas de log.

La red de seguridad real es otra: las listas de SharePoint con sus datos
intactos, los `pg_dump` diarios, y el historial de git — borrar código no es
perderlo.

### Qué scripts se retiraron y cuáles no

Se borraron los que solo servían para **crear o poblar estructuras en
SharePoint**: `crear-listas`, `esquemas`, `migrarCSV`, `migrarOC`,
`migrar-proveedores`, `provisionar-proyectos`, `cargar-insumos`, `init-sqlite`
y `limpiar-ocs-prueba`. Migrar de vuelta no es un escenario real, así que
conservarlos para invocación manual no aportaba nada.

Los tres `backfill-pdf-*` **no eran de esa categoría** y se migraron en vez de
borrarse: generan el PDF de respaldo de documentos que quedaron sin uno, y los
PDF se quedan en SharePoint por la decisión de alcance. Ahora leen de Postgres.

Quedan dos pendientes de decisión: `crear-control-costos.js`, que se va con la
etapa 1 de abajo, y `wipe-datos-prueba.js`, que aún apunta a SharePoint y habría
que repuntar si se quiere conservar como herramienta.

### Sin doble escritura: corte directo

El plan original contemplaba una etapa de escritura simultánea a SharePoint y
Postgres, con un script que comparara las dos a diario. Se descartó: una vez que
Postgres funcione no hay razón para seguir escribiendo en SharePoint.

Eso quita la etapa de convivencia, el script de comparación y el código de
escritura espejo. A cambio no hay vuelta atrás gradual, y eso se cubre así:

- Producción sigue en SharePoint mientras se desarrolla, así que hay una
  referencia viva contra la cual comparar pantalla por pantalla.
- El import es idempotente y tarda segundos. El día del corte: importar y
  desplegar, en ese orden. La ventana en que SharePoint podría recibir algo que
  Postgres no vea son minutos.
- Si algo sale mal, revertir el despliegue deja todo como estaba: SharePoint
  nunca se tocó.

**El orden importa: import primero, despliegue después.**

## Qué se encontró en los datos

SharePoint no valida, así que la migración fue la primera revisión seria que
recibieron estos datos. Lo que apareció:

### Números de documento repetidos

11 números de OC, 5 de OS y 1 de remisión, todos duplicados. Las OC y OS tenían
la misma causa: `contador.js` calcula el siguiente número como `MAX()`
excluyendo los anulados, así que al anular el documento más alto el siguiente
reutilizaba su número. `0072` y `0075` llegaron a tener tres documentos cada uno.

La remisión venía de otro lado: el número salía de `existentes.length + 1`, así
que dos creadas en el mismo segundo obtenían el mismo. `REM-00011` eran dos
remisiones byte a byte idénticas creadas con un segundo de diferencia — un doble
clic en el formulario.

**El esquema nuevo hace las dos cosas imposibles.** Ver "Numeración" en
[esquema-erp.md](esquema-erp.md).

Los 17 casos se corrigieron en el origen con `npm run corregir-listas`: 20
ediciones sobre SharePoint, ninguna destructiva. Los números de documentos
anulados pasaron a `0036-A`, `0072-B`; la remisión duplicada se marcó anulada
con el motivo en vez de borrarse; y las fechas de `OS-0095` se intercambiaron.

Se corrigió el origen y no el import a propósito: SharePoint sigue siendo la
fuente de verdad hasta el corte, y un parche que viviera solo en el import haría
que cada reimportación lo volviera a aplicar mientras las dos bases divergen.

### Una orden de servicio que terminaba antes de empezar

`OS-0095`: inicio 2026-08-13, fin 2026-08-06. Error de digitación, corregido
intercambiando las dos fechas — que no inventa ni descarta ninguna.

### Ítems de OC con dos formas distintas

Según por dónde se creara la orden, el ítem traía el nombre bajo la clave
`descripcion` (alta manual) o bajo `insumo` (generado desde un requerimiento).
El código lo parcheaba en nueve lugares con `it.descripcion || it.insumo`. En la
carga actual, **549 de 1.261 ítems** venían con la segunda forma. Ahora hay una
sola columna.

### Proveedores duplicados, en dos capas

Cinco pares colapsan al normalizar la puntuación: `900.807.426-3`,
`800,118,549-1` y `811017552.0` son tres formatos del mismo dato.

Y **nueve pares más** aparecieron después: el mismo proveedor registrado una vez
con dígito de verificación y otra sin él. `DISTRIBUCIONES TOOLS MED` tenía 66
órdenes bajo `901413646` y 3 bajo `901413646-9`.

Eso no es cosmético: `consultaProveedor.js` sugiere proveedor y precio a partir
del historial, y con la historia partida en dos las sugerencias empeoran.

Quitar el dígito es seguro porque es un **checksum calculado de la raíz**: para
una raíz dada solo existe un dígito válido, así que dos NIT no pueden diferir
únicamente en él y fusionar por raíz no puede unir dos empresas distintas. Se
verificó además que los nueve pares tuvieran razón social coincidente, y
`nit_original` conserva la forma como venía escrita.

La migración repunta los documentos, consolida los campos con `COALESCE` —si a
la fila que queda le falta el teléfono, lo toma de la otra— y solo entonces
reemplaza la función. Resultado: 433 proveedores pasan a 424, `TOOLS MED`
consolida sus 69 órdenes, y los conteos de documentos no cambian.

### Usuarios con varias filas por correo

`lfelizzola@civiltechic.com` tenía ocho filas en `UsuariosERP`, con rol y estado
distintos entre ellas. La regla correcta es que gana **la más reciente**, igual
que hacía `bulkUpsertUsuarios()` en el caché. La regla contraria concedía permisos
que el registro vigente no da.

Queda un caso sin resolver que necesita decisión humana:
`svargas@civiltechic.com` aparece con **dos nombres distintos** (Carolina Vargas
y Sandra Vargas). Son dos personas compartiendo un login. Como `creadoPor` queda
escrito en cada OC, requerimiento y remisión, la trazabilidad de quién hizo qué
se pierde entre las dos. Si son dos personas, necesitan correos separados.

### Referencias fuera del catálogo

23 proyectos y 12 proveedores referenciados por documentos no existían en su
catálogo. El import los crea con `activo = false` y `requiere_revision = true`
para no perder la referencia, pero hay que revisarlos: varios son el mismo
proyecto escrito distinto.

```sql
SELECT codigo FROM erp.proyectos WHERE requiere_revision ORDER BY codigo;
SELECT nit, razon_social FROM erp.proveedores WHERE requiere_revision;
```

`CT26-034LT ZIPAQUIRA Norte 230KV - JE Jaimes` y
`CT26-034 LT Norte 230 KV-JE Jaimes` son uno solo. `EQUIPOS GT 20026` tiene un
dígito de más. `IZZI96` probablemente es `CT26-041 Micropilotes IZZI96-COALA`.

Fusionarlos es trabajo de catálogo, no de migración, y no bloquea nada.

## Resultado de la carga

12.584 filas, 691 documentos. Las comprobaciones que importan:

| Comprobación | Resultado |
|---|---|
| Ítems que suman el subtotal e IVA de su cabecera | **282 de 282** órdenes de compra |
| Total de OC, origen contra destino | $730.726.113,6 en ambos |
| Números de documento duplicados | 0 |
| Fechas del historial sin interpretar | 0 de 5.496 |

## La capa de repositorio

Al empezar, `servidor-cotizaciones.js` llamaba a Microsoft Graph directamente en
88 lugares, más 10 en `requerimientos.js` y el resto en `contador.js`,
`configApp.js` y `controlCostos.js`: **105 puntos de llamada** que conocían la
forma de una lista de SharePoint. Mientras eso siguiera así, la aplicación no
podía leer de Postgres por más completa que estuviera la base.

`src/repo/` es la capa que faltaba. Dos reglas la mantienen útil: **fuera de
`src/repo/` no se escribe SQL, y ahí adentro no se toman decisiones de negocio.**
Los valores por defecto, el ensamblado y las reglas siguen en los módulos de
dominio.

Como no hay doble escritura, cada módulo se escribió **directo contra Postgres**:
una implementación en vez de dos.

| Módulo | Cubre |
|---|---|
| `repo/configuracion.js` | Logo, emisor, firmante, IVA por defecto |
| `repo/catalogos.js` | Proveedores, proyectos, insumos, usuarios |
| `repo/requerimientos.js` | Requerimientos y sus ítems |
| `repo/ordenesCompra.js` | OC, sus ítems y la emisión del consecutivo |
| `repo/ordenesServicio.js` | OS con AIU y tipo de contrato |
| `repo/remisiones.js` | Remisiones, ítems y el vínculo con las OC |
| `repo/inventario.js` | Movimientos, stock y consecutivo de almacén |

### El truco que hizo el cambio mecánico

El servidor accede a `reqItem.fields.X` en decenas de lugares, porque así venía
el item de SharePoint. Cada repo devuelve un objeto **plano con esos mismos
nombres de campo**, y un adaptador de tres líneas lo envuelve en `{ id, fields }`:

```js
async function obtenerOC(id) {
  const o = await repoOrdenesCompra.obtener(id);
  if (!o) throw new Error(`Orden de compra ${id} no existe`);
  return { id: o.id, fields: o };
}
```

Eso convirtió 21 llamadas de requerimientos y 26 de órdenes de compra en un
reemplazo mecánico, en vez de reescribir cada acceso.

Los ítems son el otro caso: viven en tablas hijas, pero las funciones de lectura
vuelven a armar `itemsJson` como string con la forma exacta que tenía. La consola
y las plantillas quedaron sin tocar.

### Una clase de bug que aparece al migrar

Convertir `{ id, fields }` en un objeto plano hace que `actualizado.fields || {}`
**no lance error**: devuelve `{}` y el valor queda `undefined` en silencio. Se
encontraron y corrigieron varios así —el número de OC para Control de Costos, la
cascada de anulación de remisiones, el id del requerimiento— buscando `.fields`
sobre las variables ya migradas.

Vale tenerlo presente en lo que falta: el síntoma no es un crash, es un dato que
desaparece.

### Un bug que salió al migrar el historial de precios

El caché ordenaba el historial por una columna de **texto**, así que
"septiembre 9, 2025" quedaba antes que "agosto 28, 2026" — alfabéticamente, no
cronológicamente. `consultaProveedor.js` toma las 3 compras más recientes para
sugerir proveedor y precio, así que llevaba tiempo eligiendo las equivocadas.
Ordenar por una columna `date` lo arregla.

### Esta capa está cerrada

Cero operaciones de datos por Graph. Fuera de `graphStorage.js` no queda un solo
`addListItem`, `updateListItem`, `getListItem` ni `getListItems` en la
aplicación, y ninguna lectura de documentos o catálogos sale del caché.

## Qué falta

### 1. Control de Costos

`registrarGasto()` y `actualizarFila()` en `controlCostos.js` escriben en un
libro de Excel de SharePoint con búsqueda lineal por número de OC. Con los
documentos ya tipados, el control de costos es una vista derivada de
`ordenes_compra` y `ordenes_servicio`. Se conserva la salida: una ruta que
exporta la vista a `.xlsx` con ExcelJS y la sube al mismo sitio. El Excel pasa
de ser base de datos a ser reporte.

### 2. Retirar los CSV

`consultaProveedor.js` ya acepta los datos precargados, así que `loadCSV()` y
`cargarDatosCSV()` se borran sin tocar la lógica de selección de proveedor.
Salen `PATH_COMPRAS`, `PATH_PROVEEDORES` y `PATH_PROYECTOS` del `.env`, del
README y de `test.js`. Los tres archivos se archivan, no se borran.

### 3. Postgres en el VPS

El servicio ya está definido en `docker-compose.yml`. Falta levantarlo, crear el
rol, migrar, importar y dejar el respaldo en el cron del host. Ver
[operacion-base-de-datos.md](operacion-base-de-datos.md).
