param(
  [string]$BaseUrl = "https://llms.ai.kr/opencode-gateway",
  [string]$HostName = "168.144.72.10",
  [string]$User = "root",
  [string]$SshKey = "$env:USERPROFILE\.ssh\polybot_vps_nopass",
  [string]$BillingPlansJson = '[{"id":"starter","name":"Starter credits","credits":100000,"amount":990,"currency":"usd"}]',
  [switch]$SkipOAuthLink,
  [switch]$WaitForOAuthApproval,
  [int]$OAuthTimeoutSeconds = 600,
  [switch]$ConfigureStripe,
  [switch]$CreateCheckout,
  [switch]$WaitForBillingCredit,
  [switch]$VerifyInstallerSha,
  [switch]$RequireAll
)

$ErrorActionPreference = "Stop"

function Invoke-Json {
  param(
    [Parameter(Mandatory=$true)][string]$Uri,
    [string]$Method = "GET",
    [hashtable]$Headers = @{},
    $Body = $null,
    [int]$TimeoutSec = 60
  )
  $args = @{
    Uri = $Uri
    Method = $Method
    Headers = $Headers
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) {
    $args.ContentType = "application/json"
    if ($Body -is [string]) {
      $args.Body = $Body
    } else {
      $args.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
    }
  }
  Invoke-RestMethod @args
}

function Invoke-Script {
  param(
    [Parameter(Mandatory=$true)][string]$ScriptName,
    [hashtable]$Params = @{}
  )
  $scriptPath = Join-Path $PSScriptRoot $ScriptName
  & $scriptPath @Params
}

$BaseUrl = $BaseUrl.TrimEnd("/")
$summary = [ordered]@{
  base_url = $BaseUrl
  generated_at = (Get-Date).ToString("o")
  oauth = [ordered]@{}
  stripe = [ordered]@{}
  readiness = $null
  next_actions = @()
}

if (-not $SkipOAuthLink) {
  $device = Invoke-Json "$BaseUrl/auth/device/code" "POST" @{} @{ client_id = "codexshare-operator-connect"; scope = "openid email profile" }
  $summary.oauth.user_code = $device.user_code
  $summary.oauth.activate_url = "$BaseUrl/activate?user_code=$($device.user_code)"
  $summary.oauth.google_oauth_url = "$BaseUrl/auth/oauth/start?user_code=$($device.user_code)"
  $summary.oauth.expires_at_kst = (Get-Date).AddSeconds([int]$device.expires_in).ToString("yyyy-MM-dd HH:mm:ss zzz")
  $summary.oauth.approved = $false
  $summary.next_actions += "Open oauth.google_oauth_url and approve Google login before the expiry time."

  if ($WaitForOAuthApproval) {
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $OAuthTimeoutSeconds))
    do {
      Start-Sleep -Seconds ([Math]::Max(1, [int]$device.interval))
      $poll = Invoke-Json "$BaseUrl/auth/device/token" "POST" @{} @{ device_code = $device.device_code }
      if ($poll.access_token) {
        $summary.oauth.approved = $true
        $summary.oauth.access_token_received = $true
        $userInfo = Invoke-Json "$BaseUrl/api/user" "GET" @{ Authorization = "Bearer $($poll.access_token)" }
        $summary.oauth.user_id = $userInfo.id
        break
      }
      $summary.oauth.last_poll_error = $poll.error
    } while ((Get-Date) -lt $deadline)
  }
}

if ($ConfigureStripe) {
  $summary.stripe.configure_attempted = $true
  Invoke-Script "configure-vps-billing.ps1" @{
    HostName = $HostName
    User = $User
    SshKey = $SshKey
    PublicBaseUrl = $BaseUrl
    BillingPlansJson = $BillingPlansJson
  }
} else {
  $summary.stripe.configure_attempted = $false
  $summary.next_actions += "Run this script again with -ConfigureStripe when Stripe sk_* and whsec_* values are ready."
}

if ($CreateCheckout -or $WaitForBillingCredit) {
  $prodParams = @{
    BaseUrl = $BaseUrl
    HostName = $HostName
    User = $User
    SshKey = $SshKey
    CreateCheckout = $true
  }
  if ($WaitForBillingCredit) {
    $prodParams.WaitForBillingCredit = $true
    $prodParams.RequireBillingCredit = $true
  }
  $checkoutOutput = Invoke-Script "prod-e2e.ps1" $prodParams
  $summary.stripe.checkout_e2e = ($checkoutOutput | Out-String | ConvertFrom-Json)
  if ($summary.stripe.checkout_e2e.billing.checkout_url) {
    $summary.next_actions += "Open stripe.checkout_e2e.billing.checkout_url and complete checkout; the verifier will wait if -WaitForBillingCredit is set."
  }
}

$readinessParams = @{
  BaseUrl = $BaseUrl
  HostName = $HostName
  User = $User
  SshKey = $SshKey
}
if ($VerifyInstallerSha) { $readinessParams.VerifyInstallerSha = $true }
if ($RequireAll) { $readinessParams.RequireAll = $true }
$readinessOutput = Invoke-Script "final-readiness.ps1" $readinessParams
$summary.readiness = ($readinessOutput | Out-String | ConvertFrom-Json)

if ($summary.readiness.pending) {
  foreach ($item in $summary.readiness.pending) {
    if ($summary.next_actions -notcontains $item) {
      $summary.next_actions += $item
    }
  }
}

$summary | ConvertTo-Json -Depth 40

if ($RequireAll -and -not $summary.readiness.all_complete) {
  exit 1
}
