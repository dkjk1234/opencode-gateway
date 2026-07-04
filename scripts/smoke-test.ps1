[CmdletBinding()]
param(
    [string]$Token = "dev-token",
    [int]$Port = 8788
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ErrorResponse {
    param($ErrorRecord)
    if ($ErrorRecord.Exception.PSObject.Properties.Name -contains "Response") {
        return $ErrorRecord.Exception.Response
    }
    if ($ErrorRecord.Exception.InnerException -and ($ErrorRecord.Exception.InnerException.PSObject.Properties.Name -contains "Response")) {
        return $ErrorRecord.Exception.InnerException.Response
    }
    return $null
}

function Read-ErrorBodyJson {
    param($ErrorRecord)
    try {
        if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
            return $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
        }
        $response = Get-ErrorResponse $ErrorRecord
        if (-not $response) { return $null }
        if ($response.PSObject.Methods.Name -contains "GetResponseStream") {
            $stream = $response.GetResponseStream()
            if (-not $stream) { return $null }
            $reader = [System.IO.StreamReader]::new($stream)
            $text = $reader.ReadToEnd()
            if (-not $text) { return $null }
            return $text | ConvertFrom-Json
        }
        return $null
    } catch {
        return $null
    }
}

function Get-ErrorStatusCode {
    param($ErrorRecord)
    $response = Get-ErrorResponse $ErrorRecord
    if ($response -and ($response.PSObject.Properties.Name -contains "StatusCode")) {
        return [int]$response.StatusCode
    }
    if ($ErrorRecord.Exception.PSObject.Properties.Name -contains "StatusCode") {
        return [int]$ErrorRecord.Exception.StatusCode
    }
    return $null
}

function Invoke-ExpectStatus {
    param(
        [int]$StatusCode,
        [string]$Uri,
        [string]$Method = "GET",
        [hashtable]$Headers = @{},
        [AllowNull()]$Body = $null,
        [string]$ContentType = $null
    )

    try {
        $params = @{ Uri = $Uri; Method = $Method; Headers = $Headers }
        if ($PSBoundParameters.ContainsKey("Body")) { $params.Body = $Body }
        if ($ContentType) { $params.ContentType = $ContentType }
        $result = Invoke-RestMethod @params
        throw "Expected HTTP $StatusCode from $Method $Uri but request succeeded: $($result | ConvertTo-Json -Compress)"
    } catch {
        $actual = Get-ErrorStatusCode $_
        if ($null -eq $actual) { throw }
        if ($actual -ne $StatusCode) {
            $bodyJson = Read-ErrorBodyJson $_
            throw "Expected HTTP $StatusCode from $Method $Uri but got ${actual}: $($bodyJson | ConvertTo-Json -Compress)"
        }
        return Read-ErrorBodyJson $_
    }
}

$root = Split-Path -Parent $PSScriptRoot
$tempState = Join-Path ([System.IO.Path]::GetTempPath()) ("yourservice-gateway-smoke-{0}.json" -f ([guid]::NewGuid().ToString("N")))
$adminToken = "smoke-admin-$([guid]::NewGuid().ToString('N'))"
$env:YOURSERVICE_DEV_TOKENS = "${Token}:100000"
$env:YOURSERVICE_GATEWAY_PORT = [string]$Port
$env:YOURSERVICE_DATA_PATH = $tempState
$env:YOURSERVICE_ADMIN_TOKEN = $adminToken
$env:YOURSERVICE_MAX_BODY_BYTES = "4096"

$job = Start-Job -ScriptBlock {
    param($Root, $StatePath, $TokenSpec, $PortValue, $AdminTokenValue, $MaxBodyBytes)
    Set-Location $Root
    $env:YOURSERVICE_DATA_PATH = $StatePath
    $env:YOURSERVICE_DEV_TOKENS = $TokenSpec
    $env:YOURSERVICE_GATEWAY_PORT = $PortValue
    $env:YOURSERVICE_ADMIN_TOKEN = $AdminTokenValue
    $env:YOURSERVICE_MAX_BODY_BYTES = $MaxBodyBytes
    node src/server.mjs
} -ArgumentList $root, $tempState, $env:YOURSERVICE_DEV_TOKENS, $env:YOURSERVICE_GATEWAY_PORT, $env:YOURSERVICE_ADMIN_TOKEN, $env:YOURSERVICE_MAX_BODY_BYTES

try {
    Start-Sleep -Seconds 2
    $base = "http://127.0.0.1:$Port"
    $headers = @{ Authorization = "Bearer $Token" }
    $jsonHeaders = $headers + @{ "Content-Type" = "application/json" }

    $health = Invoke-RestMethod "$base/health"
    if (-not $health.ok) { throw "Health check failed" }

    $models = Invoke-RestMethod "$base/v1/models" -Headers $headers
    if ($models.data.Count -lt 1) { throw "No models returned" }

    $grantBefore = Invoke-RestMethod "$base/v1/credits" -Headers $headers
    $grantKey = "smoke-grant-$([guid]::NewGuid().ToString('N'))"
    $grantHeaders = @{
        Authorization = "Bearer $adminToken"
        "Content-Type" = "application/json"
        "Idempotency-Key" = $grantKey
    }
    $grantBody = @{
        token = $Token
        credits = 25
        reason = "smoke test credit grant"
    } | ConvertTo-Json
    $grant = Invoke-RestMethod "$base/admin/credits/grant" -Method "POST" -Headers $grantHeaders -Body $grantBody
    $grantReplay = Invoke-RestMethod "$base/admin/credits/grant" -Method "POST" -Headers $grantHeaders -Body $grantBody
    $grantAfter = Invoke-RestMethod "$base/v1/credits" -Headers $headers
    if ($grant.replayed) { throw "Initial credit grant was marked as a replay" }
    if (-not $grantReplay.replayed) { throw "Credit grant replay was not idempotent" }
    if (($grantAfter.credits - $grantBefore.credits) -ne 25) { throw "Admin credit grant changed balance by the wrong amount" }

    $badDevice = Invoke-RestMethod "$base/auth/device/code" -Method "POST" -ContentType "application/json" -Body (@{ client_id = "opencode-cli" } | ConvertTo-Json)
    $badApproveBody = @{ user_code = $badDevice.user_code; token = "not-a-real-token" } | ConvertTo-Json
    $badApprove = Invoke-ExpectStatus -StatusCode 404 -Uri "$base/auth/device/approve" -Method "POST" -ContentType "application/json" -Body $badApproveBody
    if ($badApprove.error.code -ne "device_code_not_found") { throw "Bad approval token returned wrong error" }

    $device = Invoke-RestMethod "$base/auth/device/code" -Method "POST" -ContentType "application/json" -Body (@{ client_id = "opencode-cli" } | ConvertTo-Json)
    if (-not $device.device_code -or -not $device.user_code) { throw "Device code response missing fields" }

    $approveBody = @{ user_code = $device.user_code; token = $Token } | ConvertTo-Json
    $approved = Invoke-RestMethod "$base/auth/device/approve" -Method "POST" -ContentType "application/json" -Body $approveBody
    if (-not $approved.ok) { throw "Device approval failed" }

    $pollBody = @{
        grant_type = "urn:ietf:params:oauth:grant-type:device_code"
        device_code = $device.device_code
        client_id = "opencode-cli"
    } | ConvertTo-Json
    $oauth = Invoke-RestMethod "$base/auth/device/token" -Method "POST" -ContentType "application/json" -Body $pollBody
    if (-not $oauth.access_token -or -not $oauth.refresh_token) { throw "Device token response missing token fields" }

    $oauthHeaders = @{ Authorization = "Bearer $($oauth.access_token)" }
    $user = Invoke-RestMethod "$base/api/user" -Headers $oauthHeaders
    $orgs = Invoke-RestMethod "$base/api/orgs" -Headers $oauthHeaders
    $config = Invoke-RestMethod "$base/api/config" -Headers ($oauthHeaders + @{ "x-org-id" = $orgs[0].id })
    if (-not $user.id -or -not $config.config.provider.yourservice) { throw "Console-compatible API response invalid" }
    if ($config.config.provider.yourservice.env[0] -ne "OPENCODE_CONSOLE_TOKEN") { throw "Remote config missing OPENCODE_CONSOLE_TOKEN env" }

    $invalidModelBody = @{ model = "missing"; messages = @(@{ role = "user"; content = "hello" }) } | ConvertTo-Json -Depth 8
    $invalidModel = Invoke-ExpectStatus -StatusCode 400 -Uri "$base/v1/chat/completions" -Method "POST" -Headers $jsonHeaders -Body $invalidModelBody
    if ($invalidModel.error.code -ne "unknown_model") { throw "Unknown model did not return unknown_model" }

    $missingMessagesBody = @{ model = "fast" } | ConvertTo-Json -Depth 8
    $missingMessages = Invoke-ExpectStatus -StatusCode 400 -Uri "$base/v1/chat/completions" -Method "POST" -Headers $jsonHeaders -Body $missingMessagesBody
    if ($missingMessages.error.code -ne "invalid_messages") { throw "Missing messages did not return invalid_messages" }

    $largeBody = @{ model = "fast"; messages = @(@{ role = "user"; content = ("x" * 5000) }) } | ConvertTo-Json -Depth 8 -Compress
    $tooLarge = Invoke-ExpectStatus -StatusCode 413 -Uri "$base/v1/chat/completions" -Method "POST" -Headers $jsonHeaders -Body $largeBody
    if ($tooLarge.error.code -ne "payload_too_large") { throw "Oversized request did not return payload_too_large" }

    $body = @{
        model = "fast"
        messages = @(@{ role = "user"; content = "gateway smoke test" })
    } | ConvertTo-Json -Depth 8

    $before = Invoke-RestMethod "$base/v1/credits" -Headers $headers
    $idem = "smoke-$([guid]::NewGuid().ToString('N'))"
    $chat = Invoke-RestMethod "$base/v1/chat/completions" -Method "POST" -Headers ($jsonHeaders + @{ "Idempotency-Key" = $idem }) -Body $body
    $replay = Invoke-RestMethod "$base/v1/chat/completions" -Method "POST" -Headers ($jsonHeaders + @{ "Idempotency-Key" = $idem }) -Body $body
    $conflictBody = @{ model = "fast"; messages = @(@{ role = "user"; content = "different body" }) } | ConvertTo-Json -Depth 8
    $conflict = Invoke-ExpectStatus -StatusCode 409 -Uri "$base/v1/chat/completions" -Method "POST" -Headers ($jsonHeaders + @{ "Idempotency-Key" = $idem }) -Body $conflictBody
    $after = Invoke-RestMethod "$base/v1/credits" -Headers $headers
    if ($chat.id -ne $replay.id) { throw "Idempotent replay returned a different request id" }
    if ($conflict.error.code -ne "idempotency_conflict") { throw "Idempotency conflict returned wrong error" }
    if (($before.credits - $after.credits) -ne $chat.yourservice.credits_charged) { throw "Credit debit mismatch" }

    $usage = Invoke-RestMethod "$base/v1/usage" -Headers $headers
    $ledgerRows = @($usage.data)
    $charged = [int]$chat.yourservice.credits_charged
    if (-not ($ledgerRows | Where-Object { $_.type -eq "credit" -and $_.amount -eq 25 -and $_.reason -eq "smoke test credit grant" })) {
        throw "Admin credit grant ledger row missing"
    }
    if (-not ($ledgerRows | Where-Object { $_.type -eq "debit" -and $_.amount -eq (-$charged) })) {
        throw "Chat debit ledger row missing"
    }

    $refreshBody = @{ grant_type = "refresh_token"; refresh_token = $oauth.refresh_token; client_id = "opencode-cli" } | ConvertTo-Json
    $refreshed = Invoke-RestMethod "$base/auth/device/token" -Method "POST" -ContentType "application/json" -Body $refreshBody
    if (-not $refreshed.access_token -or -not $refreshed.refresh_token) { throw "Refresh token response missing token fields" }
    $refreshReplay = Invoke-RestMethod "$base/auth/device/token" -Method "POST" -ContentType "application/json" -Body $refreshBody
    if ($refreshReplay.error -ne "invalid_grant") { throw "Old refresh token was reusable" }

    $logoutHeaders = @{ Authorization = "Bearer $($refreshed.access_token)" }
    $logoutBody = @{ refresh_token = $refreshed.refresh_token } | ConvertTo-Json
    $logout = Invoke-RestMethod "$base/auth/logout" -Method "POST" -Headers ($logoutHeaders + @{ "Content-Type" = "application/json" }) -Body $logoutBody
    if (-not $logout.ok -or -not $logout.revoked.access) { throw "Logout did not revoke access token" }
    $loggedOut = Invoke-ExpectStatus -StatusCode 401 -Uri "$base/api/user" -Headers $logoutHeaders
    if ($loggedOut.error.code -ne "unauthorized") { throw "Logged-out access token still worked" }
    $revokedRefreshBody = @{ grant_type = "refresh_token"; refresh_token = $refreshed.refresh_token; client_id = "opencode-cli" } | ConvertTo-Json
    $revokedRefresh = Invoke-RestMethod "$base/auth/device/token" -Method "POST" -ContentType "application/json" -Body $revokedRefreshBody
    if ($revokedRefresh.error -ne "invalid_grant") { throw "Logged-out refresh token still worked" }

    [pscustomobject]@{
        health = $health.ok
        models = $models.data.Count
        user = $user.email
        orgs = $orgs.Count
        remoteProvider = [bool]$config.config.provider.yourservice
        remoteEnv = $config.config.provider.yourservice.env[0]
        chatId = $chat.id
        creditGrant = $grant.credits
        creditGrantReplay = [bool]$grantReplay.replayed
        creditsCharged = $chat.yourservice.credits_charged
        creditsRemaining = $after.credits
        ledgerRows = $ledgerRows.Count
        idempotentReplay = ($chat.id -eq $replay.id)
        idempotencyConflict = ($conflict.error.code -eq "idempotency_conflict")
        validation = ($invalidModel.error.code -eq "unknown_model" -and $missingMessages.error.code -eq "invalid_messages" -and $tooLarge.error.code -eq "payload_too_large")
        refreshRotation = ($refreshReplay.error -eq "invalid_grant")
        logout = [bool]$logout.revoked.access
    } | ConvertTo-Json -Compress
} finally {
    Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $job -Force -ErrorAction SilentlyContinue | Out-Null
    Remove-Item -LiteralPath $tempState -Force -ErrorAction SilentlyContinue
}



