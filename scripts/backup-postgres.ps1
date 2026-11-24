#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$User,
    [Parameter(Mandatory)][string]$Destination,
    [switch]$ConfirmSecureStorage,
    [switch]$AcknowledgeUnencryptedStorage
)

$ErrorActionPreference = 'Stop'
if ($ConfirmSecureStorage -eq $AcknowledgeUnencryptedStorage) {
    throw 'Choose either ConfirmSecureStorage or AcknowledgeUnencryptedStorage.'
}
if ($AcknowledgeUnencryptedStorage) {
    Write-Warning 'The archive is not encrypted by this script and follows the destination folder permissions.'
}
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
    throw 'Destination must be an existing, private directory outside the repository.'
}

$destinationPath = (Resolve-Path -LiteralPath $Destination).ProviderPath
$repoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
$repoPrefix = $repoPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($destinationPath.Equals($repoPath, $comparison) -or $destinationPath.StartsWith($repoPrefix, $comparison)) {
    throw 'Destination must be outside the repository.'
}
# Refuse paths with links/junctions: lexical containment alone cannot establish their target.
foreach ($path in @($destinationPath, $repoPath)) {
    $item = Get-Item -LiteralPath $path -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Destination and repository paths must not contain symbolic links or junctions.'
        }
        $item = $item.Parent
    }
}
$item = Get-Item -LiteralPath $destinationPath -Force
while ($null -ne $item) {
    if (Test-Path -LiteralPath (Join-Path $item.FullName '.git')) {
        throw 'Destination must not be inside a Git working tree.'
    }
    $item = $item.Parent
}

function Invoke-DockerStream {
    param([string[]]$DockerArguments, [string]$OutputPath, [string]$InputPath)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'docker'
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = [bool]$InputPath
    foreach ($argument in $DockerArguments) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $stream = $null
    $started = $false
    try {
        if (-not $process.Start()) { throw 'Unable to start Docker.' }
        $started = $true
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputPath) {
            $discard = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
            $stream = [IO.File]::OpenRead($InputPath)
            $stream.CopyTo($process.StandardInput.BaseStream)
            $process.StandardInput.Close()
            [void]$discard.GetAwaiter().GetResult()
        } else {
            $stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $process.StandardOutput.BaseStream.CopyTo($stream)
            $stream.Flush($true)
        }
        $process.WaitForExit()
        [void]$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'PostgreSQL or Docker command failed; no diagnostic output is displayed because it may contain sensitive information.' }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

$name = 'budgetin-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N')
$partial = Join-Path $destinationPath ($name + '.partial')
$archive = Join-Path $destinationPath ($name + '.dump')
try {
    Invoke-DockerStream -DockerArguments @('exec', $Container, 'pg_dump', '--format=custom', '--no-password', '--username', $User, '--dbname', $Database) -OutputPath $partial
    # Reading all entries catches truncated/corrupt data, without connecting to a database.
    Invoke-DockerStream -DockerArguments @('exec', '-i', $Container, 'pg_restore', '--file=/dev/null') -InputPath $partial
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash
    [IO.File]::Move($partial, $archive)
    Write-Output "Backup: $archive"
    Write-Output "SHA256: $hash"
    Write-Output 'Archive decoded successfully; an isolated restore is still required.'
} finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
}
