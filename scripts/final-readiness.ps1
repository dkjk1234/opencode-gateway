param(
  [string]$BaseUrl = "https://llms.ai.kr/opencode-gateway",
  [string]$DownloadBaseUrl = "https://llms.ai.kr/opencode-gateway/downloads",
  [string]$HostName = "168.144.72.10",
  [string]$User = "root",
  [string]$SshKey = "$env:USERPROFILE\.ssh\polybot_vps_nopass",
  [string]$GatewayService = "opencode-gateway.service",
  [string]$ProxyService = "codexshare-proxy.service",
  [string]$Branch = "main",
  [string]$InstallerFile = "codexshare-desktop-win-x64.exe",
  [string]$ManifestFile = "codexshare-desktop-win-x64.json",
  [switch]$RunChat,
  [switch]$VerifyInstallerSha,
  [switch]$RequireAll
)

$ErrorActionPreference = "Stop"

function Run-Text {
  param([string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory = (Get-Location).Path)
  $previousLocation = (Get-Location).Path
  try {
    Set-Location $WorkingDirectory
    $output = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $code; Output = ($output | Out-String).Trim() }
  } finally {
    Set-Location $previousLocation
  }
}

function Get-RemoteEnvValue($Name) {
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { return "" }
  $remote = "grep -m1 -E '^$Name=' /etc/opencode-gateway.env | cut -d= -f2-"
  try {
    return ((ssh -i $SshKey -o BatchMode=yes "$User@$HostName" $remote) | Select-Object -First 1).Trim()
  } catch {
    return ""
  }
}

function Parse-HeaderValue($Headers, $Name) {
  $pattern = "^$([regex]::Escape($Name)):\s*(.+)$"
  $line = $Headers | Select-String -Pattern $pattern | Select-Object -Last 1
  if (-not $line) { return "" }
  return ([regex]::Match($line.Line, $pattern).Groups[1].Value).Trim()
}

function Convert-GitRemoteToHttps($Remote) {
  $value = [string]$Remote
  if ($value -match '^git@github\.com:(.+?)(\.git)?$') {
    return "https://github.com/$($Matches[1])"
  }
  return ($value -replace '\.git$', '')
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BaseUrl = $BaseUrl.TrimEnd("/")
$DownloadBaseUrl = $DownloadBaseUrl.TrimEnd("/")

$localHead = (git -C $RepoRoot rev-parse HEAD).Trim()
$localShort = (git -C $RepoRoot rev-parse --short HEAD).Trim()
$remoteUrl = (git -C $RepoRoot config --get remote.origin.url).Trim()
$remoteBase = Convert-GitRemoteToHttps $remoteUrl
$remoteHead = ((git -C $RepoRoot ls-remote origin "refs/heads/$Branch") -split "\s+")[0]
$remoteUploaded = $localHead -eq $remoteHead

$sshScript = "set -e; cd /opt/opencode-gateway; printf 'head='; git rev-parse HEAD; printf '\ngateway='; systemctl is-active $GatewayService; printf '\nproxy='; systemctl is-active $ProxyService; printf '\n'"
$sshRaw = ssh -i $SshKey -o BatchMode=yes "$User@$HostName" $sshScript
$vps = @{}
foreach ($line in $sshRaw) {
  if ($line -match '^([^=]+)=(.*)$') {
    $vps[$Matches[1]] = $Matches[2]
  }
}

$prodParams = @{
  BaseUrl = $BaseUrl
  HostName = $HostName
  User = $User
  SshKey = $SshKey
}
if (-not $RunChat) { $prodParams.SkipChat = $true }
$prodOutput = & (Join-Path $PSScriptRoot "prod-e2e.ps1") @prodParams
$prod = ($prodOutput | Out-String) | ConvertFrom-Json

$manifestUrl = "$DownloadBaseUrl/$ManifestFile"
$installerUrl = "$DownloadBaseUrl/$InstallerFile"
$manifest = Invoke-RestMethod $manifestUrl
$headers = curl.exe -sI -L $installerUrl
$httpStatus = ($headers | Select-String -Pattern '^HTTP/' | Select-Object -Last 1).Line
$contentLengthRaw = Parse-HeaderValue $headers "Content-Length"
$contentLength = 0
if ($contentLengthRaw -match '^\d+$') {
  $contentLength = [int64]$contentLengthRaw
}

$shaVerified = $false
$downloadedSha = ""
if ($VerifyInstallerSha) {
  $tempFile = Join-Path $env:TEMP "$([guid]::NewGuid().ToString('N'))-$InstallerFile"
  try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $tempFile
    $downloadedSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $tempFile).Hash.ToLowerInvariant()
    $shaVerified = $downloadedSha -eq ([string]$manifest.sha256).ToLowerInvariant()
  } finally {
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
  }
}

$desktopOk = (
  $httpStatus -match '200' -and
  [int64]$manifest.size -gt 0 -and
  $contentLength -eq [int64]$manifest.size -and
  [string]$manifest.gatewayUrl -eq $BaseUrl -and
  -not [string]::IsNullOrWhiteSpace([string]$manifest.sha256)
)
if ($VerifyInstallerSha) {
  $desktopOk = $desktopOk -and $shaVerified
}

$requirements = [ordered]@{
  gateway_github_repo_uploaded = [bool]$remoteUploaded
  gateway_vps_deployed_current = ([string]$vps["head"] -eq $localHead)
  gateway_service_active = ([string]$vps["gateway"] -eq "active")
  codex_proxy_service_active = ([string]$vps["proxy"] -eq "active")
  db_connected = [bool]$prod.requirements.db_connected
  upstream_connected = [bool]$prod.requirements.upstream_connected
  core_api_e2e = [bool]$prod.requirements.core_api_e2e
  oauth_configured = [bool]$prod.requirements.oauth_configured
  oauth_human_approved = [bool]$prod.requirements.oauth_human_approved
  billing_checkout_ready = [bool]$prod.requirements.billing_checkout_ready
  billing_webhook_ready = [bool]$prod.requirements.billing_webhook_ready
  billing_credit_e2e = [bool]$prod.requirements.billing_credit_e2e
  desktop_installer_deployed = [bool]$desktopOk
}

$coreReady = (
  $requirements["gateway_github_repo_uploaded"] -and
  $requirements["gateway_vps_deployed_current"] -and
  $requirements["gateway_service_active"] -and
  $requirements["codex_proxy_service_active"] -and
  $requirements["db_connected"] -and
  $requirements["upstream_connected"] -and
  $requirements["core_api_e2e"] -and
  $requirements["oauth_configured"] -and
  $requirements["desktop_installer_deployed"]
)
$allReady = (
  $coreReady -and
  $requirements["oauth_human_approved"] -and
  $requirements["billing_checkout_ready"] -and
  $requirements["billing_webhook_ready"] -and
  $requirements["billing_credit_e2e"]
)

$report = [ordered]@{
  ok = [bool]$coreReady
  all_complete = [bool]$allReady
  generated_at = (Get-Date).ToString("o")
  github = [ordered]@{
    local_head = $localHead
    remote_head = $remoteHead
    branch = $Branch
    commit_url = "$remoteBase/commit/$localHead"
  }
  vps = [ordered]@{
    host = $HostName
    head = $vps["head"]
    gateway_service = $vps["gateway"]
    codex_proxy_service = $vps["proxy"]
  }
  gateway = $prod
  desktop = [ordered]@{
    manifest_url = $manifestUrl
    installer_url = $installerUrl
    http_status = $httpStatus
    manifest_name = $manifest.name
    manifest_commit = $manifest.commit
    gateway_url = $manifest.gatewayUrl
    size = [int64]$manifest.size
    content_length = $contentLength
    sha256 = $manifest.sha256
    sha256_verified = $shaVerified
  }
  requirements = $requirements
  pending = @(
    if (-not $requirements["oauth_human_approved"]) { "Google OAuth human approval has not completed yet." }
    if (-not $requirements["billing_checkout_ready"]) { "Stripe secret key and billing plans are not configured on the VPS." }
    if (-not $requirements["billing_webhook_ready"]) { "Stripe webhook secret is not configured on the VPS." }
    if (-not $requirements["billing_credit_e2e"]) { "A real checkout-to-webhook-to-credit flow has not completed yet." }
  )
}

$report | ConvertTo-Json -Depth 30

if ($RequireAll -and -not $allReady) {
  exit 1
}
if (-not $coreReady) {
  exit 1
}
