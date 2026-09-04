#!/bin/sh
# respaldo-db.sh — Respaldo diario del Postgres del ERP.
#
# Con SharePoint la copia de seguridad la hacía Microsoft. Autoalojando, el
# respaldo es responsabilidad del VPS: sin esto, un disco perdido se lleva las
# órdenes de compra de la empresa. No es opcional.
#
# ── Instalación en el VPS ──────────────────────────────────────────────────
#   chmod +x deploy/respaldo-db.sh
#   crontab -e     y agregar (3:15 am hora de Bogotá):
#
#     15 3 * * * cd /ruta/al/proyecto && ./deploy/respaldo-db.sh >> logs/respaldo-db.log 2>&1
#
# Corre en el host y no dentro de un contenedor, a propósito: así puede usar
# docker exec y escribir en un directorio que sobreviva a "compose down".
#
# ── Restaurar ──────────────────────────────────────────────────────────────
#   gunzip -c respaldos/erp-2026-08-28.sql.gz | \
#     docker exec -i oc-automation-db psql -U postgres -d erp
#
# Sobre una base que ya tiene datos, primero:
#   docker exec -i oc-automation-db psql -U postgres -d erp -c 'DROP SCHEMA erp CASCADE'

set -eu

CONTENEDOR="${CONTENEDOR_DB:-oc-automation-db}"
BASE="${POSTGRES_DB:-erp}"
USUARIO="${POSTGRES_USER:-postgres}"
DESTINO="${DIR_RESPALDOS:-./respaldos}"
RETENCION_DIAS="${RETENCION_DIAS:-30}"

mkdir -p "$DESTINO"

fecha=$(date +%Y-%m-%d)
archivo="$DESTINO/${BASE}-${fecha}.sql.gz"
parcial="$archivo.parcial"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Respaldando $BASE desde $CONTENEDOR"

if ! docker exec "$CONTENEDOR" pg_isready -U "$USUARIO" -d "$BASE" >/dev/null 2>&1; then
  echo "ERROR: el contenedor $CONTENEDOR no responde. Respaldo abortado."
  exit 1
fi

# Se escribe a .parcial y solo al final se renombra: si el dump se corta a la
# mitad, no queda un archivo truncado con nombre de respaldo válido, que es la
# peor forma de perder datos — creer que hay copia y que no sirva.
docker exec "$CONTENEDOR" pg_dump \
  -U "$USUARIO" -d "$BASE" \
  --format=plain --no-owner --no-privileges \
  | gzip -9 > "$parcial"

# pg_dump vacío o casi vacío es señal de que algo falló sin devolver error.
tamano=$(wc -c < "$parcial")
if [ "$tamano" -lt 2048 ]; then
  echo "ERROR: el respaldo pesa solo ${tamano} bytes. Se descarta."
  rm -f "$parcial"
  exit 1
fi

mv "$parcial" "$archivo"
echo "  ✓ $archivo ($(echo "$tamano" | awk '{printf "%.1f MB", $1/1048576}'))"

# Verificación real: que el gzip esté completo y sea legible.
if gzip -t "$archivo" 2>/dev/null; then
  echo "  ✓ integridad del gzip verificada"
else
  echo "ERROR: el archivo está corrupto. Se elimina."
  rm -f "$archivo"
  exit 1
fi

borrados=$(find "$DESTINO" -name "${BASE}-*.sql.gz" -type f -mtime "+${RETENCION_DIAS}" -print -delete | wc -l)
[ "$borrados" -gt 0 ] && echo "  · $borrados respaldo(s) de más de ${RETENCION_DIAS} días eliminado(s)"

echo "  · quedan $(find "$DESTINO" -name "${BASE}-*.sql.gz" -type f | wc -l) respaldo(s) en $DESTINO"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Listo"
