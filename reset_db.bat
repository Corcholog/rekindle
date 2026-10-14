@echo off
setlocal EnableDelayedExpansion

echo ====================================================================
echo           LOOM - REINICIAR BASE DE DATOS A ESTADO LIMPIO
echo ====================================================================
echo.

set "PKG_CMD=npm"
where pnpm >nul 2>&1
if %ERRORLEVEL% equ 0 set "PKG_CMD=pnpm"

echo [1/2] Verificando contenedor PostgreSQL...
docker compose up -d postgres >nul 2>&1

echo [2/2] Vaciando tablas y aplicando esquema fresco Drizzle...
call !PKG_CMD! run db:reset

echo.
echo ====================================================================
echo [OK] Base de datos reiniciada con exito.
echo ====================================================================
pause
