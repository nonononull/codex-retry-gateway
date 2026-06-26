param(
  [string]$CodexConfigPath = "$HOME\.codex\config.toml",
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$ListenHost = "127.0.0.1",
  [int]$ListenPort = 4610
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "common.ps1")

$paths = Get-GatewayStatePaths -StateRoot $StateRoot
Ensure-Directory -Path $paths.StateRoot
Ensure-Directory -Path $paths.ConfigDir
Ensure-Directory -Path $paths.LogDir
Ensure-Directory -Path $paths.BackupDir

if (-not (Test-Path -LiteralPath $CodexConfigPath)) {
  throw "Codex config file was not found: $CodexConfigPath"
}

$providerContext = Get-CodexProviderContext -CodexConfigPath $CodexConfigPath
$localGatewayBaseUrl = "http://{0}:{1}" -f $ListenHost, $ListenPort
$existingState = Read-JsonFile -Path $paths.StatePath

$originalBaseUrl = $providerContext.CurrentBaseUrl
if ($providerContext.CurrentBaseUrl -eq $localGatewayBaseUrl) {
  if ($null -eq $existingState -or [string]::IsNullOrWhiteSpace([string]$existingState.original_base_url)) {
    throw "Provider already points to the local gateway, but original_base_url is missing from state."
  }
  $originalBaseUrl = [string]$existingState.original_base_url
}

if ($originalBaseUrl -eq $localGatewayBaseUrl) {
  throw "A real upstream_base_url could not be determined."
}

$backupPath = Join-Path $paths.BackupDir ("config-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".toml")
Copy-Item -LiteralPath $CodexConfigPath -Destination $backupPath -Force

$existingGatewayConfig = Read-JsonFile -Path $paths.ConfigPath
$defaultEndpoints = @("/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions")
$mergedEndpoints = @()
foreach ($endpoint in @(
  $(if ($existingGatewayConfig) { Normalize-StringArray -Values $existingGatewayConfig.endpoints -Default @() } else { @() }) +
  $defaultEndpoints
)) {
  if ([string]::IsNullOrWhiteSpace([string]$endpoint)) {
    continue
  }
  if ($mergedEndpoints -notcontains [string]$endpoint) {
    $mergedEndpoints += [string]$endpoint
  }
}

$gatewayConfig = [ordered]@{
  listen_host = $ListenHost
  listen_port = $ListenPort
  upstream_base_url = $originalBaseUrl
  request_body_limit_bytes = if ($existingGatewayConfig -and $null -ne $existingGatewayConfig.request_body_limit_bytes) { [int]$existingGatewayConfig.request_body_limit_bytes } else { 10485760 }
  endpoints = @($mergedEndpoints)
  reasoning_equals = Normalize-IntArray -Values $(if ($existingGatewayConfig) { $existingGatewayConfig.reasoning_equals } else { $null }) -Default @(516)
  non_stream_status_code = if ($existingGatewayConfig -and $null -ne $existingGatewayConfig.non_stream_status_code) { [int]$existingGatewayConfig.non_stream_status_code } else { 502 }
  stream_action = if ($existingGatewayConfig -and -not [string]::IsNullOrWhiteSpace([string]$existingGatewayConfig.stream_action)) { [string]$existingGatewayConfig.stream_action } else { "strict_502" }
  log_match = if ($existingGatewayConfig -and $null -ne $existingGatewayConfig.log_match) { [bool]$existingGatewayConfig.log_match } else { $true }
  health_path = if ($existingGatewayConfig -and -not [string]::IsNullOrWhiteSpace([string]$existingGatewayConfig.health_path)) { [string]$existingGatewayConfig.health_path } else { "/__codex_retry_gateway/health" }
}

$previousConfigContent = Get-Content -LiteralPath $CodexConfigPath -Raw

try {
  Write-JsonFile -Path $paths.ConfigPath -Value $gatewayConfig
  Set-CodexProviderBaseUrl `
    -CodexConfigPath $CodexConfigPath `
    -ProviderName $providerContext.ProviderName `
    -NewBaseUrl $localGatewayBaseUrl

  & (Join-Path $PSScriptRoot "start-gateway.ps1") `
    -StateRoot $StateRoot `
    -ConfigPath $paths.ConfigPath `
    -LogPath $paths.LogPath `
    -RestartIfRunning

  $state = [ordered]@{
    installed_at        = (Get-Date).ToString("o")
    codex_config_path   = $CodexConfigPath
    provider_name       = $providerContext.ProviderName
    original_base_url   = $originalBaseUrl
    gateway_base_url    = $localGatewayBaseUrl
    gateway_config_path = $paths.ConfigPath
    gateway_log_path    = $paths.LogPath
    gateway_pid_path    = $paths.PidPath
    latest_backup_path  = $backupPath
    state_root          = $paths.StateRoot
  }
  Write-JsonFile -Path $paths.StatePath -Value $state

  Write-Output "Installed Codex Retry Gateway"
  Write-Output "provider=$($providerContext.ProviderName)"
  Write-Output "upstream=$originalBaseUrl"
  Write-Output "gateway=$localGatewayBaseUrl"
  Write-Output "config=$($paths.ConfigPath)"
  Write-Output "backup=$backupPath"
} catch {
  Write-Utf8NoBomFile -Path $CodexConfigPath -Content $previousConfigContent
  & (Join-Path $PSScriptRoot "stop-gateway.ps1") -StateRoot $StateRoot -Quiet
  throw
}
