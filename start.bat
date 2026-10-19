@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ====================================================================
echo           REKINDLE - SERVICE AND SERVER LAUNCHER
echo ====================================================================
echo.

REM --------------------------------------------------------------------
REM 1. Verificacion de Node.js y Gestor de Paquetes
REM --------------------------------------------------------------------
echo [1/6] Checking Node.js and the package manager...
where node >nul 2>&1
if %ERRORLEVEL% equ 0 goto NODE_OK

echo [ERROR] Node.js is not installed or not on the PATH.
echo         Please install Node.js 22 or newer.
pause
exit /b 1

:NODE_OK
set "PKG_CMD=npm.cmd"
where pnpm.cmd >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PKG_CMD=pnpm.cmd"
) else (
    where pnpm >nul 2>&1
    if %ERRORLEVEL% equ 0 set "PKG_CMD=pnpm"
)

echo [OK] Package manager: %PKG_CMD%
echo.

REM --------------------------------------------------------------------
REM 2. Verificacion de archivo .env
REM --------------------------------------------------------------------
echo [2/6] Checking the .env configuration file...
if exist ".env" (
    echo [OK] .env found.
    goto ENV_DONE
)

if exist ".env.example" (
    echo [INFO] .env not found. Copying .env.example...
    copy /y ".env.example" ".env" >nul
    echo [OK] .env created.
    goto ENV_DONE
)

echo [WARNING] Neither .env nor .env.example found. Using defaults.

:ENV_DONE
echo.

REM --------------------------------------------------------------------
REM 3 & 4. Verificacion de Base de Datos
REM --------------------------------------------------------------------
set "IS_REMOTE_DB="
findstr /i /r "^DATABASE_URL=.*supabase.* ^DATABASE_URL=.*aws-.*" .env >nul 2>&1
if %ERRORLEVEL% equ 0 set "IS_REMOTE_DB=1"

if defined IS_REMOTE_DB (
    echo [3/6] Remote database configured in .env.
    echo [4/6] Skipping local Docker (connecting to the remote database).
    goto PG_READY
)

REM --------------------------------------------------------------------
REM 3. Verificacion y Arranque de Docker
REM --------------------------------------------------------------------
echo [3/6] Checking Docker Engine...
docker info >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Docker Engine is already running.
    goto DOCKER_READY
)

echo [INFO] Docker Engine is not responding. Looking for Docker Desktop...
set "DOCKER_EXE=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
if not exist "!DOCKER_EXE!" set "DOCKER_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"

if not exist "!DOCKER_EXE!" goto DOCKER_MANUAL

echo [INFO] Starting Docker Desktop in the background...
start "" "!DOCKER_EXE!"
echo [INFO] Waiting for Docker Engine to start (up to 75 s)...

set /a DOCKER_WAIT=0

:WAIT_DOCKER_LOOP
ping 127.0.0.1 -n 4 >nul
docker info >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Docker Engine started.
    goto DOCKER_READY
)
set /a DOCKER_WAIT+=3
if !DOCKER_WAIT! lss 75 goto WAIT_DOCKER_LOOP

echo.
echo [ERROR] Docker Desktop is taking long to start.
echo         Please open Docker Desktop manually.
pause
goto DOCKER_CHECK_FINAL

:DOCKER_MANUAL
echo [ERROR] Could not find the Docker Desktop executable.
echo         Please open Docker Desktop manually.
pause

:DOCKER_CHECK_FINAL
docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Could not connect to Docker Engine. Exiting...
    pause
    exit /b 1
)

:DOCKER_READY
echo.

REM --------------------------------------------------------------------
REM 4. Levantamiento de PostgreSQL con pgvector
REM --------------------------------------------------------------------
echo [4/6] Starting PostgreSQL with pgvector (docker compose)...
docker compose up -d postgres
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 'docker compose up -d postgres' failed.
    echo         Check that Docker is running and try again.
    pause
    exit /b 1
)

echo [INFO] Waiting for PostgreSQL to accept connections...
set /a PG_WAIT=0

:WAIT_PG_LOOP
ping 127.0.0.1 -n 2 >nul
docker compose exec -T postgres pg_isready -U rekindle -d rekindledb >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] PostgreSQL with pgvector is ready on port 5432.
    goto PG_READY
)
set /a PG_WAIT+=1
if !PG_WAIT! lss 25 goto WAIT_PG_LOOP

echo [WARNING] PostgreSQL is slow to respond. Continuing...

:PG_READY
echo.

REM --------------------------------------------------------------------
REM 5. Migraciones Drizzle
REM --------------------------------------------------------------------
echo [5/6] Applying database migrations...
call !PKG_CMD! run db:migrate
if %ERRORLEVEL% neq 0 (
    echo [ERROR] The migration failed. Check that PostgreSQL is running.
    pause
    exit /b 1
)
echo [OK] Database schema is up to date.
echo.

REM --------------------------------------------------------------------
REM 6. Verificacion de Ollama (IA Local)
REM --------------------------------------------------------------------
echo [6/6] Checking Ollama (port 11434)...
curl.exe -s -m 2 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Ollama is responding at http://localhost:11434.
    goto CHECK_MODELS
)

echo [INFO] Ollama is not responding. Trying to start it...
where ollama >nul 2>&1
if %ERRORLEVEL% neq 0 goto OLLAMA_NOT_FOUND

start "" ollama serve
ping 127.0.0.1 -n 4 >nul
curl.exe -s -m 2 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Ollama started.
    goto CHECK_MODELS
)

:OLLAMA_NOT_FOUND
echo [WARNING] Ollama is not available on port 11434.
echo               Rekindle will start, but summaries and AI triage need Ollama.
goto OLLAMA_DONE

:CHECK_MODELS
curl.exe -s http://localhost:11434/api/tags | findstr /i "bge-m3" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Embedding model 'bge-m3' found.
) else (
    echo [WARNING] Model 'bge-m3' not found. Download it with: ollama pull bge-m3
)

curl.exe -s http://localhost:11434/api/tags | findstr /i "qwen2.5:7b-instruct" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Language model 'qwen2.5:7b-instruct' found.
) else (
    echo [WARNING] Model 'qwen2.5:7b-instruct' not found. Download it with: ollama pull qwen2.5:7b-instruct
)

:OLLAMA_DONE
echo.

REM --------------------------------------------------------------------
REM Verificacion final: indica que falta y como corregirlo
REM --------------------------------------------------------------------
call !PKG_CMD! run preflight
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Requirements are missing. Fix what is listed above and run start.bat again.
    pause
    exit /b 1
)

REM --------------------------------------------------------------------
REM Resumen final y arranque
REM --------------------------------------------------------------------
echo ====================================================================
echo           ALL SERVICES READY
echo ====================================================================
echo   * Rekindle web server:     http://127.0.0.1:3000
echo   * Database:            PostgreSQL + pgvector (port 5432)
echo   * Local LLM:           Ollama (port 11434)
echo ====================================================================
echo.
echo Opening the browser at http://127.0.0.1:3000 shortly...
start "" cmd /c "ping 127.0.0.1 -n 5 >nul & start http://127.0.0.1:3000"

echo.
echo Starting the Rekindle server (Ctrl+C to stop)...
echo.
call !PKG_CMD! run dev
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] The server process exited with error code %ERRORLEVEL%.
    pause
)
