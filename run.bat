@echo off
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)
if not exist xray\xray.exe (
    echo xray.exe not found, downloading...
    powershell -ExecutionPolicy Bypass -File tools\get-xray.ps1
)
echo Starting the server...
node server.js
pause
