from datetime import datetime, timezone
from html import escape
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

project_root = Path(__file__).resolve().parent.parent
load_dotenv(project_root / ".env")
load_dotenv(project_root / ".env.local")

from database import SessionLocal
from models import Citation, Guardian, MessageLog, Report

class TelegramConfigurationError(RuntimeError):
    pass


_cached_bot_token: str | None = None
_cached_bot_username: str | None = None


async def telegram_bot_username() -> str | None:
    global _cached_bot_token, _cached_bot_username
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return None
    configured_name = (os.getenv("TELEGRAM_BOT_USERNAME") or os.getenv("TELEGRAM_BOT_NAME", "")).strip().lstrip("@")
    if configured_name:
        return configured_name
    if _cached_bot_token == token and _cached_bot_username:
        return _cached_bot_username
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"https://api.telegram.org/bot{token}/getMe")
            response.raise_for_status()
            result = response.json()
        username = result.get("result", {}).get("username") if isinstance(result, dict) and result.get("ok") else None
        if not username:
            raise TelegramConfigurationError("Telegram no pudo identificar el bot. Verifica TELEGRAM_BOT_TOKEN.")
    except TelegramConfigurationError:
        raise
    except (httpx.HTTPError, ValueError) as error:
        raise TelegramConfigurationError("No se pudo validar TELEGRAM_BOT_TOKEN con Telegram.") from error
    _cached_bot_token = token
    _cached_bot_username = str(username)
    return _cached_bot_username


async def send_telegram_text(chat_id: int | str, message: str) -> None:
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        return
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={"chat_id": chat_id, "text": message},
            )
            response.raise_for_status()
    except httpx.HTTPError:
        return


async def send_report_alert(report_id: int) -> None:
    with SessionLocal() as db:
        report = db.get(Report, report_id)
        if report is None:
            return
        guardians = {guardian.id: guardian for student in report.students for guardian in student.guardians}
        bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
        for guardian in guardians.values():
            message = "Obra del Buen Consejo: hay una actualización en el expediente de su representado. Ingrese al portal institucional para consultar los detalles."
            log = MessageLog(guardian_id=guardian.id, report_id=report.id, body=message, status="queued")
            db.add(log)
            db.flush()
            if not bot_token or not guardian.telegram_chat_id:
                log.status = "unavailable"
                continue
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    response = await client.post(
                        f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={"chat_id": guardian.telegram_chat_id, "text": message},
                    )
                    response.raise_for_status()
                log.status = "sent"
            except httpx.HTTPError:
                log.status = "failed"
        db.commit()


async def send_citation_alert(citation_id: int) -> dict[str, str | None]:
    with SessionLocal() as db:
        citation = db.scalar(
            select(Citation)
            .options(
                joinedload(Citation.guardian).joinedload(Guardian.students),
                joinedload(Citation.report).joinedload(Report.students),
            )
            .where(Citation.id == citation_id)
        )
        if citation is None:
            return {"status": "FAILED", "error": "Citación no encontrada"}
        guardian = citation.guardian
        students = citation.report.students if citation.report is not None else guardian.students
        student_names = ", ".join(sorted({f"{student.first_name} {student.last_name}" for student in students})) or "No especificado"
        institution = os.getenv("INSTITUTION_NAME", "Obra del Buen Consejo")
        school_tz = ZoneInfo(os.getenv("SCHOOL_TIMEZONE", "America/Caracas"))
        scheduled = citation.scheduled_at
        if scheduled.tzinfo is None:
            scheduled = scheduled.replace(tzinfo=timezone.utc)
        local_scheduled = scheduled.astimezone(school_tz)
        date_text = local_scheduled.strftime("%d/%m/%Y")
        time_text = local_scheduled.strftime("%I:%M %p").lstrip("0")
        message = (
            f"🏛️ <b>{escape(institution)}</b>\n"
            "----------------------------------------\n"
            "📢 <b>CITACIÓN INSTITUCIONAL</b>\n\n"
            f"Estimado(a) <b>{escape(guardian.full_name)}</b>, le informamos que ha sido citado(a) "
            "para atender un asunto referente a su representado(a).\n\n"
            f"👤 <b>Estudiante:</b> {escape(student_names)}\n"
            f"📅 <b>Fecha:</b> {date_text}\n"
            f"⏰ <b>Hora:</b> {time_text}\n"
            f"📌 <b>Motivo:</b> {escape(citation.reason)}\n\n"
            "Por favor acuda puntualmente a las instalaciones de la institución.\n\n"
            "<i>Si tiene alguna duda o consulta, por favor comuníquese con la administración.</i>"
        )
        log = MessageLog(guardian_id=guardian.id, report_id=citation.report_id, body=message, status="queued")
        db.add(log)
        token = os.getenv("TELEGRAM_BOT_TOKEN", "")
        if not guardian.telegram_chat_id:
            citation.telegram_status = "NOT_LINKED"
            citation.telegram_sent_at = None
            citation.telegram_error_log = "El representante aún no ha vinculado su cuenta de Telegram"
            log.status = "unavailable"
            db.commit()
            return {"status": citation.telegram_status, "error": citation.telegram_error_log}
        if not token:
            citation.telegram_status = "FAILED"
            citation.telegram_sent_at = None
            citation.telegram_error_log = "TELEGRAM_BOT_TOKEN no está configurado"
            log.status = "failed"
        else:
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    response = await client.post(
                        f"https://api.telegram.org/bot{token}/sendMessage",
                        json={"chat_id": guardian.telegram_chat_id, "text": message, "parse_mode": "HTML"},
                    )
                    response.raise_for_status()
                    telegram_result = response.json()
                    if not isinstance(telegram_result, dict):
                        raise ValueError("Telegram devolvió una respuesta no válida")
                    if not telegram_result.get("ok"):
                        raise ValueError(str(telegram_result.get("description", "Telegram rechazó el mensaje")))
                citation.telegram_status = "SENT"
                citation.telegram_sent_at = datetime.now(timezone.utc)
                citation.telegram_error_log = None
                log.status = "sent"
                log.sent_at = citation.telegram_sent_at
            except (httpx.HTTPError, ValueError) as error:
                citation.telegram_status = "FAILED"
                citation.telegram_sent_at = None
                citation.telegram_error_log = str(error)[:2000] or "No se pudo enviar el mensaje por Telegram"
                log.status = "failed"
        db.commit()
        return {"status": citation.telegram_status, "error": citation.telegram_error_log}
