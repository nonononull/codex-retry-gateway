param(
  [string]$CodexConfigPath = "$HOME\.codex\config.toml",
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$ListenHost = "127.0.0.1",
  [int]$ListenPort = 4610
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "common.ps1")

function Get-OptionalPropertyValue {
  param(
    $Object,
    [Parameter(Mandatory = $true)]
    [string]$Name,
    $DefaultValue = $null
  )

  if ($null -eq $Object) {
    return $DefaultValue
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $DefaultValue
  }

  return $property.Value
}

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
  request_body_limit_bytes = [int](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "request_body_limit_bytes" -DefaultValue 10485760)
  endpoints = @($mergedEndpoints)
  reasoning_equals = Normalize-IntArray -Values (Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "reasoning_equals") -Default @(516, 1034, 1552)
  intercept_streaming = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "intercept_streaming" -DefaultValue $true)
  intercept_non_streaming = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "intercept_non_streaming" -DefaultValue $true)
  non_stream_status_code = [int](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "non_stream_status_code" -DefaultValue 502)
  guard_retry_attempts = [int](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "guard_retry_attempts" -DefaultValue 3)
  stream_action = if ([string]::IsNullOrWhiteSpace([string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "stream_action"))) { "strict_502" } else { [string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "stream_action") }
  log_match = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "log_match" -DefaultValue $true)
  health_path = if ([string]::IsNullOrWhiteSpace([string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "health_path"))) { "/__codex_retry_gateway/health" } else { [string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "health_path") }
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
