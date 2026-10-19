#!/usr/bin/env bash
set -e

# Change directory to script location
cd "$(dirname "$0")"

echo "===================================================================="
echo "          LOOM - SERVICE AND SERVER LAUNCHER"
echo "===================================================================="
echo ""

# 1. Package manager check
echo "[1/6] Checking Node.js and the package manager..."
if ! command -v node &> /dev/null; then
  echo "[ERROR] Node.js is not installed or not on the PATH."
  echo "        Please install Node.js 22 or newer."
  exit 1
fi

PKG_CMD="npm"
if command -v pnpm &> /dev/null; then
  PKG_CMD="pnpm"
fi
echo "[OK] Package manager: $PKG_CMD"
echo ""

# 2. Check .env
echo "[2/6] Checking the .env configuration file..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    echo "[INFO] .env not found. Copying .env.example..."
    cp .env.example .env
    echo "[OK] .env created."
  else
    echo "[WARNING] Neither .env nor .env.example found. Using defaults."
  fi
else
  echo "[OK] .env found."
fi

# 2.1 Auto-mount Obsidian Vault drive if located on an unmounted partition
VAULT_P=$(grep "^VAULT_PATH=" .env 2>/dev/null | cut -d '=' -f2-)
if [ -n "$VAULT_P" ] && [[ "$VAULT_P" =~ /run/media/[^/]+/([0-9A-Fa-f]+) ]]; then
  DISK_UUID="${BASH_REMATCH[1]}"
  if [ ! -d "$VAULT_P" ]; then
    echo "[INFO] The Obsidian vault drive ($DISK_UUID) is not mounted."
    echo "       Trying to mount it with udisksctl..."
    udisksctl mount -b "/dev/disk/by-uuid/$DISK_UUID" 2>/dev/null || true
  fi
fi
if [ -n "$VAULT_P" ] && [ -d "$VAULT_P" ]; then
  echo "[OK] Obsidian vault available at: $VAULT_P"
elif [ -n "$VAULT_P" ]; then
  echo "[WARNING] Cannot access the vault path: $VAULT_P"
fi
echo ""

# 3 & 4. Database check
DB_URL=$(grep "^DATABASE_URL=" .env | cut -d '=' -f2-)
if [ -n "$DB_URL" ] && ! echo "$DB_URL" | grep -qE "localhost|127\.0\.0\.1"; then
  echo "[3/6] Remote database configured in .env."
  echo "[4/6] Skipping local Docker (connecting to the remote database)."
else
  echo "[3/6] Checking Docker..."
  if ! docker info &> /dev/null; then
    echo "[ERROR] Docker Engine is not responding or you lack permission (try 'sudo systemctl start docker')."
    exit 1
  fi
  echo "[OK] Docker Engine is running."

  echo "[4/6] Starting PostgreSQL with pgvector..."
  docker compose up -d postgres
  for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U loom -d loomdb &> /dev/null; then
      echo "[OK] PostgreSQL with pgvector is ready on port 5432."
      break
    fi
    sleep 1
  done
fi
echo ""

# 5. Database migrations
echo "[5/6] Applying database migrations..."
if ! $PKG_CMD run db:migrate; then
  echo "[ERROR] The migration failed. Check that PostgreSQL is running (docker compose up -d postgres)."
  exit 1
fi
echo ""

# 6. Ollama & models
echo "[6/6] Checking Ollama (port 11434)..."
if curl -s -m 2 http://localhost:11434/api/tags &> /dev/null; then
  echo "[OK] Ollama is responding at http://localhost:11434."
else
  if command -v ollama &> /dev/null; then
    echo "[INFO] Starting Ollama in the background..."
    ollama serve &> /dev/null &
    sleep 3
  else
    echo "[WARNING] Ollama is not installed or not on the PATH."
  fi
fi

if curl -s http://localhost:11434/api/tags 2>/dev/null | grep -qi "bge-m3"; then
  echo "[OK] Embedding model 'bge-m3' found."
else
  echo "[WARNING] Model 'bge-m3' not found. Download it with: ollama pull bge-m3"
fi
echo ""

# Final preflight: lists exactly what is missing (models, vault, schema) with the command to fix it
echo "Running the final check (preflight)..."
if ! $PKG_CMD run preflight; then
  echo ""
  echo "[ERROR] Requirements are missing. Fix what is listed above and run ./start.sh again."
  exit 1
fi
echo ""

echo "===================================================================="
echo "          ALL SERVICES READY"
echo "===================================================================="
echo "  * Loom web server:     http://127.0.0.1:3000"
echo "  * Database:            PostgreSQL + pgvector (port 5432)"
echo "  * Local LLM:           Ollama (port 11434)"
echo "===================================================================="
echo ""

# Open browser if xdg-open exists
if command -v xdg-open &> /dev/null; then
  (sleep 2 && xdg-open http://127.0.0.1:3000 &> /dev/null) &
fi

echo "Starting the Loom server (Ctrl+C to stop)..."
echo ""
$PKG_CMD run dev
