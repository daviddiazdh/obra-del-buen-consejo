import secrets
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(20), index=True)
    guardian_id: Mapped[int | None] = mapped_column(ForeignKey("guardians.id", ondelete="SET NULL"), unique=True, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Section(Base):
    __tablename__ = "sections"
    __table_args__ = (UniqueConstraint("year_level", "name", name="uq_section_year_name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    year_level: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(20))
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    students: Mapped[list["Student"]] = relationship(back_populates="section")


class Subject(Base):
    __tablename__ = "subjects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class TeacherSection(Base):
    __tablename__ = "teacher_sections"
    __table_args__ = (UniqueConstraint("teacher_id", "section_id", "subject_id", name="uq_teacher_section_subject"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    teacher_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id", ondelete="CASCADE"), index=True)
    subject_id: Mapped[int | None] = mapped_column(ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True)


class Guardian(Base):
    __tablename__ = "guardians"
    id: Mapped[int] = mapped_column(primary_key=True)
    full_name: Mapped[str] = mapped_column(String(160))
    document_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    telegram_chat_id: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True)
    telegram_link_token: Mapped[str] = mapped_column(String(64), default=lambda: secrets.token_urlsafe(24), unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    students: Mapped[list["Student"]] = relationship(secondary="student_guardians", back_populates="guardians")


class StudentGuardian(Base):
    __tablename__ = "student_guardians"
    __table_args__ = (UniqueConstraint("student_id", "guardian_id", name="uq_student_guardian"),)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"), primary_key=True)
    guardian_id: Mapped[int] = mapped_column(ForeignKey("guardians.id", ondelete="CASCADE"), primary_key=True)
    relationship_type: Mapped[str] = mapped_column(String(40), default="representante")


class Student(Base):
    __tablename__ = "students"
    id: Mapped[int] = mapped_column(primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    document_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    qr_token: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: secrets.token_urlsafe(24))
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id", ondelete="RESTRICT"), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    section: Mapped[Section] = relationship(back_populates="students")
    guardians: Mapped[list[Guardian]] = relationship(secondary="student_guardians", back_populates="students")
    reports: Mapped[list["Report"]] = relationship(secondary="report_students", back_populates="students")


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    severity: Mapped[str] = mapped_column(String(20), index=True)
    description: Mapped[str] = mapped_column(Text)
    action_taken: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject: Mapped[str | None] = mapped_column(String(100), nullable=True)
    location: Mapped[str | None] = mapped_column(String(120), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    students: Mapped[list[Student]] = relationship(secondary="report_students", back_populates="reports")


class ReportStudent(Base):
    __tablename__ = "report_students"
    __table_args__ = (UniqueConstraint("report_id", "student_id", name="uq_report_student"),)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"), primary_key=True)
    action_taken: Mapped[str | None] = mapped_column(Text, nullable=True)


class Citation(Base):
    __tablename__ = "citations"
    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int | None] = mapped_column(ForeignKey("reports.id", ondelete="SET NULL"), nullable=True, index=True)
    guardian_id: Mapped[int] = mapped_column(ForeignKey("guardians.id", ondelete="RESTRICT"), index=True)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    guardian_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    attended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    guardian: Mapped[Guardian] = relationship()


class MessageLog(Base):
    __tablename__ = "message_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    guardian_id: Mapped[int] = mapped_column(ForeignKey("guardians.id", ondelete="RESTRICT"), index=True)
    report_id: Mapped[int | None] = mapped_column(ForeignKey("reports.id", ondelete="SET NULL"), nullable=True)
    channel: Mapped[str] = mapped_column(String(20), default="telegram")
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
