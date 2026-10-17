#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "===================================================================="
echo "          LOOM - REINICIAR BASE DE DATOS A ESTADO LIMPIO"
echo "===================================================================="
echo ""

PKG_CMD="npm"
if command -v pnpm &> /dev/null; then
  PKG_CMD="pnpm"
fi

echo "[1/2] Verificando contenedor PostgreSQL..."
docker compose up -d postgres

echo "[2/2] Vaciando tablas y aplicando esquema fresco Drizzle..."
$PKG_CMD run db:reset

echo ""
echo "===================================================================="
echo "[OK] Base de datos reiniciada con exito."
echo "===================================================================="
