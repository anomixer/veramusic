@echo off
setlocal
:: ===========================================================================
:: VERA PSG Jukebox build.bat
::
:: Usage:
::   build.bat                  -> full build (gen_demo + mod2psg + check + pack)
::   build.bat jukebox          -> same as above
::   build.bat quick            -> skip mod2psg, just re-assemble + pack
::   build.bat demo             -> regen demo.mod/psg only, then pack
::   build.bat ftm <in.ftm> [songIdx] [out.psg]
::                           -> convert a FamiStudio/FamiTone project to a VERA
::                              PSG stream and validate it (no disk pack)
:: ===========================================================================

set TARGET=%1
if "%TARGET%"=="" set TARGET=jukebox

echo [VERA PSG JUKEBOX] target=%TARGET%
echo.

if /i "%TARGET%"=="quick"        goto BDISK
if /i "%TARGET%"=="demo"         goto TDEMO
if /i "%TARGET%"=="space"        goto TSPACE
if /i "%TARGET%"=="debris"       goto TSPACE
if /i "%TARGET%"=="fantaisie"    goto TFANT
if /i "%TARGET%"=="midi"         goto TFANT
if /i "%TARGET%"=="beatit"       goto TBEAT
if /i "%TARGET%"=="ftm"          goto TFTM
if /i "%TARGET%"=="jukebox"      goto TJUKE

echo [FAILED] Unknown target "%TARGET%". Valid: jukebox, quick, demo, fantaisie, beatit, space, ftm
goto FAIL

:TDEMO
echo [1/3] Synthesise demo.mod ...
node tools/gen_demo.mjs music/demo.mod
if errorlevel 1 goto FAIL

echo [2/3] Convert demo.mod to demo.psg ...
node tools/mod2psg.mjs music/demo.mod --no-wav
if errorlevel 1 goto FAIL

echo [3/3] Validate demo.psg ...
node tools/check_psg.mjs music/demo.psg
if errorlevel 1 goto FAIL

goto BDISK

:TFANT
if not exist music/Fantaisie-impromptu.mid echo [FAILED] music/Fantaisie-impromptu.mid not found && goto FAIL

echo [1/2] Convert Fantaisie-impromptu.mid to Fantaisie-impromptu.psg ...
node tools/mid2psg.mjs music/Fantaisie-impromptu.mid --no-wav
if errorlevel 1 goto FAIL

echo [2/2] Validate Fantaisie-impromptu.psg ...
node tools/check_psg.mjs music/Fantaisie-impromptu.psg
if errorlevel 1 goto FAIL

goto BDISK

:TBEAT
if not exist music/BeatIt.mid echo [FAILED] music/BeatIt.mid not found && goto FAIL

echo [1/2] Convert BeatIt.mid to BeatIt.psg ...
node tools/mid2psg.mjs music/BeatIt.mid --no-wav
if errorlevel 1 goto FAIL

echo [2/2] Validate BeatIt.psg ...
node tools/check_psg.mjs music/BeatIt.psg
if errorlevel 1 goto FAIL

goto BDISK

:TSPACE
if exist music/space_debris.wav (
  echo [1/1] Convert space_debris.wav to pure PCM space_debris.pcm ...
  node tools/wav2pcm.mjs music/space_debris.wav music/space_debris.pcm --rate=21 --no-wav
  if errorlevel 1 goto FAIL
) else if exist music/space_debris.mod (
  echo [1/1] Render space_debris.mod to pure PCM space_debris.pcm ...
  node tools/render_pure_pcm.mjs music/space_debris.mod music/space_debris.pcm --no-wav
  if errorlevel 1 goto FAIL
) else (
  echo [FAILED] Neither space_debris.wav nor space_debris.mod found in music/ && goto FAIL
)

goto BDISK

:TFTM
rem ---------------------------------------------------------------------------
rem FamiStudio/FamiTone -> VERA PSG. Every channel stem FamiStudio renders is
rem converted (NES 2A03, VRC6, Sunsoft, ...); sample channels such as DPCM are
rem reported because PSG registers cannot express them.
rem ---------------------------------------------------------------------------
rem Strip surrounding quotes from the arguments: a caller may include them, and
rem leaving them in turns the empty-argument tests below into a syntax error.
set FTM_SRC=%~2
if "%FTM_SRC%"=="" set FTM_SRC=music/alterego-simpl0r.ftm
set FTM_SONG=%~3
if "%FTM_SONG%"=="" set FTM_SONG=0
set FTM_OUT=%~4
if "%FTM_OUT%"=="" set FTM_OUT=%FTM_SRC:.ftm=.psg

if not exist "%FTM_SRC%" (
  echo [FAILED] Input not found: "%FTM_SRC%"
  goto FAIL
)

if "%FAMISTUDIO%"=="" set FAMISTUDIO=C:\dev\FamiStudio450\FamiStudio.exe

echo [1/2] Convert "%FTM_SRC%" song %FTM_SONG% to "%FTM_OUT%" ...
rem Forward the extra converter options. Note cmd splits "--opt=value" at the
rem '=' when a batch file is invoked from PowerShell, so the converter also
rem accepts the space-separated "--opt value" form.
node tools/ftm2psg.mjs "%FTM_SRC%" %FTM_SONG% "%FTM_OUT%" %~5 %~6 %~7 %~8 %~9
if errorlevel 1 goto FAIL

echo [2/2] Validate "%FTM_OUT%" ...
node tools/check_psg.mjs "%FTM_OUT%"
if errorlevel 1 goto FAIL

echo.
echo ============================================================
echo  FTM BUILD SUCCEEDED
echo    %FTM_OUT%
echo    Audition with:  tools\psgplay.exe "%FTM_OUT%"
echo    (this target does not repack jukebox.po / jukebox.hdv)
echo ============================================================
goto END

:TJUKE
echo [1/7] Synthesise demo.mod ...
node tools/gen_demo.mjs music/demo.mod
if errorlevel 1 goto FAIL

echo [2/7] Convert demo.mod to demo.psg ...
node tools/mod2psg.mjs music/demo.mod --no-wav
if errorlevel 1 goto FAIL

if exist music/Fantaisie-impromptu.mid (
  echo [3/7] Convert Fantaisie-impromptu.mid to Fantaisie-impromptu.psg - no WAV ...
  node tools/mid2psg.mjs music/Fantaisie-impromptu.mid --no-wav
  if errorlevel 1 goto FAIL
)

if exist music/BeatIt.mid (
  echo [4/7] Convert BeatIt.mid to BeatIt.psg - no WAV ...
  node tools/mid2psg.mjs music/BeatIt.mid --no-wav
  if errorlevel 1 goto FAIL
)

if exist music/space_debris.wav (
  if not exist music/space_debris.pcm (
    echo [5/7] Convert space_debris.wav to pure PCM space_debris.pcm ...
    node tools/wav2pcm.mjs music/space_debris.wav music/space_debris.pcm --rate=21 --no-wav
    if errorlevel 1 goto FAIL
  )
) else if exist music/space_debris.mod (
  if not exist music/space_debris.pcm (
    echo [5/7] Render space_debris.mod to pure PCM space_debris.pcm ...
    node tools/render_pure_pcm.mjs music/space_debris.mod music/space_debris.pcm --no-wav
    if errorlevel 1 goto FAIL
  )
)

if exist music/alexander-nakarada-the-wellerman.mp3 (
  if not exist music/wellerman_full.pcm (
    echo [6/7] Convert alexander-nakarada-the-wellerman.mp3 to wellerman_full.pcm - FULL 2:00 ...
    node tools/wav2pcm.mjs music/alexander-nakarada-the-wellerman.mp3 music/wellerman_full.pcm --rate=21 --no-wav
    if errorlevel 1 goto FAIL
  )
  if not exist music/wellerman_ram.pcm (
    node tools/wav2pcm.mjs music/alexander-nakarada-the-wellerman.mp3 music/wellerman_ram.pcm --start=15.0 --duration=3.5 --rate=21 --no-wav
    if errorlevel 1 goto FAIL
  )
)

echo [7/7] Validate PSG streams ...
node tools/check_psg.mjs music/demo.psg
if errorlevel 1 goto FAIL
if exist music/Fantaisie-impromptu.psg (
  node tools/check_psg.mjs music/Fantaisie-impromptu.psg
  if errorlevel 1 goto FAIL
)
if exist music/BeatIt.psg (
  node tools/check_psg.mjs music/BeatIt.psg
  if errorlevel 1 goto FAIL
)

:BDISK
echo.
echo Assembling + packing jukebox.po (140KB) + jukebox.hdv (32MB) ...
node tools/build_jukebox.mjs
if errorlevel 1 goto FAIL

echo.
echo ============================================================
echo  BUILD SUCCEEDED
echo    jukebox.po      -- 140KB Floppy: Option 1 Demo, Option 2 Chopin
echo    jukebox.hdv     -- 32MB HDV (and jukebox.hdv.zip):
echo                       Option 1 Demo, Option 2 Chopin,
echo                       Option 3 Beat It, Option 4 Caribbean Blue,
echo                       Option 5 Space Debris, Option 6 The Wellerman
echo    Controls        -- ESC=Exit, P=Pause, +,-=VOL, [,]=SEEK, Timer T: mm:ss.s
echo ============================================================
goto END

:FAIL
echo.
echo *** BUILD FAILED ***
exit /b 1

:END
endlocal
