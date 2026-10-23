param(
  [Parameter(Mandatory = $true)][string]$ArtifactZip,
  [switch]$DirectEgress
)
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $ArtifactZip).Path
$root = Join-Path $env:LOCALAPPDATA 'mcp-gateway/native-build'
New-Item -ItemType Directory -Path $root -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $root /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect native verification directory' }
$fixture = Join-Path $root ('smoke-' + [guid]::NewGuid().ToString('N'))
$runtime = Join-Path $fixture 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($artifact)
  try {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/').Contains('..')) { throw 'Unsafe ZIP entry' }
      if (-not $names.Add($name)) { throw 'Duplicate ZIP entry' }
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixType -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { throw 'ZIP links are forbidden' }
      $target = [IO.Path]::GetFullPath((Join-Path $runtime $name))
      if (-not $target.StartsWith($runtime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP entry escapes extraction directory' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($artifact, $runtime)
  $arguments = @((Join-Path $PSScriptRoot 'verify-gateway-native.mjs'), $runtime)
  if ($DirectEgress) { $arguments += '--direct-egress' }
  & (Join-Path $runtime 'node.exe') @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Native gateway verification failed' }
} finally {
  # The fixture is a newly created GUID child of the verified private root.
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  if (-not $resolvedFixture.StartsWith([IO.Path]::GetFullPath($root) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
