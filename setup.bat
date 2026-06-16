@echo off
echo ==========================================
echo   My-ai-app Setup Script (Windows)
echo ==========================================
echo.

echo Step 1: Pulling latest code from GitHub...
git pull origin main
if %errorlevel% neq 0 (
    echo ERROR: Git pull failed. Make sure you have git installed.
    pause
    exit /b 1
)

echo.
echo Step 2: Installing dependencies...
echo This may take 2-3 minutes...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   ✅ Setup Complete!
echo ==========================================
echo.
echo Starting your server...
echo Open your browser and go to: http://localhost:3000
echo.
echo To test the sync:
echo   1. Go to http://localhost:3000/test-sync.html
echo   2. Click "Upload Test Data"
echo   3. Click "Fetch Data"
echo.
echo Press Ctrl+C to stop the server
echo.

npm run dev
