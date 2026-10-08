@echo off
setlocal
echo ===================================================
echo  Building zsmplay.exe (Win32 x86 MSVC)
echo ===================================================

if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat" (
    call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat"
) else if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat" (
    call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat"
)

cd /d "%~dp0"
set YMFM=C:\dev\applewin\source\ymfm
cl /nologo /O2 /MT /W3 /EHsc zsmplay.cpp "%YMFM%\ymfm_opm.cpp" /I"%YMFM%" /link winmm.lib /out:zsmplay.exe
set CLERR=%errorlevel%
if exist zsmplay.obj del zsmplay.obj
if exist ymfm_opm.obj del ymfm_opm.obj

if not "%CLERR%"=="0" (
    echo.
    echo [FAILED] Build failed. If LNK1104, kill running zsmplay.exe first.
) else (
    echo.
    echo [SUCCESS] Built tools\zsmplay.exe successfully!
)
