# ============================================================
#  Publicar "Semáforo Mantención" en GitHub Pages
#  Cómo usarlo: clic derecho sobre este archivo → "Ejecutar con PowerShell"
#  (o abrir PowerShell en esta carpeta y escribir:  .\publicar.ps1 )
#
#  Requiere GitHub CLI conectado (ya lo está: cuenta gconsacs-hash).
#  Se puede ejecutar todas las veces que quieras: la primera vez crea
#  el sitio, las siguientes solo suben los cambios.
# ============================================================

$Repo = "semaforo-mantencion"
$Carpeta = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Carpeta

$Archivos = @(
  "index.html", "style.css", "db.js", "app.js",
  "sw.js", "manifest.json",
  "assets/icono-192.png", "assets/icono-512.png"
)

Write-Host ""
Write-Host "🚦 Publicando Semáforo Mantención..." -ForegroundColor Cyan

# 1) Usuario de GitHub
$Usuario = (gh api user --jq .login 2>$null)
if (-not $Usuario) {
  Write-Host "❌ GitHub CLI no está conectado. Escribe primero:  gh auth login" -ForegroundColor Red
  Read-Host "Presiona Enter para salir"
  exit 1
}
Write-Host "   Cuenta: $Usuario"

# 2) Crear el repositorio si no existe
$existe = $true
gh repo view "$Usuario/$Repo" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { $existe = $false }

if (-not $existe) {
  Write-Host "   Creando el repositorio $Repo..."
  gh repo create $Repo --public --description "Semaforo Mantencion - alertas de mantencion con foto y semaforo rojo/amarillo/verde" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ No se pudo crear el repositorio." -ForegroundColor Red
    Read-Host "Presiona Enter para salir"
    exit 1
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host "   El repositorio ya existe: se actualizarán los archivos."
}

# 3) Subir cada archivo (si ya existe, se reemplaza)
foreach ($ruta in $Archivos) {
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $Carpeta $ruta))
  $base64 = [Convert]::ToBase64String($bytes)
  $tmp = [System.IO.Path]::GetTempFileName()

  # ¿Ya existe en GitHub? Entonces hay que mandar su "sha" para reemplazarlo
  $sha = (gh api "repos/$Usuario/$Repo/contents/$ruta" --jq .sha 2>$null)
  $cuerpo = @{ message = "Actualizar $ruta"; content = $base64 }
  if ($sha) { $cuerpo.sha = $sha }
  ($cuerpo | ConvertTo-Json -Compress) | Set-Content -Path $tmp -Encoding ascii

  gh api -X PUT "repos/$Usuario/$Repo/contents/$ruta" --input $tmp | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "   ✔ $ruta" } else { Write-Host "   ✖ $ruta (no se pudo subir)" -ForegroundColor Yellow }
  Remove-Item $tmp -Force
}

# 4) Activar GitHub Pages (solo la primera vez)
$rama = (gh api "repos/$Usuario/$Repo" --jq .default_branch)
gh api "repos/$Usuario/$Repo/pages" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "   Activando GitHub Pages..."
  $tmp = [System.IO.Path]::GetTempFileName()
  (@{ source = @{ branch = $rama; path = "/" } } | ConvertTo-Json -Compress) | Set-Content -Path $tmp -Encoding ascii
  gh api -X POST "repos/$Usuario/$Repo/pages" --input $tmp | Out-Null
  Remove-Item $tmp -Force
}

$url = "https://$Usuario.github.io/$Repo/"
Write-Host ""
Write-Host "✅ ¡Listo! En 1 o 2 minutos la app estará en:" -ForegroundColor Green
Write-Host "   $url" -ForegroundColor Green
Write-Host ""
Write-Host "   Ábrela en el teléfono con Chrome y toca 'Instalar' para tenerla como app."
Write-Host ""
Read-Host "Presiona Enter para cerrar"
