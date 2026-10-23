# Metadata-only fixtures test the publication boundary, not runtime behavior.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'mcp-gateway/native-build'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$directory = Join-Path $root ('release-gate-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$revision = 'a' * 40
$count = 0
function New-Fixture($Dirty, $RevisionValue = $revision, [switch]$Duplicate) {
  $filename = Join-Path $directory ([guid]::NewGuid().ToString('N') + '.zip')
  $manifest = @{ schemaVersion = 1; platform = 'win32'; arch = 'x64'; nodeVersion = 'v24.16.0'; sourceDirty = $Dirty; sourceRevision = $RevisionValue }
  $zip = [IO.Compression.ZipFile]::Open($filename, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $copies = if ($Duplicate) { 2 } else { 1 }
    for ($i = 0; $i -lt $copies; $i++) {
      $entry = $zip.CreateEntry('runtime-manifest.json')
      $writer = [IO.StreamWriter]::new($entry.Open())
      try { $writer.Write(($manifest | ConvertTo-Json -Compress)) } finally { $writer.Dispose() }
    }
  } finally { $zip.Dispose() }
  $hash = (Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($filename + '.sha256', "$hash  fixture.zip`n")
  return $filename
}
function Assert-Rejected([string]$Filename, [string]$Reason) {
  try {
    & (Join-Path $PSScriptRoot 'verify-gateway-native-release.ps1') -ArtifactZip $Filename -SourceRevision $revision | Out-Null
    throw 'Invalid publication fixture was accepted'
  } catch { if ($_.Exception.Message -ne $Reason) { throw } }
  $script:count++
}
try {
  $valid = New-Fixture $false
  $result = & (Join-Path $PSScriptRoot 'verify-gateway-native-release.ps1') -ArtifactZip $valid -SourceRevision $revision
  if ($result -ne (Get-FileHash -LiteralPath $valid -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Valid provenance fixture rejected' }
  $count++
  Assert-Rejected (New-Fixture $true) 'Dirty or unverified local previews must not be published'
  Assert-Rejected (New-Fixture $null) 'Dirty or unverified local previews must not be published'
  Assert-Rejected (New-Fixture $false ('b' * 40)) 'Manifest source revision does not match the workflow revision'
  Assert-Rejected (New-Fixture $false $revision -Duplicate) 'Exactly one root runtime manifest is required'
  [IO.File]::WriteAllText($valid + '.sha256', ('0' * 64) + '  fixture.zip')
  Assert-Rejected $valid 'Artifact checksum mismatch'
  Write-Output "Native release publication gate: $count checks passed"
} finally {
  $resolved = [IO.Path]::GetFullPath($directory)
  if (-not $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
