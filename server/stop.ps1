# Stops the Office Mini server. Only stops a process that is running "server.app" on Office Mini's port.
$root = Split-Path -Parent $PSScriptRoot
$port = 8765
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | Select-Object -First 1
    if ($line -match '(\d+)') { $port = [int]$Matches[1] }
}

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
    Write-Host "Office Mini is not running (nothing on port $port)."
    exit 0
}

$stopped = 0
foreach ($procId in ($listeners.OwningProcess | Sort-Object -Unique)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
    if (-not $proc -or $proc.CommandLine -notmatch 'server[\.:]app') {
        Write-Host "Port $port is used by another program ($($proc.Name)); leaving it alone."
        continue
    }
    # The .venv python.exe is a small launcher that starts the real interpreter; stop both.
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    if ($parent -and $parent.CommandLine -match 'server[\.:]app') {
        Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $stopped++
}
if ($stopped) { Write-Host "Office Mini stopped." }
