param(
  [string]$HostName = "168.144.72.10",
  [string]$User = "root",
  [string]$SshKey = "$env:USERPROFILE\.ssh\polybot_vps_nopass",
  [string]$EnvPath = "/etc/opencode-gateway.env",
  [string]$ServiceName = "opencode-gateway.service",
  [string]$PublicBaseUrl = "https://llms.ai.kr/opencode-gateway",
  [string]$BillingPlansJson,
  [string]$StripeSecretKey,
  [string]$StripeWebhookSecret,
  [string]$SuccessUrl,
  [string]$CancelUrl,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Read-SecretText($Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Assert-PlanJson($Json) {
  if ([string]::IsNullOrWhiteSpace($Json)) {
    throw "BillingPlansJson is required. Example: '[{""id"":""starter"",""name"":""Starter credits"",""credits"":100000,""amount"":990,""currency"":""usd""}]'"
  }
  $parsed = $Json | ConvertFrom-Json
  $items = @($parsed)
  if ($items.Count -lt 1) {
    throw "BillingPlansJson must contain at least one plan."
  }
  foreach ($plan in $items) {
    if (-not $plan.id) { throw "Each billing plan must include id." }
    if (-not $plan.credits -or [int64]$plan.credits -le 0) { throw "Billing plan '$($plan.id)' must include positive credits." }
    if (-not $plan.stripe_price_id -and (-not $plan.amount -or [int64]$plan.amount -le 0)) {
      throw "Billing plan '$($plan.id)' must include amount unless stripe_price_id is set."
    }
  }
}

Require-Command ssh

if ([string]::IsNullOrWhiteSpace($BillingPlansJson)) {
  $BillingPlansJson = Read-Host "Billing plans JSON"
}
if ([string]::IsNullOrWhiteSpace($StripeSecretKey)) {
  $StripeSecretKey = Read-SecretText "Stripe secret key (sk_live_... or sk_test_...)"
}
if ([string]::IsNullOrWhiteSpace($StripeWebhookSecret)) {
  $StripeWebhookSecret = Read-SecretText "Stripe webhook secret (whsec_...)"
}

Assert-PlanJson $BillingPlansJson

if ([string]::IsNullOrWhiteSpace($StripeSecretKey)) {
  throw "StripeSecretKey is required."
}
if ([string]::IsNullOrWhiteSpace($StripeWebhookSecret)) {
  throw "StripeWebhookSecret is required."
}
if ([string]::IsNullOrWhiteSpace($SuccessUrl)) {
  $SuccessUrl = "$PublicBaseUrl/billing/success?session_id={CHECKOUT_SESSION_ID}"
}
if ([string]::IsNullOrWhiteSpace($CancelUrl)) {
  $CancelUrl = "$PublicBaseUrl/billing/cancel"
}

$config = [ordered]@{
  YOURSERVICE_BILLING_PROVIDER = "stripe"
  YOURSERVICE_BILLING_PLANS_JSON = $BillingPlansJson
  YOURSERVICE_BILLING_SUCCESS_URL = $SuccessUrl
  YOURSERVICE_BILLING_CANCEL_URL = $CancelUrl
  YOURSERVICE_STRIPE_SECRET_KEY = $StripeSecretKey
  YOURSERVICE_STRIPE_WEBHOOK_SECRET = $StripeWebhookSecret
  YOURSERVICE_STRIPE_API_BASE_URL = "https://api.stripe.com"
}

$planCount = @($BillingPlansJson | ConvertFrom-Json).Count
$safePreview = [ordered]@{
  host = "$User@$HostName"
  env_path = $EnvPath
  service = $ServiceName
  public_base_url = $PublicBaseUrl
  plans_count = $planCount
  stripe_secret_configured = $StripeSecretKey.Length -gt 0
  stripe_webhook_configured = $StripeWebhookSecret.Length -gt 0
  success_url = $SuccessUrl
  cancel_url = $CancelUrl
}

if ($DryRun) {
  $safePreview | ConvertTo-Json -Depth 5
  exit 0
}

$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Compress)))
$remoteScript = @'
set -euo pipefail
payload="$1"
env_path="$2"
service_name="$3"
tmp="$(mktemp)"
python3 - "$payload" "$env_path" > "$tmp" <<'PY'
import base64
import json
import os
import shlex
import sys

payload = sys.argv[1]
env_path = sys.argv[2]
updates = json.loads(base64.b64decode(payload).decode("utf-8"))
existing = []
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as handle:
        existing = handle.readlines()
keys = set(updates)
for line in existing:
    stripped = line.strip()
    key = stripped.split("=", 1)[0] if "=" in stripped else ""
    if key not in keys:
        sys.stdout.write(line)
if existing and not existing[-1].endswith("\n"):
    sys.stdout.write("\n")
sys.stdout.write("\n# Stripe billing configured by scripts/configure-vps-billing.ps1\n")
for key, value in updates.items():
    sys.stdout.write(f"{key}={shlex.quote(str(value))}\n")
PY
install -m 600 "$tmp" "${env_path}.new"
rm -f "$tmp"
if [ -f "$env_path" ]; then
  cp -a "$env_path" "${env_path}.bak.$(date +%Y%m%d%H%M%S)"
fi
mv "${env_path}.new" "$env_path"
systemctl restart "$service_name"
systemctl is-active --quiet "$service_name"
printf 'billing env updated and %s restarted\n' "$service_name"
'@

$remoteTarget = "$User@$HostName"
$sshArgs = @("-i", $SshKey, "-o", "BatchMode=yes", $remoteTarget, "bash", "-s", "--", $payload, $EnvPath, $ServiceName)
$remoteScript | ssh @sshArgs

Write-Host "Done. Now verify with:"
Write-Host "  .\scripts\prod-billing-readiness.ps1 -BaseUrl '$PublicBaseUrl' -SshKey '$SshKey' -HostName '$HostName'"
