import asyncio
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from sqlalchemy import select

project_root = Path(__file__).resolve().parent.parent
load_dotenv(project_root / ".env")
load_dotenv(project_root / ".env.local")

from database import SessionLocal
from models import Guardian

logging.basicConfig(level=logging.INFO)
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat is None or update.message is None:
        return
    link_token = context.args[0] if context.args else ""
    if not link_token:
        await update.message.reply_text("Para vincular tu cuenta, solicita tu código al colegio y abre el enlace personal de vinculación.")
        return
    with SessionLocal() as db:
        guardian = db.scalar(select(Guardian).where(Guardian.telegram_link_token == link_token))
        if guardian is None:
            await update.message.reply_text("El enlace no es válido o ya fue utilizado. Solicita uno nuevo al colegio.")
            return
        guardian.telegram_chat_id = str(update.effective_chat.id)
        guardian.telegram_linked_at = datetime.now(timezone.utc)
        guardian.telegram_link_token = os.urandom(24).hex()
        guardian_name = guardian.full_name
        db.commit()
    institution = os.getenv("INSTITUTION_NAME", "Obra del Buen Consejo")
    await update.message.reply_text(f"¡Hola {guardian_name}! Tu cuenta ha sido vinculada exitosamente con {institution} para recibir notificaciones.")


async def run_bot() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("Configura TELEGRAM_BOT_TOKEN antes de iniciar el bot.")
    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    await application.initialize()
    await application.start()
    await application.updater.start_polling(allowed_updates=Update.ALL_TYPES)
    try:
        await asyncio.Event().wait()
    finally:
        await application.updater.stop()
        await application.stop()
        await application.shutdown()


if __name__ == "__main__":
    asyncio.run(run_bot())
