import csv
import io
from collections import OrderedDict
from datetime import datetime, timedelta
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import main
from app.database import Account, LoginSession
from support import WorkspaceTestCase
from test_assistant import sample_pdf, sales_workbook


class TestWorkspace(WorkspaceTestCase):
    def create_ticket(self, title="VPN indisponível", **overrides):
        body = {
            "title": title, "description": "VPN indisponível para toda a equipe.",
            "system": "VPN", "category": "Conectividade", "priority": "Alta", **overrides,
        }
        result = self.client.post("/api/tickets", headers=self.headers, json=body)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json(), body

    def register_account(self):
        data = {"name": "Guilherme", "email": "guilherme@example.com", "password": "Senha de teste, 42"}
        result = self.client.post("/api/auth/register", headers=self.headers, json=data)
        self.assertEqual(result.status_code, 201, result.text)
        self.assertIn("HttpOnly", result.headers["set-cookie"])
        return result.json()["account"], data

    def test_account_separates_guest_and_persists_across_browsers(self):
        guest, _ = self.create_ticket("Chamado do visitante")
        account, login = self.register_account()
        self.assertEqual(self.client.get("/api/tickets", headers=self.headers).json(), [])
        private, _ = self.create_ticket("Chamado da conta")
        raw_token = self.client.cookies.get("gai_account")
        with Session(self.engine) as db:
            self.assertNotEqual(db.get(Account, account["id"]).password_hash, login["password"])
            self.assertNotEqual(db.scalar(select(LoginSession)).digest, raw_token)
        with TestClient(main.app) as another:
            attempt = another.get("/api/tickets", headers={"X-GAI-Session": account["id"]})
            self.assertEqual(attempt.status_code, 422)
            headers = {"X-GAI-Session": str(uuid4())}
            self.assertEqual(another.get("/api/tickets", headers=headers).json(), [])
            bad_login = another.post("/api/auth/login", headers=headers, json={
                "email": login["email"], "password": "uma senha errada",
            })
            self.assertEqual(bad_login.status_code, 401)
            signed_in = another.post("/api/auth/login", headers=headers, json=login)
            self.assertEqual(signed_in.status_code, 200, signed_in.text)
            self.assertEqual(another.get("/api/tickets", headers=headers).json()[0]["id"], private["id"])
        self.assertEqual(self.client.post("/api/auth/logout", headers=self.headers).status_code, 204)
        self.assertEqual(self.client.get("/api/auth/me", headers=self.headers).json(), {"account": None})
        self.assertEqual(self.client.get("/api/tickets", headers=self.headers).json()[0]["id"], guest["id"])
        with Session(self.engine) as db:
            sessions = db.scalars(select(LoginSession)).all()
            self.assertEqual(len(sessions), 1)

    def test_auth_throttle_applies_by_address_and_operation(self):
        with patch("app.auth.ATTEMPTS_PER_MINUTE", 2), patch("app.auth.attempts", OrderedDict()):
            for _ in range(2):
                result = self.client.post("/api/auth/login", headers=self.headers, json={
                    "email": "guilherme@example.com", "password": "x",
                })
                self.assertEqual(result.status_code, 401)
            result = self.client.post("/api/auth/login", headers=self.headers, json={
                "email": "guilherme@example.com", "password": "x",
            })
            self.assertEqual(result.status_code, 429)
            self.assertGreater(int(result.headers["Retry-After"]), 0)

    def test_ticket_lifecycle_versions_due_date_and_audit(self):
        ticket, payload = self.create_ticket()
        created, due = [datetime.fromisoformat(ticket[key]) for key in ("created_at", "due_at")]
        self.assertEqual(due - created, timedelta(hours=8))
        url = f"/api/tickets/{ticket['id']}"
        payload.update(status="resolved", priority="Crítica", version=ticket["version"])
        updated = self.client.put(url, headers=self.headers, json=payload).json()
        self.assertEqual(updated["status"], "resolved")
        self.assertIsNotNone(updated["resolved_at"])
        self.assertEqual(datetime.fromisoformat(updated["due_at"]) - created, timedelta(hours=4))
        self.assertEqual(self.client.put(url, headers=self.headers, json=payload).status_code, 409)
        outsider = {"X-GAI-Session": str(uuid4())}
        self.assertEqual(self.client.put(url, headers=outsider, json=payload).status_code, 404)
        summary = self.client.get("/api/workspace/summary", headers=self.headers).json()
        self.assertEqual(summary["active"], 0)
        self.assertEqual(summary["statuses"]["resolved"], 1)
        self.assertEqual(summary["events"][0]["action"], "ticket_updated")

    def test_csv_export_quotes_formula_cells_and_is_scoped(self):
        self.create_ticket("=1+2", system="@entrada")
        other = {"X-GAI-Session": str(uuid4())}
        self.client.post("/api/tickets", headers=other, json={
            "title": "Outro espaço", "description": "Chamado privado.",
        })
        response = self.client.get("/api/tickets/export.csv", headers=self.headers)
        rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig")), delimiter=";"))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][1:3], ["'=1+2", "'@entrada"])
        self.assertIn("attachment", response.headers["Content-Disposition"])

    def test_demo_is_idempotent_and_uses_real_metrics(self):
        url = "/api/workspace/demo"
        self.assertEqual(self.client.post(url, headers=self.headers).json(), {"loaded": True})
        self.assertEqual(self.client.post(url, headers=self.headers).json(), {"loaded": False})
        summary = self.client.get("/api/workspace/summary", headers=self.headers).json()
        self.assertEqual(summary["active"], 4)
        self.assertEqual(summary["urgent"], 2)
        self.assertEqual(summary["overdue"], 1)
        self.assertEqual(summary["documents"], 2)
        self.assertTrue(summary["demo_loaded"])
        self.assertEqual(sum(summary["statuses"].values()), 6)

    def test_knowledge_sources_download_and_delete_are_scoped(self):
        upload = self.client.post("/api/documents", headers=self.headers,
                                  files={"attachment": ("Contrato em PDF.pdf", sample_pdf())})
        self.assertEqual(upload.status_code, 201, upload.text)
        document = upload.json()
        url = f"/api/documents/{document['id']}"
        duplicate = self.client.post("/api/documents", headers=self.headers,
                                     files={"attachment": ("outro.pdf", sample_pdf())})
        self.assertEqual(duplicate.status_code, 409)
        reply = self.chat("Qual é o prazo contratual?", data={"mode": "knowledge"})["messages"][-1]
        self.assertIn("30 dias", reply["text"])
        self.assertEqual(reply["knowledge_sources"], [{
            "document_id": document["id"], "title": document["name"], "page": 1,
        }])
        outsider = {"X-GAI-Session": str(uuid4())}
        denied = self.client.post("/api/chat", headers=outsider, data={
            "question": "Qual é o prazo contratual?", "mode": "knowledge",
        })
        self.assertNotIn("knowledge_sources", denied.json()["messages"][-1])
        self.assertEqual(self.client.get(url + "/download", headers=outsider).status_code, 404)
        self.assertEqual(self.client.delete(url, headers=outsider).status_code, 404)
        download = self.client.get(url + "/download", headers=self.headers)
        self.assertEqual(download.content, sample_pdf())
        self.assertIn("Contrato%20em%20PDF.pdf", download.headers["Content-Disposition"])
        self.assertEqual(self.client.delete(url, headers=self.headers).status_code, 204)
        self.assertEqual(self.client.get(url + "/download", headers=self.headers).status_code, 404)

    def test_library_excel_can_be_used_for_conversation_with_calculation(self):
        upload = self.client.post("/api/documents", headers=self.headers,
                                  files={"attachment": ("vendas.xlsx", sales_workbook())})
        self.assertEqual(upload.status_code, 201, upload.text)
        data = {"document_id": upload.json()["id"], "mode": "document"}
        reply = self.chat("Qual vendedor vendeu mais?", data=data)["messages"][-1]
        self.assertIn("Felipe", reply["text"])
        self.assertIn("1.230", reply["text"])

    def test_ticket_suggestion_is_structured_and_requires_confirmation(self):
        description = "O login do TOTVS apresenta erro para a equipe."
        suggestion = self.client.post("/api/tickets/triage", headers=self.headers, json={"description": description})
        self.assertEqual(suggestion.status_code, 200)
        classification = suggestion.json()["classification"]
        self.assertEqual(classification["sistema"], "TOTVS")
        self.assertEqual(classification["categoria"], "Acesso")
        chat = self.chat(description, data={"mode": "ticket"})
        self.assertEqual(chat["messages"][-1]["ticket"], classification)
        self.assertEqual(self.client.get("/api/tickets", headers=self.headers).json(), [])
