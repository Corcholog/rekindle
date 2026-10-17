@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ====================================================================
echo           LOOM - INICIADOR DE SERVICIOS Y SERVIDOR
echo ====================================================================
echo.

REM --------------------------------------------------------------------
REM 1. Verificacion de Node.js y Gestor de Paquetes
REM --------------------------------------------------------------------
echo [1/6] Verificando entorno Node.js y gestor de paquetes...
where node >nul 2>&1
if %ERRORLEVEL% equ 0 goto NODE_OK

echo [ERROR] Node.js no esta instalado o no se encuentra en el PATH.
echo         Por favor instala Node.js (v20 o superior).
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

echo [OK] Gestor de paquetes detectado: %PKG_CMD%
echo.

REM --------------------------------------------------------------------
REM 2. Verificacion de archivo .env
REM --------------------------------------------------------------------
echo [2/6] Verificando archivo de configuracion .env...
if exist ".env" (
    echo [OK] Archivo .env detectado.
    goto ENV_DONE
)

if exist ".env.example" (
    echo [INFO] Archivo .env no encontrado. Creando copia a partir de .env.example...
    copy /y ".env.example" ".env" >nul
    echo [OK] Archivo .env generado.
    goto ENV_DONE
)

echo [ADVERTENCIA] No se encontro .env ni .env.example. Usando valores por defecto.

:ENV_DONE
echo.

REM --------------------------------------------------------------------
REM 3 & 4. Verificacion de Base de Datos
REM --------------------------------------------------------------------
set "IS_REMOTE_DB="
findstr /i /r "^DATABASE_URL=.*supabase.* ^DATABASE_URL=.*aws-.*" .env >nul 2>&1
if %ERRORLEVEL% equ 0 set "IS_REMOTE_DB=1"

if defined IS_REMOTE_DB (
    echo [3/6] Base de datos remota detectada en .env.
    echo [4/6] Omitiendo Docker local (conectando directamente a la nube).
    goto PG_READY
)

REM --------------------------------------------------------------------
REM 3. Verificacion y Arranque de Docker
REM --------------------------------------------------------------------
echo [3/6] Verificando estado de Docker Engine...
docker info >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Docker Engine ya se encuentra en ejecucion.
    goto DOCKER_READY
)

echo [INFO] Docker Engine no responde. Buscando Docker Desktop en el sistema...
set "DOCKER_EXE=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
if not exist "!DOCKER_EXE!" set "DOCKER_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"

if not exist "!DOCKER_EXE!" goto DOCKER_MANUAL

echo [INFO] Iniciando Docker Desktop en segundo plano...
start "" "!DOCKER_EXE!"
echo [INFO] Esperando a que Docker Engine termine de inicializarse (hasta 75s)...

set /a DOCKER_WAIT=0

:WAIT_DOCKER_LOOP
ping 127.0.0.1 -n 4 >nul
docker info >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Docker Engine iniciado y conectado con exito.
    goto DOCKER_READY
)
set /a DOCKER_WAIT+=3
if !DOCKER_WAIT! lss 75 goto WAIT_DOCKER_LOOP

echo.
echo [ERROR] Docker Desktop esta tardando en iniciar.
echo         Por favor abre la ventana de Docker Desktop manualmente.
pause
goto DOCKER_CHECK_FINAL

:DOCKER_MANUAL
echo [ERROR] No se pudo localizar el ejecutable de Docker Desktop.
echo         Por favor abre Docker Desktop manualmente.
pause

:DOCKER_CHECK_FINAL
docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] No se pudo conectar con Docker Engine. Saliendo...
    pause
    exit /b 1
)

:DOCKER_READY
echo.

REM --------------------------------------------------------------------
REM 4. Levantamiento de PostgreSQL con pgvector
REM --------------------------------------------------------------------
echo [4/6] Levantando base de datos PostgreSQL con pgvector (docker compose)...
docker compose up -d postgres
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Fallo 'docker compose up -d postgres'.
    echo         Verifica que Docker este corriendo y vuelve a intentar.
    pause
    exit /b 1
)

echo [INFO] Esperando a que PostgreSQL este listo para aceptar conexiones...
set /a PG_WAIT=0

:WAIT_PG_LOOP
ping 127.0.0.1 -n 2 >nul
docker compose exec -T postgres pg_isready -U loom -d loomdb >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] PostgreSQL con pgvector listo en el puerto 5432.
    goto PG_READY
)
set /a PG_WAIT+=1
if !PG_WAIT! lss 25 goto WAIT_PG_LOOP

echo [ADVERTENCIA] PostgreSQL demoro en responder. Continuando con el siguiente paso...

:PG_READY
echo.

REM --------------------------------------------------------------------
REM 5. Migraciones Drizzle
REM --------------------------------------------------------------------
echo [5/6] Verificando esquema de base de datos Drizzle...
call !PKG_CMD! run db:migrate
if %ERRORLEVEL% equ 0 (
    echo [OK] Esquema de base de datos listo y actualizado.
) else (
    echo [ADVERTENCIA] La migracion finalizo con advertencia. Continuando si las tablas ya existen...
)
echo.

REM --------------------------------------------------------------------
REM 6. Verificacion de Ollama (IA Local)
REM --------------------------------------------------------------------
echo [6/6] Verificando servicio de inferencia Ollama (puerto 11434)...
curl.exe -s -m 2 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Ollama activo y respondiendo en http://localhost:11434.
    goto CHECK_MODELS
)

echo [INFO] Ollama no responde. Intentando iniciar servicio local...
where ollama >nul 2>&1
if %ERRORLEVEL% neq 0 goto OLLAMA_NOT_FOUND

start "" ollama serve
ping 127.0.0.1 -n 4 >nul
curl.exe -s -m 2 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Ollama iniciado correctamente.
    goto CHECK_MODELS
)

:OLLAMA_NOT_FOUND
echo [ADVERTENCIA] Ollama no esta disponible en el puerto 11434.
echo               El servidor Loom iniciara, pero el resumen y triaje con IA requieren Ollama.
goto OLLAMA_DONE

:CHECK_MODELS
curl.exe -s http://localhost:11434/api/tags | findstr /i "bge-m3" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Modelo de embeddings 'bge-m3' detectado.
) else (
    echo [ADVERTENCIA] Modelo 'bge-m3' no encontrado. Puedes descargarlo con: ollama pull bge-m3
)

curl.exe -s http://localhost:11434/api/tags | findstr /i "qwen2.5:7b-instruct" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Modelo de lenguaje 'qwen2.5:7b-instruct' detectado.
) else (
    echo [ADVERTENCIA] Modelo 'qwen2.5:7b-instruct' no encontrado. Puedes descargarlo con: ollama pull qwen2.5:7b-instruct
)

:OLLAMA_DONE
echo.

REM --------------------------------------------------------------------
REM Resumen final y arranque
REM --------------------------------------------------------------------
echo ====================================================================
echo           TODOS LOS SERVICIOS PREPARADOS CON EXITO
echo ====================================================================
echo   * Servidor Web Loom:   http://127.0.0.1:3000
echo   * Base de Datos:       PostgreSQL + pgvector (Puerto 5432)
echo   * LLM Local:           Ollama (Puerto 11434)
echo ====================================================================
echo.
echo Programando apertura del navegador en http://127.0.0.1:3000...
start "" cmd /c "ping 127.0.0.1 -n 5 >nul & start http://127.0.0.1:3000"

echo.
echo Iniciando servidor Loom (Presiona Ctrl+C para detener)...
echo.
call !PKG_CMD! run dev
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] El proceso del servidor finalizo con codigo de error %ERRORLEVEL%.
    pause
)
