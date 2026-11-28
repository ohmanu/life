# icon.ico de LIFE (ventana, barra de tareas, accesos directos) con cada tamaño dibujado aparte por icono.ps1,
# en vez de reducir el de 1024: así el marco y el glifo conservan grosor a 16-32 px.
#   scripts/ico.ps1   (escribe src-tauri/icons/icon.ico)
param([string]$Out = "$PSScriptRoot\..\src-tauri\icons\icon.ico")
$tam = 16, 20, 24, 32, 40, 48, 64, 256
$tmp = Join-Path ([IO.Path]::GetTempPath()) "life-ico"
New-Item -ItemType Directory -Force $tmp | Out-Null
$pngs = foreach ($n in $tam) {
  $f = Join-Path $tmp "$n.png"
  & "$PSScriptRoot\icono.ps1" -Out $f -Size $n -Rounded
  , [IO.File]::ReadAllBytes($f)
}
$ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$tam.Count)
$off = 6 + 16 * $tam.Count
for ($i = 0; $i -lt $tam.Count; $i++) {
  $n = $tam[$i]; $b = if ($n -ge 256) { 0 } else { $n }
  $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$off)
  $off += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush(); [IO.File]::WriteAllBytes((Resolve-Path -LiteralPath (Split-Path $Out)).Path + "\" + (Split-Path $Out -Leaf), $ms.ToArray())
Remove-Item -Recurse -Force $tmp
