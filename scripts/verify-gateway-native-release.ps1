# Read-only publication gate; local preview archives deliberately fail it.
param(
  [Parameter(Mandatory = $true)][string]$ArtifactZip,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceRevision
)
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $ArtifactZip).Path
$hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
$declared = (Get-Content -Raw -LiteralPath ($artifact + '.sha256')).Split(' ')[0].Trim()
if ($hash -ne $declared) { throw 'Artifact checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($artifact)
try {
  $entries = @($zip.Entries | Where-Object FullName -eq 'runtime-manifest.json')
  if ($entries.Count -ne 1) { throw 'Exactly one root runtime manifest is required' }
  $reader = [IO.StreamReader]::new($entries[0].Open())
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'win32' -or $manifest.arch -ne 'x64' -or $manifest.nodeVersion -ne 'v24.16.0') { throw 'Unsupported native release manifest' }
  if ($manifest.sourceDirty -isnot [bool] -or $manifest.sourceDirty) { throw 'Dirty or unverified local previews must not be published' }
  if ($manifest.sourceRevision -cne $SourceRevision) { throw 'Manifest source revision does not match the workflow revision' }
} finally { $zip.Dispose() }
Write-Output $hash
