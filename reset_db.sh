#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "===================================================================="
echo "          LOOM - RESET THE DATABASE TO A CLEAN STATE"
echo "===================================================================="
echo ""

PKG_CMD="npm"
if command -v pnpm &> /dev/null; then
  PKG_CMD="pnpm"
fi

echo "[1/2] Checking the PostgreSQL container..."
docker compose up -d postgres

echo "[2/2] Dropping the tables and applying a fresh schema..."
$PKG_CMD run db:reset

echo ""
echo "===================================================================="
echo "[OK] Database reset."
echo "===================================================================="
