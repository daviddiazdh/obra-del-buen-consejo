# CLAUDE.md — Obra del Buen Consejo

Guía de contexto para trabajar en este proyecto. Leer antes de escribir código.

## Qué es este proyecto

Sistema de **control disciplinario y convivencia escolar** para un colegio de
Bachillerato (años 1.º–5.º) en Venezuela. Es un prototipo que corre en la **LAN
del colegio**, no en Internet público. HTTPS con certificado autofirmado que
cada dispositivo debe instalar como confiable.

Flujo central: un profesor presencia un incidente → identifica al estudiante
escaneando su **carnet QR** (cámara del móvil, `@zxing/browser`) o buscándolo →
registra un **reporte** con gravedad → el **representante** (padre/tutor)
recibe aviso por **Telegram** y consulta el detalle en su portal → si amerita,
coordinación agenda una **citación** y el **portero** controla la asistencia.

## Stack

| Capa | Tecnología |
| --- | --- |
| Frontend | React 19 + TypeScript + Vite 6. CSS artesanal en `src/*.css` (Tailwind 4 está en devDependencies pero los estilos reales son clases propias; mantener ese enfoque) |
| Backend | FastAPI + SQLAlchemy 2.0 (estilo `Mapped`/`mapped_column`), Pydantic v2 |
| BD | PostgreSQL 16 (Docker, producción LAN) / SQLite (desarrollo local, `DATABASE_URL=sqlite:///./local-dev.db`) |
| Infra | Nginx sirve el build React y hace proxy de `/api` → FastAPI :8000. Docker Compose: `db`, `api`, `web`, `telegram-bot` (perfil opcional `telegram`) |
| Auth | JWT (python-jose, HS256, 480 min) + RBAC. Contraseñas PBKDF2-SHA256 con salt, formato `salt_hex:digest_hex` |
| Notificaciones | Telegram Bot API vía httpx (salida HTTPS). Polling (`backend/telegram_bot.py`) o webhook (`POST /api/webhooks/telegram` con secreto) |

## Estructura de archivos

```
backend/
  main.py           # TODAS las rutas API (~1.100 líneas, un solo archivo)
  models.py         # Modelos SQLAlchemy (12 tablas)
  schemas.py        # Esquemas Pydantic (validación entrada/salida)
  security.py       # JWT, hash de contraseñas, allow_roles()
  notifications.py  # Envío Telegram: send_report_alert, send_citation_alert
  database.py       # Engine, SessionLocal, get_db
  telegram_bot.py   # Bot de polling para vinculación /start <token>
  updater/          # Servicio interno de CD (ver sección "CI/CD" más abajo)
  tests/test_school_workflow.py  # Un test de flujo completo (pytest)
src/
  App.tsx                # Shell, login, navegación por rol, vista Reportes, Dashboard, Directorio, Portal, Importar
  AdminPanel.tsx         # Pestaña Administración (usuarios, estudiantes, representantes, cursos y materias, actualizaciones)
  UpdatesPanel.tsx       # Pestaña "Actualizaciones" dentro de AdminPanel (CD)
  CitationsView.tsx      # Agenda de citaciones (la vista vigente)
  ReportsHistoryView.tsx # Historial general de reportes
  StudentProfileView.tsx # Expediente 360° con editor de reportes
  *.css                  # Estilos por área (admin.css, portal.css, scheduler.css…)
deploy/
  nginx.conf, generate-cert.{sh,ps1}, plantilla-estudiantes.csv
.github/workflows/release.yml  # Build + push a GHCR + Release al subir tag v*.*.*
instalar-windows.{bat,ps1}     # Asistente de instalación Windows (instala Docker Desktop, .env, cert, arranca)
instalar-linux.sh              # Asistente equivalente para Ubuntu/Debian
```

Asistentes de instalación: `instalar-windows.ps1` debe seguir siendo
compatible con **PowerShell 5.1** y guardarse en **UTF-8 con BOM** (sin BOM,
5.1 rompe las tildes); `instalar-linux.sh` va con finales LF
(`.gitattributes`). Ambos escriben `HOST_PROJECT_DIR`: en Windows con la
forma `/run/desktop/mnt/host/c/...`, que es la ruta que ve el daemon. El
desplegador del `updater` monta el proyecto **en esa misma ruta** y
`docker-compose.yml` fija `name: obra-del-buen-consejo`. No cambies ninguna
de las dos cosas: las rutas relativas de los bind mounts y el volumen de
Postgres dependen de ellas.

No hay React Router: la navegación es un `useState<View>` en `App.tsx` y cada
rol ve un subconjunto de vistas (`visibleNav`).

## Roles (RBAC)

| Rol | Alcance |
| --- | --- |
| `admin` | CRUD completo de cuentas, cursos, materias, alumnos, representantes, reportes; importación masiva |
| `coordinator` | Historial de reportes, expedientes, agenda, enlaces Telegram. Lee catálogos, no los escribe |
| `teacher` | Alumnos y reportes **solo de sus secciones asignadas** (tabla `teacher_sections`) |
| `doorman` | Agenda del día: buscar y marcar citación como `attended` / `no_show` |
| `guardian` | Portal familiar: solo sus estudiantes vinculados, sus reportes, citas y mensajes. Su cuenta `users` tiene `guardian_id` apuntando a `guardians` |

Toda ruta privada usa `Depends(allow_roles(...))`. **El filtro de secciones del
profesor se re-verifica en cada escritura** (crear/editar/borrar reporte, QR),
no solo al listar. Mantener esa disciplina en código nuevo.

## Modelo de datos (12 tablas)

- `users` — cuentas institucionales. `guardian_id` FK nullable UNIQUE vincula cuentas de representante.
- `sections` — cursos: `year_level` (1–5) + `name` (ej. "A"), UNIQUE conjunto. Nombre se guarda en MAYÚSCULAS.
- `subjects` — catálogo de materias.
- `section_subjects` — N:M curso↔materia.
- `teacher_sections` — asignación profesor-sección-materia (`subject_id` NULL = profesor responsable/guía del curso).
- `students` — `document_id` (cédula) UNIQUE, `qr_token` UNIQUE aleatorio (el QR **nunca** contiene la cédula), `section_id`.
- `guardians` — representantes: cédula UNIQUE, teléfono, correo, `telegram_chat_id`, `telegram_link_token` (un solo uso, se regenera al vincular).
- `student_guardians` — N:M alumno↔representante con `relationship_type`.
- `reports` — incidencia: `severity` ∈ {`leve`, `grave`, `muy_grave`}, descripción, `action_taken`, materia, lugar, `occurred_at`. **Grupal**: N:M con estudiantes vía `report_students`.
- `citations` — citación a representante: `scheduled_at`, motivo, `status` ∈ {`pending`, `attended`, `no_show`, `cancelled`}, `guardian_confirmed`, y estado Telegram (`telegram_status` ∈ {`NOT_SENT`, `SENT`, `FAILED`, `NOT_LINKED`}, `telegram_sent_at`, `telegram_error_log`).
- `message_logs` — bitácora de notificaciones: `status` ∈ {`queued`, `sent`, `failed`, `unavailable`}.

### Migraciones

**No hay Alembic.** `ensure_schema()` en `main.py` hace `create_all` y añade
columnas de compatibilidad con `ALTER TABLE` al arrancar. Para añadir una
columna nueva: añadirla al modelo **y** al diccionario `compatibility_columns`
de `ensure_schema()`. Cambios estructurales mayores (renombrar, cambiar tipos)
requieren introducir migraciones versionadas antes de tocar datos reales.

## Convenciones del proyecto (obligatorias)

1. **Borrado lógico siempre.** Nada se elimina con DELETE: se marca
   `active = False` (`DELETE /api/...` solo desactiva). Las citaciones se
   cancelan (`status = 'cancelled'`) y se conservan para auditoría. Los
   listados filtran `active == True` salvo `include_inactive=true`
   (solo admin/coordinator).
2. **Paginación en todos los listados**: parámetros `q`, `page`,
   `page_size` (máx. 100); respuesta `{items, page, page_size, total, pages}`
   vía `page_payload()` / `paged_rows()`.
3. **Fechas en UTC en la BD.** Naive → se asume `SCHOOL_TIMEZONE`
   (`America/Caracas` por defecto) en citaciones o UTC en reportes, y se
   convierte a UTC al guardar. Solo se pasa a hora local para mostrar
   (frontend con `Intl.DateTimeFormat('es', ...)`, mensajes Telegram con
   `ZoneInfo`).
4. **Mensajes de error de la API en español**, pensados para el usuario final
   (`detail="Representante no encontrado"`). El frontend los muestra tal cual
   vía `apiErrorMessage()`.
5. **Unicidad verificada a mano + IntegrityError como red de seguridad**: se
   consulta duplicado antes de insertar (409 con mensaje claro) y además se
   captura `IntegrityError` con rollback.
6. **Privacidad**: el QR es un token aleatorio; los mensajes Telegram **no
   llevan detalles del incidente**, solo avisan que hay novedad y remiten al
   portal autenticado. Mantener esto en cualquier notificación nueva.
7. **Reglas de citaciones**: cupo por bloque de hora
   (`CITATION_CAPACITY_PER_HOUR`, default 3), sin duplicados
   representante+bloque, fecha siempre futura, lock advisory de Postgres para
   concurrencia. Editar una cita (fecha/motivo/representante) resetea su
   estado Telegram a `NOT_SENT`.
8. **Validación Pydantic estricta**: cédulas solo dígitos (3–32),
   contraseñas mínimo 12 caracteres, severidad por Enum.
9. **Frontend**: componentes de función + hooks, sin librería de estado ni
   router. `fetch` directo con `Authorization: Bearer` (token en
   localStorage, claves `obc-token` / `obc-role`). Búsquedas con debounce
   (~180 ms). Estilos: clases CSS propias en los `.css` de `src/`, no
   utilidades Tailwind.
10. **Importador CSV/XLSX todo-o-nada**: si una fila falla, no se inserta
    ninguna. Cabeceras normalizadas sin acentos. Columnas requeridas:
    `nombres, apellidos, documento, anio, seccion`.

## Comandos

```bash
# Desarrollo local (sin Docker): SQLite + Vite
python -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
npm install
DATABASE_URL='sqlite:///./local-dev.db' BOOTSTRAP_USER=admin \
  BOOTSTRAP_PASSWORD='Development-Only-ChangeMe-2026' \
  SECRET_KEY='development-only-secret-key-replace-this-value' \
  .venv/bin/python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
npm run dev          # Vite en :5173, proxy /api → :8000

# Pruebas y verificaciones
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests -q
npm run build        # tsc -b && vite build (verifica tipos)
python -m compileall -q backend
docker compose config

# Producción LAN
docker compose up -d --build
docker compose --profile telegram up -d --build   # con bot de polling
```

Usuario inicial: `BOOTSTRAP_USER`/`BOOTSTRAP_PASSWORD` del entorno; solo se
crea con la BD vacía. Variables en `.env` (ver `.env.example`); el token de
Telegram en desarrollo va en `.env.local` (ignorado por Git).

## CI/CD (actualizaciones remotas)

El servidor de la oficina se actualiza solo, con aprobación de un admin,
sin acceso SSH. Flujo completo en el README ("Actualizaciones (CD)"); aquí
el resumen para tocar código:

- `git tag vX.Y.Z` + push → `.github/workflows/release.yml` construye 3
  imágenes (`api`, `web`, `updater`) y las publica en
  `ghcr.io/daviddiazdh/obra-del-buen-consejo-{api,web,updater}` (tag de la
  versión + `latest`), y crea el Release (notas autogeneradas).
- `backend/updater/` es un FastAPI **aparte**, sin autenticación propia,
  alcanzable **solo** desde `api` por la red interna de Compose (nunca
  `ports:`). Tiene montado `/var/run/docker.sock` → equivale a root en el
  host. Responsabilidades: cachear la última versión de
  `GET /repos/{GITHUB_REPO}/releases/latest`, y al recibir `POST /update`,
  lanzar un contenedor **desplegador independiente** (no gestionado por
  Compose, por eso sobrevive aunque `updater` se reemplace a mitad de
  camino) que corre `docker compose pull && up -d`.
- `backend/main.py` expone el único puente autenticado: `GET
  /api/system/version`, `POST /api/system/update`, `GET
  /api/system/update/status`, los tres con `allow_roles("admin")`. "Versión
  actual" siempre viene de `APP_VERSION` (env var horneada en la imagen vía
  `ARG` del Dockerfile, no de una variable de Compose que se pueda
  desincronizar), nunca de lo que reporta `updater`.
- `docker-compose.yml`: `api`/`web`/`updater` tienen `image:
  ...:latest` (lo que trae `docker compose pull`) **y** `build:` (para
  seguir pudiendo compilar en local con `docker compose up -d --build`
  igual que antes). No pongas una versión fija en ese `image:`; el pin de
  versión vive dentro de la imagen, no en el tag que se pull-ea.
- Frontend: `src/UpdatesPanel.tsx`, pestaña dentro de `AdminPanel.tsx`
  (admin-only, reutiliza las clases CSS existentes, no añade `.css` nuevo).
  Hace polling tolerante a errores de red mientras la API se reinicia.

Al tocar este flujo: cualquier servicio nuevo que quieras que se
auto-actualice necesita (a) su propia imagen construida en el workflow,
(b) un `image:` en docker-compose.yml apuntando a `:latest` en GHCR. El
contenedor desplegador usa `docker:27-cli` (trae el plugin `compose`); si
cambias esa imagen base, verifica que siga incluyendo `docker compose`.

## Cosas que saber / deuda conocida

- `LegacyCitationView` en `App.tsx` y la rama `view === 'Citaciones'` dentro
  de `OtherView` son **código muerto** (la vista vigente es
  `CitationsView.tsx`). No construir sobre ellas.
- El contador fijo `<span className="nav-count">4</span>` del sidebar y parte
  del dashboard de respaldo en `OtherView` usan datos de ejemplo.
- `backend-restart.*.log` en la raíz son restos de operación, no código.
- Un solo test (`test_school_workflow`) cubre el flujo completo con SQLite en
  memoria y Telegram simulado con `monkeypatch`. Al añadir funcionalidades,
  extender este patrón.
- No exponer la API ni Postgres a Internet; el diseño asume LAN con firewall.

## Qué NO hacer

- No introducir DELETE físico ni "limpiar" registros inactivos.
- No poner la cédula (ni datos personales) dentro del QR ni en mensajes
  Telegram.
- No añadir rutas sin `allow_roles(...)` ni olvidar el re-chequeo de secciones
  cuando el rol `teacher` escribe.
- No cambiar el esquema sin actualizar `ensure_schema()` (o sin plan de
  migración si hay datos reales).
- No devolver listados sin paginar ni superar `page_size=100`.
- No publicar un `ports:` para `updater` ni exponerlo fuera de la red
  interna de Compose: tiene el socket de Docker montado.
- No hagas que `updater` dependa del estado en memoria del propio proceso
  de la API para saber si un despliegue está en curso; siempre consulta el
  contenedor desplegador real vía Docker, porque ese proceso puede morir y
  reiniciarse a mitad de una actualización.
