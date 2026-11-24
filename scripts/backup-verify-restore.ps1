#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$ExpectedSha256,
    [string]$Image = 'postgres:16-alpine'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw 'Backup archive was not found.' }
if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'ExpectedSha256 must be a SHA-256 hash.' }
$archivePath = (Resolve-Path -LiteralPath $Archive).ProviderPath
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $ExpectedSha256) {
    throw 'Backup hash does not match.'
}

$id = [guid]::NewGuid().ToString('N')
$container = "budgetin-restore-verify-$id"
$started = $false
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
    # tmpfs and no network keep the restored copy separate from persistent production volumes.
    & docker run --rm -d --pull=never --name $container --network none `
        --tmpfs '/var/lib/postgresql/data:rw,nosuid,size=1g' `
        -e 'POSTGRES_USER=restore_verifier' -e 'POSTGRES_DB=restore_verification' `
        -e "POSTGRES_PASSWORD=$([guid]::NewGuid().ToString('N'))" $Image 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated restore container.' }
    $started = $true

    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        & docker exec $container pg_isready -U restore_verifier -d restore_verification 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Isolated PostgreSQL did not become ready.' }

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'docker'
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('exec', '-i', $container, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'restore_verifier', '-d', 'restore_verification')) {
        [void]$start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $stream = $null
    $processStarted = $false
    try {
        if (-not $process.Start()) { throw 'Could not start restore process.' }
        $processStarted = $true
        $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr = $process.StandardError.ReadToEndAsync()
        $stream = [IO.File]::OpenRead($archivePath)
        $stream.CopyTo($process.StandardInput.BaseStream)
        $process.StandardInput.Close()
        [void]$stdout.GetAwaiter().GetResult()
        $process.WaitForExit()
        [void]$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Isolated restore failed; diagnostic output suppressed.' }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($processStarted -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }

    $result = & docker exec $container psql -X -qAt -v ON_ERROR_STOP=1 -U restore_verifier -d restore_verification -c "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.transactions') IS NOT NULL AND to_regclass('public.telegram_accounts') IS NOT NULL;" 2>&1
    if ($LASTEXITCODE -ne 0 -or ($result -join '').Trim() -ne 't') { throw 'Restored schema verification failed.' }
    $watch.Stop()
    Write-Output ("Isolated restore and schema verification passed in {0:N1} seconds. No user records displayed." -f $watch.Elapsed.TotalSeconds)
} finally {
    if ($started -and $container -match '^budgetin-restore-verify-[0-9a-f]{32}$') {
        & docker stop --time 2 $container 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not stop temporary restore container $container" }
    }
}
