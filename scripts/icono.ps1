# Iconos de LIFE: el 生 con marco, como el logo de la barra de estado.
#   App (1024, con esquinas redondeadas): scripts/icono.ps1 -Out src-tauri/icons/source.png -Size 1024 -Rounded
#     y luego: npx tauri icon src-tauri/icons/source.png -o <carpeta temporal>, copiando solo los archivos que ya hay en src-tauri/icons.
#   Bandeja (32 px): scripts/icono.ps1 -Out src-tauri/icons/tray.png -Size 32
#   Usa la fuente del sistema Yu Gothic UI y los colores de src/styles/console.css (--bg, --ph).
param([string]$Out, [int]$Size, [switch]$Rounded)
Add-Type -AssemblyName System.Drawing

$bg   = [System.Drawing.Color]::FromArgb(255, 0x03, 0x11, 0x0f)
$ph   = [System.Drawing.Color]::FromArgb(255, 0x38, 0xf2, 0xc4)

$bmp = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.InterpolationMode = 'HighQualityBicubic'
$g.PixelOffsetMode = 'HighQuality'
$g.Clear([System.Drawing.Color]::Transparent)

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($r -le 0) { $p.AddRectangle((New-Object System.Drawing.RectangleF $x, $y, $w, $h)); return $p }
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$s = [float]$Size
# Fondo
$radius = if ($Rounded) { $s * 0.12 } else { $s * 0.06 }
$g.FillPath((New-Object System.Drawing.SolidBrush $bg), (RoundRect 0 0 $s $s $radius))

# Marco y glifo como trazados (como .logo .mark: borde fino de fósforo y el glifo dentro)
$inset = $s * 0.12
$stroke = [Math]::Max(1.0, $s * 0.032)
$frame = RoundRect $inset $inset ($s - 2 * $inset) ($s - 2 * $inset) 0
$fam = New-Object System.Drawing.FontFamily 'Yu Gothic UI'
$em = $s * 0.6
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$path.AddString([string][char]0x751F, $fam, [int][System.Drawing.FontStyle]::Bold, $em, (New-Object System.Drawing.PointF 0, 0), $fmt)
$b = $path.GetBounds()
$m = New-Object System.Drawing.Drawing2D.Matrix
$m.Translate(($s - $b.Width) / 2 - $b.X, ($s - $b.Height) / 2 - $b.Y)
$path.Transform($m)
$penPh = New-Object System.Drawing.Pen $ph, $stroke
$brPh = New-Object System.Drawing.SolidBrush $ph

# Brillo: las formas en una capa aparte, desenfocadas (reducir y volver a ampliar) y suaves
if ($Size -ge 64) {
  $layer = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $lg = [System.Drawing.Graphics]::FromImage($layer); $lg.SmoothingMode = 'AntiAlias'
  $lg.DrawPath((New-Object System.Drawing.Pen $ph, ($stroke * 2.2)), $frame)
  $lg.FillPath($brPh, $path); $lg.DrawPath((New-Object System.Drawing.Pen $ph, ($s * 0.02)), $path)
  $small = [int][Math]::Max(8, $Size / 14)
  $tiny = New-Object System.Drawing.Bitmap $small, $small
  $tg = [System.Drawing.Graphics]::FromImage($tiny); $tg.InterpolationMode = 'HighQualityBicubic'; $tg.DrawImage($layer, 0, 0, $small, $small)
  $ia = New-Object System.Drawing.Imaging.ImageAttributes
  $cm = New-Object System.Drawing.Imaging.ColorMatrix; $cm.Matrix33 = 0.75
  $ia.SetColorMatrix($cm)
  $g.DrawImage($tiny, (New-Object System.Drawing.Rectangle 0, 0, $Size, $Size), 0, 0, $small, $small, 'Pixel', $ia)
}
$g.DrawPath($penPh, $frame)
$g.FillPath($brPh, $path)

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
