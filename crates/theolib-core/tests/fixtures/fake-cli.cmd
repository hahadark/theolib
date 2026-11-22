@echo off
rem fake CLI for tests only (parse-logic verification).
rem  - first arg --version: print a version line, exit.
rem  - FAKE_OUT (env): emit that JSONL file to stdout.
rem  - FAKE_SLEEP (env, seconds): sleep first (for cancel test).
rem  - FAKE_STDIN_OUT (env): save received stdin to that file.
rem  - FAKE_RESULT (env) + arg -o <file>: write FAKE_RESULT into <file> (codex output).
setlocal enabledelayedexpansion
if "%~1"=="--version" (
  echo fake-cli 1.2.3
  exit /b 0
)
if defined FAKE_SLEEP (
  powershell -NoProfile -Command "Start-Sleep -Seconds %FAKE_SLEEP%"
)
if defined FAKE_STDIN_OUT (
  powershell -NoProfile -Command "$i=[Console]::In.ReadToEnd(); [IO.File]::WriteAllText($env:FAKE_STDIN_OUT, $i)"
)
if defined FAKE_OUT (
  type "%FAKE_OUT%"
)
if defined FAKE_RESULT (
  set "next=false"
  set "outfile="
  for %%A in (%*) do (
    if "!next!"=="true" (
      set "outfile=%%~A"
      set "next=false"
    )
    if /I "%%~A"=="-o" set "next=true"
  )
  if defined outfile (
    powershell -NoProfile -Command "[IO.File]::WriteAllText($env:outfile, $env:FAKE_RESULT)"
  )
)
endlocal
