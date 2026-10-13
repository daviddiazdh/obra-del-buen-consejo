param(
  [Parameter(Mandatory = $true)]
  [string]$LanIp
)

New-Item -ItemType Directory -Force -Path "deploy/certs" | Out-Null
openssl req -x509 -nodes -days 365 -newkey rsa:2048 `
  -keyout deploy/certs/obc.key `
  -out deploy/certs/obc.crt `
  -subj "/CN=Obra del Buen Consejo" `
  -addext "subjectAltName=IP:127.0.0.1,IP:$LanIp,DNS:localhost"
if ($LASTEXITCODE -ne 0) { throw "OpenSSL no pudo generar el certificado." }
Write-Host "Certificado creado para 127.0.0.1 y $LanIp. Instala deploy/certs/obc.crt en cada dispositivo móvil de confianza."
