@echo off
SETLOCAL ENABLEDELAYEDEXPANSION

IF NOT EXIST .initialized (
  echo First run initialization...
  node scripts\init.js || goto end
)

IF NOT EXIST .env (
  echo [ERROR] .env file missing.
  exit /b 1
)
IF NOT EXIST node_modules (
  echo Installing dependencies...
  npm install
)

echo JIRA Tempo AI Agent (Batch)
echo 1^) Web + Agent
echo 2^) Agent Only
echo 3^) Test Mode
echo 4^) Status
echo 5^) Web Only
echo 6^) Exit
set /p choice=Choose (1-6): 
if "%choice%"=="1" goto web
if "%choice%"=="2" goto agent
if "%choice%"=="3" goto test
if "%choice%"=="4" goto status
if "%choice%"=="5" goto webOnly
goto end

:web
node server.js
goto end
:agent
node ai-agent-daemon.js start
goto end
:test
echo Enable dry run? (Y/N):
set /p dry=
if /I "%dry%"=="Y" set AI_AGENT_DRY_RUN=true
if /I "%dry%"=="N" set AI_AGENT_DRY_RUN=false
set AI_AGENT_TEST_MODE=true
node ai-agent-daemon.js start
goto end
:status
node ai-agent-daemon.js status
goto end
:webOnly
node server.js
goto end
:end
ENDLOCAL
