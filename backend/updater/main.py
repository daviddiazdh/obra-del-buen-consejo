"""Servicio interno de actualización (CD).

No se expone a la red del colegio: solo es alcanzable desde el contenedor
`api` a través de la red interna de Docker Compose (nunca se publica un
`ports:` para este servicio). Su trabajo es:

1. Consultar periódicamente la última versión publicada (GitHub Releases)
   del repositorio del proyecto.
2. Reportar esa información cuando el backend principal la solicite.
3. Al recibir una orden de actualizar, lanzar un contenedor "desplegador"
   independiente (vía el socket de Docker) que hace `docker compose pull`
   seguido de `docker compose up -d`. Ese contenedor desplegador NO es
   gestionado por docker-compose, así que sigue vivo aunque este mismo
   servicio `updater` sea reemplazado a mitad de la actualización (es
   justamente uno de los contenedores que una nueva versión puede traer).

Nada aquí requiere autenticación propia: la autorización (solo rol admin)
la aplica el backend principal antes de llamar a este servicio.
"""

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import docker
import httpx
from docker.errors import DockerException
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("updater")

GITHUB_REPO = os.getenv("GITHUB_REPO", "").strip()
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "").strip()
CHECK_INTERVAL_MINUTES = float(os.getenv("CHECK_INTERVAL_MINUTES", "30"))
HOST_PROJECT_DIR = os.getenv("HOST_PROJECT_DIR", "").strip()
COMPOSE_FILE = os.getenv("COMPOSE_FILE", "docker-compose.yml")
DEPLOYER_IMAGE = os.getenv("DEPLOYER_IMAGE", "docker:27-cli")
DEPLOYER_LABEL_KEY = "obc.updater.role"
DEPLOYER_LABEL_VALUE = "deployer"

app = FastAPI(title="Obra del Buen Consejo · Updater interno")

# Estado en memoria del último chequeo a GitHub. No necesita persistir:
# si este proceso se reinicia, vuelve a consultar GitHub en el arranque.
_release_cache: dict[str, Any] = {
    "latest": None,
    "published_at": None,
    "release_notes": None,
    "release_url": None,
    "checked_at": None,
    "check_error": None,
}
_cache_lock = asyncio.Lock()


def _docker_client() -> docker.DockerClient:
    try:
        return docker.from_env()
    except DockerException as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo hablar con Docker: {exc}") from exc


async def _fetch_latest_release() -> dict[str, Any]:
    if not GITHUB_REPO:
        return {**_release_cache, "check_error": "GITHUB_REPO no está configurado en el servidor."}
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url, headers=headers)
        if response.status_code == 404:
            error = "No se encontró ninguna versión publicada (releases) en el repositorio, o GITHUB_TOKEN no tiene acceso."
            return {**_release_cache, "check_error": error, "checked_at": datetime.now(timezone.utc).isoformat()}
        if response.status_code == 401:
            error = "GitHub rechazó el token configurado (GITHUB_TOKEN)."
            return {**_release_cache, "check_error": error, "checked_at": datetime.now(timezone.utc).isoformat()}
        response.raise_for_status()
        payload = response.json()
        return {
            "latest": payload.get("tag_name"),
            "published_at": payload.get("published_at"),
            "release_notes": (payload.get("body") or "").strip()[:4000],
            "release_url": payload.get("html_url"),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "check_error": None,
        }
    except httpx.HTTPError as exc:
        return {**_release_cache, "check_error": f"No se pudo consultar GitHub: {exc}", "checked_at": datetime.now(timezone.utc).isoformat()}


async def _refresh_cache() -> None:
    result = await _fetch_latest_release()
    async with _cache_lock:
        _release_cache.update(result)
    if result.get("check_error"):
        logger.warning("Chequeo de versión con errores: %s", result["check_error"])
    else:
        logger.info("Última versión publicada detectada: %s", result.get("latest"))


async def _periodic_check() -> None:
    while True:
        await _refresh_cache()
        await asyncio.sleep(max(60.0, CHECK_INTERVAL_MINUTES * 60))


@app.on_event("startup")
async def on_startup() -> None:
    asyncio.create_task(_periodic_check())


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/version")
async def version(current: str = "") -> dict:
    stale = _release_cache["checked_at"] is None
    if stale:
        await _refresh_cache()
    latest = _release_cache.get("latest")
    update_available = bool(latest) and bool(current) and latest != current
    return {**_release_cache, "update_available": update_available}


def _find_deployer_containers(client: docker.DockerClient) -> list:
    containers = client.containers.list(all=True, filters={"label": f"{DEPLOYER_LABEL_KEY}={DEPLOYER_LABEL_VALUE}"})
    return sorted(containers, key=lambda c: c.attrs["Created"], reverse=True)


class UpdateRequest(BaseModel):
    target_version: str


@app.post("/update", status_code=202)
def start_update(payload: UpdateRequest) -> dict:
    if not HOST_PROJECT_DIR:
        raise HTTPException(status_code=500, detail="HOST_PROJECT_DIR no está configurado en el servidor; no se puede desplegar.")
    client = _docker_client()
    existing = _find_deployer_containers(client)
    if existing and existing[0].status == "running":
        raise HTTPException(status_code=409, detail="Ya hay una actualización en curso.")
    # Limpia desplegadores anteriores ya terminados para no acumular contenedores.
    for container in existing:
        if container.status != "running":
            container.remove(force=True)

    name = f"obc-deploy-{int(time.time())}"
    command = [
        "sh",
        "-c",
        f"docker compose -f {COMPOSE_FILE} pull && docker compose -f {COMPOSE_FILE} up -d --remove-orphans",
    ]
    # El proyecto se monta en la MISMA ruta que tiene en el host. Docker
    # Compose convierte las rutas relativas del docker-compose.yml (por
    # ejemplo ./deploy/certs) en absolutas usando el directorio de trabajo,
    # y esas rutas absolutas las interpreta el daemon del HOST. Si el
    # proyecto se montara en otra ruta (p. ej. /stack), los bind mounts
    # apuntarían a carpetas inexistentes en el host.
    # En Windows con Docker Desktop, HOST_PROJECT_DIR debe venir con la forma
    # que ve el daemon: /run/desktop/mnt/host/c/... (el instalador la escribe).
    try:
        client.containers.run(
            image=DEPLOYER_IMAGE,
            command=command,
            name=name,
            working_dir=HOST_PROJECT_DIR,
            volumes={
                "/var/run/docker.sock": {"bind": "/var/run/docker.sock", "mode": "rw"},
                HOST_PROJECT_DIR: {"bind": HOST_PROJECT_DIR, "mode": "rw"},
            },
            labels={DEPLOYER_LABEL_KEY: DEPLOYER_LABEL_VALUE, "obc.updater.target_version": payload.target_version},
            detach=True,
            auto_remove=False,
        )
    except DockerException as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo iniciar el despliegue: {exc}") from exc
    return {"status": "started", "target_version": payload.target_version}


@app.get("/update/status")
def update_status() -> dict:
    client = _docker_client()
    containers = _find_deployer_containers(client)
    if not containers:
        return {"running": False, "log": "", "success": None, "target_version": None, "finished_at": None}
    container = containers[0]
    container.reload()
    target_version = container.labels.get("obc.updater.target_version")
    log_text = container.logs(tail=400).decode("utf-8", errors="replace")
    if container.status == "running":
        return {"running": True, "log": log_text, "success": None, "target_version": target_version, "finished_at": None}
    exit_code = container.attrs.get("State", {}).get("ExitCode")
    finished_at = container.attrs.get("State", {}).get("FinishedAt")
    return {
        "running": False,
        "log": log_text,
        "success": exit_code == 0,
        "target_version": target_version,
        "finished_at": finished_at,
    }


@app.get("/")
def root() -> dict:
    return {"service": "obra-del-buen-consejo-updater"}
