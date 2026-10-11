@echo off
rem Ponko-HUD ¡¤ (c) 2026 visitor257 ¡¤ MIT License ¡¤ github.com/visitor257/Ponko-HUD
rem Ponko HUD - native window (WebView2). No browser chrome, own taskbar icon.
setlocal
set "ROOT=%~dp0"
set "PYW=C:\Python314\pythonw.exe"
if not exist "%PYW%" set "PYW=pythonw"
start "" "%PYW%" "%ROOT%native_host.py" %*
endlocal
