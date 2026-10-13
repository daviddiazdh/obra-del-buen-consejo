from datetime import datetime, timedelta
from io import BytesIO
import os
import tempfile
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
import pandas as pd
from sqlalchemy import select

database_file = os.path.join(tempfile.mkdtemp(prefix="obc-test-"), "school.db")
os.environ["DATABASE_URL"] = f"sqlite:///{database_file}"
os.environ["BOOTSTRAP_USER"] = "admin"
os.environ["BOOTSTRAP_PASSWORD"] = "test-admin-password"
os.environ["BOOTSTRAP_NAME"] = "Administrador de prueba"
os.environ["SECRET_KEY"] = "test-only-secret-key-never-use-in-production"
os.environ["SCHOOL_TIMEZONE"] = "America/Caracas"
os.environ["TELEGRAM_BOT_TOKEN"] = ""
os.environ["TELEGRAM_BOT_USERNAME"] = "school_test_bot"
os.environ["TELEGRAM_WEBHOOK_SECRET"] = "test-telegram-webhook-secret"
os.environ["CITATION_CAPACITY_PER_HOUR"] = "1"
from database import SessionLocal
from main import app
from models import Guardian


def test_school_workflow():
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/students").status_code == 401
        schema = client.get("/api/openapi.json")
        assert schema.status_code == 200
        assert "/api/reports" in schema.json()["paths"]

        login = client.post("/api/auth/login", json={"username": "admin", "password": "test-admin-password"})
        assert login.status_code == 200
        admin = {"Authorization": f"Bearer {login.json()['access_token']}"}
        accounts = client.get("/api/users?page=1&page_size=5", headers=admin)
        assert accounts.status_code == 200
        assert accounts.json()["items"][0]["username"] == "admin"

        invalid_roster = b"nombres,apellidos,documento,anio\nAna,Ejemplo,12345678,1\n"
        invalid_import = client.post("/api/import/students", headers=admin, files={"file": ("invalid.csv", invalid_roster, "text/csv")})
        assert invalid_import.status_code == 422

        roster = b"nombres,apellidos,documento,anio,seccion,representante,documento_representante,telefono,correo\nAna,Ejemplo,12345678,1,A,Maria Ejemplo,87654321,+584120000000,maria@example.org\n"
        imported = client.post("/api/import/students", headers=admin, files={"file": ("roster.csv", roster, "text/csv")})
        assert imported.status_code == 200, imported.text
        assert imported.json()["created_students"] == 1

        workbook = BytesIO()
        pd.DataFrame([{
            "nombres": "Bruno", "apellidos": "Ejemplo", "documento": "22334455", "anio": "1",
            "seccion": "A", "representante": "Maria Ejemplo", "documento_representante": "87654321",
        }]).to_excel(workbook, index=False)
        imported_xlsx = client.post("/api/import/students", headers=admin, files={"file": ("roster.xlsx", workbook.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
        assert imported_xlsx.status_code == 200, imported_xlsx.text
        assert imported_xlsx.json()["created_students"] == 1

        manual_guardian = client.post("/api/guardians", headers=admin, json={
            "full_name": "Carlos Manual", "document_id": "55667788", "phone": "+584120000001", "email": "carlos@example.org",
        })
        assert manual_guardian.status_code == 201, manual_guardian.text
        manual_section = client.post("/api/sections", headers=admin, json={"year_level": 2, "name": "B"})
        assert manual_section.status_code == 201, manual_section.text
        assert client.post("/api/sections", headers=admin, json={"year_level": 2, "name": "B"}).status_code == 409
        manual_student = client.post("/api/students", headers=admin, json={
            "first_name": "Lucía", "last_name": "Manual", "document_id": "99887766",
            "section_id": manual_section.json()["id"], "guardian_ids": [manual_guardian.json()["id"]],
        })
        assert manual_student.status_code == 201, manual_student.text
        assert manual_student.json()["section_name"] == "2° B"
        assert manual_student.json()["qr_token"]
        edited_student = client.patch(f"/api/students/{manual_student.json()['id']}", headers=admin, json={"last_name": "Actualizada"})
        assert edited_student.status_code == 200
        edited_guardian = client.patch(f"/api/guardians/{manual_guardian.json()['id']}", headers=admin, json={"phone": "+584120000009"})
        assert edited_guardian.status_code == 200
        assert edited_guardian.json()["phone"] == "+584120000009"
        for index in range(10):
            extra_student = client.post("/api/students", headers=admin, json={
                "first_name": f"Lote{index}", "last_name": "Prueba", "document_id": f"777700{index:02d}",
                "section_id": manual_section.json()["id"],
            })
            assert extra_student.status_code == 201, extra_student.text

        students_page = client.get("/api/students?page=1&page_size=100", headers=admin).json()
        students = students_page["items"]
        assert students_page["total"] == 13
        page_two = client.get("/api/students?page=2&page_size=5", headers=admin).json()
        assert page_two["page"] == 2
        assert len(page_two["items"]) == 5
        assert client.get("/api/students?page_size=101", headers=admin).status_code == 422
        assert len(students) == 13
        student = next(item for item in students if item["document_id"] == "12345678")
        assert student["qr_token"]
        assert student["section_name"] == "1° A"

        report = client.post("/api/reports", headers=admin, json={
            "severity": "grave",
            "description": "Incidente de prueba para validar el expediente.",
            "action_taken": "Conversación de seguimiento con orientación.",
            "subject": "Matemática",
            "location": "Aula 1A",
            "occurred_at": datetime.now(ZoneInfo("America/Caracas")).isoformat(),
            "student_ids": [student["id"]],
        })
        assert report.status_code == 201, report.text
        report_id = report.json()["id"]

        summary = client.get(f"/api/students/{student['id']}/summary", headers=admin)
        assert summary.status_code == 200, summary.text
        assert summary.json()["severity_counts"]["grave"] == 1
        assert summary.json()["reports"][0]["action_taken"] == "Conversación de seguimiento con orientación."
        assert summary.json()["guardians"][0]["full_name"] == "Maria Ejemplo"
        edited_report = client.patch(f"/api/reports/{report_id}", headers=admin, json={"description": "Descripción corregida por coordinación."})
        assert edited_report.status_code == 200, edited_report.text
        assert edited_report.json()["description"] == "Descripción corregida por coordinación."

        with SessionLocal() as db:
            guardian = db.scalar(select(Guardian).where(Guardian.document_id == "87654321"))
            assert guardian is not None
            guardian_id = guardian.id

        teacher_response = client.post("/api/users", headers=admin, json={
            "username": "teacher-test", "full_name": "Profesor Prueba", "password": "teacher-test-password", "role": "teacher",
        })
        assert teacher_response.status_code == 201, teacher_response.text
        teacher_login = client.post("/api/auth/login", json={"username": "teacher-test", "password": "teacher-test-password"}).json()
        teacher = {"Authorization": f"Bearer {teacher_login['access_token']}"}
        assert client.get("/api/users", headers=teacher).status_code == 403
        assert client.post("/api/sections", headers=teacher, json={"year_level": 3, "name": "C"}).status_code == 403
        assert client.post("/api/guardians", headers=teacher, json={"full_name": "No autorizado", "document_id": "44556677"}).status_code == 403
        assert client.post("/api/students", headers=teacher, json={
            "first_name": "No", "last_name": "Autorizado", "document_id": "88776655", "section_id": manual_section.json()["id"],
        }).status_code == 403
        denied = client.post("/api/reports", headers=teacher, json={
            "severity": "leve", "description": "Debe bloquearse sin asignación.",
            "occurred_at": datetime.now(ZoneInfo("America/Caracas")).isoformat(), "student_ids": [student["id"]],
        })
        assert denied.status_code == 403
        assert client.patch(f"/api/reports/{report_id}", headers=teacher, json={"description": "Sin permiso."}).status_code == 403
        section_id = client.get("/api/sections?page=1&page_size=100", headers=admin).json()["items"][0]["id"]
        subject = client.post("/api/subjects", headers=admin, json={"name": "Orientación"})
        assert subject.status_code == 201, subject.text
        assigned = client.post(f"/api/teachers/{teacher_response.json()['id']}/sections", headers=admin, json={"section_id": section_id, "subject_id": subject.json()["id"]})
        assert assigned.status_code == 201, assigned.text
        course_teacher = client.patch(f"/api/sections/{manual_section.json()['id']}", headers=admin, json={"teacher_id": teacher_response.json()["id"], "name": "C"})
        assert course_teacher.status_code == 200, course_teacher.text
        assert course_teacher.json()["teacher_id"] == teacher_response.json()["id"]
        edited_subject = client.patch(f"/api/subjects/{subject.json()['id']}", headers=admin, json={"name": "Orientación escolar"})
        assert edited_subject.status_code == 200
        allowed = client.post("/api/reports", headers=teacher, json={
            "severity": "leve", "description": "Permitido en su sección asignada.",
            "occurred_at": datetime.now(ZoneInfo("America/Caracas")).isoformat(), "student_ids": [student["id"]],
        })
        assert allowed.status_code == 201, allowed.text

        now_school = datetime.now(ZoneInfo("America/Caracas"))
        scheduled = (now_school + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)
        citation = client.post("/api/citations", headers=admin, json={
            "guardian_id": guardian_id, "report_id": report_id,
            "scheduled_at": scheduled.isoformat(), "reason": "Seguimiento escolar",
        })
        assert citation.status_code == 201, citation.text
        duplicate_citation = client.post("/api/citations", headers=admin, json={
            "guardian_id": guardian_id, "scheduled_at": scheduled.isoformat(), "reason": "Duplicada",
        })
        assert duplicate_citation.status_code == 409
        for day_offset in range(2, 12):
            other_date = (now_school + timedelta(days=day_offset)).replace(hour=11, minute=0, second=0, microsecond=0)
            other_citation = client.post("/api/citations", headers=admin, json={
                "guardian_id": guardian_id, "scheduled_at": other_date.isoformat(), "reason": f"Seguimiento {day_offset}",
            })
            assert other_citation.status_code == 201, other_citation.text
        edited_citation = client.patch(f"/api/citations/{citation.json()['id']}", headers=admin, json={"reason": "Seguimiento corregido"})
        assert edited_citation.status_code == 200
        day = scheduled.date().isoformat()
        agenda = client.get(f"/api/citations?day={day}&q=12345678", headers=admin)
        assert agenda.status_code == 200, agenda.text
        assert len(agenda.json()["items"]) == 1

        history = client.get("/api/citations?page=1&page_size=5", headers=admin)
        assert history.status_code == 200
        assert history.json()["total"] == 11
        history_page_two = client.get("/api/citations?page=2&page_size=5", headers=admin).json()
        assert history_page_two["page"] == 2
        assert len(history_page_two["items"]) == 5
        by_guardian = client.get(f"/api/guardians/{guardian_id}/citations", headers=admin)
        assert by_guardian.status_code == 200
        assert by_guardian.json()["total"] == 11

        guardian_user = client.post("/api/users", headers=admin, json={
            "username": "guardian-test", "full_name": "Maria Ejemplo", "password": "guardian-test-password",
            "role": "guardian", "guardian_id": guardian_id,
        })
        assert guardian_user.status_code == 201, guardian_user.text
        guardian_login = client.post("/api/auth/login", json={"username": "guardian-test", "password": "guardian-test-password"}).json()
        guardian_headers = {"Authorization": f"Bearer {guardian_login['access_token']}"}
        portal = client.get("/api/guardian/summary", headers=guardian_headers)
        assert portal.status_code == 200, portal.text
        assert len(portal.json()["students"]) == 2
        assert portal.json()["reports"][0]["student_name"] == "Ana Ejemplo"
        assert client.get("/api/messages", headers=guardian_headers).status_code == 200

        confirmed = client.patch(f"/api/guardian/citations/{citation.json()['id']}/confirm", headers=guardian_headers)
        assert confirmed.status_code == 200, confirmed.text
        forbidden = client.patch(f"/api/guardian/citations/{citation.json()['id']}/confirm", headers=teacher)
        assert forbidden.status_code == 403

        with SessionLocal() as db:
            guardian = db.scalar(select(Guardian).where(Guardian.id == guardian_id))
            link_token = guardian.telegram_link_token
        webhook_body = {"message": {"chat": {"id": 98765}, "text": f"/start {link_token}"}}
        blocked_webhook = client.post("/api/webhooks/telegram", json=webhook_body, headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"})
        assert blocked_webhook.status_code == 403
        webhook = client.post("/api/webhooks/telegram", json=webhook_body, headers={"X-Telegram-Bot-Api-Secret-Token": "test-telegram-webhook-secret"})
        assert webhook.status_code == 200
        linked_portal = client.get("/api/guardian/summary", headers=guardian_headers)
        assert linked_portal.json()["guardian"]["telegram_linked"] is True

        assert client.delete(f"/api/citations/{citation.json()['id']}", headers=admin).status_code == 204
        assert client.delete(f"/api/students/{manual_student.json()['id']}", headers=admin).status_code == 204
        assert client.delete(f"/api/guardians/{manual_guardian.json()['id']}", headers=admin).status_code == 204
        assert client.delete(f"/api/sections/{manual_section.json()['id']}", headers=admin).status_code == 204
        assert client.delete(f"/api/subjects/{subject.json()['id']}", headers=admin).status_code == 204
        assert client.delete(f"/api/reports/{report_id}", headers=admin).status_code == 204
        assert client.delete(f"/api/users/{teacher_response.json()['id']}", headers=admin).status_code == 204
