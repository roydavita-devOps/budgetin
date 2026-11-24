#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string]$EnvFile,
    [Parameter(Mandatory)][string]$RecoveryFile
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This procedure requires Windows DPAPI.' }
$envPath = (Resolve-Path -LiteralPath $EnvFile).ProviderPath
if (Test-Path -LiteralPath $RecoveryFile) { throw 'Recovery file already exists.' }
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$recoveryPath = [IO.Path]::GetFullPath($RecoveryFile)
if ($recoveryPath.StartsWith($repo.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The recovery file must be outside the repository.'
}

function Invoke-Docker {
    param([string[]]$Arguments, [string]$InputText = '')
    $info = [Diagnostics.ProcessStartInfo]::new('docker')
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in $Arguments) { [void]$info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $out = $process.StandardOutput.ReadToEndAsync()
        $err = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($InputText)
        $process.StandardInput.Close()
        $process.WaitForExit()
        $stdout = $out.GetAwaiter().GetResult()
        [void]$err.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Docker or PostgreSQL operation failed; sensitive diagnostics withheld.' }
        return $stdout.Trim()
    } finally { $process.Dispose() }
}

function Get-ScramVerifier([string]$Password) {
    $salt = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $key = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2($Password, $salt, 4096, [Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    $hmac = [Security.Cryptography.HMACSHA256]::new($key)
    try {
        $clientKey = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('Client Key'))
        $storedKey = [Security.Cryptography.SHA256]::HashData($clientKey)
        $serverKey = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('Server Key'))
        return 'SCRAM-SHA-256$4096:' + [Convert]::ToBase64String($salt) + '$' + [Convert]::ToBase64String($storedKey) + ':' + [Convert]::ToBase64String($serverKey)
    } finally { $hmac.Dispose() }
}

function Set-RolePassword([string]$Password) {
    $verifier = Get-ScramVerifier $Password
    $sql = "ALTER ROLE `"$dbUser`" PASSWORD '$verifier';`n"
    [void](Invoke-Docker -Arguments @('exec', '-i', $Container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', $dbUser, '-d', $dbName) -InputText $sql)
}

function Write-Env([byte[]]$Bytes) {
    $stream = [IO.File]::Open($envPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.SetLength($Bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

$oldBytes = [IO.File]::ReadAllBytes($envPath)
$encoding = [Text.UTF8Encoding]::new($false, $true)
$oldText = $encoding.GetString($oldBytes)
if ($oldText.StartsWith([char]0xFEFF)) { throw 'UTF-8 BOM is not supported by this procedure.' }
$vars = @{}
foreach ($line in ($oldText -split "`r?`n")) {
    if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$') {
        if ($vars.ContainsKey($matches[1])) { throw 'Duplicate environment key; resolve it before rotating.' }
        $vars[$matches[1]] = $matches[2]
    }
}
foreach ($key in @('POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','DATABASE_URL','JWT_SECRET','BOT_INTERNAL_TOKEN')) {
    if (-not $vars.ContainsKey($key) -or -not $vars[$key]) { throw "Missing environment key: $key" }
}
$dbUser = $vars.POSTGRES_USER
$dbName = $vars.POSTGRES_DB
if ($dbUser -cnotmatch '^[a-z_][a-z0-9_]*$' -or $dbName -cnotmatch '^[a-z_][a-z0-9_]*$') { throw 'Unsupported database or role name.' }
$uri = [Uri]$vars.DATABASE_URL
$userinfo = $uri.UserInfo.Split(':', 2)
if ($uri.Scheme -cne 'postgres' -or $uri.Host -cne 'postgres' -or $uri.Port -ne 5432 -or $userinfo.Count -ne 2 -or
    [Uri]::UnescapeDataString($userinfo[0]) -cne $dbUser -or [Uri]::UnescapeDataString($userinfo[1]) -cne $vars.POSTGRES_PASSWORD -or
    $uri.AbsolutePath -cne "/$dbName" -or $uri.Query -or $uri.Fragment) { throw 'DATABASE_URL does not match the expected Docker database configuration.' }

$identity = Invoke-Docker -Arguments @('exec', $Container, 'psql', '-X', '-U', $dbUser, '-d', $dbName, '-Atc', "SELECT current_user || ':' || current_database() || ':' || (inet_server_addr() IS NULL)::text")
if ($identity -cne "$($dbUser):$($dbName):true") { throw 'Unexpected database identity or connection method.' }
$ip = Invoke-Docker -Arguments @('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', $Container)
if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Expected a single Docker IPv4 address for database authentication verification.' }
$newPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$newJwt = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$newInternal = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$newText = $oldText
$changes = @{
    POSTGRES_PASSWORD = $newPassword
    DATABASE_URL = "postgres://$($dbUser):$($newPassword)@postgres:5432/$dbName"
    JWT_SECRET = $newJwt
    BOT_INTERNAL_TOKEN = $newInternal
}
foreach ($key in $changes.Keys) {
    $newText = [regex]::Replace($newText, "(?m)^$key=[^`r`n]*", [System.Text.RegularExpressions.MatchEvaluator]{ param($m) "$key=$($changes[$key])" })
}
$newBytes = $encoding.GetBytes($newText)
$journal = ConvertTo-Json -Compress -InputObject @{ old = [Convert]::ToBase64String($oldBytes); new = [Convert]::ToBase64String($newBytes); container = $Container; database = $dbName; role = $dbUser }
$encrypted = [Security.Cryptography.ProtectedData]::Protect($encoding.GetBytes($journal), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$file = [IO.File]::Open($recoveryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $file.Write($encrypted, 0, $encrypted.Length); $file.Flush($true) } finally { $file.Dispose() }
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($recoveryPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
if ($encoding.GetString($decrypted) -cne $journal) { throw 'Recovery journal verification failed; credentials were not changed.' }
$roleChanged = $false
$writingStarted = $false
try {
    $roleChanged = $true
    Set-RolePassword $newPassword
    $verify = "export PGPASSWORD='$newPassword'`nexec psql -X -h $ip -U $dbUser -d $dbName -Atc 'SELECT 1'"
    if ((Invoke-Docker -Arguments @('exec', '-i', $Container, 'sh') -InputText $verify) -cne '1') { throw 'New database credentials could not be verified.' }
    if (-not [Linq.Enumerable]::SequenceEqual[byte]($oldBytes, [IO.File]::ReadAllBytes($envPath))) { throw 'Environment file changed during rotation.' }
    $writingStarted = $true
    Write-Env $newBytes
    Write-Output 'Database password and environment secrets updated. Encrypted recovery journal retained.'
} catch {
    $recoveryFailed = $false
    if ($roleChanged) { try { Set-RolePassword $vars.POSTGRES_PASSWORD } catch { $recoveryFailed = $true } }
    if ($writingStarted) { try { Write-Env $oldBytes } catch { $recoveryFailed = $true } }
    if ($recoveryFailed) { throw 'Rotation failed and automatic recovery was incomplete. Keep the encrypted recovery journal and stop deployment.' }
    throw 'Rotation failed; database password restored and any attempted environment write reverted. Review the environment file and keep the encrypted recovery journal.'
}
