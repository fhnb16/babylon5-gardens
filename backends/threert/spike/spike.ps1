# M0 spike runner: points threert.config.json at one scene entry, then runs a threert command on the project.
#   ./spike.ps1 c_tube_1m check
#   ./spike.ps1 c_tube_1m render -o shots/c_1m.png --spp 64
# Scenes live in src/<name>.ts ("game" = the template's game.ts). Never use this for publish/login/pair.
# Plain $args (no param block), so threert flags like -o are not taken as PowerShell common parameters.
$ErrorActionPreference = 'Stop'
if (-not $args) { throw 'usage: spike.ps1 <scene> [threert args...]' }
$Scene = [string]$args[0]
$Rest = @($args | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
$here = $PSScriptRoot
$bad = @('publish', 'unpublish', 'login', 'pair', 'unpair')
if ($Rest -and $bad -contains $Rest[0]) { throw "spike.ps1 refuses '$($Rest[0])'" }
$entry = if ($Scene -eq 'game') { 'game.ts' } else { "src/$Scene.ts" }
if (-not (Test-Path (Join-Path $here $entry))) { throw "no scene $entry" }
$cfg = [ordered]@{ id = 'spike'; name = 'b5spike'; entry = $entry }
($cfg | ConvertTo-Json) | Set-Content -Encoding utf8NoBOM (Join-Path $here 'threert.config.json')
$exe = Join-Path $env:LOCALAPPDATA 'threert-portable\ThreeRT\bin\threert.exe'
if (-not $Rest) { return }
Push-Location $here
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $exe @Rest
  Write-Host ("[spike] {0} {1}: {2:N2} s" -f $Scene, ($Rest -join ' '), $sw.Elapsed.TotalSeconds)
} finally { Pop-Location }
