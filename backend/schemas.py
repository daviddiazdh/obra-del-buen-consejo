from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Severity(str, Enum):
    leve = "leve"
    grave = "grave"
    muy_grave = "muy_grave"


class LoginRequest(BaseModel):
    username: str
    password: str


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    full_name: str = Field(min_length=3, max_length=160)
    password: str = Field(min_length=12, max_length=200)
    role: Literal["admin", "coordinator", "teacher", "doorman", "guardian"]
    guardian_id: int | None = None


class UserUpdate(BaseModel):
    username: str | None = Field(default=None, min_length=3, max_length=80)
    full_name: str | None = Field(default=None, min_length=3, max_length=160)
    password: str | None = Field(default=None, min_length=12, max_length=200)
    role: Literal["admin", "coordinator", "teacher", "doorman", "guardian"] | None = None
    guardian_id: int | None = None
    active: bool | None = None


class GuardianCreate(BaseModel):
    full_name: str = Field(min_length=3, max_length=160)
    document_id: str = Field(min_length=3, max_length=32)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=254)
    student_ids: list[int] = Field(default_factory=list, max_length=100)

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str) -> str:
        value = value.strip()
        if not value.isascii() or not value.isdigit() or not 3 <= len(value) <= 32:
            raise ValueError("El documento debe contener entre 3 y 32 dígitos")
        return value


class GuardianUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=3, max_length=160)
    document_id: str | None = Field(default=None, min_length=3, max_length=32)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=254)
    student_ids: list[int] | None = Field(default=None, max_length=100)
    active: bool | None = None

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value.isascii() or not value.isdigit() or not 3 <= len(value) <= 32:
            raise ValueError("El documento debe contener entre 3 y 32 dígitos")
        return value


class StudentCreate(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    document_id: str = Field(min_length=3, max_length=32)
    section_id: int
    guardian_ids: list[int] = Field(default_factory=list, max_length=20)

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str) -> str:
        value = value.strip()
        if not value.isascii() or not value.isdigit() or not 3 <= len(value) <= 32:
            raise ValueError("El documento debe contener entre 3 y 32 dígitos")
        return value


class StudentUpdate(BaseModel):
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    document_id: str | None = Field(default=None, min_length=3, max_length=32)
    section_id: int | None = None
    guardian_ids: list[int] | None = Field(default=None, max_length=20)
    active: bool | None = None

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value.isascii() or not value.isdigit() or not 3 <= len(value) <= 32:
            raise ValueError("El documento debe contener entre 3 y 32 dígitos")
        return value


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=200)


class TeacherAssignment(BaseModel):
    section_id: int
    subject_id: int | None = None


class SubjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)


class SubjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    active: bool | None = None


class SectionCreate(BaseModel):
    year_level: int = Field(ge=1, le=5)
    name: str = Field(min_length=1, max_length=20)
    teacher_id: int | None = None
    subject_ids: list[int] = Field(default_factory=list, max_length=100)


class SectionUpdate(BaseModel):
    year_level: int | None = Field(default=None, ge=1, le=5)
    name: str | None = Field(default=None, min_length=1, max_length=20)
    teacher_id: int | None = None
    active: bool | None = None
    subject_ids: list[int] | None = Field(default=None, max_length=100)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    full_name: str


class StudentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    first_name: str
    last_name: str
    document_id: str
    qr_token: str
    section_name: str


class ReportCreate(BaseModel):
    severity: Severity
    description: str = Field(min_length=5, max_length=5000)
    action_taken: str | None = Field(default=None, max_length=5000)
    subject: str | None = Field(default=None, max_length=100)
    location: str | None = Field(default=None, max_length=120)
    occurred_at: datetime
    student_ids: list[int] = Field(min_length=1, max_length=100)


class ReportUpdate(BaseModel):
    severity: Severity | None = None
    description: str | None = Field(default=None, min_length=5, max_length=5000)
    action_taken: str | None = Field(default=None, max_length=5000)
    subject: str | None = Field(default=None, max_length=100)
    location: str | None = Field(default=None, max_length=120)
    occurred_at: datetime | None = None
    student_ids: list[int] | None = Field(default=None, min_length=1, max_length=100)


class ReportOut(BaseModel):
    id: int
    severity: str
    description: str
    action_taken: str | None = None
    occurred_at: datetime
    student_ids: list[int]


class CitationStatus(BaseModel):
    status: str = Field(pattern="^(pending|attended|no_show|cancelled)$")


class CitationCreate(BaseModel):
    guardian_id: int
    report_id: int | None = None
    scheduled_at: datetime
    reason: str = Field(min_length=3, max_length=2000)
    notify_telegram: bool = True


class CitationUpdate(BaseModel):
    guardian_id: int | None = None
    scheduled_at: datetime | None = None
    reason: str | None = Field(default=None, min_length=3, max_length=2000)
