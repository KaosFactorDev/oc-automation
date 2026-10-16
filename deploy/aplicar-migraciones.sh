#!/usr/bin/env bash
# Aplica las migraciones pendientes de supabase/migrations sobre la base del VPS.
#
# Lo corre el workflow de deploy (.github/workflows/deploy.yml) DESPUÉS de
# sincronizar el código y ANTES de reconstruir los contenedores. Así:
#   · el código nuevo nunca arranca contra un esquema viejo, y
#   · si una migración falla, el deploy se detiene sin reconstruir: la versión
#     anterior sigue corriendo y la base queda como estaba (cada migración va en
#     su transacción).
#
# Se apoya en la misma tabla que usa `npm run db:push` (el CLI de Supabase),
# supabase_migrations.schema_migrations, así que los dos caminos son
# intercambiables: lo que aplicó uno, el otro lo da por aplicado.
#
# Uso (en el VPS, desde la carpeta del proyecto):
#   deploy/aplicar-migraciones.sh              aplica las pendientes
#   deploy/aplicar-migraciones.sh --en-seco    solo las lista
#
# Variables opcionales: DB_CONTAINER (default oc-automation-db), DB_NAME (erp).

set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-oc-automation-db}"
DB_NAME="${DB_NAME:-erp}"
EN_SECO=0
[ "${1:-}" = "--en-seco" ] && EN_SECO=1

if [ ! -d supabase/migrations ]; then
  echo "Hay que correrlo desde la carpeta del proyecto (no encuentro supabase/migrations)." >&2
  exit 1
fi

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -q -U postgres -d "$DB_NAME" "$@"
}

# La tabla de registro, por si la base es nueva (en el VPS ya existe: la creó
# el CLI). Mismas columnas que crea el CLI.
psql_db <<'SQL'
SET client_min_messages TO warning;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version    text PRIMARY KEY,
  statements text[],
  name       text
);
SQL

aplicadas="$(psql_db -At -c 'SELECT version FROM supabase_migrations.schema_migrations')"

pendientes=()
for archivo in $(ls supabase/migrations/*.sql | sort); do
  base="$(basename "$archivo")"
  version="${base%%_*}"
  if ! grep -qx "$version" <<<"$aplicadas"; then
    pendientes+=("$archivo")
  fi
done

if [ "${#pendientes[@]}" -eq 0 ]; then
  echo "Migraciones: ninguna pendiente."
  exit 0
fi

echo "Migraciones pendientes (${#pendientes[@]}):"
printf '  · %s\n' "${pendientes[@]##*/}"
[ "$EN_SECO" -eq 1 ] && exit 0

for archivo in "${pendientes[@]}"; do
  base="$(basename "$archivo")"
  version="${base%%_*}"
  nombre="${base#*_}"; nombre="${nombre%.sql}"
  registro="INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${version}', '${nombre//\'/\'\'}');"

  echo "Aplicando ${base}…"
  if grep -qiE '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$archivo"; then
    # La migración maneja su propia transacción: se respeta, y el registro va
    # después. Si falla, ON_ERROR_STOP corta antes de registrarla.
    psql_db < "$archivo"
    psql_db -c "$registro"
  else
    # Migración y registro en UNA transacción: o quedan las dos, o ninguna.
    { echo 'BEGIN;'; cat "$archivo"; echo; echo "$registro"; echo 'COMMIT;'; } | psql_db
  fi
done

echo "Migraciones aplicadas: ${#pendientes[@]}."
