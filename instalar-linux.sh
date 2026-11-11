#!/usr/bin/env bash
# Asistente de instalación — Obra del Buen Consejo (Linux: Ubuntu, Debian y derivados)
#
# Uso, desde la carpeta del proyecto:   sudo bash instalar-linux.sh
#
# Hace, en orden:
#   1. Instala Docker Engine + Compose si faltan (script oficial get.docker.com)
#      y lo deja arrancando con el sistema.
#   2. Genera .env con contraseñas aleatorias (no sobrescribe uno existente).
#   3. Genera el certificado HTTPS para la IP de la red local.
#   4. Abre los puertos 80/443 en ufw si está activo.
#   5. Descarga las imágenes publicadas en GHCR y arranca el sistema.
# Es seguro volver a ejecutarlo: cada paso detecta lo que ya está hecho.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$RAIZ"
ENV_FILE="$RAIZ/.env"
CERT_DIR="$RAIZ/deploy/certs"
LOG="$RAIZ/instalacion.log"

paso()  { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()    { printf '    \033[32m[OK]\033[0m %s\n' "$1"; }
aviso() { printf '    \033[33m[!]\033[0m %s\n' "$1"; }
fallo() { printf '\n\033[31mERROR: %s\033[0m\nDetalle completo en: %s\n' "$1" "$LOG" >&2; exit 1; }
trap 'fallo "El paso anterior falló (línea $LINENO)."' ERR

preguntar() { # $1 texto, $2 valor por defecto
  local r; read -r -p "    $1 [$2]: " r </dev/tty || true
  printf '%s' "${r:-$2}"
}

clave_aleatoria() { # solo letras y números: evita escapar la URL de PostgreSQL
  LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' </dev/urandom | head -c "$1" || true
}

leer_env() { # $1 clave
  [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true
}

poner_env() { # $1 clave, $2 valor — reemplaza la línea o la añade
  local tmp; tmp="$(mktemp)"
  awk -v k="$1" -v v="$2" 'BEGIN{h=0} $0 ~ "^"k"=" {print k"="v; h=1; next} {print} END{if(!h) print k"="v}' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}

[ "$(id -u)" -eq 0 ] || { echo "Ejecute el asistente con sudo:  sudo bash $0"; exit 1; }
exec > >(tee -a "$LOG") 2>&1

printf '\033[36m=================================================================\n'
printf '   Obra del Buen Consejo — Asistente de instalación (Linux)\n'
printf '=================================================================\033[0m\n'

# --- 1. Docker ---------------------------------------------------------------

paso 'Comprobando Docker'
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q curl; }
  echo '    Instalando Docker Engine (script oficial de Docker)...'
  instalador="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$instalador"
  sh "$instalador"
  rm -f "$instalador"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || fallo 'Docker está instalado pero no responde. Revise: systemctl status docker'
ok "Docker $(docker version --format '{{.Server.Version}}') con Compose $(docker compose version --short)"
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  usermod -aG docker "$SUDO_USER" && ok "Usuario $SUDO_USER añadido al grupo docker (efectivo al volver a iniciar sesión)"
fi

# --- 2. configuración (.env) -------------------------------------------------

paso 'Configuración del sistema'
[ -f "$ENV_FILE" ] || cp "$RAIZ/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"

ip_detectada="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
echo '    Los teléfonos y computadoras del colegio entrarán por esta dirección IP.'
echo '    Recomendado: pida al encargado de la red que la reserve (IP fija / reserva DHCP).'
while :; do
  ip="$(preguntar 'IP de este equipo en la red del colegio' "${ip_detectada:-127.0.0.1}")"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && break
done

poner_env HOST_PROJECT_DIR "$RAIZ"
admin_password=''
secreto="$(leer_env SECRET_KEY)"
if [ -z "$secreto" ] || [[ "$secreto" == replace-with* ]]; then
  poner_env INSTITUTION_NAME "$(preguntar 'Nombre de la institución' 'Obra del Buen Consejo')"
  poner_env BOOTSTRAP_USER   "$(preguntar 'Usuario del administrador' 'admin')"
  poner_env BOOTSTRAP_NAME   "$(preguntar 'Nombre visible del administrador' 'Administrador del sistema')"
  admin_password="$(clave_aleatoria 16)"
  poner_env BOOTSTRAP_PASSWORD "$admin_password"
  poner_env POSTGRES_PASSWORD  "$(clave_aleatoria 40)"
  poner_env SECRET_KEY         "$(clave_aleatoria 64)"
  read -r -p '    Token del bot de Telegram (opcional; Enter para omitir): ' tg </dev/tty || true
  if [ -n "${tg:-}" ]; then
    poner_env TELEGRAM_BOT_TOKEN "$tg"
    poner_env COMPOSE_PROFILES telegram
  fi
else
  ok '.env ya existe: se conservan contraseñas y datos (solo se actualiza la ruta del proyecto).'
fi
ok 'Archivo .env listo (permisos 600: solo root puede leerlo)'

# --- 3. certificado HTTPS ----------------------------------------------------

paso 'Certificado HTTPS para la red local'
crt="$CERT_DIR/obc.crt"
if [ -f "$crt" ] && command -v openssl >/dev/null 2>&1 \
   && openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$ip\b" \
   && openssl x509 -in "$crt" -noout -checkend $((30*86400)) >/dev/null; then
  ok "El certificado existente ya cubre $ip"
else
  mkdir -p "$CERT_DIR"
  # Se usa OpenSSL dentro de un contenedor para no depender del sistema.
  docker run --rm -v "$CERT_DIR:/certs" alpine:3.20 sh -c \
    "apk add --no-cache openssl >/dev/null && openssl req -x509 -nodes -days 825 -newkey rsa:2048 -keyout /certs/obc.key -out /certs/obc.crt -subj '/CN=Obra del Buen Consejo' -addext 'subjectAltName=IP:127.0.0.1,IP:$ip,DNS:localhost' 2>/dev/null && chmod 600 /certs/obc.key"
  ok "Certificado creado para $ip"
fi
cp "$crt" "$RAIZ/certificado-para-dispositivos.crt"
if [ -d /usr/local/share/ca-certificates ] && command -v update-ca-certificates >/dev/null 2>&1; then
  cp "$crt" /usr/local/share/ca-certificates/obra-del-buen-consejo.crt
  update-ca-certificates >/dev/null 2>&1 && ok 'Certificado instalado como confiable en este equipo'
fi

# --- 4. firewall --------------------------------------------------------------

paso 'Firewall'
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ok 'Puertos 80 y 443 abiertos en ufw'
else
  ok 'ufw no está activo; no hay reglas que añadir'
fi

# --- 5. descargar y arrancar ------------------------------------------------

paso 'Descargando la última versión publicada (puede tardar unos minutos)'
docker compose pull || fallo 'No se pudieron descargar las imágenes. Revise la conexión a Internet.'

paso 'Arrancando el sistema'
docker compose up -d --no-build --remove-orphans

echo '    Esperando a que el sistema responda...'
for _ in $(seq 1 60); do
  [ "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/health || true)" = 200 ] && break
  sleep 3
done
[ "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/health || true)" = 200 ] \
  || fallo 'El sistema no respondió a tiempo. Ejecute "docker compose logs api" en esta carpeta para ver el motivo.'
ok 'El sistema está en línea'

# --- resumen (fuera del registro, para no guardar la contraseña en él) -------
trap - ERR
exec >/dev/tty 2>&1
printf '\n\033[32m=================================================================\n'
printf '   Instalación completada\n'
printf '=================================================================\033[0m\n'
printf '  Dirección:      https://%s\n' "$ip"
printf '  Usuario admin:  %s\n' "$(leer_env BOOTSTRAP_USER)"
if [ -n "$admin_password" ]; then
  printf '  \033[33mContraseña:     %s\033[0m\n' "$admin_password"
  printf '  \033[33mANÓTELA en un lugar seguro y cámbiela tras el primer inicio de sesión.\033[0m\n'
else
  printf '  Contraseña:     la misma de la instalación anterior (BOOTSTRAP_PASSWORD en .env)\n'
fi
printf '\n  Para que teléfonos y tablets confíen en la conexión segura, instale en\n'
printf '  cada uno el archivo:  certificado-para-dispositivos.crt  (en esta carpeta).\n'
printf '  El sistema arranca solo cada vez que se enciende el equipo.\n\n'
