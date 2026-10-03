param(
    [string]$Python = 'python',
    [string]$TestFilter = 'sftp_integration'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workRoot = Join-Path $repoRoot 'work'
$runRoot = Join-Path $workRoot ('sftp-tests-' + [guid]::NewGuid().ToString('N'))
$fixtureRoot = Join-Path $runRoot 'fixture'
$manifestPath = Join-Path $fixtureRoot 'fixture.json'
$previousFixture = [Environment]::GetEnvironmentVariable('DROPPING_SFTP_FIXTURE', 'Process')
$fixtureProcess = $null
$testExitCode = 1

try {
    $pythonCommand = (Get-Command $Python -ErrorAction Stop).Source
    & $pythonCommand -c 'import paramiko'
    if ($LASTEXITCODE -ne 0) {
        throw 'The selected Python needs paramiko. Install it in your Python environment, then retry.'
    }
    New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
    $fixtureScript = Join-Path $PSScriptRoot 'sftp_fixture.py'
    $fixtureProcess = Start-Process -FilePath $pythonCommand `
        -ArgumentList @('-u', ('"' + $fixtureScript + '"'), '--base-dir', ('"' + $fixtureRoot + '"')) `
        -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runRoot 'fixture.stdout.log') `
        -RedirectStandardError (Join-Path $runRoot 'fixture.stderr.log')

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath $manifestPath)) {
        $fixtureProcess.Refresh()
        if ($fixtureProcess.HasExited) {
            $details = Get-Content -LiteralPath (Join-Path $runRoot 'fixture.stderr.log') -Raw
            throw "The SFTP fixture exited before it was ready: $details"
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The SFTP fixture did not become ready within 30 seconds.' }
        Start-Sleep -Milliseconds 100
    }
    $env:DROPPING_SFTP_FIXTURE = $manifestPath
    Write-Host "SFTP fixture: $manifestPath"
    Push-Location $repoRoot
    try {
        & cargo test --manifest-path src-tauri/Cargo.toml --lib $TestFilter -- --ignored --nocapture
        $testExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    @{ testFilter = $TestFilter; exitCode = $testExitCode; manifest = $manifestPath } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'result.json') -Encoding UTF8
}
finally {
    [Environment]::SetEnvironmentVariable('DROPPING_SFTP_FIXTURE', $previousFixture, 'Process')
    if ($fixtureProcess) {
        $fixtureProcess.Refresh()
        if (-not $fixtureProcess.HasExited) {
            if (Test-Path -LiteralPath $fixtureRoot) {
                [IO.File]::WriteAllText((Join-Path $fixtureRoot 'STOP'), '')
            }
            if (-not $fixtureProcess.WaitForExit(5000)) {
                Stop-Process -Id $fixtureProcess.Id
            }
        }
        $fixtureProcess.Dispose()
    }
    Write-Host "SFTP test evidence: $runRoot"
}

exit $testExitCode
