@echo off
setlocal
echo ===================================================
echo  Building psgplay.exe (Win32 x86 MSVC)
echo ===================================================

if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat" (
    call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat"
) else if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat" (
    call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat"
)

cd /d "%~dp0"
cl /nologo /O2 /MT /W3 psgplay.c /link winmm.lib /out:psgplay.exe
if exist psgplay.obj del psgplay.obj

if exist psgplay.exe (
    echo.
    echo [SUCCESS] Built tools\psgplay.exe successfully!
) else (
    echo.
    echo [FAILED] Compilation failed.
)
