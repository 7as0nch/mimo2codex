<#
.SYNOPSIS
Start mimo2codex when needed, then launch Codex CLI with an isolated CODEX_HOME.

.DESCRIPTION
This Windows-only launcher is for users who want Codex CLI to use MiMo via
mimo2codex without changing the normal ~/.codex directory used by Codex Desktop.

It creates an isolated Codex home at %USERPROFILE%\.codex-mimo by default,
writes minimal auth/config files there if missing, starts mimo2codex if port
8788 is not listening, prints the local API/admin URLs, then forwards all
remaining arguments to `codex`.

API keys are intentionally not hardcoded here. Configure them with:

  mimo2codex init

and edit %USERPROFILE%\.mimo2codex\.env, or set MIMO_API_KEY in your shell.
#>

[CmdletBinding()]
param(
    [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex-mimo"),
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8788,
    [string]$Model = "mimo-v2.5-pro",
    [int]$ModelContextWindow = 1000000,
    [int]$ModelMaxOutputTokens = 131072,
    [switch]$NoLaunchCodex,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArgs
)

$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Convert-FileToUtf8NoBom {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    $content = Get-Content -Raw -Encoding UTF8 $Path
    if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
        $content = $content.Substring(1)
    }

    Write-Utf8NoBom -Path $Path -Content $content
}

function Test-ProxyListening {
    param(
        [Parameter(Mandatory = $true)][int]$LocalPort
    )

    return Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
}

$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCommand) {
    Write-Error "Codex CLI was not found on PATH. Install Codex first, then re-run this script."
    exit 1
}

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null

$authPath = Join-Path $CodexHome "auth.json"
$configPath = Join-Path $CodexHome "config.toml"

if (-not (Test-Path $authPath)) {
    Write-Utf8NoBom -Path $authPath -Content @"
{
  "OPENAI_API_KEY": "mimo2codex-local"
}
"@
}

if (-not (Test-Path $configPath)) {
    $baseUrl = "http://$HostName`:$Port/v1"
    Write-Utf8NoBom -Path $configPath -Content @"
model = "$Model"
model_provider = "mimo"
model_context_window = $ModelContextWindow
model_max_output_tokens = $ModelMaxOutputTokens

[model_providers.mimo]
name = "MiMo (via mimo2codex)"
base_url = "$baseUrl"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 1
"@
}

Convert-FileToUtf8NoBom $authPath
Convert-FileToUtf8NoBom $configPath

try {
    Get-Content -Raw -Encoding UTF8 $authPath | ConvertFrom-Json | Out-Null
}
catch {
    Write-Error "Invalid auth.json in $CodexHome. It must be pure JSON with no comments."
    exit 1
}

$env:CODEX_HOME = $CodexHome

$proxyUp = Test-ProxyListening -LocalPort $Port
if (-not $proxyUp) {
    $mimoCommand = Get-Command mimo2codex -ErrorAction SilentlyContinue
    if (-not $mimoCommand) {
        Write-Error "mimo2codex was not found on PATH. Install it with `npm install -g mimo2codex` or run the installer first."
        exit 1
    }

    $envFile = Join-Path $env:USERPROFILE ".mimo2codex\.env"
    if (-not $env:MIMO_API_KEY -and -not (Test-Path $envFile)) {
        Write-Host "[!] No MIMO_API_KEY in the shell and no ~/.mimo2codex/.env found." -ForegroundColor Yellow
        Write-Host "    Run: mimo2codex init" -ForegroundColor Yellow
        Write-Host "    Then fill MIMO_API_KEY in %USERPROFILE%\.mimo2codex\.env." -ForegroundColor Yellow
    }

    $launcherPath = Join-Path $CodexHome "start-mimo2codex.ps1"
    $escapedMimoCommand = $mimoCommand.Source.Replace("'", "''")
    $launcherContent = @"
& '$escapedMimoCommand'
"@
    Write-Utf8NoBom -Path $launcherPath -Content $launcherContent

    Write-Host "[*] Starting mimo2codex proxy in the background..." -ForegroundColor Cyan
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File",
        $launcherPath
    )

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $proxyUp = Test-ProxyListening -LocalPort $Port
        if ($proxyUp) {
            break
        }
    }

    if (-not $proxyUp) {
        Write-Error "mimo2codex did not start listening on $HostName`:$Port. Start it manually once to inspect its error output."
        exit 1
    }
}
else {
    Write-Host "[*] mimo2codex proxy already running on $Port" -ForegroundColor Green
}

$proxyUrl = "http://$HostName`:$Port"
Write-Host "[*] CODEX_HOME:        $CodexHome" -ForegroundColor Cyan
Write-Host "[*] mimo2codex API:   $proxyUrl/v1" -ForegroundColor Cyan
Write-Host "[*] mimo2codex admin: $proxyUrl/admin/" -ForegroundColor Cyan

if ($NoLaunchCodex) {
    exit 0
}

& codex @CodexArgs

