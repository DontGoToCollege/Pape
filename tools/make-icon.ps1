# Draws src\Pape\app.ico (16..256 px): a dusk sky tile with a low sun and two hills.
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dst  = Join-Path $root "src\Pape\app.ico"

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

# Drawn on a 256x256 grid; the graphics object is scaled for each size.
function Draw($g) {
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 88
    $tile.AddArc(8, 8, $r, $r, 180, 90); $tile.AddArc(248 - $r, 8, $r, $r, 270, 90)
    $tile.AddArc(248 - $r, 248 - $r, $r, $r, 0, 90); $tile.AddArc(8, 248 - $r, $r, $r, 90, 90)
    $tile.CloseFigure()
    $sky = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 8), (New-Object System.Drawing.Point 0, 248), (C "#2a3f8f"), (C "#f08a5d")
    $g.FillPath($sky, $tile)
    $g.SetClip($tile)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush (C "#ffd36e")), 128, 92, 76, 76)
    $pt = { param($x, $y) New-Object System.Drawing.PointF $x, $y }
    $g.FillPolygon((New-Object System.Drawing.SolidBrush (C "#3b2a5c")), [System.Drawing.PointF[]]@((& $pt 0 190), (& $pt 70 120), (& $pt 150 200), (& $pt 256 140), (& $pt 256 256), (& $pt 0 256)))
    $g.FillPolygon((New-Object System.Drawing.SolidBrush (C "#1b1733")), [System.Drawing.PointF[]]@((& $pt 0 226), (& $pt 110 170), (& $pt 256 222), (& $pt 256 256), (& $pt 0 256)))
    $g.ResetClip()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.ScaleTransform($s / 256, $s / 256)
    Draw $g
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    ,@($s, $ms.ToArray())
}

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
    $s = $f[0]; $bytes = $f[1]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$bytes.Length); $w.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($f in $frames) { $w.Write([byte[]]$f[1]) }
$w.Flush()
[System.IO.File]::WriteAllBytes($dst, $out.ToArray())
Write-Host "wrote $dst ($([math]::Round($out.Length/1KB,1)) KB, $($frames.Count) frames)"
