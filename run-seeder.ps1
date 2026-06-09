# =============================================================================
# run-seeder.ps1 — Orchestrates Docker Compose backend + sdk-seeder
#
# 1. Starts the backend containers via docker compose up -d
# 2. Waits for the API gateway health endpoint to report UP
# 3. Runs the seeder which syncs to the backend's accelerated virtual clock
# =============================================================================

param(
    [int]$Days = 365,
    [int]$TimeoutSeconds = 300,
    [int]$PollIntervalMs = 1000,
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

# --- Configuration ---
$BackendDir = Resolve-Path "$PSScriptRoot\..\durion-positivity-backend"
$BackendDirWsl = wsl wslpath -a -u ($BackendDir.Path.Replace('\', '/'))
$GatewayHealthUrl = "http://localhost:8080/actuator/health"
$GatewayTimeUrl = "http://localhost:8080/system/time"
$LocationHealthUrl = "http://localhost:8084/actuator/health"

# Seeder env
$env:SEEDER_BASE_URL = "http://localhost:8080"
$env:SEEDER_USERNAME = "admin.alpha"
$env:SEEDER_PASSWORD = "s3cur1ty!"
$env:SEEDER_DAYS = "$Days"
$env:SEEDER_POLL_INTERVAL_MS = "$PollIntervalMs"

# --- Step 1: Start Docker Compose ---
if ($NoBuild) {
    Write-Host ""
    Write-Host "===============================================================================" -ForegroundColor Cyan
    Write-Host " SKIPPING DOCKER BUILD (-NoBuild specified)" -ForegroundColor Cyan
    Write-Host "===============================================================================" -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "===============================================================================" -ForegroundColor Cyan
    Write-Host " STARTING BACKEND (docker compose up -d --build)" -ForegroundColor Cyan
    Write-Host "===============================================================================" -ForegroundColor Cyan
    Write-Host ""

    Push-Location $BackendDir
    try {
        wsl -e sh -c "cd '$BackendDirWsl' && docker compose up -d --build"
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose up failed with exit code $LASTEXITCODE"
        }
    } catch {
        # No-op, error will be thrown above if needed
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host " Docker containers starting..." -ForegroundColor Green
}

# --- Step 2: Wait for API Gateway to be healthy ---
Write-Host ""
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host " WAITING FOR API GATEWAY HEALTH ($GatewayHealthUrl)" -ForegroundColor Cyan
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host ""

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$healthy = $false

while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-RestMethod -Uri $GatewayHealthUrl -TimeoutSec 5 -ErrorAction Stop
        if ($response.status -eq "UP") {
            $healthy = $true
            break
        }
        Write-Host "  Gateway status: $($response.status) — waiting..." -ForegroundColor Yellow
    } catch {
        Write-Host "  Gateway not ready yet — $($_.Exception.Message)" -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 5
}

if (-not $healthy) {
    Write-Host ""
    Write-Host " TIMEOUT: API Gateway did not become healthy within ${TimeoutSeconds}s" -ForegroundColor Red
    Write-Host " Check logs: docker compose -f $BackendDir\docker-compose.yml logs pos-api-gateway" -ForegroundColor Red
    exit 1
}

Write-Host "  API Gateway is UP" -ForegroundColor Green

# --- Step 2b: Wait for Location Service to be healthy ---
Write-Host ""
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host " WAITING FOR LOCATION SERVICE HEALTH ($LocationHealthUrl)" -ForegroundColor Cyan
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host ""

$locationDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
$locationHealthy = $false

while ((Get-Date) -lt $locationDeadline) {
    try {
        $locResponse = Invoke-RestMethod -Uri $LocationHealthUrl -TimeoutSec 5 -ErrorAction Stop
        if ($locResponse.status -eq "UP") {
            $locationHealthy = $true
            break
        }
        Write-Host "  Location status: $($locResponse.status) — waiting..." -ForegroundColor Yellow
    } catch {
        Write-Host "  Location not ready yet — $($_.Exception.Message)" -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 5
}

if (-not $locationHealthy) {
    Write-Host ""
    Write-Host " TIMEOUT: Location Service did not become healthy within ${TimeoutSeconds}s" -ForegroundColor Red
    exit 1
}

Write-Host "  Location Service is UP" -ForegroundColor Green

# --- Step 3: Verify /system/time endpoint ---
Write-Host ""
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host " VERIFYING VIRTUAL TIME ENDPOINT ($GatewayTimeUrl)" -ForegroundColor Cyan
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host ""

$timeReady = $false
$retries = 0

while ($retries -lt 30) {
    try {
        $timeResponse = Invoke-RestMethod -Uri $GatewayTimeUrl -TimeoutSec 5 -ErrorAction Stop
        Write-Host "  Virtual Time : $($timeResponse.virtualTime)" -ForegroundColor Green
        Write-Host "  Scale        : $($timeResponse.scale)x" -ForegroundColor Green
        Write-Host "  Zone         : $($timeResponse.zone)" -ForegroundColor Green
        $timeReady = $true
        break
    } catch {
        Write-Host "  /system/time not ready — $($_.Exception.Message)" -ForegroundColor DarkGray
        $retries++
        Start-Sleep -Seconds 2
    }
}

if (-not $timeReady) {
    Write-Host ""
    Write-Host " TIMEOUT: /system/time endpoint not reachable" -ForegroundColor Red
    exit 1
}

# --- Step 4: Run the seeder ---
Write-Host ""
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host (" STARTING SEEDER ({0} virtual days, poll every {1}ms)" -f $Days, $PollIntervalMs) -ForegroundColor Cyan
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host ""

npm run seed -w packages/sdk-seeder
