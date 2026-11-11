# Obra del Buen Consejo

Prototipo responsive para control disciplinario y seguimiento escolar de Bachillerato. Incluye registro docente con QR, administración manual de usuarios, cursos, alumnos y representantes, importación de padrones, agenda de portería, expediente 360° y portal del representante.

## Arquitectura

```text
Móvil / navegador escolar
        │ HTTPS :443 (certificado local)
        ▼
Nginx: archivos React + proxy /api
        │                         │
        ▼                         ▼
FastAPI :8000 ─────────────── PostgreSQL 16
   │                 │
   ├─ JWT + RBAC      └─ SQLAlchemy
   ├─ CSV / XLSX
   └─ Telegram Bot API (salida HTTPS)
```

La cámara usa `@zxing/browser` con `facingMode: environment` para preferir la cámara trasera. El QR contiene un token aleatorio, no la cédula. El navegador móvil solo habilita cámara en HTTPS (o localhost); en LAN el dispositivo debe confiar en el certificado instalado.

## Modelo relacional

| Tabla | Campos principales | Relaciones |
| --- | --- | --- |
| `users` | id PK, username UNIQUE, full_name, password_hash, role, guardian_id FK nullable UNIQUE, active | Cuenta institucional; guardian_id asocia un usuario representante |
| `sections` | id PK, year_level (1–5), name, active, UNIQUE(year_level, name) | Una sección tiene muchos alumnos y un profesor responsable; relación N:M con materias |
| `subjects` | id PK, name UNIQUE, active | Materias del catálogo asociables a uno o varios cursos |
| `section_subjects` | section_id FK + subject_id FK PK compuesta | Materias disponibles en cada curso |
| `teacher_sections` | id PK, teacher_id FK, section_id FK, subject_id FK nullable | Asignación profesor-sección-materia; combinación UNIQUE |
| `students` | id PK, first_name, last_name, document_id UNIQUE, qr_token UNIQUE, section_id FK, active | Pertenece a sección; relación N:M con representantes/reportes |
| `guardians` | id PK, full_name, document_id UNIQUE, phone, email, telegram_chat_id UNIQUE, telegram_link_token UNIQUE, active | Uno o varios estudiantes por representante |
| `student_guardians` | student_id FK + guardian_id FK PK compuesta, relationship_type | Tabla puente alumno-representante |
| `reports` | id PK, created_by FK users, severity, description, action_taken, subject, location, occurred_at, created_at, active | Reporte grupal, N:M con estudiantes |
| `report_students` | report_id FK + student_id FK PK compuesta, action_taken | Tabla puente del incidente grupal |
| `citations` | id PK, report_id FK nullable, guardian_id FK, scheduled_at, reason, status, guardian_confirmed, attended_at, created_by FK | Agenda; cancelar cambia status a cancelled y conserva el registro |
| `message_logs` | id PK, guardian_id FK, report_id FK nullable, channel, body, status, sent_at, created_at | Bitácora de notificaciones Telegram |

Las bajas administrativas son lógicas para conservar el historial y las relaciones. El arranque crea tablas nuevas, añade columnas compatibles del prototipo anterior y migra las asociaciones curso-materia existentes; cambios estructurales futuros deben versionarse con migraciones antes de un despliegue con datos reales.

## Roles

| Rol | Alcance implementado en API |
| --- | --- |
| `admin` | CRUD y paginación de cuentas, cursos, materias, alumnos, representantes y reportes; carga masiva |
| `coordinator` | Historial general de reportes, expediente, agenda y enlace Telegram |
| `teacher` | Alumnos y reportes limitados a secciones asignadas |
| `doorman` | Agenda del día, búsqueda y cambio de estado de citación |
| `guardian` | Solo estudiantes vinculados, sus reportes, citaciones y mensajes |

Cada ruta privada valida JWT y rol; el filtro de secciones del profesor se vuelve a comprobar al guardar. La pestaña Administración está disponible solo para `admin` y permite altas manuales; las cuentas nuevas de profesor requieren curso asignado.

## Rutas API

Todas usan prefijo `/api`; excepto health y login, requieren `Authorization: Bearer <token>`.

| Método y ruta | Permiso | Uso |
| --- | --- | --- |
| `GET /health` | Público | Health check |
| `POST /auth/login`, `GET /auth/me`, `POST /auth/password` | Público / usuario | JWT, identidad y cambio de clave con validación de clave actual |
| `POST /users` | Admin | Alta de cuenta con rol |
| `GET /users?page=&page_size=&q=` | Admin | Cuentas paginadas y buscables, sin contraseñas |
| `POST /users`, `PATCH /users/{id}`, `DELETE /users/{id}` | Admin | Alta, edición/cambio de contraseña y desactivación |
| `GET /sections?page=&page_size=&q=`, `POST /sections`, `PATCH /sections/{id}`, `DELETE /sections/{id}` | Admin/coordinator; escritura solo admin | Cursos 1.º–5.º, profesor responsable y baja lógica |
| `GET /guardians?page=&page_size=&q=`, `POST /guardians`, `PATCH /guardians/{id}`, `DELETE /guardians/{id}` | Admin/coordinator; escritura solo admin | Contactos, vínculos, paginación y búsqueda |
| `GET /subjects?page=&page_size=&q=`, `POST /subjects`, `PATCH /subjects/{id}`, `DELETE /subjects/{id}` | Admin/coordinator; escritura solo admin | Materias paginadas y editables |
| `POST /teachers/{id}/sections` | Admin | Asigna sección/materia |
| `GET /students?page=&page_size=&q=&section_id=`, `POST /students`, `PATCH /students/{id}`, `DELETE /students/{id}` | Admin/coordinator/teacher/doorman; escritura manual solo admin | Directorio paginado/buscable y matrícula editable |
| `GET /students/qr/{token}` | Admin/coordinator/teacher | Resuelve QR contra el padrón y verifica sección docente |
| `GET /students/{id}/summary` | Admin/coordinator/teacher | Expediente 360°, gravedad, reportes, representantes y citas |
| `POST /reports`, `GET /reports?page=&page_size=&q=&student_id=`, `PATCH /reports/{id}`, `DELETE /reports/{id}` | Admin/coordinator/teacher | CRUD y búsqueda de reportes individuales/grupales con control de sección |
| `POST /import/students` | Admin | Importa CSV/XLSX, validación completa y transacción |
| `POST /citations`, `GET /citations?page=&page_size=&q=&day=` | Admin/coordinator/doorman | Permite elegir envío Telegram al agendar; expone estado del envío y enlace del representante |
| `GET /guardians/{id}/citations?page=&page_size=` | Admin/coordinator/doorman | Historial de un representante |
| `PATCH /citations/{id}`, `DELETE /citations/{id}` | Admin/coordinator | Edita o cancela (mantiene la auditoría); bloquea citas duplicadas por representante/horario |
| `POST /citations/{id}/send-telegram` | Admin/coordinator | Envía o reintenta una notificación de citación y registra resultado/fecha/error |
| `PATCH /citations/{id}/status` | Admin/coordinator/doorman | `pending`, `attended`, `no_show` o `cancelled` |
| `GET /guardians/{id}/telegram-link` | Admin/coordinator | Enlace de vinculación de Telegram de un solo uso |
| `GET /messages?guardian_id=...` | Admin/coordinator/guardian | Bitácora; el representante solo consulta la suya |
| `GET /guardian/summary` | Guardian | Datos exclusivos del representante autenticado |
| `POST /webhooks/telegram` | Telegram (secreto requerido) | Vincula un chat con `/start <token>` mediante `X-Telegram-Bot-Api-Secret-Token` |

Todas las listas limitan la página a 100 filas como máximo. El historial general permite buscar reportes por descripción, estudiante, documento, materia o lugar; administración y coordinación pueden incluir registros desactivados. OpenAPI interactivo: `https://<IP-del-servidor>/api/docs`.

## Ejecución local en LAN (Docker)

Requisitos: Docker Desktop/Engine con Compose v2 y OpenSSL. Desde PowerShell en el directorio del proyecto:

```powershell
Copy-Item .env.example .env
```

Edita `.env`: define contraseñas aleatorias para PostgreSQL y el administrador, y una clave `SECRET_KEY` larga y aleatoria. Para `POSTGRES_PASSWORD`, usa al menos 32 caracteres aleatorios alfanuméricos para que la URL de conexión no requiera escape. No publiques `.env` ni los archivos de `deploy/certs`.

Genera el certificado con la IP LAN fija del servidor:

```powershell
.\deploy\generate-cert.ps1 -LanIp 192.168.1.20
```

En Linux/macOS también existe `LAN_IP=192.168.1.20 sh deploy/generate-cert.sh`. Instala `deploy/certs/obc.crt` como certificado de confianza en cada smartphone/tablet; ajusta la IP del certificado si cambia la dirección del servidor.

```powershell
docker compose up -d --build
```

Abre `https://192.168.1.20`, inicia sesión con `BOOTSTRAP_USER`/`BOOTSTRAP_PASSWORD` de `.env`. El puerto 80 redirige a HTTPS. El usuario bootstrap se crea únicamente al inicializar la base vacía; cambia su clave con `POST /api/auth/password` después de iniciar sesión.

Para activar Telegram en desarrollo local, coloca únicamente el token de BotFather en `TELEGRAM_BOT_TOKEN` dentro del archivo privado `.env.local` (ya ignorado por Git) y reinicia el backend. El servicio consulta `getMe` para descubrir el nombre público del bot; no hace falta configurar el usuario. Para Docker, configura ese mismo token en `.env` y levanta el perfil de polling con `docker compose --profile telegram up -d --build`. `INSTITUTION_NAME` tiene un valor por defecto configurable y `TELEGRAM_BOT_USERNAME` es un override opcional. El representante inicia sesión en el portal familiar, pulsa **Vincular Telegram** y luego **Iniciar** en el bot; el sistema guarda el chat y la fecha de vinculación. La API también ofrece `POST /api/webhooks/telegram`, protegido por `TELEGRAM_WEBHOOK_SECRET` y el header `X-Telegram-Bot-Api-Secret-Token`, si el servidor tiene HTTPS públicamente accesible; configura el webhook desde la API de Telegram y no ejecutes el perfil de polling a la vez. Para una LAN aislada, polling saliente es el modo compatible. En la agenda, cada citación muestra el estado Telegram; administración y coordinación pueden enviar o reintentar la notificación. Al agendar, el envío está habilitado por defecto y se puede desmarcar. Los intentos sin vínculo o con error quedan reflejados en la citación y en la bitácora de mensajes.

El importador acepta `.xlsx` y `.csv`, máximo 10 MB. Usa la plantilla `deploy/plantilla-estudiantes.csv`; columnas obligatorias: `nombres, apellidos, documento, anio, seccion`; opcionales: `representante, documento_representante, telefono, correo`. Si alguna fila no es válida no se inserta ninguna. También puedes crear cursos, estudiantes, representantes y cuentas desde Administración sin Excel; el QR estudiantil se genera al guardar.

## Actualizaciones (CD)

El servidor de la oficina puede detectar, por sí mismo, cuándo hay una
versión nueva publicada en GitHub y actualizarse con la aprobación de un
administrador, sin que nadie tenga que entrar por SSH a esa máquina.

```text
git tag vX.Y.Z + push
        │
        ▼
GitHub Actions construye 3 imágenes (api, web, updater)
y las publica en GHCR + crea un Release
        │
        ▼
Servicio "updater" en la oficina revisa el Release más reciente
cada CHECK_INTERVAL_MINUTES (por defecto 30)
        │
        ▼
Panel Administración → pestaña "Actualizaciones" muestra el aviso
        │  (el admin pulsa "Actualizar ahora")
        ▼
"updater" lanza un contenedor desplegador independiente que hace
docker compose pull && docker compose up -d
```

### Publicar una versión nueva

```bash
git tag v1.4.0
git push origin v1.4.0
```

Eso dispara `.github/workflows/release.yml`: construye las imágenes de
`api`, `web` y `updater`, las publica en `ghcr.io/daviddiazdh/obra-del-buen-consejo-*`
(etiquetadas con la versión y con `latest`) y crea el Release en GitHub con
notas generadas automáticamente a partir de los commits.

### Configurar el servidor de la oficina (una sola vez)

1. En `.env`, completa `GITHUB_REPO`, `GITHUB_TOKEN` (un token de GitHub de
   solo lectura; obligatorio si el repositorio es privado) y
   `HOST_PROJECT_DIR` con la ruta absoluta de esta carpeta **tal como la ve
   el sistema operativo del servidor** (ver comentarios en `.env.example`).
2. Si el repositorio de GitHub es privado, las imágenes en GHCR también lo
   son: el Docker del servidor necesita su propio inicio de sesión, aparte
   del `GITHUB_TOKEN` de arriba (ese solo lo usa el servicio `updater` para
   leer la API de GitHub). Una sola vez, en el servidor:
   ```bash
   docker login ghcr.io -u <tu-usuario-de-GitHub>
   ```
   Pide un token (PAT) con permiso `read:packages` cuando lo solicite.
3. `docker compose up -d --build` como siempre. El servicio `updater`
   queda escuchando; no publica ningún puerto, solo es alcanzable desde
   `api` por la red interna de Docker Compose.

### Cómo se aplica una actualización

Un administrador entra a **Administración → Actualizaciones**, ve la
versión instalada y la última publicada (con sus notas), y pulsa
**Actualizar ahora**. A partir de ahí:

- El backend valida que de verdad haya una versión nueva y pide al
  servicio `updater` que inicie el despliegue.
- `updater` lanza, vía el socket de Docker, un contenedor desplegador
  *independiente* (no gestionado por `docker compose`) que ejecuta
  `docker compose pull && docker compose up -d --remove-orphans`. Al ser
  independiente, sigue corriendo aunque el propio `updater` —o la API— se
  reinicien a mitad del proceso, que es justamente lo que pasa cuando la
  nueva versión también los reemplaza.
- El panel va mostrando el progreso (con el registro del contenedor
  desplegador) y, cuando la API vuelve a responder con la nueva versión,
  ofrece recargar la página.
- La aplicación queda brevemente fuera de servicio (segundos a un minuto)
  mientras se recrean los contenedores; no hay downtime cero.

### Advertencias de seguridad

El servicio `updater` tiene montado el socket de Docker del host
(`/var/run/docker.sock`), lo cual equivale a privilegios de administrador
sobre esa máquina. Es una condición necesaria para que pueda reiniciar el
resto de los contenedores. Por eso:

- Nunca le publiques un puerto (`ports:`) ni lo expongas a la LAN; solo
  debe ser alcanzable desde `api`.
- Restringe quién tiene acceso físico o remoto a la máquina que corre
  Docker Compose, igual que harías con cualquier servidor con privilegios
  de root.
- El `GITHUB_TOKEN` de `.env` solo necesita permiso de lectura sobre el
  repositorio; no uses un token con más alcance del necesario.

## Desarrollo y operación

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
npm install

# Terminal 1: API local con SQLite y administrador de desarrollo
# Configuración privada de Telegram (al habilitarlo, completa TELEGRAM_BOT_TOKEN en .env.local)
$env:DATABASE_URL='sqlite:///./local-dev.db'
$env:BOOTSTRAP_USER='admin'
$env:BOOTSTRAP_PASSWORD='Development-Only-ChangeMe-2026'
$env:SECRET_KEY='development-only-secret-key-replace-this-value'
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000

# Terminal 2: interfaz Vite (proxy /api hacia la terminal 1)
npm run dev

# Terminal 3: escucha las vinculaciones /start de Telegram (solo cuando el token esté configurado)
$env:PYTHONPATH='backend'
.\.venv\Scripts\python.exe backend\telegram_bot.py
```

Abre `http://localhost:5173` e inicia con `admin` / `Development-Only-ChangeMe-2026`. Son credenciales solo de desarrollo; no las uses en una red compartida.

Prueba API aislada: `$env:PYTHONPATH='backend'; .\.venv\Scripts\python.exe -m pytest backend\tests -q`. Comprobaciones adicionales: `npm run build`, `python -m compileall -q backend` y `docker compose config`.

PostgreSQL persiste en el volumen `postgres_data`. Programa copias cifradas fuera del contenedor con `docker compose exec -T db pg_dump -U obc obc > backup.sql` y prueba regularmente su restauración. Restringe los puertos 80/443 a la LAN mediante firewall; no publiques la API ni Postgres a Internet. El certificado autofirmado cifra tráfico, pero no acredita identidad hasta que cada dispositivo confíe en él. Telegram no debe transportar detalles sensibles del incidente; los avisos de este prototipo solo comunican la novedad y reservan el detalle para el portal autenticado.
