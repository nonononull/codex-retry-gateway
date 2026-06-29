param(
  [string]$CodexConfigPath = "$HOME\.codex\config.toml",
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$ListenHost = "127.0.0.1",
  [int]$ListenPort = 4610,
  [switch]$NoOpen
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
$currentBaseUrl = [string]$providerContext.CurrentBaseUrl
$requestedGatewayBaseUrl = Get-GatewayBaseUrl -ListenHost $ListenHost -ListenPort $ListenPort
$existingState = Read-JsonFile -Path $paths.StatePath
$existingGatewayConfig = Read-JsonFile -Path $paths.ConfigPath
$stateGatewayBaseUrl = if ($existingState -and -not [string]::IsNullOrWhiteSpace([string]$existingState.gateway_base_url)) { [string]$existingState.gateway_base_url } else { $null }
$configGatewayBaseUrl = Get-GatewayBaseUrlFromConfig -GatewayConfig $existingGatewayConfig
$managedGatewayBaseUrls = @($requestedGatewayBaseUrl)
foreach ($candidate in @($stateGatewayBaseUrl, $configGatewayBaseUrl)) {
  if ([string]::IsNullOrWhiteSpace([string]$candidate)) {
    continue
  }
  if ($managedGatewayBaseUrls -notcontains [string]$candidate) {
    $managedGatewayBaseUrls += [string]$candidate
  }
}

$originalBaseUrl = if ($existingState -and -not [string]::IsNullOrWhiteSpace([string]$existingState.original_base_url)) {
  [string]$existingState.original_base_url
} elseif ($existingGatewayConfig -and -not [string]::IsNullOrWhiteSpace([string]$existingGatewayConfig.upstream_base_url)) {
  [string]$existingGatewayConfig.upstream_base_url
} else {
  $null
}

$canReuseExistingInstall =
  ($null -ne $existingGatewayConfig) -and
  (-not [string]::IsNullOrWhiteSpace([string]$originalBaseUrl)) -and
  ($managedGatewayBaseUrls -contains $currentBaseUrl)

$mode = "install"

if (-not $canReuseExistingInstall) {
  & (Join-Path $PSScriptRoot "install-for-current-provider.ps1") `
    -CodexConfigPath $CodexConfigPath `
    -StateRoot $StateRoot `
    -ListenHost $ListenHost `
    -ListenPort $ListenPort
} else {
  $mode = "reuse"
  $previousCodexConfigContent = Get-Content -LiteralPath $CodexConfigPath -Raw
  $previousGatewayConfigContent = if (Test-Path -LiteralPath $paths.ConfigPath) { Get-Content -LiteralPath $paths.ConfigPath -Raw } else { $null }
  $previousStateContent = if (Test-Path -LiteralPath $paths.StatePath) { Get-Content -LiteralPath $paths.StatePath -Raw } else { $null }

  try {
    $existingGatewayConfig.listen_host = $ListenHost
    $existingGatewayConfig.listen_port = $ListenPort
    if ([string]::IsNullOrWhiteSpace([string]$existingGatewayConfig.health_path)) {
      $existingGatewayConfig.health_path = "/__codex_retry_gateway/health"
    }
    if ($null -eq $existingGatewayConfig.PSObject.Properties["intercept_streaming"]) {
      $existingGatewayConfig | Add-Member -NotePropertyName "intercept_streaming" -NotePropertyValue $true
    }
    if ($null -eq $existingGatewayConfig.PSObject.Properties["intercept_non_streaming"]) {
      $existingGatewayConfig | Add-Member -NotePropertyName "intercept_non_streaming" -NotePropertyValue $true
    }
    if ($null -eq $existingGatewayConfig.PSObject.Properties["guard_retry_attempts"]) {
      $existingGatewayConfig | Add-Member -NotePropertyName "guard_retry_attempts" -NotePropertyValue 3
    }
    if ((-not [bool]$existingGatewayConfig.intercept_streaming) -and (-not [bool]$existingGatewayConfig.intercept_non_streaming)) {
      $existingGatewayConfig.intercept_streaming = $true
      $existingGatewayConfig.intercept_non_streaming = $true
    }
    Write-JsonFile -Path $paths.ConfigPath -Value $existingGatewayConfig

    if ($currentBaseUrl -ne $requestedGatewayBaseUrl) {
      Set-CodexProviderBaseUrl `
        -CodexConfigPath $CodexConfigPath `
        -ProviderName $providerContext.ProviderName `
        -NewBaseUrl $requestedGatewayBaseUrl
    }

    & (Join-Path $PSScriptRoot "start-gateway.ps1") `
      -StateRoot $StateRoot `
      -ConfigPath $paths.ConfigPath `
      -LogPath $paths.LogPath `
      -RestartIfRunning

    $statePayload = [ordered]@{
      installed_at        = if ($existingState -and $existingState.installed_at) { [string]$existingState.installed_at } else { (Get-Date).ToString("o") }
      last_started_at     = (Get-Date).ToString("o")
      codex_config_path   = $CodexConfigPath
      provider_name       = $providerContext.ProviderName
      original_base_url   = $originalBaseUrl
      gateway_base_url    = $requestedGatewayBaseUrl
      gateway_config_path = $paths.ConfigPath
      gateway_log_path    = $paths.LogPath
      gateway_pid_path    = $paths.PidPath
      latest_backup_path  = if ($existingState -and $existingState.latest_backup_path) { [string]$existingState.latest_backup_path } else { "" }
      state_root          = $paths.StateRoot
    }
    Write-JsonFile -Path $paths.StatePath -Value $statePayload
  } catch {
    Write-Utf8NoBomFile -Path $CodexConfigPath -Content $previousCodexConfigContent
    if ($null -ne $previousGatewayConfigContent) {
      Write-Utf8NoBomFile -Path $paths.ConfigPath -Content $previousGatewayConfigContent
    }
    if ($null -ne $previousStateContent) {
      Write-Utf8NoBomFile -Path $paths.StatePath -Content $previousStateContent
    }
    & (Join-Path $PSScriptRoot "stop-gateway.ps1") -StateRoot $StateRoot -Quiet
    throw
  }
}

$effectiveGatewayConfig = Read-JsonFile -Path $paths.ConfigPath
$effectiveGatewayBaseUrl = Get-GatewayBaseUrlFromConfig -GatewayConfig $effectiveGatewayConfig
if ([string]::IsNullOrWhiteSpace([string]$effectiveGatewayBaseUrl)) {
  $effectiveGatewayBaseUrl = $requestedGatewayBaseUrl
}

$uiUrl = $effectiveGatewayBaseUrl + "/__codex_retry_gateway/ui"
if (-not $NoOpen) {
  Start-Process $uiUrl | Out-Null
}

Write-Output "Codex Retry Gateway UI is ready"
Write-Output "mode=$mode"
Write-Output "ui=$uiUrl"
Write-Output "gateway=$effectiveGatewayBaseUrl"
