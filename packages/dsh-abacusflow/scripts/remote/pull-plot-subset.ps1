#!/usr/bin/env pwsh
# Pull the plot-relevant subset of a remote run from dongfang into the local WSL topics
# tree, so the ABACUS panel can open it.
#
# Why a subset: a real run directory is tens of gigabytes (RI coefficients, Coulomb
# matrices, wavefunctions, charge densities). The files a band/QSGW plot actually reads
# are a few megabytes. On the NiO run that is 37 GB -> 2.0 MiB; on Bi2Se3, 826 MB -> 0.8 MiB.
#
# Usage:
#   .\pull-plot-subset.ps1 -Run nio-matched-dzp-k666-20261016-r1
#   .\pull-plot-subset.ps1 -Run bi2se3-soc-abacus-reexport-20261025-r1 -HostName dongfang
#   .\pull-plot-subset.ps1 -Run <name> -WithEigenvalues
#
# The remote half is `pack-plot-anyrun.py`, uploaded each time so the two stay in step.

param(
    [Parameter(Mandatory = $true)][string]$Run,
    [string]$HostName = 'dongfang',
    # Where pulled runs land; defaults to the folder the panel scans (env var).
    [string]$LocalRoot = $env:ABACUSFLOW_SCAN_ROOT,
    [string]$RemoteRuns = '~/ai-runs',
    [switch]$WithEigenvalues
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$packer = Join-Path $here 'pack-plot-anyrun.py'
if (-not (Test-Path $packer)) { throw "missing $packer" }

$archive = "$Run-plot.tar.gz"
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')

Write-Host "==> packing on $HostName : $Run"
$py = Get-Content $packer -Raw -Encoding UTF8
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$extra = if ($WithEigenvalues) { ' --with-eigenvalues' } else { '' }
# Run directories live under ~/ai-runs; the packer takes the full path.
$remoteCmd = "echo $b64 | base64 -d > ~/pack-plot-anyrun.py && " +
    "python3 ~/pack-plot-anyrun.py $RemoteRuns/$Run ~/$archive$extra"
$packOut = & ssh @sshOpts $HostName $remoteCmd 2>&1
$packOut | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { throw "remote packing failed (exit $LASTEXITCODE)" }

Write-Host "==> ensuring $LocalRoot"
New-Item -ItemType Directory -Force -Path $LocalRoot | Out-Null

Write-Host "==> downloading"
$target = Join-Path $LocalRoot $archive
$started = Get-Date
& scp @sshOpts -o ConnectTimeout=20 "${HostName}:${archive}" $target 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }
$secs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
$mb = [math]::Round((Get-Item $target).Length / 1MB, 2)
Write-Host "    $mb MiB in ${secs}s"

Write-Host "==> extracting"
# `tar.exe` fails on `\\wsl$\...` for some member names ("Invalid argument"), because it
# writes through `\\?\UNC\...` with metadata; Node's fs uses the ordinary Win32 path and
# works. So the extractor is Node, not tar.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is required to extract onto a UNC path' }
$extractor = Join-Path $here 'extract-tar.mjs'
if (-not (Test-Path $extractor)) { throw "missing $extractor" }
& $node $extractor $target $LocalRoot
if ($LASTEXITCODE -ne 0) { throw "extract failed (exit $LASTEXITCODE)" }

$extracted = Join-Path $LocalRoot $Run
$files = (Get-ChildItem $extracted -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "==> done: $extracted ($files files)"
Write-Host ""
Write-Host "在面板里把这个路径填进根目录："
Write-Host "  $extracted"
