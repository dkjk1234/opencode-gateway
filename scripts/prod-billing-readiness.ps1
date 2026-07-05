param(
  [string]$BaseUrl = "https://llms.ai.kr/opencode-gateway",
  [string]$AdminToken,
  [string]$BearerToken,
  [string]$HostName = "168.144.72.10",
  [string]$User = "root",
  [string]$SshKey = "$env:USERPROFILE\.ssh\polybot_vps_nopass",
  [switch]$SkipSshTokenLookup,
  [switch]$RequireWebhook
)

$ErrorActionPreference = "Stop"

function Get-RemoteEnvValue($Name) {
  if ($SkipSshTokenLookup) { return "" }
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { return "" }
  $remote = "grep -m1 -E '^$Name=' /etc/opencode-gateway.env | cut -d= -f2-"
  try {
    return ((ssh -i $SshKey -o BatchMode=yes "$User@$HostName" $remote) | Select-Object -First 1).Trim()
  } catch {
    return ""
  }
}

function Invoke-Json($Uri, $Headers = @{}) {
  try {
    return Invoke-RestMethod -Uri $Uri -Headers $Headers -Method Get
  } catch {
    $response = $_.Exception.Response
    if ($response) {
      return [pscustomobject]@{
        error = $_.Exception.Message
        status = [int]$response.StatusCode
      }
    }
    throw
  }
}

$BaseUrl = $BaseUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($AdminToken)) {
  $AdminToken = Get-RemoteEnvValue "YOURSERVICE_ADMIN_TOKEN"
}
if ([string]::IsNullOrWhiteSpace($BearerToken)) {
  $BearerToken = Get-RemoteEnvValue "YOURSERVICE_DEV_TOKEN"
  if ([string]::IsNullOrWhiteSpace($BearerToken)) {
    $tokens = Get-RemoteEnvValue "YOURSERVICE_DEV_TOKENS"
    if ($tokens) {
      $BearerToken = (($tokens -split ",")[0] -split ":")[0]
    }
  }
}

$health = Invoke-Json "$BaseUrl/health"
$admin = $null
if ($AdminToken) {
  $admin = Invoke-Json "$BaseUrl/admin/status" @{ Authorization = "Bearer $AdminToken" }
}
$plans = $null
if ($BearerToken) {
  $plans = Invoke-Json "$BaseUrl/billing/plans" @{ Authorization = "Bearer $BearerToken" }
}

if ($admin -and $admin.billing) {
  $billing = $admin.billing
} elseif ($health.billing) {
  $billing = $health.billing
} else {
  $billing = [pscustomobject]@{}
}

if ($billing.stripe) {
  $stripe = $billing.stripe
} else {
  $stripe = [pscustomobject]@{}
}

$plansCount = 0
if ($billing.PSObject.Properties.Name -contains "plans_count") {
  $plansCount = [int]$billing.plans_count
}

$stripeWebhookConfigured = $false
if ($billing.PSObject.Properties.Name -contains "stripe_webhook_configured") {
  $stripeWebhookConfigured = [bool]$billing.stripe_webhook_configured
} elseif ($stripe.PSObject.Properties.Name -contains "webhook_configured") {
  $stripeWebhookConfigured = [bool]$stripe.webhook_configured
}

$successUrlConfigured = $false
if ($billing.PSObject.Properties.Name -contains "success_url_configured") {
  $successUrlConfigured = [bool]$billing.success_url_configured
}

$cancelUrlConfigured = $false
if ($billing.PSObject.Properties.Name -contains "cancel_url_configured") {
  $cancelUrlConfigured = [bool]$billing.cancel_url_configured
}

$authenticatedPlansVisible = $false
if ($plans -and $plans.plans) {
  $authenticatedPlansVisible = @($plans.plans).Count -gt 0
} elseif ($plans -and $plans.data) {
  $authenticatedPlansVisible = @($plans.data).Count -gt 0
}

$report = [ordered]@{
  ok = [bool]$health.ok
  base_url = $BaseUrl
  state_backend = $health.state_backend
  billing_provider = $billing.provider
  checkout_configured = [bool]$billing.checkout_configured
  plans_count = $plansCount
  stripe_secret_configured = [bool]$stripe.secret_configured
  stripe_webhook_configured = $stripeWebhookConfigured
  success_url_configured = $successUrlConfigured
  cancel_url_configured = $cancelUrlConfigured
  authenticated_plans_visible = $authenticatedPlansVisible
}

$report | ConvertTo-Json -Depth 8

$ready = $report.ok -and $report.checkout_configured -and ($report.plans_count -gt 0) -and $report.stripe_secret_configured
if ($RequireWebhook) {
  $ready = $ready -and $report.stripe_webhook_configured
}
if (-not $ready) {
  exit 1
}
