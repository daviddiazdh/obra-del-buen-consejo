#!/usr/bin/env sh
set -eu

mkdir -p deploy/certs
LAN_IP="${LAN_IP:-127.0.0.1}"
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout deploy/certs/obc.key \
  -out deploy/certs/obc.crt \
  -subj "/CN=Obra del Buen Consejo" \
  -addext "subjectAltName=IP:127.0.0.1,IP:${LAN_IP},DNS:localhost"
chmod 600 deploy/certs/obc.key
printf 'Certificado generado para 127.0.0.1 y %s. Instala obc.crt en cada móvil/tablet de confianza.\n' "$LAN_IP"
