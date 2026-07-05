param(
  [string]$BaseUrl = "https://llms.ai.kr/opencode-gateway",
  [string]$Token,
  [string]$AdminToken,
  [string]$HostName = "168.144.72.10",
  [string]$User = "root",
  [string]$SshKey = "$env:USERPROFILE\.ssh\polybot_vps_nopass",
  [switch]$SkipSshTokenLookup,
  [switch]$SkipChat,
  [switch]$CreateOAuthLink,
  [switch]$WaitForOAuthApproval,
  [int]$OAuthTimeoutSeconds = 300,
  [switch]$RequireOAuthApproval,
  [switch]$RequireBillingReady,
  [switch]$CreateCheckout,
  [string]$BillingPlanId
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

function Get-FirstTokenFromSeedSpec($SeedSpec) {
  if ([string]::IsNullOrWhiteSpace($SeedSpec)) { return "" }
  return (($SeedSpec -split ",")[0] -split ":")[0].Trim()
}

$BaseUrl = $BaseUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($Token)) {
  $Token = Get-RemoteEnvValue "YOURSERVICE_DEV_TOKEN"
  if ([string]::IsNullOrWhiteSpace($Token)) {
    $Token = Get-FirstTokenFromSeedSpec (Get-RemoteEnvValue "YOURSERVICE_DEV_TOKENS")
  }
}
if ([string]::IsNullOrWhiteSpace($AdminToken)) {
  $AdminToken = Get-RemoteEnvValue "YOURSERVICE_ADMIN_TOKEN"
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "A gateway bearer token is required. Pass -Token or allow SSH lookup from /etc/opencode-gateway.env."
}

$headers = @{ Authorization = "Bearer $Token" }
$core = [ordered]@{}
$oauth = [ordered]@{ requested = [bool]($CreateOAuthLink -or $WaitForOAuthApproval -or $RequireOAuthApproval) }
$billing = [ordered]@{}

$health = Invoke-Json "$BaseUrl/health"
if (-not $health.ok) { throw "Health check failed for $BaseUrl" }
$core.health = $true
$core.state_backend = $health.state_backend

$admin = $null
if ($AdminToken) {
  $admin = Invoke-Json "$BaseUrl/admin/status" "GET" @{ Authorization = "Bearer $AdminToken" }
  $core.admin_status = [bool]$admin.ok
  if ($admin.gateway) {
    $core.upstream_mode = $admin.gateway.upstream.mode
    $core.upstream_base_configured = [bool]$admin.gateway.upstream.openai_base_url_configured
  }
  if ($admin.oauth) {
    $oauth.enabled = [bool]$admin.oauth.enabled
    $oauth.redirect_uri = $admin.oauth.redirect_uri
    $oauth.external_identities = [int]$admin.state.external_identities
  }
} else {
  $core.admin_status = $false
}

$models = Invoke-Json "$BaseUrl/v1/models" "GET" $headers
if (-not $models.data -or @($models.data).Count -lt 1) { throw "No models returned from $BaseUrl/v1/models" }
$core.models = @($models.data).Count

$creditsBefore = Invoke-Json "$BaseUrl/v1/credits" "GET" $headers
$core.credits_before = [int64]$creditsBefore.credits

if ($SkipChat) {
  $core.chat = "skipped"
} else {
  $chatBody = @{
    model = "fast"
    messages = @(
      @{ role = "user"; content = "Reply with exactly: ok" }
    )
    max_tokens = 32
  }
  $chat = Invoke-Json "$BaseUrl/v1/chat/completions" "POST" ($headers + @{ "Idempotency-Key" = "prod-e2e-chat-$([guid]::NewGuid().ToString('N'))" }) $chatBody 120
  if ($chat.object -ne "chat.completion") { throw "Unexpected chat object: $($chat.object)" }
  $content = [string]$chat.choices[0].message.content
  if ([string]::IsNullOrWhiteSpace($content)) { throw "Chat completion returned empty content." }
  $core.chat = "passed"
  $core.chat_preview = $content.Substring(0, [Math]::Min(80, $content.Length))
}

$creditsAfter = Invoke-Json "$BaseUrl/v1/credits" "GET" $headers
$core.credits_after = [int64]$creditsAfter.credits
$core.credits_delta = [int64]$creditsAfter.credits - [int64]$creditsBefore.credits

$usage = Invoke-Json "$BaseUrl/v1/usage" "GET" $headers
if ($usage.data) {
  $core.usage_rows_visible = @($usage.data).Count
} else {
  $core.usage_rows_visible = 0
}

$billingStatus = Invoke-Json "$BaseUrl/billing/status" "GET" $headers
$billing.provider = $billingStatus.provider
$billing.checkout_configured = [bool]$billingStatus.checkout_configured
$billing.plans_count = [int]$billingStatus.plans_count
$billing.stripe_secret_configured = [bool]$billingStatus.stripe.secret_configured
$billing.webhook_configured = [bool]$billingStatus.webhook_configured
$plans = Invoke-Json "$BaseUrl/billing/plans" "GET" $headers
$billing.authenticated_plans_visible = [bool]($plans.data -and @($plans.data).Count -gt 0)

if ($CreateCheckout) {
  if (-not $billing.checkout_configured) {
    $billing.checkout = "skipped_not_configured"
  } else {
    if ([string]::IsNullOrWhiteSpace($BillingPlanId)) {
      if ($plans.data -and @($plans.data).Count -gt 0) {
        $BillingPlanId = [string]$plans.data[0].id
      } else {
        throw "CreateCheckout was requested but no BillingPlanId was supplied and no plans were returned."
      }
    }
    $checkout = Invoke-Json "$BaseUrl/billing/checkout" "POST" ($headers + @{ "Idempotency-Key" = "prod-e2e-checkout-$([guid]::NewGuid().ToString('N'))" }) @{ plan_id = $BillingPlanId }
    $billing.checkout = "created"
    $billing.checkout_provider = $checkout.provider
    $billing.checkout_url = $checkout.checkout_url
  }
} else {
  $billing.checkout = "not_requested"
}

if ($CreateOAuthLink -or $WaitForOAuthApproval -or $RequireOAuthApproval) {
  $device = Invoke-Json "$BaseUrl/auth/device/code" "POST" @{} @{ client_id = "codexshare-prod-e2e"; scope = "openid email profile" }
  $oauth.user_code = $device.user_code
  $oauth.activate_url = "$BaseUrl/activate?user_code=$($device.user_code)"
  $oauth.google_oauth_url = "$BaseUrl/auth/oauth/start?user_code=$($device.user_code)"
  $oauth.expires_in = [int]$device.expires_in
  $oauth.approved = $false

  if ($WaitForOAuthApproval -or $RequireOAuthApproval) {
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $OAuthTimeoutSeconds))
    do {
      Start-Sleep -Seconds ([Math]::Max(1, [int]$device.interval))
      $poll = Invoke-Json "$BaseUrl/auth/device/token" "POST" @{} @{ device_code = $device.device_code }
      if ($poll.access_token) {
        $oauth.approved = $true
        $oauth.access_token_received = $true
        $oauthUser = Invoke-Json "$BaseUrl/api/user" "GET" @{ Authorization = "Bearer $($poll.access_token)" }
        $oauth.user_id = $oauthUser.id
        break
      }
      $oauth.last_poll_error = $poll.error
    } while ((Get-Date) -lt $deadline)
  }
}

$requirements = [ordered]@{
  gateway_repo_uploaded = $true
  gateway_server_deployed = $true
  db_connected = ($core.state_backend -eq "postgres")
  upstream_connected = [bool]$core.upstream_base_configured
  core_api_e2e = ($core.health -and $core.models -ge 1 -and ($core.chat -eq "passed" -or $SkipChat))
  oauth_configured = [bool]$oauth.enabled
  oauth_human_approved = [bool]$oauth.approved
  billing_checkout_ready = [bool]$billing.checkout_configured
  billing_webhook_ready = [bool]$billing.webhook_configured
}

$report = [ordered]@{
  ok = $true
  base_url = $BaseUrl
  generated_at = (Get-Date).ToString("o")
  core = $core
  oauth = $oauth
  billing = $billing
  requirements = $requirements
}

$report | ConvertTo-Json -Depth 20

$mustPass = $requirements.core_api_e2e -and $requirements.db_connected
if ($RequireOAuthApproval) {
  $mustPass = $mustPass -and $requirements.oauth_human_approved
}
if ($RequireBillingReady) {
  $mustPass = $mustPass -and $requirements.billing_checkout_ready -and $requirements.billing_webhook_ready
}
if (-not $mustPass) {
  exit 1
}
