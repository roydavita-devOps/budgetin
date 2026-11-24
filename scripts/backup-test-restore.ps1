#requires -Version 7.0
[CmdletBinding()]
param([string]$Image = 'postgres:16-alpine')

$ErrorActionPreference = 'Stop'
$id = [guid]::NewGuid().ToString('N')
$container = "budgetin-backup-test-$id"
$volume = "budgetin-backup-test-$id"
$directory = Join-Path ([IO.Path]::GetTempPath()) "budgetin-backup-test-$id"
$containerCreated = $false
$volumeCreated = $false
$directoryCreated = $false
$watch = [Diagnostics.Stopwatch]::StartNew()

function Run-Docker([string[]]$DockerArguments) {
    & docker @DockerArguments 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Synthetic Docker test failed at '$($DockerArguments[0]) $($DockerArguments[1])'; diagnostic output suppressed." }
}

try {
    [void](New-Item -ItemType Directory -Path $directory -ErrorAction Stop)
    $directoryCreated = $true
    Run-Docker @('volume', 'create', $volume)
    $volumeCreated = $true
    # A created container is tracked before it is started, including startup failures.
    Run-Docker @('create', '--name', $container, '--network', 'none', '--pull', 'never', '--mount', "type=volume,src=$volume,dst=/var/lib/postgresql/data", '-e', 'POSTGRES_PASSWORD=synthetic-only', '-e', 'POSTGRES_USER=synthetic', '-e', 'POSTGRES_DB=synthetic', $Image)
    $containerCreated = $true
    Run-Docker @('start', $container)
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        & docker exec $container pg_isready -U synthetic -d synthetic 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Synthetic PostgreSQL did not become ready.' }
    Run-Docker @('exec', $container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'synthetic', '-d', 'synthetic', '-c', "CREATE TABLE users (id integer); CREATE TABLE transactions (id integer); CREATE TABLE telegram_accounts (id integer); CREATE TABLE backup_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO backup_probe VALUES (1, 'synthetic-alpha'), (2, 'synthetic-beta');")
    & (Join-Path $PSScriptRoot 'backup-postgres.ps1') -Container $container -Database 'synthetic' -User 'synthetic' -Destination $directory -ConfirmSecureStorage | Out-Null
    $archives = @(Get-ChildItem -LiteralPath $directory -Filter '*.dump' -File)
    if ($archives.Count -ne 1) { throw 'Expected exactly one synthetic archive.' }
    & (Join-Path $PSScriptRoot 'backup-verify-restore.ps1') -Archive $archives[0].FullName -ExpectedSha256 (Get-FileHash -LiteralPath $archives[0].FullName -Algorithm SHA256).Hash | Out-Null
    Run-Docker @('cp', $archives[0].FullName, "${container}:/tmp/synthetic.dump")
    Run-Docker @('exec', $container, 'createdb', '-U', 'synthetic', 'restored')
    Run-Docker @('exec', $container, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'synthetic', '-d', 'restored', '/tmp/synthetic.dump')
    $result = & docker exec $container psql -X -qAt -v ON_ERROR_STOP=1 -U synthetic -d restored -c "SELECT count(*) = 2 AND count(*) FILTER (WHERE (id, value) IN ((1, 'synthetic-alpha'), (2, 'synthetic-beta'))) = 2 FROM backup_probe;" 2>&1
    if ($LASTEXITCODE -ne 0 -or ($result -join '').Trim() -ne 't') { throw 'Synthetic restore verification failed.' }
    $corrupt = Join-Path $directory 'truncated.corrupt'
    Copy-Item -LiteralPath $archives[0].FullName -Destination $corrupt
    $file = [IO.File]::Open($corrupt, [IO.FileMode]::Open, [IO.FileAccess]::Write)
    try { $file.SetLength([long]($file.Length / 2)) } finally { $file.Dispose() }
    Run-Docker @('cp', $corrupt, "${container}:/tmp/truncated.dump")
    & docker exec $container pg_restore --file=/dev/null /tmp/truncated.dump 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { throw 'Truncated archive unexpectedly decoded successfully.' }
    try {
        & (Join-Path $PSScriptRoot 'backup-postgres.ps1') -Container $container -Database 'database_that_does_not_exist' -User 'synthetic' -Destination $directory -ConfirmSecureStorage | Out-Null
        throw 'A failing dump unexpectedly succeeded.'
    } catch {
        if ($_.Exception.Message -eq 'A failing dump unexpectedly succeeded.') { throw }
    }
    if (@(Get-ChildItem -LiteralPath $directory -Filter '*.partial' -File).Count -ne 0 -or @(Get-ChildItem -LiteralPath $directory -Filter '*.dump' -File).Count -ne 1) {
        throw 'Failed dump left an unexpected file.'
    }
    $rejected = $false
    try {
        & (Join-Path $PSScriptRoot 'backup-postgres.ps1') -Container $container -Database 'synthetic' -User 'synthetic' -Destination $PSScriptRoot -ConfirmSecureStorage | Out-Null
    } catch { $rejected = $true }
    if (-not $rejected) { throw 'Repository destination was not rejected.' }
    $watch.Stop()
    Write-Output ("Synthetic backup and isolated restore passed in {0:N1} seconds. No production backup was accessed." -f $watch.Elapsed.TotalSeconds)
} finally {
    if ($containerCreated) { & docker rm -f $container 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove test container $container" } }
    if ($volumeCreated) { & docker volume rm $volume 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove test volume $volume" } }
    if ($directoryCreated) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
