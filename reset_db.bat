@echo off
setlocal EnableDelayedExpansion

echo ====================================================================
echo           REKINDLE - RESET THE DATABASE TO A CLEAN STATE
echo ====================================================================
echo.

set "PKG_CMD=npm"
where pnpm >nul 2>&1
if %ERRORLEVEL% equ 0 set "PKG_CMD=pnpm"

echo [1/2] Checking the PostgreSQL container...
docker compose up -d postgres >nul 2>&1

echo [2/2] Dropping the tables and applying a fresh schema...
call !PKG_CMD! run db:reset

echo.
echo ====================================================================
echo [OK] Database reset.
echo ====================================================================
pause
