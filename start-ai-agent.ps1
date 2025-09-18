Param(
    [switch]$Test,
    [switch]$DryRun,
    [switch]$AgentOnly,
    [switch]$WebOnly
)

Write-Host "JIRA Tempo AI Time Tracking Agent (PowerShell)" -ForegroundColor Cyan

if (-Not (Test-Path .initialized)) {
  Write-Host "First run initialization..." -ForegroundColor Yellow
  node scripts/init.js
}

if (-Not (Test-Path .env)) {
  Write-Host "ERROR: .env file not found." -ForegroundColor Red
  exit 1
}

if (-Not (Test-Path node_modules)) {
  Write-Host "Installing dependencies..." -ForegroundColor Yellow
  npm install
}

function RunNode($args, $envExtra) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = $args
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false
  foreach($k in $envExtra.Keys){ $psi.Environment[$k] = $envExtra[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
}

if ($Test) {
  $envs = @{ AI_AGENT_TEST_MODE = 'true'; AI_AGENT_DRY_RUN = ($DryRun ? 'true':'false') }
  RunNode "ai-agent-daemon.js start" $envs
  exit 0
}
if ($AgentOnly) { RunNode "ai-agent-daemon.js start" @{}; exit 0 }
if ($WebOnly) { RunNode "server.js" @{}; exit 0 }

Write-Host "1) Web + Agent"; Write-Host "2) Agent Only"; Write-Host "3) Test Mode"; Write-Host "4) Status"; Write-Host "5) Web Only"; Write-Host "6) Exit"
$choice = Read-Host 'Choice'

switch($choice){
  '1' { RunNode "server.js" @{} }
  '2' { RunNode "ai-agent-daemon.js start" @{} }
  '3' { $dry = Read-Host 'Dry run? (y/N)'; $envs=@{AI_AGENT_TEST_MODE='true';AI_AGENT_DRY_RUN=($dry -match '^[Yy]')?'true':'false'}; RunNode "ai-agent-daemon.js start" $envs }
  '4' { RunNode "ai-agent-daemon.js status" @{} }
  '5' { RunNode "server.js" @{} }
  default { Write-Host 'Bye' }
}
