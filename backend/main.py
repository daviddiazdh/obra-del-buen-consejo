import os
import re
import unicodedata
import hmac
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo

import httpx
import pandas as pd
from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt
from sqlalchemy import delete, func, inspect as sa_inspect, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

project_root = Path(__file__).resolve().parent.parent
load_dotenv(project_root / ".env")
load_dotenv(project_root / ".env.local")

from database import Base, SessionLocal, engine, get_db
from models import Citation, Guardian, MessageLog, Report, Section, SectionSubject, Student, Subject, TeacherSection, User
from notifications import TelegramConfigurationError, send_citation_alert, send_report_alert, send_telegram_text, telegram_bot_username
from schemas import CitationCreate, CitationStatus, CitationUpdate, GuardianCreate, GuardianUpdate, LoginRequest, PasswordChange, ReportCreate, ReportOut, ReportUpdate, SectionCreate, SectionUpdate, StudentCreate, StudentOut, StudentUpdate, SubjectCreate, SubjectUpdate, TeacherAssignment, TokenResponse, UserCreate, UserUpdate
from security import allow_roles, create_access_token, hash_password, verify_password


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_schema()
    username = os.getenv("BOOTSTRAP_USER", "")
    password = os.getenv("BOOTSTRAP_PASSWORD", "")
    if username and password:
        with SessionLocal() as db:
            if db.scalar(select(User).where(User.username == username)) is None:
                db.add(User(username=username, full_name=os.getenv("BOOTSTRAP_NAME", "Administrador"), password_hash=hash_password(password), role="admin"))
                db.commit()
    yield


app = FastAPI(
    title="Obra del Buen Consejo · API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "").split(",") if os.getenv("CORS_ORIGINS") else [],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Authorization", "Content-Type"],
)
Db = Annotated[Session, Depends(get_db)]
APP_VERSION = os.getenv("APP_VERSION", "dev")
UPDATER_URL = os.getenv("UPDATER_URL", "http://updater:8090")


def page_payload(items: list, total: int, page: int, page_size: int) -> dict:
    return {"items": items, "page": page, "page_size": page_size, "total": total, "pages": (total + page_size - 1) // page_size}


def paged_rows(db: Session, query, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    rows = db.scalars(query.offset((page - 1) * page_size).limit(page_size)).unique().all()
    return rows, total


def ensure_schema() -> None:
    Base.metadata.create_all(bind=engine)
    compatibility_columns = {
        "users": {"guardian_id": "INTEGER"},
        "sections": {"active": "BOOLEAN NOT NULL DEFAULT TRUE"},
        "subjects": {"active": "BOOLEAN NOT NULL DEFAULT TRUE"},
        "guardians": {"active": "BOOLEAN NOT NULL DEFAULT TRUE", "telegram_linked_at": "TIMESTAMP WITH TIME ZONE"},
        "reports": {"active": "BOOLEAN NOT NULL DEFAULT TRUE", "action_taken": "TEXT"},
        "citations": {
            "guardian_confirmed": "BOOLEAN NOT NULL DEFAULT FALSE",
            "telegram_status": "VARCHAR(20) NOT NULL DEFAULT 'NOT_SENT'",
            "telegram_sent_at": "TIMESTAMP WITH TIME ZONE",
            "telegram_error_log": "TEXT",
        },
    }
    inspector = sa_inspect(engine)
    with engine.begin() as connection:
        for table, columns in compatibility_columns.items():
            existing = {column["name"] for column in inspector.get_columns(table)}
            for name, definition in columns.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))
    with SessionLocal() as db:
        legacy_links = db.execute(
            select(TeacherSection.section_id, TeacherSection.subject_id)
            .where(TeacherSection.subject_id.is_not(None))
        ).all()
        for section_id, subject_id in legacy_links:
            if db.get(SectionSubject, (section_id, subject_id)) is None:
                db.add(SectionSubject(section_id=section_id, subject_id=subject_id))
        db.commit()


def replace_section_subjects(db: Session, section_id: int, subject_ids: list[int]) -> None:
    if len(set(subject_ids)) != len(subject_ids):
        raise HTTPException(status_code=422, detail="No repitas materias en el curso")
    subjects = db.scalars(select(Subject).where(Subject.id.in_(subject_ids), Subject.active.is_(True))).all() if subject_ids else []
    if len(subjects) != len(subject_ids):
        raise HTTPException(status_code=404, detail="Una o más materias no existen o están inactivas")
    db.execute(delete(SectionSubject).where(SectionSubject.section_id == section_id))
    assignments = delete(TeacherSection).where(
        TeacherSection.section_id == section_id,
        TeacherSection.subject_id.is_not(None),
    )
    if subject_ids:
        assignments = assignments.where(TeacherSection.subject_id.not_in(subject_ids))
    db.execute(assignments)
    db.add_all(SectionSubject(section_id=section_id, subject_id=subject.id) for subject in subjects)


def normalize_header(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")


def field(row: dict, *names: str) -> str:
    for name in names:
        value = row.get(name)
        if pd.notna(value) and str(value).strip():
            return str(value).strip()
    return ""


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/webhooks/telegram")
def telegram_webhook(
    payload: dict,
    background_tasks: BackgroundTasks,
    db: Db,
    secret_header: str | None = Header(default=None, alias="X-Telegram-Bot-Api-Secret-Token"),
):
    webhook_secret = os.getenv("TELEGRAM_WEBHOOK_SECRET", "")
    if not webhook_secret or not secret_header or not hmac.compare_digest(secret_header, webhook_secret):
        raise HTTPException(status_code=403, detail="Webhook no autorizado")
    message = payload.get("message") or payload.get("edited_message") or {}
    text_value = str(message.get("text", ""))
    chat_id = (message.get("chat") or {}).get("id")
    command = text_value.split(maxsplit=1)
    if chat_id is None or not command or command[0].split("@", 1)[0] != "/start":
        return {"ok": True}
    link_token = command[1].strip() if len(command) == 2 else ""
    guardian = db.scalar(select(Guardian).where(Guardian.telegram_link_token == link_token)) if link_token else None
    if guardian is None:
        background_tasks.add_task(send_telegram_text, chat_id, "Enlace no válido. Solicita uno nuevo al colegio.")
        return {"ok": True}
    guardian.telegram_chat_id = str(chat_id)
    guardian.telegram_linked_at = datetime.now(timezone.utc)
    guardian.telegram_link_token = os.urandom(24).hex()
    db.commit()
    background_tasks.add_task(send_telegram_text, chat_id, f"¡Hola {guardian.full_name}! Tu cuenta ha sido vinculada exitosamente con {os.getenv('INSTITUTION_NAME', 'Obra del Buen Consejo')} para recibir notificaciones.")
    return {"ok": True}


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Db):
    user = db.scalar(select(User).where(User.username == payload.username))
    if user is None or not user.active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    return TokenResponse(access_token=create_access_token(user), role=user.role, full_name=user.full_name)


@app.post("/api/users", status_code=201)
def create_user(payload: UserCreate, db: Db, _: User = Depends(allow_roles("admin"))):
    if payload.role == "guardian" and (payload.guardian_id is None or db.get(Guardian, payload.guardian_id) is None):
        raise HTTPException(status_code=422, detail="Las cuentas de representante deben vincularse a un representante existente")
    if payload.role != "guardian" and payload.guardian_id is not None:
        raise HTTPException(status_code=422, detail="guardian_id solo se permite en cuentas de representantes")
    if db.scalar(select(User.id).where(User.username == payload.username)):
        raise HTTPException(status_code=409, detail="El usuario ya existe")
    user = User(username=payload.username, full_name=payload.full_name, password_hash=hash_password(payload.password), role=payload.role, guardian_id=payload.guardian_id)
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username, "full_name": user.full_name, "role": user.role}


@app.get("/api/users")
def list_users(
    db: Db,
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    include_inactive: bool = False,
    _: User = Depends(allow_roles("admin")),
):
    query = select(User).order_by(User.full_name)
    if not include_inactive:
        query = query.where(User.active.is_(True))
    if q.strip():
        term = f"%{q.strip()}%"
        query = query.where(or_(User.username.ilike(term), User.full_name.ilike(term), User.role.ilike(term)))
    users, total = paged_rows(db, query, page, page_size)
    return page_payload([{"id": user.id, "username": user.username, "full_name": user.full_name, "role": user.role, "active": user.active, "guardian_id": user.guardian_id} for user in users], total, page, page_size)


@app.patch("/api/users/{user_id}")
def update_user(user_id: int, payload: UserUpdate, db: Db, _: User = Depends(allow_roles("admin"))):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Cuenta no encontrada")
    values = payload.model_dump(exclude_unset=True)
    password = values.pop("password", None)
    if values.get("username") and db.scalar(select(User.id).where(User.username == values["username"], User.id != user_id)):
        raise HTTPException(status_code=409, detail="El nombre de usuario ya está en uso")
    next_role = values.get("role", user.role)
    guardian_id = values.get("guardian_id", user.guardian_id)
    if next_role == "guardian" and (guardian_id is None or db.get(Guardian, guardian_id) is None):
        raise HTTPException(status_code=422, detail="Vincula la cuenta a un representante existente")
    if next_role != "guardian":
        values["guardian_id"] = None
    for key, value in values.items():
        setattr(user, key, value)
    if next_role != "teacher":
        db.execute(delete(TeacherSection).where(TeacherSection.teacher_id == user.id))
    if password:
        user.password_hash = hash_password(password)
    db.commit()
    return {"id": user.id, "username": user.username, "full_name": user.full_name, "role": user.role, "active": user.active, "guardian_id": user.guardian_id}


@app.delete("/api/users/{user_id}", status_code=204)
def deactivate_user(user_id: int, db: Db, current: User = Depends(allow_roles("admin"))):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Cuenta no encontrada")
    if user.id == current.id:
        raise HTTPException(status_code=409, detail="No puedes desactivar tu propia cuenta")
    user.active = False
    if user.role == "teacher":
        db.execute(delete(TeacherSection).where(TeacherSection.teacher_id == user.id))
    db.commit()


@app.get("/api/sections")
def list_sections(
    db: Db,
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    include_inactive: bool = False,
    _: User = Depends(allow_roles("admin", "coordinator")),
):
    query = select(Section).order_by(Section.year_level, Section.name)
    if not include_inactive:
        query = query.where(Section.active.is_(True))
    if q.strip():
        term = f"%{q.strip()}%"
        query = query.where(Section.name.ilike(term))
    sections, total = paged_rows(db, query, page, page_size)
    return page_payload([section_view(db, section) for section in sections], total, page, page_size)


def section_view(db: Session, section: Section) -> dict:
    assignment = db.scalar(select(TeacherSection).where(TeacherSection.section_id == section.id, TeacherSection.subject_id.is_(None)))
    teacher = db.get(User, assignment.teacher_id) if assignment else None
    if teacher is not None and not teacher.active:
        teacher = None
    subjects = db.scalars(
        select(Subject)
        .join(SectionSubject, SectionSubject.subject_id == Subject.id)
        .where(SectionSubject.section_id == section.id, Subject.active.is_(True))
        .order_by(Subject.name)
    ).all()
    return {"id": section.id, "year_level": section.year_level, "name": section.name, "active": section.active, "teacher_id": teacher.id if teacher else None, "teacher_name": teacher.full_name if teacher else None, "subject_ids": [subject.id for subject in subjects], "subject_names": [subject.name for subject in subjects]}


@app.post("/api/sections", status_code=201)
def create_section(payload: SectionCreate, db: Db, _: User = Depends(allow_roles("admin"))):
    name = payload.name.strip().upper()
    if not name:
        raise HTTPException(status_code=422, detail="El nombre de la sección es obligatorio")
    teacher = db.get(User, payload.teacher_id) if payload.teacher_id is not None else None
    if payload.teacher_id is not None and (teacher is None or teacher.role != "teacher" or not teacher.active):
        raise HTTPException(status_code=404, detail="Profesor activo no encontrado")
    section = Section(year_level=payload.year_level, name=name)
    db.add(section)
    try:
        db.flush()
        replace_section_subjects(db, section.id, payload.subject_ids)
        if teacher:
            db.add(TeacherSection(teacher_id=teacher.id, section_id=section.id))
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Ese curso y sección ya están registrados") from exc
    db.refresh(section)
    return section_view(db, section)


@app.patch("/api/sections/{section_id}")
def update_section(section_id: int, payload: SectionUpdate, db: Db, _: User = Depends(allow_roles("admin"))):
    section = db.get(Section, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail="Curso no encontrado")
    values = payload.model_dump(exclude_unset=True)
    teacher_id = values.pop("teacher_id", ...)
    subject_ids = values.pop("subject_ids", ...)
    if "name" in values:
        values["name"] = values["name"].strip().upper()
        if not values["name"]:
            raise HTTPException(status_code=422, detail="El nombre de la sección es obligatorio")
    if db.scalar(select(Section.id).where(Section.year_level == values.get("year_level", section.year_level), Section.name == values.get("name", section.name), Section.id != section_id)):
        raise HTTPException(status_code=409, detail="Ese curso y sección ya están registrados")
    teacher = None
    if teacher_id is not ... and teacher_id is not None:
        teacher = db.get(User, teacher_id)
        if teacher is None or teacher.role != "teacher" or not teacher.active:
            raise HTTPException(status_code=404, detail="Profesor activo no encontrado")
    for key, value in values.items():
        setattr(section, key, value)
    if subject_ids is not ... and subject_ids is not None:
        replace_section_subjects(db, section.id, subject_ids)
    if teacher_id is not ...:
        db.execute(delete(TeacherSection).where(TeacherSection.section_id == section.id, TeacherSection.subject_id.is_(None)))
        if teacher:
            db.add(TeacherSection(teacher_id=teacher.id, section_id=section.id))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="No se pudo actualizar el curso") from exc
    return section_view(db, section)


@app.delete("/api/sections/{section_id}", status_code=204)
def deactivate_section(section_id: int, db: Db, _: User = Depends(allow_roles("admin"))):
    section = db.get(Section, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail="Curso no encontrado")
    section.active = False
    db.commit()


@app.get("/api/guardians")
def list_guardians(
    db: Db,
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    include_inactive: bool = False,
    _: User = Depends(allow_roles("admin", "coordinator")),
):
    query = select(Guardian).order_by(Guardian.full_name)
    if not include_inactive:
        query = query.where(Guardian.active.is_(True))
    if q.strip():
        term = f"%{q.strip()}%"
        query = query.where(or_(Guardian.full_name.ilike(term), Guardian.document_id.ilike(term), Guardian.phone.ilike(term), Guardian.email.ilike(term)))
    query = query.options(joinedload(Guardian.students))
    guardians, total = paged_rows(db, query, page, page_size)
    items = [{"id": guardian.id, "full_name": guardian.full_name, "document_id": guardian.document_id, "phone": guardian.phone, "email": guardian.email, "active": guardian.active, "telegram_linked": bool(guardian.telegram_chat_id), "student_ids": [student.id for student in guardian.students], "student_names": ", ".join(f"{student.first_name} {student.last_name}" for student in guardian.students)} for guardian in guardians]
    return page_payload(items, total, page, page_size)


@app.post("/api/guardians", status_code=201)
def create_guardian(payload: GuardianCreate, db: Db, _: User = Depends(allow_roles("admin"))):
    if len(set(payload.student_ids)) != len(payload.student_ids):
        raise HTTPException(status_code=422, detail="No repitas estudiantes en la vinculación")
    if db.scalar(select(Guardian.id).where(Guardian.document_id == payload.document_id)):
        raise HTTPException(status_code=409, detail="Ya existe un representante con ese documento")
    students = db.scalars(select(Student).where(Student.id.in_(payload.student_ids), Student.active.is_(True))).all() if payload.student_ids else []
    if len(students) != len(payload.student_ids):
        raise HTTPException(status_code=404, detail="Uno o más estudiantes no existen o están inactivos")
    guardian = Guardian(full_name=payload.full_name.strip(), document_id=payload.document_id.strip(), phone=payload.phone, email=payload.email, students=students)
    db.add(guardian)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="No se pudo registrar: documento duplicado") from exc
    db.refresh(guardian)
    return {"id": guardian.id, "full_name": guardian.full_name, "document_id": guardian.document_id, "linked_students": len(students)}


@app.patch("/api/guardians/{guardian_id}")
def update_guardian(guardian_id: int, payload: GuardianUpdate, db: Db, _: User = Depends(allow_roles("admin"))):
    guardian = db.get(Guardian, guardian_id)
    if guardian is None:
        raise HTTPException(status_code=404, detail="Representante no encontrado")
    values = payload.model_dump(exclude_unset=True)
    student_ids = values.pop("student_ids", ...)
    if values.get("document_id") and db.scalar(select(Guardian.id).where(Guardian.document_id == values["document_id"], Guardian.id != guardian_id)):
        raise HTTPException(status_code=409, detail="Ese documento ya pertenece a otro representante")
    if student_ids is not ...:
        if len(set(student_ids)) != len(student_ids):
            raise HTTPException(status_code=422, detail="No repitas estudiantes en la vinculación")
        students = db.scalars(select(Student).where(Student.id.in_(student_ids), Student.active.is_(True))).all() if student_ids else []
        if len(students) != len(student_ids):
            raise HTTPException(status_code=404, detail="Uno o más estudiantes no existen o están inactivos")
        guardian.students = students
    for key, value in values.items():
        setattr(guardian, key, value.strip() if isinstance(value, str) else value)
    if values.get("active") is False:
        db.query(User).filter(User.guardian_id == guardian.id).update({User.active: False})
    db.commit()
    return {"id": guardian.id, "full_name": guardian.full_name, "document_id": guardian.document_id, "phone": guardian.phone, "email": guardian.email, "active": guardian.active, "student_names": ", ".join(f"{student.first_name} {student.last_name}" for student in guardian.students)}


@app.delete("/api/guardians/{guardian_id}", status_code=204)
def deactivate_guardian(guardian_id: int, db: Db, _: User = Depends(allow_roles("admin"))):
    guardian = db.get(Guardian, guardian_id)
    if guardian is None:
        raise HTTPException(status_code=404, detail="Representante no encontrado")
    guardian.active = False
    db.query(User).filter(User.guardian_id == guardian.id).update({User.active: False})
    db.commit()


@app.get("/api/subjects")
def list_subjects(db: Db, q: str = "", page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), include_inactive: bool = False, section_id: int | None = None, _: User = Depends(allow_roles("admin", "coordinator"))):
    query = select(Subject).order_by(Subject.name)
    if section_id is not None:
        query = query.join(SectionSubject, SectionSubject.subject_id == Subject.id).where(SectionSubject.section_id == section_id)
    if not include_inactive:
        query = query.where(Subject.active.is_(True))
    if q.strip():
        query = query.where(Subject.name.ilike(f"%{q.strip()}%"))
    subjects, total = paged_rows(db, query, page, page_size)
    return page_payload([{"id": subject.id, "name": subject.name, "active": subject.active} for subject in subjects], total, page, page_size)


@app.post("/api/subjects", status_code=201)
def create_subject(payload: SubjectCreate, db: Db, _: User = Depends(allow_roles("admin"))):
    subject = Subject(name=payload.name.strip())
    db.add(subject)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="La materia ya está registrada") from exc
    db.refresh(subject)
    return {"id": subject.id, "name": subject.name, "active": subject.active}


@app.patch("/api/subjects/{subject_id}")
def update_subject(subject_id: int, payload: SubjectUpdate, db: Db, _: User = Depends(allow_roles("admin"))):
    subject = db.get(Subject, subject_id)
    if subject is None:
        raise HTTPException(status_code=404, detail="Materia no encontrada")
    values = payload.model_dump(exclude_unset=True)
    if values.get("name"):
        values["name"] = values["name"].strip()
        if db.scalar(select(Subject.id).where(Subject.name == values["name"], Subject.id != subject_id)):
            raise HTTPException(status_code=409, detail="La materia ya existe")
    for key, value in values.items():
        setattr(subject, key, value)
    db.commit()
    return {"id": subject.id, "name": subject.name, "active": subject.active}


@app.delete("/api/subjects/{subject_id}", status_code=204)
def deactivate_subject(subject_id: int, db: Db, _: User = Depends(allow_roles("admin"))):
    subject = db.get(Subject, subject_id)
    if subject is None:
        raise HTTPException(status_code=404, detail="Materia no encontrada")
    subject.active = False
    db.commit()


@app.post("/api/teachers/{teacher_id}/sections", status_code=201)
def assign_teacher_section(teacher_id: int, payload: TeacherAssignment, db: Db, _: User = Depends(allow_roles("admin"))):
    teacher = db.get(User, teacher_id)
    if teacher is None or teacher.role != "teacher":
        raise HTTPException(status_code=404, detail="Profesor no encontrado")
    assigned_section = db.get(Section, payload.section_id)
    if assigned_section is None or not assigned_section.active:
        raise HTTPException(status_code=404, detail="Sección no encontrada o inactiva")
    subject = db.get(Subject, payload.subject_id) if payload.subject_id is not None else None
    if payload.subject_id is not None and (subject is None or not subject.active):
        raise HTTPException(status_code=404, detail="Materia no encontrada")
    assignment = TeacherSection(teacher_id=teacher.id, section_id=payload.section_id, subject_id=payload.subject_id)
    db.add(assignment)
    if payload.subject_id is not None and db.get(SectionSubject, (payload.section_id, payload.subject_id)) is None:
        db.add(SectionSubject(section_id=payload.section_id, subject_id=payload.subject_id))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="La asignación ya existe") from exc
    return {"teacher_id": teacher.id, "section_id": payload.section_id, "subject_id": payload.subject_id}


@app.get("/api/auth/me")
def who_am_i(user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher", "doorman", "guardian"))]):
    return {"id": user.id, "username": user.username, "full_name": user.full_name, "role": user.role}


@app.post("/api/auth/password")
def change_password(payload: PasswordChange, db: Db, user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher", "doorman", "guardian"))]):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="La contraseña actual no coincide")
    user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"message": "Contraseña actualizada"}


@app.get("/api/students")
def list_students(
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher", "doorman"))],
    q: str = "",
    section_id: int | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    include_inactive: bool = False,
):
    query = select(Student).options(joinedload(Student.section), joinedload(Student.guardians)).order_by(Student.last_name, Student.first_name)
    if not include_inactive:
        query = query.where(Student.active.is_(True))
    if section_id is not None:
        query = query.where(Student.section_id == section_id)
    if q.strip():
        term = f"%{q.strip()}%"
        query = query.where(or_(Student.first_name.ilike(term), Student.last_name.ilike(term), Student.document_id.ilike(term)))
    if user.role == "teacher":
        assigned = select(TeacherSection.section_id).where(TeacherSection.teacher_id == user.id)
        query = query.where(Student.section_id.in_(assigned))
    students, total = paged_rows(db, query, page, page_size)
    items = [{
        **StudentOut(id=s.id, first_name=s.first_name, last_name=s.last_name, document_id=s.document_id, qr_token=s.qr_token, section_name=f"{s.section.year_level}° {s.section.name}").model_dump(),
        "active": s.active,
        "section_id": s.section_id,
        "guardian_ids": [guardian.id for guardian in s.guardians],
        "guardians": [{"id": guardian.id, "full_name": guardian.full_name, "document_id": guardian.document_id, "active": guardian.active} for guardian in s.guardians],
    } for s in students]
    return page_payload(items, total, page, page_size)


@app.post("/api/students", response_model=StudentOut, status_code=201)
def create_student(payload: StudentCreate, db: Db, _: User = Depends(allow_roles("admin"))):
    if len(set(payload.guardian_ids)) != len(payload.guardian_ids):
        raise HTTPException(status_code=422, detail="No repitas representantes")
    section = db.get(Section, payload.section_id)
    if section is None or not section.active:
        raise HTTPException(status_code=404, detail="La sección seleccionada no existe o está inactiva")
    if db.scalar(select(Student.id).where(Student.document_id == payload.document_id)):
        raise HTTPException(status_code=409, detail="Ya existe un estudiante con ese documento")
    guardians = db.scalars(select(Guardian).where(Guardian.id.in_(payload.guardian_ids), Guardian.active.is_(True))).all() if payload.guardian_ids else []
    if len(guardians) != len(payload.guardian_ids):
        raise HTTPException(status_code=404, detail="Uno o más representantes no existen")
    student = Student(first_name=payload.first_name.strip(), last_name=payload.last_name.strip(), document_id=payload.document_id.strip(), section=section, guardians=guardians)
    db.add(student)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="No se pudo registrar: documento duplicado") from exc
    db.refresh(student)
    return StudentOut(id=student.id, first_name=student.first_name, last_name=student.last_name, document_id=student.document_id, qr_token=student.qr_token, section_name=f"{section.year_level}° {section.name}")


@app.get("/api/students/qr/{qr_token}", response_model=StudentOut)
def student_by_qr(qr_token: str, db: Db, user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher"))]):
    student = db.scalar(select(Student).options(joinedload(Student.section)).where(Student.qr_token == qr_token, Student.active.is_(True)))
    if student is None:
        raise HTTPException(status_code=404, detail="Código QR no registrado")
    if user.role == "teacher":
        assigned = db.scalar(select(TeacherSection.id).where(TeacherSection.teacher_id == user.id, TeacherSection.section_id == student.section_id))
        if assigned is None:
            raise HTTPException(status_code=403, detail="El alumno no pertenece a tus secciones")
    return StudentOut(id=student.id, first_name=student.first_name, last_name=student.last_name, document_id=student.document_id, qr_token=student.qr_token, section_name=f"{student.section.year_level}° {student.section.name}")


@app.patch("/api/students/{student_id}")
def update_student(student_id: int, payload: StudentUpdate, db: Db, _: User = Depends(allow_roles("admin"))):
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=404, detail="Estudiante no encontrado")
    values = payload.model_dump(exclude_unset=True)
    guardian_ids = values.pop("guardian_ids", ...)
    if values.get("document_id") and db.scalar(select(Student.id).where(Student.document_id == values["document_id"], Student.id != student_id)):
        raise HTTPException(status_code=409, detail="Ese documento ya pertenece a otro estudiante")
    if "section_id" in values:
        section = db.get(Section, values["section_id"])
        if section is None or not section.active:
            raise HTTPException(status_code=404, detail="El curso seleccionado no existe o está inactivo")
    if guardian_ids is not ...:
        if len(set(guardian_ids)) != len(guardian_ids):
            raise HTTPException(status_code=422, detail="No repitas representantes")
        guardians = db.scalars(select(Guardian).where(Guardian.id.in_(guardian_ids), Guardian.active.is_(True))).all() if guardian_ids else []
        if len(guardians) != len(guardian_ids):
            raise HTTPException(status_code=404, detail="Uno o más representantes no existen o están inactivos")
        student.guardians = guardians
    for key, value in values.items():
        setattr(student, key, value.strip() if isinstance(value, str) else value)
    db.commit()
    db.refresh(student)
    return {"id": student.id, "first_name": student.first_name, "last_name": student.last_name, "document_id": student.document_id, "section_name": f"{student.section.year_level}° {student.section.name}", "active": student.active}


@app.delete("/api/students/{student_id}", status_code=204)
def deactivate_student(student_id: int, db: Db, _: User = Depends(allow_roles("admin"))):
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=404, detail="Estudiante no encontrado")
    student.active = False
    db.commit()


@app.post("/api/reports", response_model=ReportOut, status_code=201)
def create_report(
    payload: ReportCreate,
    background_tasks: BackgroundTasks,
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher"))],
):
    if len(set(payload.student_ids)) != len(payload.student_ids):
        raise HTTPException(status_code=422, detail="No repitas estudiantes en el mismo reporte")
    students = db.scalars(select(Student).where(Student.id.in_(payload.student_ids), Student.active.is_(True))).all()
    if len(students) != len(payload.student_ids):
        raise HTTPException(status_code=404, detail="Uno o más estudiantes no existen o están inactivos")
    if user.role == "teacher":
        assigned = set(db.scalars(select(TeacherSection.section_id).where(TeacherSection.teacher_id == user.id)).all())
        if any(student.section_id not in assigned for student in students):
            raise HTTPException(status_code=403, detail="Solo puedes reportar estudiantes de tus secciones asignadas")
    occurred_at = payload.occurred_at
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    report = Report(
        created_by=user.id,
        severity=payload.severity.value,
        description=payload.description.strip(),
        action_taken=payload.action_taken,
        subject=payload.subject,
        location=payload.location,
        occurred_at=occurred_at,
        students=students,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    background_tasks.add_task(send_report_alert, report.id)
    return ReportOut(id=report.id, severity=report.severity, description=report.description, action_taken=report.action_taken, occurred_at=report.occurred_at, student_ids=[s.id for s in students])


@app.get("/api/reports")
def list_reports(
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher"))],
    q: str = "",
    student_id: int | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    include_inactive: bool = False,
):
    query = select(Report).options(joinedload(Report.students)).order_by(Report.created_at.desc())
    if not include_inactive or user.role == "teacher":
        query = query.where(Report.active.is_(True))
    if student_id is not None:
        query = query.join(Report.students).where(Student.id == student_id)
    if q.strip():
        term = f"%{q.strip()}%"
        query = query.where(or_(
            Report.description.ilike(term),
            Report.subject.ilike(term),
            Report.location.ilike(term),
            Report.students.any(or_(Student.first_name.ilike(term), Student.last_name.ilike(term), Student.document_id.ilike(term))),
        ))
    if user.role == "teacher":
        assigned = select(TeacherSection.section_id).where(TeacherSection.teacher_id == user.id)
        query = query.join(Report.students).where(Student.section_id.in_(assigned)).distinct()
    reports, total = paged_rows(db, query, page, page_size)
    items = [{
        **ReportOut(id=r.id, severity=r.severity, description=r.description, action_taken=r.action_taken, occurred_at=r.occurred_at, student_ids=[s.id for s in r.students]).model_dump(),
        "created_at": r.created_at,
        "subject": r.subject,
        "location": r.location,
        "active": r.active,
        "student_names": ", ".join(f"{student.first_name} {student.last_name}" for student in r.students),
        "student_documents": ", ".join(student.document_id for student in r.students),
        "students": [{"id": student.id, "full_name": f"{student.first_name} {student.last_name}", "document_id": student.document_id, "section_name": f"{student.section.year_level}° {student.section.name}"} for student in r.students],
    } for r in reports]
    return page_payload(items, total, page, page_size)


@app.patch("/api/reports/{report_id}")
def update_report(
    report_id: int,
    payload: ReportUpdate,
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher"))],
):
    report = db.scalar(select(Report).options(joinedload(Report.students)).where(Report.id == report_id, Report.active.is_(True)))
    if report is None:
        raise HTTPException(status_code=404, detail="Reporte no encontrado")
    if user.role == "teacher":
        assigned = set(db.scalars(select(TeacherSection.section_id).where(TeacherSection.teacher_id == user.id)).all())
        if any(student.section_id not in assigned for student in report.students):
            raise HTTPException(status_code=403, detail="No puedes editar reportes fuera de tus secciones")
    values = payload.model_dump(exclude_unset=True)
    student_ids = values.pop("student_ids", ...)
    if student_ids is not ...:
        if len(set(student_ids)) != len(student_ids):
            raise HTTPException(status_code=422, detail="No repitas estudiantes en el reporte")
        students = db.scalars(select(Student).where(Student.id.in_(student_ids), Student.active.is_(True))).all()
        if len(students) != len(student_ids):
            raise HTTPException(status_code=404, detail="Uno o más estudiantes no existen o están inactivos")
        if user.role == "teacher" and any(student.section_id not in assigned for student in students):
            raise HTTPException(status_code=403, detail="No puedes añadir alumnos fuera de tus secciones")
        report.students = students
    if "severity" in values and values["severity"] is not None:
        values["severity"] = values["severity"].value
    for key, value in values.items():
        setattr(report, key, value.strip() if isinstance(value, str) else value)
    db.commit()
    db.refresh(report)
    return ReportOut(id=report.id, severity=report.severity, description=report.description, action_taken=report.action_taken, occurred_at=report.occurred_at, student_ids=[student.id for student in report.students])


@app.delete("/api/reports/{report_id}", status_code=204)
def deactivate_report(report_id: int, db: Db, user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher"))]):
    report = db.scalar(select(Report).options(joinedload(Report.students)).where(Report.id == report_id, Report.active.is_(True)))
    if report is None:
        raise HTTPException(status_code=404, detail="Reporte no encontrado")
    if user.role == "teacher":
        assigned = set(db.scalars(select(TeacherSection.section_id).where(TeacherSection.teacher_id == user.id)).all())
        if any(student.section_id not in assigned for student in report.students):
            raise HTTPException(status_code=403, detail="No puedes eliminar reportes fuera de tus secciones")
    report.active = False
    db.commit()


@app.post("/api/import/students")
async def import_students(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: User = Depends(allow_roles("admin")),
):
    suffix = (file.filename or "").lower().rsplit(".", 1)[-1]
    if suffix not in {"xlsx", "csv"}:
        raise HTTPException(status_code=415, detail="Usa un archivo .xlsx o .csv")
    contents = await file.read()
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="El archivo supera el límite de 10 MB")
    try:
        from io import BytesIO, StringIO
        if suffix == "xlsx":
            frame = pd.read_excel(BytesIO(contents), dtype=str, engine="openpyxl")
        else:
            frame = pd.read_csv(StringIO(contents.decode("utf-8-sig")), dtype=str)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo leer el archivo: {exc}") from exc
    frame.columns = [normalize_header(column) for column in frame.columns]
    required = {"nombres", "apellidos", "documento", "anio", "seccion"}
    if missing := required - set(frame.columns):
        raise HTTPException(status_code=422, detail={"message": "Faltan columnas requeridas", "columns": sorted(missing)})

    records = frame.fillna("").to_dict(orient="records")
    errors: list[str] = []
    clean_rows: list[dict[str, str | int]] = []
    seen_documents: set[str] = set()
    for index, row in enumerate(records, start=2):
        document = field(row, "documento", "cedula", "identificacion")
        first_name = field(row, "nombres", "nombre")
        last_name = field(row, "apellidos", "apellido")
        year_text = field(row, "anio", "ano", "year")
        section_name = field(row, "seccion", "seccion_nombre", "paralelo")
        match = re.search(r"[1-5]", year_text)
        year_level = int(match.group()) if match else 0
        if not all((document, first_name, last_name, section_name)) or year_level not in range(1, 6):
            errors.append(f"Fila {index}: nombres, apellidos, documento, año (1 a 5) y sección son obligatorios.")
            continue
        if document in seen_documents:
            errors.append(f"Fila {index}: documento duplicado dentro del archivo ({document}).")
            continue
        if db.scalar(select(Student.id).where(Student.document_id == document)):
            errors.append(f"Fila {index}: el documento {document} ya está registrado.")
            continue
        seen_documents.add(document)
        clean_rows.append({
            "document": document, "first_name": first_name, "last_name": last_name,
            "year": year_level, "section": section_name,
            "guardian_name": field(row, "representante", "nombre_representante", "representante_nombre"),
            "guardian_document": field(row, "documento_representante", "cedula_representante"),
            "phone": field(row, "telefono", "telefono_representante"),
            "email": field(row, "correo", "email", "correo_representante"),
        })
    if errors:
        raise HTTPException(status_code=422, detail={"message": "No se importó ningún registro", "rows": errors[:50], "total_errors": len(errors)})
    if not clean_rows:
        raise HTTPException(status_code=422, detail="El archivo no contiene estudiantes")

    created_guardians: dict[str, Guardian] = {}
    try:
        for row in clean_rows:
            section = db.scalar(select(Section).where(Section.year_level == row["year"], Section.name == row["section"]))
            if section is None:
                section = Section(year_level=row["year"], name=row["section"])
                db.add(section)
                db.flush()
            student = Student(first_name=row["first_name"], last_name=row["last_name"], document_id=row["document"], section_id=section.id)
            db.add(student)
            guardian_document = str(row["guardian_document"])
            guardian_name = str(row["guardian_name"])
            if guardian_document and guardian_name:
                guardian = created_guardians.get(guardian_document) or db.scalar(select(Guardian).where(Guardian.document_id == guardian_document))
                if guardian is None:
                    guardian = Guardian(full_name=guardian_name, document_id=guardian_document, phone=row["phone"] or None, email=row["email"] or None)
                    db.add(guardian)
                    db.flush()
                created_guardians[guardian_document] = guardian
                student.guardians.append(guardian)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Se detectó un dato duplicado. No se importó ningún registro.") from exc
    return {"created_students": len(clean_rows), "created_or_linked_guardians": len(created_guardians), "message": "Importación completada"}


@app.post("/api/citations", status_code=201)
async def create_citation(
    payload: CitationCreate,
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator"))],
):
    guardian = db.get(Guardian, payload.guardian_id)
    if guardian is None:
        raise HTTPException(status_code=404, detail="Representante no encontrado")
    if payload.report_id and db.get(Report, payload.report_id) is None:
        raise HTTPException(status_code=404, detail="Reporte no encontrado")
    school_tz = ZoneInfo(os.getenv("SCHOOL_TIMEZONE", "America/Caracas"))
    scheduled_at = payload.scheduled_at
    if scheduled_at.tzinfo is None:
        scheduled_at = scheduled_at.replace(tzinfo=school_tz)
    if scheduled_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="La citación debe programarse para una fecha futura")
    scheduled_at = scheduled_at.astimezone(timezone.utc)
    slot_start = scheduled_at.replace(minute=0, second=0, microsecond=0)
    slot_end = slot_start + timedelta(hours=1)
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:slot_key)"), {"slot_key": int(slot_start.timestamp())})
    capacity = int(os.getenv("CITATION_CAPACITY_PER_HOUR", "3"))
    occupied = db.scalar(select(func.count(Citation.id)).where(Citation.status == "pending", Citation.scheduled_at >= slot_start, Citation.scheduled_at < slot_end)) or 0
    if occupied >= capacity:
        raise HTTPException(status_code=409, detail="Ese bloque horario alcanzó el máximo de citaciones")
    duplicate = db.scalar(select(Citation.id).where(Citation.guardian_id == guardian.id, Citation.status == "pending", Citation.scheduled_at >= slot_start, Citation.scheduled_at < slot_end))
    if duplicate:
        raise HTTPException(status_code=409, detail="Este representante ya tiene una citación pendiente en ese horario")
    citation = Citation(guardian_id=guardian.id, report_id=payload.report_id, scheduled_at=scheduled_at, reason=payload.reason, created_by=user.id)
    db.add(citation)
    db.commit()
    db.refresh(citation)
    if payload.notify_telegram:
        await send_citation_alert(citation.id)
        db.refresh(citation)
    return citation_view(citation)


def citation_view(citation: Citation) -> dict:
    guardian = citation.guardian
    students = citation.report.students if citation.report is not None else guardian.students
    names = ", ".join(sorted({f"{student.first_name} {student.last_name}" for student in students}))
    documents = ", ".join(sorted({student.document_id for student in students}))
    return {
        "id": citation.id,
        "guardian_id": guardian.id,
        "guardian_name": guardian.full_name,
        "guardian_document": guardian.document_id,
        "guardian_telegram_linked": bool(guardian.telegram_chat_id),
        "student_names": names,
        "student_documents": documents,
        "scheduled_at": citation.scheduled_at,
        "reason": citation.reason,
        "status": citation.status,
        "guardian_confirmed": citation.guardian_confirmed,
        "telegram_status": citation.telegram_status,
        "telegram_sent_at": citation.telegram_sent_at.replace(tzinfo=timezone.utc) if citation.telegram_sent_at and citation.telegram_sent_at.tzinfo is None else citation.telegram_sent_at,
        "telegram_error_log": citation.telegram_error_log,
    }


@app.get("/api/citations")
def list_citations(
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "doorman"))],
    day: date | None = None,
    q: str = "",
    guardian_id: int | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    school_tz = ZoneInfo(os.getenv("SCHOOL_TIMEZONE", "America/Caracas"))
    query = select(Citation).options(joinedload(Citation.guardian).joinedload(Guardian.students), joinedload(Citation.report).joinedload(Report.students)).order_by(Citation.scheduled_at.desc())
    if day is not None:
        from_date = day
        to_date = day
    if from_date is not None:
        start = datetime.combine(from_date, time.min, tzinfo=school_tz).astimezone(timezone.utc)
        query = query.where(Citation.scheduled_at >= start)
    if to_date is not None:
        end = datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=school_tz).astimezone(timezone.utc)
        query = query.where(Citation.scheduled_at < end)
    if guardian_id is not None:
        query = query.where(Citation.guardian_id == guardian_id)
    if q.strip():
        term = f"%{q.strip()}%"
        query = query.join(Citation.guardian).outerjoin(Guardian.students).where(or_(Guardian.full_name.ilike(term), Guardian.document_id.ilike(term), Student.first_name.ilike(term), Student.last_name.ilike(term), Student.document_id.ilike(term))).distinct()
    citations, total = paged_rows(db, query, page, page_size)
    return page_payload([citation_view(item) for item in citations], total, page, page_size)


@app.get("/api/guardians/{guardian_id}/citations")
def guardian_citations(guardian_id: int, db: Db, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), _: User = Depends(allow_roles("admin", "coordinator", "doorman"))):
    if db.get(Guardian, guardian_id) is None:
        raise HTTPException(status_code=404, detail="Representante no encontrado")
    query = select(Citation).options(joinedload(Citation.guardian).joinedload(Guardian.students), joinedload(Citation.report).joinedload(Report.students)).where(Citation.guardian_id == guardian_id).order_by(Citation.scheduled_at.desc())
    citations, total = paged_rows(db, query, page, page_size)
    return page_payload([citation_view(item) for item in citations], total, page, page_size)


@app.post("/api/citations/{citation_id}/send-telegram")
async def send_citation_telegram(citation_id: int, db: Db, _: User = Depends(allow_roles("admin", "coordinator"))):
    citation = db.get(Citation, citation_id)
    if citation is None:
        raise HTTPException(status_code=404, detail="Citación no encontrada")
    if citation.status == "cancelled":
        raise HTTPException(status_code=409, detail="No se pueden enviar citaciones canceladas")
    await send_citation_alert(citation_id)
    db.refresh(citation)
    return citation_view(citation)


@app.patch("/api/citations/{citation_id}")
def update_citation(citation_id: int, payload: CitationUpdate, db: Db, user: Annotated[User, Depends(allow_roles("admin", "coordinator"))]):
    citation = db.get(Citation, citation_id)
    if citation is None or citation.status == "cancelled":
        raise HTTPException(status_code=404, detail="Citación no encontrada")
    values = payload.model_dump(exclude_unset=True)
    guardian_id = values.get("guardian_id", citation.guardian_id)
    guardian = db.get(Guardian, guardian_id)
    if guardian is None or not guardian.active:
        raise HTTPException(status_code=404, detail="Representante activo no encontrado")
    scheduled_at = values.get("scheduled_at", citation.scheduled_at)
    school_tz = ZoneInfo(os.getenv("SCHOOL_TIMEZONE", "America/Caracas"))
    if scheduled_at.tzinfo is None:
        scheduled_at = scheduled_at.replace(tzinfo=school_tz)
    if scheduled_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="La citación debe quedar programada para una fecha futura")
    scheduled_at = scheduled_at.astimezone(timezone.utc)
    slot_start = scheduled_at.replace(minute=0, second=0, microsecond=0)
    slot_end = slot_start + timedelta(hours=1)
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:slot_key)"), {"slot_key": int(slot_start.timestamp())})
    capacity = int(os.getenv("CITATION_CAPACITY_PER_HOUR", "3"))
    occupied_query = select(func.count(Citation.id)).where(Citation.status == "pending", Citation.id != citation_id, Citation.scheduled_at >= slot_start, Citation.scheduled_at < slot_end)
    occupied = db.scalar(occupied_query) or 0
    if occupied >= capacity:
        raise HTTPException(status_code=409, detail="Ese bloque horario alcanzó el máximo de citaciones")
    duplicate = db.scalar(select(Citation.id).where(Citation.id != citation_id, Citation.guardian_id == guardian_id, Citation.status == "pending", Citation.scheduled_at >= slot_start, Citation.scheduled_at < slot_end))
    if duplicate:
        raise HTTPException(status_code=409, detail="El representante ya tiene una cita pendiente en ese horario")
    updated_reason = values.get("reason")
    if updated_reason is None:
        updated_reason = citation.reason
    notification_changed = guardian_id != citation.guardian_id or scheduled_at != citation.scheduled_at or updated_reason.strip() != citation.reason
    citation.guardian_id = guardian_id
    citation.scheduled_at = scheduled_at
    if "reason" in values and values["reason"] is not None:
        citation.reason = updated_reason.strip()
    if notification_changed:
        citation.telegram_status = "NOT_SENT"
        citation.telegram_sent_at = None
        citation.telegram_error_log = None
    db.commit()
    db.refresh(citation)
    return citation_view(citation)


@app.delete("/api/citations/{citation_id}", status_code=204)
def cancel_citation(citation_id: int, db: Db, _: User = Depends(allow_roles("admin", "coordinator"))):
    citation = db.get(Citation, citation_id)
    if citation is None:
        raise HTTPException(status_code=404, detail="Citación no encontrada")
    citation.status = "cancelled"
    db.commit()


@app.patch("/api/citations/{citation_id}/status")
def update_citation_status(
    citation_id: int,
    payload: CitationStatus,
    db: Db,
    _: User = Depends(allow_roles("admin", "coordinator", "doorman")),
):
    citation = db.get(Citation, citation_id)
    if citation is None:
        raise HTTPException(status_code=404, detail="Citación no encontrada")
    citation.status = payload.status
    citation.attended_at = datetime.now(timezone.utc) if payload.status == "attended" else None
    db.commit()
    return citation_view(citation)


@app.get("/api/guardians/{guardian_id}/telegram-link")
async def telegram_link(guardian_id: int, db: Db, _: User = Depends(allow_roles("admin", "coordinator"))):
    guardian = db.get(Guardian, guardian_id)
    if guardian is None:
        raise HTTPException(status_code=404, detail="Representante no encontrado")
    try:
        bot_username = await telegram_bot_username()
    except TelegramConfigurationError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if not bot_username:
        raise HTTPException(status_code=503, detail="TELEGRAM_BOT_TOKEN no está configurado")
    return {"url": f"https://t.me/{bot_username}?start={guardian.telegram_link_token}"}


@app.get("/api/messages")
def list_messages(
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "guardian"))],
    guardian_id: int | None = None,
):
    if user.role == "guardian":
        guardian_id = user.guardian_id
    if guardian_id is None:
        raise HTTPException(status_code=422, detail="Indica el representante que deseas consultar")
    messages = db.scalars(select(MessageLog).where(MessageLog.guardian_id == guardian_id).order_by(MessageLog.created_at.desc()).limit(100)).all()
    return [{"id": item.id, "channel": item.channel, "body": item.body, "status": item.status, "created_at": item.created_at} for item in messages]


@app.get("/api/students/{student_id}/summary")
def student_summary(
    student_id: int,
    db: Db,
    user: Annotated[User, Depends(allow_roles("admin", "coordinator", "teacher"))],
):
    student = db.scalar(select(Student).options(joinedload(Student.section), joinedload(Student.guardians)).where(Student.id == student_id))
    if student is None:
        raise HTTPException(status_code=404, detail="Estudiante no encontrado")
    if user.role == "teacher":
        assigned = set(db.scalars(select(TeacherSection.section_id).where(TeacherSection.teacher_id == user.id)).all())
        if student.section_id not in assigned:
            raise HTTPException(status_code=403, detail="No tienes acceso a esta sección")
    reports = sorted((report for report in student.reports if report.active), key=lambda item: item.occurred_at, reverse=True)
    citations = db.scalars(select(Citation).where(Citation.guardian_id.in_([g.id for g in student.guardians])).order_by(Citation.scheduled_at.desc()).limit(30)).all() if student.guardians else []
    return {
        "student": {"id": student.id, "first_name": student.first_name, "last_name": student.last_name, "document_id": student.document_id, "qr_token": student.qr_token, "section": f"{student.section.year_level}° {student.section.name}"},
        "severity_counts": {severity: sum(report.severity == severity for report in reports) for severity in ("leve", "grave", "muy_grave")},
        "reports": [{"id": report.id, "severity": report.severity, "description": report.description, "action_taken": report.action_taken, "occurred_at": report.occurred_at, "created_at": report.created_at, "location": report.location, "subject": report.subject, "student_ids": [item.id for item in report.students]} for report in reports],
        "guardians": [{"id": guardian.id, "full_name": guardian.full_name, "document_id": guardian.document_id, "phone": guardian.phone, "email": guardian.email} for guardian in student.guardians],
        "citations": [citation_view(item) for item in citations],
    }


@app.get("/api/guardian/summary")
async def guardian_summary(db: Db, user: Annotated[User, Depends(allow_roles("guardian"))]):
    if user.guardian_id is None:
        raise HTTPException(status_code=404, detail="La cuenta no está vinculada a un representante")
    guardian = db.scalar(select(Guardian).options(joinedload(Guardian.students).joinedload(Student.section)).where(Guardian.id == user.guardian_id))
    if guardian is None or not guardian.active:
        raise HTTPException(status_code=404, detail="Representante no encontrado")
    report_items = []
    for student in guardian.students:
        for report in student.reports:
            report_items.append({"student_name": f"{student.first_name} {student.last_name}", "severity": report.severity, "description": report.description, "action_taken": report.action_taken, "occurred_at": report.occurred_at})
    report_items.sort(key=lambda item: item["occurred_at"], reverse=True)
    citations = db.scalars(select(Citation).where(Citation.guardian_id == guardian.id).order_by(Citation.scheduled_at.desc()).limit(30)).all()
    messages = db.scalars(select(MessageLog).where(MessageLog.guardian_id == guardian.id).order_by(MessageLog.created_at.desc()).limit(50)).all()
    telegram_url = None
    telegram_error = None
    if not guardian.telegram_chat_id:
        try:
            bot_username = await telegram_bot_username()
            if bot_username:
                telegram_url = f"https://t.me/{bot_username}?start={guardian.telegram_link_token}"
        except TelegramConfigurationError as error:
            telegram_error = str(error)
        if not os.getenv("TELEGRAM_BOT_TOKEN", "").strip() and not telegram_error:
            telegram_error = "Vinculación por Telegram pendiente de configurar: falta TELEGRAM_BOT_TOKEN."
    return {
        "guardian": {
            "full_name": guardian.full_name,
            "telegram_linked": bool(guardian.telegram_chat_id),
            "telegram_url": telegram_url,
            "telegram_error": telegram_error,
        },
        "students": [{"id": student.id, "first_name": student.first_name, "last_name": student.last_name, "section": f"{student.section.year_level}° {student.section.name}"} for student in guardian.students],
        "reports": report_items[:100],
        "citations": [citation_view(item) for item in citations],
        "messages": [{"id": item.id, "body": item.body, "status": item.status, "created_at": item.created_at} for item in messages],
    }


@app.patch("/api/guardian/citations/{citation_id}/confirm")
def confirm_guardian_citation(
    citation_id: int,
    db: Db,
    user: Annotated[User, Depends(allow_roles("guardian"))],
):
    citation = db.get(Citation, citation_id)
    if citation is None or citation.guardian_id != user.guardian_id:
        raise HTTPException(status_code=404, detail="Citación no encontrada")
    citation.guardian_confirmed = True
    db.commit()
    return {"id": citation.id, "guardian_confirmed": citation.guardian_confirmed}


# --- Actualizaciones (CD) ---------------------------------------------------
# El servicio "updater" no tiene autenticación propia: solo es alcanzable
# desde este contenedor por la red interna de Docker Compose. Estas tres
# rutas son el único punto de entrada, y quedan restringidas a admin igual
# que el resto de Administración.

async def _updater_request(method: str, path: str, **kwargs) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.request(method, f"{UPDATER_URL}{path}", **kwargs)
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            raise HTTPException(status_code=response.status_code, detail=detail)
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="El servicio de actualizaciones no está disponible en este servidor.") from exc


@app.get("/api/system/version")
async def system_version(_: User = Depends(allow_roles("admin"))):
    info = await _updater_request("GET", "/version", params={"current": APP_VERSION})
    return {**info, "current": APP_VERSION}


@app.post("/api/system/update")
async def system_update(_: User = Depends(allow_roles("admin"))):
    info = await _updater_request("GET", "/version", params={"current": APP_VERSION})
    if not info.get("update_available"):
        raise HTTPException(status_code=409, detail="No hay una actualización disponible.")
    return await _updater_request("POST", "/update", json={"target_version": info["latest"]})


@app.get("/api/system/update/status")
async def system_update_status(_: User = Depends(allow_roles("admin"))):
    return await _updater_request("GET", "/update/status")
