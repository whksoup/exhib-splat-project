# Contact sheets and sharpness for a compare.mjs run:
#   powershell -File sheet.ps1 <outDir> [cropW cropH]
# Per view and budget: <outDir>/sheet-<view>-<budget>.png, the arms stacked, each the
# centre crop at 1:1. sharpness.csv: per shot, the spectral -6/-12 dB points of the
# centre 512 px (blur-diagnosis/Spec.cs: lower = softer; 0.5 = sharp to the pixel).
param([Parameter(Mandatory)][string]$OutDir, [int]$CropW = 960, [int]$CropH = 400)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot "..\2026-10-23-blur-diagnosis\Spec.cs") -ReferencedAssemblies System.Drawing

$results = Get-Content (Join-Path $OutDir "results.json") -Raw | ConvertFrom-Json
$rows = @()
foreach ($r in $results) {
  if (-not $r.file) { continue }
  $f = Join-Path $OutDir $r.file
  $p = [Spec]::Probe($f, -1, -1, 512)
  $f6 = if ($p -match "f6=([\d.]+)") { [double]$Matches[1] } else { $null }
  $f12 = if ($p -match "f12=([\d.]+)") { [double]$Matches[1] } else { $null }
  $rows += [pscustomobject]@{ arm = $r.arm; view = $r.view; budget = $r.budget; f6 = $f6; f12 = $f12; drawn = $r.drawn; settledS = if ($r.settledMs) { [math]::Round($r.settledMs / 1000, 1) } else { $null }; downloadedMB = $r.gsl.downloadedMB; gpuMB = $r.gsl.residentGpuMB }
}
$rows | Export-Csv (Join-Path $OutDir "sharpness.csv") -NoTypeInformation
$rows | Format-Table -AutoSize | Out-String -Width 200

$font = New-Object System.Drawing.Font "Arial", 16
foreach ($g in ($results | Where-Object file | Group-Object view, budget)) {
  $shots = @($g.Group)
  $sheet = New-Object System.Drawing.Bitmap $CropW, ($CropH * $shots.Count)
  $gr = [System.Drawing.Graphics]::FromImage($sheet)
  for ($i = 0; $i -lt $shots.Count; $i++) {
    $img = [System.Drawing.Image]::FromFile((Join-Path $OutDir $shots[$i].file))
    $src = New-Object System.Drawing.Rectangle ([int](($img.Width - $CropW) / 2)), ([int](($img.Height - $CropH) / 2)), $CropW, $CropH
    $gr.DrawImage($img, (New-Object System.Drawing.Rectangle 0, ($CropH * $i), $CropW, $CropH), $src, [System.Drawing.GraphicsUnit]::Pixel)
    $label = "{0}  {1:N2}M drawn" -f $shots[$i].arm, ($shots[$i].drawn / 1e6)
    $gr.FillRectangle([System.Drawing.Brushes]::Black, 0, ($CropH * $i), 330, 28)
    $gr.DrawString($label, $font, [System.Drawing.Brushes]::Yellow, 4, ($CropH * $i + 3))
    $img.Dispose()
  }
  $gr.Dispose()
  $name = "sheet-{0}-{1}.png" -f $shots[0].view, $shots[0].budget
  $sheet.Save((Join-Path $OutDir $name))
  $sheet.Dispose()
  $name
}
