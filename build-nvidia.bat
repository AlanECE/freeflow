@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
echo === FreeFlow - build NVIDIA (CUDA) ===
if not exist "node_modules" ( call "C:\Program Files\nodejs\npm.cmd" install & if errorlevel 1 goto :fail )
py -3.13 -m pip install faster-whisper pyinstaller nvidia-cublas-cu12 "nvidia-cudnn-cu12<10" >nul 2>&1
call "C:\Program Files\nodejs\npm.cmd" run build:native
if errorlevel 1 goto :fail
if exist "stt\dist\freeflow-stt" rmdir /s /q "stt\dist\freeflow-stt"
if exist "stt\dist\freeflow-stt-cuda" rmdir /s /q "stt\dist\freeflow-stt-cuda"
py -3.13 stt\build_stt.py --cuda
if errorlevel 1 goto :fail
if exist "stt\dist\freeflow-stt" move "stt\dist\freeflow-stt" "stt\dist\freeflow-stt-cuda" >nul
if exist "stt\dist\freeflow-stt-rocm" rmdir /s /q "stt\dist\freeflow-stt-rocm"
if exist "release" rmdir /s /q "release"
call "C:\Program Files\nodejs\node.exe" scripts\package-universal.js
if errorlevel 1 goto :fail
call "%~dp0node_modules\.bin\electron-builder.cmd" --win nsis --x64 --prepackaged release/FreeFlow-win32-x64 --config.nsis.artifactName=FreeFlow-Setup-NVIDIA.exe --publish never
goto :end
:fail
echo === BUILD FAILED ===
exit /b 1
:end
endlocal