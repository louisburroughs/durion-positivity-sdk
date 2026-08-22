<#
.SYNOPSIS
  Opens AWS SSM port-forwarding tunnels to the alpha EC2 host for the
  sdk-integration-tests suite.

.DESCRIPTION
  Mechanism (BACKEND_INTERACTION_TEST_SPEC.md, Task 7 Step 1): the alpha stack's
  base docker-compose.yml already publishes both target services on the EC2 host
  (pos-api-gateway 8080:8080, pos-security-service 8086:8080), so this uses the
  AWS-owned AWS-StartPortForwardingSession document against instance-local ports.
  The ...ToRemoteHost variant and a loopback-only Compose publish are both
  unnecessary. No security-group ingress is opened and nothing on alpha changes.

.EXAMPLE
  ./scripts/alpha-itest-tunnel.ps1

.EXAMPLE
  ./scripts/alpha-itest-tunnel.ps1 -InstanceId i-0123456789abcdef0

.NOTES
  Ctrl-C shuts both sessions down.
#>

[CmdletBinding()]
param(
  [string] $InstanceId        = $env:ALPHA_INSTANCE_ID,
  [string] $Region            = $(if ($env:ALPHA_REGION) { $env:ALPHA_REGION } else { 'us-east-1' }),
  [int]    $GatewayLocalPort  = $(if ($env:ITEST_GATEWAY_LOCAL_PORT)  { [int]$env:ITEST_GATEWAY_LOCAL_PORT }  else { 18080 }),
  [int]    $SecurityLocalPort = $(if ($env:ITEST_SECURITY_LOCAL_PORT) { [int]$env:ITEST_SECURITY_LOCAL_PORT } else { 18086 })
)

$ErrorActionPreference = 'Stop'

$GatewayRemotePort  = 8080
$SecurityRemotePort = 8086

$script:Sessions = @()
$script:LogDir   = $null

function Fail([string] $Message) {
  Write-Error $Message
  exit 1
}

# `aws ssm start-session` spawns session-manager-plugin as a child and does NOT
# forward termination to it. Stopping only the aws process leaves the plugin
# orphaned, still holding the SSM session and the local port. Kill the tree.
function Stop-ProcessTree([int] $ProcessId) {
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    & taskkill.exe /PID $ProcessId /T /F *> $null
    if ($LASTEXITCODE -eq 0) { return }
  }

  # Non-Windows (or taskkill unavailable): walk children first, then the parent.
  try {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-ProcessTree ([int]$child.ProcessId) }
  } catch {
    $childIds = & pgrep -P $ProcessId 2>$null
    foreach ($childId in @($childIds | Where-Object { $_ })) { Stop-ProcessTree ([int]$childId) }
  }

  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Test-PortInUse([int] $Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(400)) {
      try { $client.EndConnect($async); return $true } catch { return $false }
    }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Start-Forward {
  param(
    [string] $Label,
    [int]    $RemotePort,
    [int]    $LocalPort,
    [string] $LogPath
  )

  $arguments = @(
    'ssm', 'start-session',
    '--target', $InstanceId,
    '--region', $Region,
    '--document-name', 'AWS-StartPortForwardingSession',
    '--parameters', "portNumber=$RemotePort,localPortNumber=$LocalPort"
  )

  $proc = Start-Process -FilePath 'aws' `
                        -ArgumentList $arguments `
                        -NoNewWindow -PassThru `
                        -RedirectStandardOutput $LogPath `
                        -RedirectStandardError "$LogPath.err"

  Write-Host ("  {0}: localhost:{1} -> {2}:{3} (pid {4})" -f $Label, $LocalPort, $InstanceId, $RemotePort, $proc.Id)
  $script:Sessions += [pscustomobject]@{ Label = $Label; Process = $proc; Log = $LogPath }
  return $proc
}

function Wait-Ready {
  param(
    [string]                    $Label,
    [System.Diagnostics.Process] $Process,
    [string]                    $LogPath
  )

  for ($waited = 0; $waited -lt 30; $waited++) {
    $out = @()
    if (Test-Path $LogPath)        { $out += Get-Content $LogPath -ErrorAction SilentlyContinue }
    if (Test-Path "$LogPath.err")  { $out += Get-Content "$LogPath.err" -ErrorAction SilentlyContinue }
    $text = $out -join "`n"

    if ($text -match 'Waiting for connections') { return }

    if ($Process.HasExited) {
      Write-Host "error: $Label session exited before it was ready:" -ForegroundColor Red
      $text -split "`n" | ForEach-Object { Write-Host "  $_" }
      if ($text -match 'AccessDenied|not authorized') {
        Write-Host ""
        Write-Host "  This looks like an IAM denial. The calling identity needs ssm:StartSession on both:"
        Write-Host "    arn:aws:ec2:${Region}:<account>:instance/$InstanceId"
        Write-Host "    arn:aws:ssm:${Region}::document/AWS-StartPortForwardingSession"
      }
      Fail "$Label tunnel failed to open."
    }

    Start-Sleep -Seconds 1
  }

  Fail "$Label session did not report ready within 30s. Log: $LogPath"
}

try {
  # ---- Preflight -----------------------------------------------------------

  if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Fail "AWS CLI not found. Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  }

  if (-not (Get-Command session-manager-plugin -ErrorAction SilentlyContinue)) {
    Fail "session-manager-plugin not found. SSM port forwarding needs it. Install: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
  }

  & aws sts get-caller-identity --region $Region *> $null
  if ($LASTEXITCODE -ne 0) {
    Fail "No usable AWS credentials for region $Region. Configure a profile/role with ssm:StartSession on the alpha instance, then retry."
  }

  foreach ($port in @($GatewayLocalPort, $SecurityLocalPort)) {
    if (Test-PortInUse $port) {
      Fail "Local port $port is already in use (an older tunnel still running?). Close it or set ITEST_GATEWAY_LOCAL_PORT / ITEST_SECURITY_LOCAL_PORT."
    }
  }

  # ---- Resolve the alpha instance -----------------------------------------

  if ($InstanceId) {
    Write-Host "Using instance $InstanceId"
  } else {
    Write-Host "Resolving alpha instance by tag (Project=durion, Environment=alpha)..."
    $raw = & aws ec2 describe-instances `
      --region $Region `
      --filters "Name=tag:Project,Values=durion" `
                "Name=tag:Environment,Values=alpha" `
                "Name=instance-state-name,Values=running" `
      --query 'Reservations[].Instances[].InstanceId' `
      --output text 2>$null

    if ($LASTEXITCODE -ne 0) {
      Fail "ec2:DescribeInstances failed. Check credentials and permissions, or pass -InstanceId to skip the lookup."
    }

    $found = @(($raw -split '\s+') | Where-Object { $_ })
    switch ($found.Count) {
      0       { Fail "No running instance tagged Project=durion, Environment=alpha in $Region. Pass -InstanceId explicitly." }
      1       { $InstanceId = $found[0] }
      default { Fail ("Tag lookup matched {0} running instances ({1}). Pass -InstanceId to pick one." -f $found.Count, ($found -join ', ')) }
    }
    Write-Host "Resolved alpha instance: $InstanceId"
  }

  $pingStatus = & aws ssm describe-instance-information `
    --region $Region `
    --filters "Key=InstanceIds,Values=$InstanceId" `
    --query 'InstanceInformationList[0].PingStatus' `
    --output text 2>$null

  if ($LASTEXITCODE -ne 0 -or $pingStatus -ne 'Online') {
    $shown = if ($pingStatus) { $pingStatus } else { 'None' }
    Fail "Instance $InstanceId is not an Online SSM managed node (ping status: $shown). Check the SSM agent, the instance profile (AmazonSSMManagedInstanceCore), and outbound 443 to the ssm/ssmmessages/ec2messages endpoints."
  }

  # ---- Open both forwarding sessions --------------------------------------

  $script:LogDir = Join-Path ([System.IO.Path]::GetTempPath()) ("alpha-itest-tunnel-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null

  Write-Host ""
  Write-Host "Opening SSM port-forwarding sessions..."

  $gatewayLog  = Join-Path $script:LogDir 'gateway.log'
  $securityLog = Join-Path $script:LogDir 'security.log'

  $gatewayProc  = Start-Forward -Label 'pos-api-gateway     ' -RemotePort $GatewayRemotePort  -LocalPort $GatewayLocalPort  -LogPath $gatewayLog
  $securityProc = Start-Forward -Label 'pos-security-service' -RemotePort $SecurityRemotePort -LocalPort $SecurityLocalPort -LogPath $securityLog

  Wait-Ready -Label 'pos-api-gateway'      -Process $gatewayProc  -LogPath $gatewayLog
  Wait-Ready -Label 'pos-security-service' -Process $securityProc -LogPath $securityLog

  # ---- Print the exports the suite needs ----------------------------------

  Write-Host ""
  Write-Host "Tunnel is up. Set these in the shell that runs the suite:"
  Write-Host ""
  Write-Host "  `$env:ITEST_BASE_URL = 'http://localhost:$GatewayLocalPort'"
  Write-Host "  `$env:ITEST_SECURITY_SERVICE_URL = 'http://localhost:$SecurityLocalPort'"
  Write-Host ""
  Write-Host "  # bash/zsh equivalent:"
  Write-Host "  export ITEST_BASE_URL=http://localhost:$GatewayLocalPort"
  Write-Host "  export ITEST_SECURITY_SERVICE_URL=http://localhost:$SecurityLocalPort"
  Write-Host ""
  Write-Host "Then:  npm run test:integration"
  Write-Host ""
  Write-Host "Smoke-check:"
  Write-Host "  curl http://localhost:$GatewayLocalPort/actuator/health"
  Write-Host "  curl http://localhost:$SecurityLocalPort/actuator/health"
  Write-Host ""
  Write-Host "Traffic rides the SSM-encrypted channel; nothing is exposed publicly."
  Write-Host "Press Ctrl-C to close both sessions."

  while ($true) {
    Start-Sleep -Seconds 1
    foreach ($session in $script:Sessions) {
      if ($session.Process.HasExited) {
        Write-Host ""
        Write-Host ("{0} session ended (exit code {1}). Shutting down." -f $session.Label.Trim(), $session.Process.ExitCode)
        return
      }
    }
  }
}
finally {
  if ($script:Sessions.Count -gt 0) {
    Write-Host ""
    Write-Host "Closing tunnel sessions..."
    foreach ($session in $script:Sessions) {
      if (-not $session.Process.HasExited) {
        Stop-ProcessTree $session.Process.Id
      }
    }
  }
  if ($script:LogDir -and (Test-Path $script:LogDir)) {
    Remove-Item -Recurse -Force $script:LogDir -ErrorAction SilentlyContinue
  }
}
