@echo off
echo ===========================
echo Limpiando procesos previos...
taskkill /IM node.exe /F >nul 2>&1
echo Iniciando entorno del bot...
echo ===========================

:: Crear un script VBS temporal para ejecutar el bot de forma invisible
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_bot.vbs"
echo WshShell.Run "node ""%~dp0index.js""", 0, False >> "%temp%\run_bot.vbs"

:: Abrir el dashboard en el navegador
start "" "http://localhost:3000"

:: Ejecutar el bot de forma oculta y borrar el script temporal
wscript "%temp%\run_bot.vbs"
del "%temp%\run_bot.vbs"

:: Cerramos esta ventana del CMD
exit
