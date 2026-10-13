import os

import httpx
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Citation, Guardian, MessageLog, Report


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


async def send_citation_alert(citation_id: int) -> None:
    with SessionLocal() as db:
        citation = db.get(Citation, citation_id)
        if citation is None:
            return
        guardian = citation.guardian
        scheduled = citation.scheduled_at.strftime("%d/%m/%Y %H:%M")
        message = f"Obra del Buen Consejo: tiene una citación escolar el {scheduled}. Ingrese al portal institucional para consultar los detalles."
        log = MessageLog(guardian_id=guardian.id, body=message, status="queued")
        db.add(log)
        token = os.getenv("TELEGRAM_BOT_TOKEN", "")
        if not token or not guardian.telegram_chat_id:
            log.status = "unavailable"
        else:
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    response = await client.post(
                        f"https://api.telegram.org/bot{token}/sendMessage",
                        json={"chat_id": guardian.telegram_chat_id, "text": message},
                    )
                    response.raise_for_status()
                log.status = "sent"
            except httpx.HTTPError:
                log.status = "failed"
        db.commit()
