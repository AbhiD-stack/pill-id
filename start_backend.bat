@echo off
echo Activating virtual environment...
call "C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id\backend\.venv\Scripts\activate.bat"

echo Starting server...
python "C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id\backend\app\main.py"

REM This will keep the window open so you can see the error
cmd /k