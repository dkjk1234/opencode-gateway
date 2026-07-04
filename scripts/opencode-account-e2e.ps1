param(
  [string]$OpenCodeRepo = "C:\Users\USER\AppData\Local\Temp\opencode-service-design",
  [int]$Port = 18811,
  [string]$Token = "dev-token",
  [switch]$SkipRun
)

$ErrorActionPreference = "Stop"

$GatewayRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$OpenCodePackage = Join-Path $OpenCodeRepo "packages\opencode"
if (-not (Test-Path (Join-Path $OpenCodePackage "src\index.ts"))) {
  throw "OpenCode package was not found at $OpenCodePackage"
}

$BaseUrl = "http://127.0.0.1:$Port"
$RunId = [guid]::NewGuid().ToString("N")
$TempRoot = Join-Path $env:TEMP "yourservice-opencode-e2e-$RunId"
$GatewayState = Join-Path $TempRoot "gateway-state.json"
$GatewayStdout = Join-Path $TempRoot "gateway.stdout.log"
$GatewayStderr = Join-Path $TempRoot "gateway.stderr.log"
$ProjectDir = Join-Path $TempRoot "project"
$HomeDir = Join-Path $TempRoot "home"
$DataDir = Join-Path $TempRoot "data"
$ConfigDir = Join-Path $TempRoot "config"
$StateDir = Join-Path $TempRoot "state"
$CacheDir = Join-Path $TempRoot "cache"
$DbPath = Join-Path $TempRoot "opencode.db"

New-Item -ItemType Directory -Force `
  $TempRoot,$ProjectDir,$HomeDir,$DataDir,$ConfigDir,$StateDir,$CacheDir | Out-Null

Set-Content -LiteralPath (Join-Path $ProjectDir "README.md") -Value "OpenCode gateway E2E scratch project" -Encoding UTF8

$previous = @{}
foreach ($name in @(
  "YOURSERVICE_GATEWAY_HOST",
  "YOURSERVICE_GATEWAY_PORT",
  "YOURSERVICE_PUBLIC_BASE_URL",
  "YOURSERVICE_DATA_PATH",
  "YOURSERVICE_DEV_TOKENS",
  "YOURSERVICE_ALLOW_DEV_APPROVAL",
  "YOURSERVICE_AUTO_APPROVE_DEVICE",
  "YOURSERVICE_RATE_LIMIT_DISABLED",
  "YOURSERVICE_UPSTREAM_MODE",
  "OPENCODE_TEST_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_DB",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_PURE",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_AUTOCOMPACT",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_SHARE",
  "OPENCODE_CONSOLE_URL"
)) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Restore-Env {
  foreach ($entry in $previous.GetEnumerator()) {
    if ($null -eq $entry.Value) {
      [Environment]::SetEnvironmentVariable($entry.Key, $null, "Process")
    } else {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
  }
}

function Invoke-OpenCode {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
  )
  Push-Location $OpenCodePackage
  try {
    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & npx --yes bun run --conditions=browser .\src\index.ts @Args 2>&1
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $oldErrorActionPreference
    }
    [pscustomobject]@{
      ExitCode = $code
      Output = ($output | Out-String)
    }
  } finally {
    Pop-Location
  }
}

$gateway = $null
try {
  $env:YOURSERVICE_GATEWAY_HOST = "127.0.0.1"
  $env:YOURSERVICE_GATEWAY_PORT = [string]$Port
  $env:YOURSERVICE_PUBLIC_BASE_URL = $BaseUrl
  $env:YOURSERVICE_DATA_PATH = $GatewayState
  $env:YOURSERVICE_DEV_TOKENS = "$Token`:100000"
  $env:YOURSERVICE_ALLOW_DEV_APPROVAL = "true"
  $env:YOURSERVICE_AUTO_APPROVE_DEVICE = "true"
  $env:YOURSERVICE_RATE_LIMIT_DISABLED = "true"
  $env:YOURSERVICE_UPSTREAM_MODE = "mock"

  $gateway = Start-Process `
    -FilePath "node" `
    -ArgumentList @("src/server.mjs") `
    -WorkingDirectory $GatewayRoot `
    -RedirectStandardOutput $GatewayStdout `
    -RedirectStandardError $GatewayStderr `
    -WindowStyle Hidden `
    -PassThru

  $deadline = (Get-Date).AddSeconds(30)
  do {
    try {
      $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
      if ($health.ok) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ((Get-Date) -lt $deadline)

  if (-not $health.ok) {
    throw "Gateway did not become healthy. stderr: $(Get-Content $GatewayStderr -Raw -ErrorAction SilentlyContinue)"
  }

  $env:OPENCODE_TEST_HOME = $HomeDir
  $env:XDG_DATA_HOME = $DataDir
  $env:XDG_CONFIG_HOME = $ConfigDir
  $env:XDG_STATE_HOME = $StateDir
  $env:XDG_CACHE_HOME = $CacheDir
  $env:OPENCODE_DB = $DbPath
  $env:OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  $env:OPENCODE_PURE = "1"
  $env:OPENCODE_DISABLE_AUTOUPDATE = "1"
  $env:OPENCODE_DISABLE_AUTOCOMPACT = "1"
  $env:OPENCODE_DISABLE_MODELS_FETCH = "1"
  $env:OPENCODE_DISABLE_SHARE = "true"
  $env:OPENCODE_CONSOLE_URL = $BaseUrl

  $login = Invoke-OpenCode console login $BaseUrl
  if ($login.ExitCode -ne 0 -or $login.Output -notmatch "Logged in as") {
    throw "OpenCode console login failed with exit $($login.ExitCode): $($login.Output)"
  }

  $orgs = Invoke-OpenCode console orgs
  if ($orgs.ExitCode -ne 0 -or $orgs.Output -notmatch "YourService Dev Org") {
    throw "OpenCode console orgs failed with exit $($orgs.ExitCode): $($orgs.Output)"
  }

  $config = Invoke-OpenCode debug config
  if ($config.ExitCode -ne 0) {
    throw "OpenCode debug config failed with exit $($config.ExitCode): $($config.Output)"
  }
  if ($config.Output -notmatch '"yourservice"' -or $config.Output -notmatch '"model":\s*"yourservice/pro"') {
    throw "OpenCode debug config did not include YourService provider/model: $($config.Output)"
  }

  $runStatus = "skipped"
  if (-not $SkipRun) {
    $run = Invoke-OpenCode run --dir $ProjectDir --model "yourservice/fast" --format json --title "yourservice-e2e" --agent general "Reply with exactly: pong"
    if ($run.ExitCode -ne 0) {
      throw "OpenCode run failed with exit $($run.ExitCode): $($run.Output)"
    }
    if ($run.Output -notmatch "YourService gateway mock response" -and $run.Output -notmatch "pong") {
      throw "OpenCode run output did not show gateway-backed assistant output: $($run.Output)"
    }
    $runStatus = "passed"
  }

  $credits = Invoke-RestMethod -Uri "$BaseUrl/v1/credits" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

  [pscustomobject]@{
    ok = $true
    baseUrl = $BaseUrl
    health = $health.ok
    login = "passed"
    orgs = "passed"
    remoteConfig = "passed"
    run = $runStatus
    credits = $credits.credits
    tempRoot = $TempRoot
    opencodeDb = $DbPath
  } | ConvertTo-Json -Compress
} finally {
  if ($gateway -and -not $gateway.HasExited) {
    Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue
    $gateway.WaitForExit(5000) | Out-Null
  }
  Restore-Env
}
