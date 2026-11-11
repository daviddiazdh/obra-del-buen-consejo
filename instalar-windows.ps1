#Requires -Version 5.1
<#
  Asistente de instalación — Obra del Buen Consejo (Windows 10/11)

  Se ejecuta con doble clic en instalar-windows.bat. Hace, en orden:
    1. Comprueba requisitos (Windows, virtualización) y activa WSL2.
    2. Instala Docker Desktop si falta y lo deja arrancando con Windows.
    3. Genera .env con contraseñas aleatorias (no sobrescribe uno existente).
    4. Genera el certificado HTTPS para la IP de la red local.
    5. Abre los puertos 80/443 en el firewall (solo redes privadas).
    6. Descarga las imágenes publicadas en GHCR y arranca el sistema.

  Es seguro volver a ejecutarlo: cada paso detecta lo que ya está hecho.
  Si Windows necesita reiniciar, el asistente continúa solo al iniciar sesión.
#>
param([switch]$Reanudar)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Raiz

$EnvFile      = Join-Path $Raiz '.env'
$CertDir      = Join-Path $Raiz 'deploy\certs'
$DockerExe    = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$TareaReanudar = 'ObraDelBuenConsejo-Instalador'

# --- utilidades --------------------------------------------------------------

function Paso([string]$texto)  { Write-Host ''; Write-Host "==> $texto" -ForegroundColor Cyan }
function Ok([string]$texto)    { Write-Host "    [OK] $texto" -ForegroundColor Green }
function Aviso([string]$texto) { Write-Host "    [!] $texto" -ForegroundColor Yellow }
function Fallo([string]$texto) {
  Write-Host ''
  Write-Host "ERROR: $texto" -ForegroundColor Red
  Write-Host "Detalle completo en: $(Join-Path $Raiz 'instalacion.log')"
  try { Stop-Transcript | Out-Null } catch {}
  Read-Host 'Pulse Enter para cerrar'
  exit 1
}

function Es-Administrador {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Clave-Aleatoria([int]$largo) {
  # Solo letras y números: evita tener que escapar la URL de PostgreSQL.
  $alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] $largo
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $alfabeto[$_ % $alfabeto.Length] })
}

function Preguntar([string]$texto, [string]$porDefecto) {
  $r = Read-Host "    $texto [$porDefecto]"
  if ([string]::IsNullOrWhiteSpace($r)) { return $porDefecto }
  return $r.Trim()
}

function Ejecutar-Silencioso {
  # En PowerShell 5.1, redirigir el stderr de un programa externo con
  # $ErrorActionPreference='Stop' lanza excepción aunque el programa funcione
  # (p. ej. avisos de docker). Aquí se relaja solo para esta llamada y se
  # devuelve el código de salida real.
  param([string]$Programa, [string[]]$Argumentos)
  $anterior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Programa @Argumentos *> $null; return $LASTEXITCODE }
  catch { return 1 }
  finally { $ErrorActionPreference = $anterior }
}

function Docker-Responde {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  return ((Ejecutar-Silencioso 'docker' @('info')) -eq 0)
}

function Leer-Env {
  $valores = [ordered]@{}
  if (Test-Path -LiteralPath $EnvFile) {
    foreach ($linea in [IO.File]::ReadAllLines($EnvFile)) {
      if ($linea -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $valores[$Matches[1]] = $Matches[2] }
    }
  }
  return $valores
}

function Escribir-Env([hashtable]$cambios) {
  # Parte de .env (o de .env.example) y reemplaza solo las claves indicadas,
  # conservando comentarios y orden. UTF-8 sin BOM (Compose no admite BOM).
  $origen = if (Test-Path -LiteralPath $EnvFile) { $EnvFile } else { Join-Path $Raiz '.env.example' }
  $lineas = New-Object System.Collections.Generic.List[string]
  $lineas.AddRange([string[]][IO.File]::ReadAllLines($origen))
  foreach ($clave in $cambios.Keys) {
    $hecho = $false
    for ($i = 0; $i -lt $lineas.Count; $i++) {
      if ($lineas[$i] -match "^\s*$([regex]::Escape($clave))=") { $lineas[$i] = "$clave=$($cambios[$clave])"; $hecho = $true; break }
    }
    if (-not $hecho) { $lineas.Add("$clave=$($cambios[$clave])") }
  }
  [IO.File]::WriteAllText($EnvFile, (($lineas -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
}

function Programar-Reanudacion {
  # Tarea al iniciar sesión, con privilegios elevados, que se borra al terminar.
  $accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Reanudar"
  $disparador = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $TareaReanudar -Action $accion -Trigger $disparador -Principal $principal -Force | Out-Null
}

function Pedir-Reinicio([string]$motivo) {
  Programar-Reanudacion
  Write-Host ''
  Aviso "$motivo"
  Aviso 'Hay que reiniciar Windows. El asistente continuará solo al volver a iniciar sesión.'
  try { Stop-Transcript | Out-Null } catch {}
  $r = Read-Host '    ¿Reiniciar ahora? (S/n)'
  if ($r -notmatch '^[nN]') { Restart-Computer -Force }
  exit 0
}

# --- 0. privilegios y registro ----------------------------------------------

if (-not (Es-Administrador)) {
  $argumentos = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Reanudar) { $argumentos += ' -Reanudar' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argumentos
  exit 0
}

Start-Transcript -Path (Join-Path $Raiz 'instalacion.log') -Append | Out-Null
Unregister-ScheduledTask -TaskName $TareaReanudar -Confirm:$false -ErrorAction SilentlyContinue

Clear-Host
Write-Host '=================================================================' -ForegroundColor Cyan
Write-Host '   Obra del Buen Consejo — Asistente de instalación (Windows)' -ForegroundColor Cyan
Write-Host '=================================================================' -ForegroundColor Cyan
if ($Reanudar) { Write-Host 'Continuando la instalación después del reinicio...' }

try {

# --- 1. requisitos -----------------------------------------------------------

Paso 'Comprobando requisitos del equipo'
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19044) { Fallo "Docker Desktop requiere Windows 10 21H2 (compilación 19044) o superior. Este equipo tiene la compilación $build. Actualice Windows y vuelva a ejecutar el asistente." }
Ok "Windows compilación $build"

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$hyperv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
if (-not $cpu.VirtualizationFirmwareEnabled -and -not $hyperv) {
  Aviso 'La virtualización parece DESACTIVADA en la BIOS/UEFI (Intel VT-x / AMD-V / SVM).'
  Aviso 'Docker no podrá arrancar sin ella. Si falla más adelante, actívela en la BIOS y repita.'
} else { Ok 'Virtualización disponible' }

$libreGB = [math]::Round((Get-PSDrive -Name ($Raiz.Substring(0,1))).Free / 1GB, 1)
if ($libreGB -lt 10) { Aviso "Solo hay $libreGB GB libres en el disco; se recomiendan al menos 10 GB." } else { Ok "$libreGB GB libres en disco" }

# --- 2. WSL2 + Docker Desktop -----------------------------------------------

Paso 'Comprobando WSL2 (necesario para Docker)'
if ((Ejecutar-Silencioso 'wsl.exe' @('--status')) -ne 0) {
  Write-Host '    Activando WSL2... (puede tardar varios minutos)'
  if ((Ejecutar-Silencioso 'wsl.exe' @('--install', '--no-distribution')) -ne 0) {
    # wsl.exe antiguo (Windows 10 sin actualizar) no conoce --no-distribution:
    # se activan directamente las dos características de Windows.
    foreach ($caracteristica in 'Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') {
      Enable-WindowsOptionalFeature -Online -FeatureName $caracteristica -All -NoRestart | Out-Null
    }
  }
  Pedir-Reinicio 'WSL2 quedó activado.'
}
Ejecutar-Silencioso 'wsl.exe' @('--update') | Out-Null
Ok 'WSL2 activo'

Paso 'Comprobando Docker Desktop'
if (-not (Test-Path -LiteralPath $DockerExe)) {
  $arq = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  $url = "https://desktop.docker.com/win/main/$arq/Docker%20Desktop%20Installer.exe"
  $instalador = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
  Write-Host '    Descargando Docker Desktop (unos 600 MB)...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'   # sin barra: la descarga es 10x más rápida en PS 5.1
  Invoke-WebRequest -Uri $url -OutFile $instalador -UseBasicParsing
  $ProgressPreference = 'Continue'
  Write-Host '    Instalando Docker Desktop...'
  $p = Start-Process -FilePath $instalador -Wait -PassThru `
    -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2','--always-run-service'
  Remove-Item -LiteralPath $instalador -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { Fallo "El instalador de Docker Desktop terminó con código $($p.ExitCode)." }
  # El usuario que inicia sesión necesita pertenecer a docker-users.
  try { Add-LocalGroupMember -Group 'docker-users' -Member "$env:USERDOMAIN\$env:USERNAME" -ErrorAction Stop } catch {}
  Pedir-Reinicio 'Docker Desktop quedó instalado.'
}
Ok 'Docker Desktop instalado'

# Que Docker Desktop arranque al iniciar sesión (el sistema vive dentro de Docker).
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Docker Desktop' -Value "`"$DockerExe`""
$env:Path = "$env:ProgramFiles\Docker\Docker\resources\bin;$env:Path"

if (-not (Docker-Responde)) {
  Write-Host '    Iniciando Docker Desktop (la primera vez puede tardar 2-3 minutos)...'
  Start-Process -FilePath $DockerExe
  $limite = (Get-Date).AddMinutes(6)
  while (-not (Docker-Responde)) {
    if ((Get-Date) -gt $limite) { Fallo 'Docker Desktop no terminó de arrancar. Ábralo desde el menú Inicio, acepte los términos si los pide, espere a que diga "Engine running" y vuelva a ejecutar el asistente.' }
    Start-Sleep -Seconds 5
  }
}
Ok 'Docker está funcionando'

# --- 3. configuración (.env) ------------------------------------------------

Paso 'Configuración del sistema'
$actual = Leer-Env

$ipDetectada = '127.0.0.1'
$conexion = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
if ($conexion -and $conexion.IPv4Address) { $ipDetectada = @($conexion.IPv4Address)[0].IPAddress }
Write-Host '    Los teléfonos y computadoras del colegio entrarán por esta dirección IP.'
Write-Host '    Recomendado: pida al encargado de la red que la reserve (IP fija / reserva DHCP).'
do {
  $ip = Preguntar 'IP de este equipo en la red del colegio' $ipDetectada
} until ($ip -match '^(\d{1,3}\.){3}\d{1,3}$')

$hostDir = '/run/desktop/mnt/host/' + $Raiz.Substring(0,1).ToLower() + ($Raiz.Substring(2) -replace '\\','/')
$cambios = @{ HOST_PROJECT_DIR = $hostDir }
$adminPassword = $null

$secretoSinCambiar = { param($v) (-not $v) -or ($v -like 'replace-with*') }
if (& $secretoSinCambiar $actual['SECRET_KEY']) {
  # Primera instalación: se preguntan los datos y se generan todos los secretos.
  $cambios['INSTITUTION_NAME'] = Preguntar 'Nombre de la institución' 'Obra del Buen Consejo'
  $cambios['BOOTSTRAP_USER']   = Preguntar 'Usuario del administrador' 'admin'
  $cambios['BOOTSTRAP_NAME']   = Preguntar 'Nombre visible del administrador' 'Administrador del sistema'
  $adminPassword = Clave-Aleatoria 16
  $cambios['BOOTSTRAP_PASSWORD'] = $adminPassword
  $cambios['POSTGRES_PASSWORD']  = Clave-Aleatoria 40
  $cambios['SECRET_KEY']         = Clave-Aleatoria 64
  $tg = Read-Host '    Token del bot de Telegram (opcional; Enter para omitir)'
  if (-not [string]::IsNullOrWhiteSpace($tg)) {
    $cambios['TELEGRAM_BOT_TOKEN'] = $tg.Trim()
    $cambios['COMPOSE_PROFILES']   = 'telegram'
  }
} else {
  Ok '.env ya existe: se conservan contraseñas y datos (solo se actualiza la ruta del proyecto).'
}
Escribir-Env $cambios
Ok 'Archivo .env listo (contiene las contraseñas: no lo comparta ni lo copie fuera del equipo)'

# --- 4. certificado HTTPS ---------------------------------------------------

Paso 'Certificado HTTPS para la red local'
$crt = Join-Path $CertDir 'obc.crt'
$regenerar = $true
if (Test-Path -LiteralPath $crt) {
  $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $crt
  $san = ($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ' '
  if ($san -match [regex]::Escape($ip) -and $c.NotAfter -gt (Get-Date).AddDays(30)) { $regenerar = $false }
}
if ($regenerar) {
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
  # OpenSSL no viene con Windows: se usa dentro de un contenedor temporal.
  & docker run --rm -v "${CertDir}:/certs" alpine:3.20 sh -c `
    "apk add --no-cache openssl >/dev/null && openssl req -x509 -nodes -days 825 -newkey rsa:2048 -keyout /certs/obc.key -out /certs/obc.crt -subj '/CN=Obra del Buen Consejo' -addext 'subjectAltName=IP:127.0.0.1,IP:$ip,DNS:localhost' 2>/dev/null"
  if ($LASTEXITCODE -ne 0) { Fallo 'No se pudo generar el certificado HTTPS.' }
  Ok "Certificado creado para $ip"
} else { Ok "El certificado existente ya cubre $ip" }
# Que el navegador de ESTE equipo confíe en el certificado.
Import-Certificate -FilePath $crt -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Copy-Item -LiteralPath $crt -Destination (Join-Path $Raiz 'certificado-para-dispositivos.crt') -Force
Ok 'Certificado instalado como confiable en este equipo'

# --- 5. firewall --------------------------------------------------------------

Paso 'Firewall de Windows'
$regla = 'Obra del Buen Consejo (HTTP/HTTPS)'
if (-not (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $regla -Direction Inbound -Protocol TCP -LocalPort 80,443 `
    -Action Allow -Profile Private,Domain | Out-Null
}
Ok 'Puertos 80 y 443 abiertos para redes privadas y de dominio'
$publicas = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -ne 'Disconnected' }
if ($publicas) {
  Aviso "La red '$($publicas[0].Name)' está marcada como PÚBLICA: los demás dispositivos no podrán entrar."
  $r = Read-Host '    ¿Marcarla como red privada? Hágalo solo si es la red del colegio (S/n)'
  if ($r -notmatch '^[nN]') { $publicas | Set-NetConnectionProfile -NetworkCategory Private; Ok 'Red marcada como privada' }
}

# --- 6. descargar y arrancar ------------------------------------------------

Paso 'Descargando la última versión publicada (puede tardar unos minutos)'
& docker compose pull
if ($LASTEXITCODE -ne 0) { Fallo 'No se pudieron descargar las imágenes. Revise la conexión a Internet.' }

Paso 'Arrancando el sistema'
& docker compose up -d --no-build --remove-orphans
if ($LASTEXITCODE -ne 0) { Fallo 'Docker no pudo arrancar los servicios. Revise instalacion.log.' }

Write-Host '    Esperando a que el sistema responda...'
$limite = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Seconds 3
  $anterior = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $estado = & curl.exe -sk -o NUL -w '%{http_code}' 'https://localhost/api/health'
  $ErrorActionPreference = $anterior
  if ((Get-Date) -gt $limite) { Fallo 'El sistema no respondió a tiempo. Ejecute "docker compose logs api" en esta carpeta para ver el motivo.' }
} until ($estado -eq '200')
Ok 'El sistema está en línea'

} catch {
  Fallo $_.Exception.Message
}

# --- resumen ----------------------------------------------------------------
# Se cierra el registro ANTES de mostrar la contraseña para no guardarla en él.
Stop-Transcript | Out-Null
$final = Leer-Env
Write-Host ''
Write-Host '=================================================================' -ForegroundColor Green
Write-Host '   Instalación completada' -ForegroundColor Green
Write-Host '=================================================================' -ForegroundColor Green
Write-Host "  Dirección:      https://$ip"
Write-Host "  Usuario admin:  $($final['BOOTSTRAP_USER'])"
if ($adminPassword) {
  Write-Host "  Contraseña:     $adminPassword" -ForegroundColor Yellow
  Write-Host '  ANÓTELA en un lugar seguro y cámbiela tras el primer inicio de sesión.' -ForegroundColor Yellow
} else {
  Write-Host '  Contraseña:     la misma de la instalación anterior (BOOTSTRAP_PASSWORD en .env)'
}
Write-Host ''
Write-Host '  Para que teléfonos y tablets confíen en la conexión segura, instale en'
Write-Host '  cada uno el archivo:  certificado-para-dispositivos.crt  (en esta carpeta).'
Write-Host ''
Write-Host '  Este equipo debe permanecer encendido y con la sesión iniciada para que'
Write-Host '  el sistema esté disponible (Docker Desktop arranca al iniciar sesión).'
Write-Host ''
Read-Host 'Pulse Enter para cerrar'
