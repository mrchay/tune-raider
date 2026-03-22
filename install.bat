@echo off
cd /d "%~dp0"

echo === Tune Raider - Install Dependencies ===
echo.

echo [1/3] Installing Node.js packages...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Python packages...
pip install pyacoustid numpy soundfile librosa scipy matplotlib tqdm
if %errorlevel% neq 0 (
    echo ERROR: pip install failed
    pause
    exit /b 1
)

echo.
echo [3/3] Downloading ffmpeg + ffprobe...

set "TOOLS_DIR=%~dp0src\backend\tools"
set "FFMPEG_PATH=%TOOLS_DIR%\ffmpeg.exe"
set "FFPROBE_PATH=%TOOLS_DIR%\ffprobe.exe"

if exist "%FFMPEG_PATH%" if exist "%FFPROBE_PATH%" (
    echo   Already present, skipping.
    goto :done
)

set "FFMPEG_URL=https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
set "TEMP_ZIP=%TEMP%\ffmpeg-release-essentials.zip"
set "TEMP_EXTRACT=%TEMP%\ffmpeg-extract"

echo   Downloading from gyan.dev (essentials build)...
echo   This may take a minute...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%FFMPEG_URL%' -OutFile '%TEMP_ZIP%'"
if %errorlevel% neq 0 (
    echo ERROR: ffmpeg download failed
    pause
    exit /b 1
)

echo   Extracting...
if exist "%TEMP_EXTRACT%" rmdir /s /q "%TEMP_EXTRACT%"
powershell -NoProfile -Command "Expand-Archive -Path '%TEMP_ZIP%' -DestinationPath '%TEMP_EXTRACT%' -Force"
if %errorlevel% neq 0 (
    echo ERROR: ffmpeg extraction failed
    pause
    exit /b 1
)

:: Find the extracted folder (named like ffmpeg-7.1-essentials_build)
for /d %%D in ("%TEMP_EXTRACT%\ffmpeg-*") do (
    copy /y "%%D\bin\ffmpeg.exe" "%TOOLS_DIR%\ffmpeg.exe" >nul
    copy /y "%%D\bin\ffprobe.exe" "%TOOLS_DIR%\ffprobe.exe" >nul
)

if not exist "%FFMPEG_PATH%" (
    echo ERROR: ffmpeg.exe not found after extraction
    pause
    exit /b 1
)

:: Clean up
del /q "%TEMP_ZIP%" 2>nul
rmdir /s /q "%TEMP_EXTRACT%" 2>nul

echo   Done.

:done
echo.
echo === Installation complete ===
echo Run 'run.bat' to start Tune Raider.
pause
