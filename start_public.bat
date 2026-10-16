@echo off
REM Runs Pill ID from this PC and gives you a public https link to share
REM (free Cloudflare tunnel, no account). Keep this window open while
REM people use the app; closing it takes the link offline.
cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed. Install it once with:
  echo     winget install --id Cloudflare.cloudflared
  echo then close this window and run start_public.bat again.
  pause
  exit /b 1
)

echo [1/3] Building the web app (about a minute)...
pushd frontend
call npm run build:static
if errorlevel 1 (
  echo The web app build failed -- see the messages above.
  popd
  pause
  exit /b 1
)
popd

echo [2/3] Starting the server in a new window (it takes a minute to load the model)...
start "Pill ID server" cmd /k "call backend\.venv\Scripts\activate.bat && cd backend\app && python main.py"

echo Waiting for the server to be ready...
set /a tries=0
:wait
timeout /t 5 /nobreak >nul
set /a tries+=1
curl -s -f http://127.0.0.1:8000/api/health >nul 2>nul
if not errorlevel 1 goto ready
if %tries% LSS 60 goto wait
echo The server did not start within 5 minutes. Look at the "Pill ID server" window for the error.
pause
exit /b 1
:ready

echo [3/3] Opening the public link. Look for the line ending in .trycloudflare.com below,
echo and open that address + /v3/  (for example https://xxxx.trycloudflare.com/v3/)
cloudflared tunnel --url http://127.0.0.1:8000
