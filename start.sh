#!/usr/bin/env bash
set -e

# Change directory to script location
cd "$(dirname "$0")"

echo "===================================================================="
echo "          LOOM - INICIADOR DE SERVICIOS Y SERVIDOR"
echo "===================================================================="
echo ""

# 1. Package manager check
echo "[1/6] Verificando entorno Node.js y gestor de paquetes..."
if ! command -v node &> /dev/null; then
  echo "[ERROR] Node.js no está instalado o no se encuentra en el PATH."
  echo "        Por favor instala Node.js (v22 o superior)."
  exit 1
fi

PKG_CMD="npm"
if command -v pnpm &> /dev/null; then
  PKG_CMD="pnpm"
fi
echo "[OK] Gestor de paquetes detectado: $PKG_CMD"
echo ""

# 2. Check .env
echo "[2/6] Verificando archivo de configuracion .env..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    echo "[INFO] Archivo .env no encontrado. Creando copia a partir de .env.example..."
    cp .env.example .env
    echo "[OK] Archivo .env generado."
  else
    echo "[ADVERTENCIA] No se encontro .env ni .env.example. Usando valores por defecto."
  fi
else
  echo "[OK] Archivo .env detectado."
fi

# 2.1 Auto-mount Obsidian Vault drive if located on an unmounted partition
VAULT_P=$(grep "^VAULT_PATH=" .env 2>/dev/null | cut -d '=' -f2-)
if [ -n "$VAULT_P" ] && [[ "$VAULT_P" =~ /run/media/[^/]+/([0-9A-Fa-f]+) ]]; then
  DISK_UUID="${BASH_REMATCH[1]}"
  if [ ! -d "$VAULT_P" ]; then
    echo "[INFO] La unidad de disco de Obsidian ($DISK_UUID) no está montada."
    echo "       Intentando montar automáticamente con udisksctl..."
    udisksctl mount -b "/dev/disk/by-uuid/$DISK_UUID" 2>/dev/null || true
  fi
fi
if [ -n "$VAULT_P" ] && [ -d "$VAULT_P" ]; then
  echo "[OK] Obsidian Vault accesible en: $VAULT_P"
elif [ -n "$VAULT_P" ]; then
  echo "[ADVERTENCIA] No se pudo acceder a la ruta del Vault: $VAULT_P"
fi
echo ""

# 3 & 4. Database check
DB_URL=$(grep "^DATABASE_URL=" .env | cut -d '=' -f2-)
if [ -n "$DB_URL" ] && ! echo "$DB_URL" | grep -qE "localhost|127\.0\.0\.1"; then
  echo "[3/6] Base de datos remota detectada en .env."
  echo "[4/6] Omitiendo Docker local (conectando directamente a la nube)."
else
  echo "[3/6] Verificando estado de Docker..."
  if ! docker info &> /dev/null; then
    echo "[ERROR] Docker Engine no responde o no tienes permisos (prueba 'sudo systemctl start docker')."
    exit 1
  fi
  echo "[OK] Docker Engine en ejecución."

  echo "[4/6] Levantando base de datos PostgreSQL con pgvector..."
  docker compose up -d postgres
  for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U loom -d loomdb &> /dev/null; then
      echo "[OK] PostgreSQL con pgvector listo en el puerto 5432."
      break
    fi
    sleep 1
  done
fi
echo ""

# 5. Database migrations
echo "[5/6] Verificando esquema de base de datos Drizzle..."
if ! $PKG_CMD run db:migrate; then
  echo "[ERROR] La migración falló. Revisa que PostgreSQL esté activo (docker compose up -d postgres)."
  exit 1
fi
echo ""

# 6. Ollama & models
echo "[6/6] Verificando servicio de inferencia Ollama (puerto 11434)..."
if curl -s -m 2 http://localhost:11434/api/tags &> /dev/null; then
  echo "[OK] Ollama activo y respondiendo en http://localhost:11434."
else
  if command -v ollama &> /dev/null; then
    echo "[INFO] Iniciando Ollama en segundo plano..."
    ollama serve &> /dev/null &
    sleep 3
  else
    echo "[ADVERTENCIA] Ollama no está instalado o en el PATH."
  fi
fi

if curl -s http://localhost:11434/api/tags 2>/dev/null | grep -qi "bge-m3"; then
  echo "[OK] Modelo de embeddings 'bge-m3' detectado."
else
  echo "[ADVERTENCIA] Modelo 'bge-m3' no encontrado. Puedes descargarlo con: ollama pull bge-m3"
fi
echo ""

# Final preflight: lists exactly what is missing (models, vault, schema) with the command to fix it
echo "Ejecutando verificación final (preflight)..."
if ! $PKG_CMD run preflight; then
  echo ""
  echo "[ERROR] Faltan requisitos. Corrige lo indicado arriba y vuelve a ejecutar ./start.sh."
  exit 1
fi
echo ""

echo "===================================================================="
echo "          TODOS LOS SERVICIOS PREPARADOS CON EXITO"
echo "===================================================================="
echo "  * Servidor Web Loom:   http://127.0.0.1:3000"
echo "  * Base de Datos:       PostgreSQL + pgvector (Puerto 5432)"
echo "  * LLM Local:           Ollama (Puerto 11434)"
echo "===================================================================="
echo ""

# Open browser if xdg-open exists
if command -v xdg-open &> /dev/null; then
  (sleep 2 && xdg-open http://127.0.0.1:3000 &> /dev/null) &
fi

echo "Iniciando servidor Loom (Presiona Ctrl+C para detener)..."
echo ""
$PKG_CMD run dev
