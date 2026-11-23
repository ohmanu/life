# Iconos de LIFE: el 生 con marco, como el logo de la barra de estado, con el brillo de fósforo de la app.
#   App (1024, con esquinas redondeadas): scripts/icono.ps1 -Out src-tauri/icons/source.png -Size 1024 -Rounded
#     y luego: npx tauri icon src-tauri/icons/source.png -o <carpeta temporal>, copiando solo los archivos que ya hay en src-tauri/icons.
#   Bandeja (32 px): scripts/icono.ps1 -Out src-tauri/icons/tray.png -Size 32
#   Usa la fuente del sistema Yu Gothic UI y los colores de src/styles/console.css (--bg, --ph, --hi).
#   Se dibuja a 4× (mínimo 512 px) y se reduce al final, para que el brillo salga suave también a 32 px.
param([string]$Out, [int]$Size, [switch]$Rounded)
Add-Type -AssemblyName System.Drawing

function Col([int]$a, [int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }
$bg = Col 255 0x03 0x11 0x0f
$ph = Col 255 0x38 0xf2 0xc4
$hi = Col 255 0xe4 0xff 0xf7

$W = [Math]::Max(512, $Size * 2)
$s = [float]$W

function NewBmp([int]$n) { New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb) }
function Gfx($bmp) {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  return $g
}
function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($r -le 0) { $p.AddRectangle((New-Object System.Drawing.RectangleF $x, $y, $w, $h)); return $p }
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}
# Desenfoque: reducir de golpe a `tiny` px (cuanto menor, más ancho el brillo) y volver a ampliar
# por pasos, con los bordes en espejo para que no aparezcan franjas.
function Escala($src, [int]$n) {
  $dst = NewBmp $n; $gx = Gfx $dst
  $ia = New-Object System.Drawing.Imaging.ImageAttributes; $ia.SetWrapMode('TileFlipXY')
  $gx.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $n, $n), 0, 0, $src.Width, $src.Height, 'Pixel', $ia)
  $gx.Dispose(); return $dst
}
function Blur($src, [int]$tiny) {
  $cur = Escala $src $tiny; $n = $tiny
  while ($n -lt $W) { $n = [Math]::Min($W, $n * 2); $cur = Escala $cur $n }
  return $cur
}
function DrawAlpha($g, $img, [float]$alpha) {
  $ia = New-Object System.Drawing.Imaging.ImageAttributes
  $cm = New-Object System.Drawing.Imaging.ColorMatrix; $cm.Matrix33 = $alpha
  $ia.SetColorMatrix($cm)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $W, $W), 0, 0, $W, $W, 'Pixel', $ia)
}

# Formas: fondo, marco y glifo.
$radius = if ($Rounded) { $s * 0.12 } else { $s * 0.08 }
$fondo = RoundRect 0 0 $s $s $radius
$inset = $s * 0.13
$stroke = if ($Size -lt 64) { $s * 0.05 } else { $s * 0.028 }
$frame = RoundRect $inset $inset ($s - 2 * $inset) ($s - 2 * $inset) 0
$fam = New-Object System.Drawing.FontFamily 'Yu Gothic UI'
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddString([string][char]0x751F, $fam, [int][System.Drawing.FontStyle]::Bold, $s * 0.56, (New-Object System.Drawing.PointF 0, 0), [System.Drawing.StringFormat]::GenericTypographic)
$bnd = $path.GetBounds()
$m = New-Object System.Drawing.Drawing2D.Matrix
$m.Translate(($s - $bnd.Width) / 2 - $bnd.X, ($s - $bnd.Height) / 2 - $bnd.Y)
$path.Transform($m)

$penPh = New-Object System.Drawing.Pen $ph, $stroke
$brPh = New-Object System.Drawing.SolidBrush $ph

# Capa de lo que brilla (marco y glifo).
$luz = NewBmp $W; $lg = Gfx $luz
$lg.DrawPath($penPh, $frame); $lg.FillPath($brPh, $path); $lg.Dispose()

$img = NewBmp $W; $g = Gfx $img
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillPath((New-Object System.Drawing.SolidBrush $bg), $fondo)
$g.SetClip($fondo)

# Tramado de líneas (como las celdas de la app); a tamaño de bandeja no se vería.
if ($Size -ge 64) {
  $paso = [float]($s / 200)
  $penLinea = New-Object System.Drawing.Pen (Col 16 0x38 0xf2 0xc4), ($paso * 0.45)
  for ($y = 0.0; $y -lt $s; $y += $paso) { $g.DrawLine($penLinea, 0, $y, $s, $y) }
}

# Resplandor dentro del marco (inset), como el box-shadow interior de .logo .mark.
$dentro = NewBmp $W; $dg = Gfx $dentro
$dg.DrawPath((New-Object System.Drawing.Pen $ph, ($stroke * 2)), $frame); $dg.Dispose()
$g.SetClip($frame); DrawAlpha $g (Blur $dentro 48) 0.55; $g.SetClip($fondo)

# Brillo exterior: uno ancho y suave y otro corto e intenso.
DrawAlpha $g (Blur $luz 28) 0.9
DrawAlpha $g (Blur $luz 96) 0.8

# Formas nítidas encima, con un núcleo algo más claro en el glifo (fósforo encendido).
$g.DrawPath($penPh, $frame)
$g.FillPath($brPh, $path)
$nucleo = New-Object System.Drawing.Pen (Col 90 0xe4 0xff 0xf7), ($s * 0.006)
$g.DrawPath($nucleo, $path)
$g.ResetClip(); $g.Dispose()

# Reducir al tamaño final.
$final = NewBmp $Size; $og = Gfx $final
$og.Clear([System.Drawing.Color]::Transparent)
$og.DrawImage($img, 0, 0, $Size, $Size); $og.Dispose()
$final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$final.Dispose(); $img.Dispose()
