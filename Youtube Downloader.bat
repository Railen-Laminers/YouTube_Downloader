@echo off
setlocal enabledelayedexpansion

echo Starting YouTube Downloader App...

REM -----------------------
REM Find free backend port (starting at 5000)
REM -----------------------
set BACKEND_PORT=5000

:check_backend_port
netstat -ano | findstr :!BACKEND_PORT! > nul
if %ERRORLEVEL%==0 (
    set /a BACKEND_PORT=!BACKEND_PORT!+1
    goto check_backend_port
)
echo Using backend port !BACKEND_PORT!

REM Start backend with PORT (expanded before passed to new cmd)
start "" cmd /k "cd /d C:\WebDevelopment\ReactProjects\YouTube_Downloader\backend && set PORT=%BACKEND_PORT% && npm run dev"

REM Wait a bit for backend to start (adjust if needed)
timeout /t 5 /nobreak > nul

REM -----------------------
REM Find free frontend port (starting at 3000)
REM -----------------------
set FRONTEND_PORT=3000

:check_frontend_port
netstat -ano | findstr :!FRONTEND_PORT! > nul
if %ERRORLEVEL%==0 (
    set /a FRONTEND_PORT=!FRONTEND_PORT!+1
    goto check_frontend_port
)
echo Using frontend port !FRONTEND_PORT!

REM Start frontend with PORT and set VITE_API_ORIGIN for Vite's proxy
REM Note: VITE_API_ORIGIN should be the backend origin (without /api)
start "" cmd /k "cd /d C:\WebDevelopment\ReactProjects\YouTube_Downloader\frontend && set PORT=%FRONTEND_PORT% && set VITE_API_ORIGIN=http://localhost:%BACKEND_PORT% && npm run dev"

REM Wait a bit for frontend to start
timeout /t 5 /nobreak > nul

REM Open browser at frontend port
start http://localhost:%FRONTEND_PORT%

endlocal
