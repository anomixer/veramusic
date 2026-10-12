@echo off
setlocal
cd /d "%~dp0"
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo Visual Studio C++ Build Tools not found.
  exit /b 1
)
call "%VCVARS%" >nul
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /O2 /MT /W3 /EHsc ftmplay.cpp /link winmm.lib /out:ftmplay.exe
if errorlevel 1 exit /b 1
del /q ftmplay.obj 2>nul
echo Built tools\ftmplay.exe
