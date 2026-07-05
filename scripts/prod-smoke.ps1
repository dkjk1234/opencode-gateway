param(
  [Parameter(Mandatory=$true)]
  [string]$BaseUrl,

  [Parameter(Mandatory=$true)]
  [string]$Token
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd("/")
$headers = @{ Authorization = "Bearer $Token" }

$health = Invoke-RestMethod "$base/health"
if (-not $health.ok) {
  throw "Health check failed"
}

$models = Invoke-RestMethod "$base/v1/models" -Headers $headers
if (-not $models.data -or $models.data.Count -lt 1) {
  throw "No models returned"
}

$credits = Invoke-RestMethod "$base/v1/credits" -Headers $headers

$body = @{
  model = "fast"
  messages = @(
    @{ role = "user"; content = "Reply with the word ok." }
  )
  max_tokens = 32
} | ConvertTo-Json -Depth 8

$chat = Invoke-RestMethod "$base/v1/chat/completions" `
  -Method POST `
  -Headers ($headers + @{ "Content-Type" = "application/json" }) `
  -Body $body

[pscustomobject]@{
  health = [bool]$health.ok
  models = $models.data.Count
  credits = $credits.credits
  chatObject = $chat.object
  responsePreview = $chat.choices[0].message.content.Substring(0, [Math]::Min(80, $chat.choices[0].message.content.Length))
} | ConvertTo-Json -Depth 6
