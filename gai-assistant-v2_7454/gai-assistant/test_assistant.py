import io
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from openpyxl import Workbook
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from support import WorkspaceTestCase


def sales_workbook():
    book = Workbook()
    book.active.title = "Vendas"
    for row in (("Vendedor", "Vendas"), ("Felipe", 800), ("Ana", 950), ("Felipe", 430)):
        book.active.append(row)
    target = io.BytesIO()
    book.save(target)
    return target.getvalue()


def sample_pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(300, 300)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({
            NameObject("/F1"): DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
        })
    })
    contents = DecodedStreamObject()
    contents.set_data(b"BT /F1 12 Tf 20 150 Td (Prazo contratual de 30 dias.) Tj ET")
    page[NameObject("/Contents")] = contents
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue()


class TestAssistant(WorkspaceTestCase):
    def test_conversation_context_and_session_isolation(self):
        first = self.chat("Meu nome é Guilherme.")
        cid = first["conversation"]["id"]
        second = self.chat("Qual é meu nome?", data={"conversation_id": cid})
        self.assertIn("Guilherme", second["messages"][-1]["text"])
        history = self.client.get(f"/api/conversations/{cid}", headers=self.headers).json()
        self.assertEqual(len(history["messages"]), 4)
        other = {"X-GAI-Session": str(uuid4())}
        self.assertEqual(self.client.get("/api/conversations", headers=other).json(), [])
        self.assertEqual(self.client.get(f"/api/conversations/{cid}", headers=other).status_code, 404)

    def test_file_context_excel_ranking_and_follow_up(self):
        result = self.chat(
            "Qual vendedor vendeu mais?", data={"mode": "document"},
            files={"attachment": ("vendas.xlsx", sales_workbook())},
        )
        text = result["messages"][-1]["text"]
        self.assertIn("Felipe", text)
        self.assertIn("1.230", text)
        cid = result["conversation"]["id"]
        follow_up = self.chat("Qual é o total?", data={"conversation_id": cid})
        self.assertIn("2.180", follow_up["messages"][-1]["text"])

    def test_pdf_retrieval_reports_page(self):
        result = self.chat(
            "Qual é o prazo contratual?", data={"mode": "document"},
            files={"attachment": ("contrato.pdf", sample_pdf())},
        )
        self.assertIn("Pág. 1", result["messages"][-1]["text"])
        self.assertIn("30 dias", result["messages"][-1]["text"])

    def test_invalid_file_does_not_create_conversation(self):
        response = self.client.post(
            "/api/chat", headers=self.headers, data={"question": "Leia o arquivo"},
            files={"attachment": ("arquivo.txt", b"texto")},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get("/api/conversations", headers=self.headers).json(), [])

    def test_sql_code_and_ticket(self):
        sql = self.chat("Liste os clientes ativos.", data={"mode": "sql"})
        self.assertIn("WHERE status = 'ATIVO'", sql["messages"][-1]["text"])
        inactive = self.chat("Liste os clientes inativos.", data={"mode": "sql"})
        self.assertIn("WHERE status = 'INATIVO'", inactive["messages"][-1]["text"])
        code = self.chat("Crie uma API REST em Node.js.", data={"mode": "code"})
        self.assertIn("app.listen", code["messages"][-1]["text"])
        ticket = self.chat("TOTVS está retornando erro de login.", data={"mode": "ticket"})
        self.assertIn("**Prioridade:** Média", ticket["messages"][-1]["text"])
        self.assertIn("**Sistema:** TOTVS", ticket["messages"][-1]["text"])

    def test_web_api_returns_sources_and_openai_gets_context(self):
        def fake_provider(url, **kwargs):
            request = httpx.Request("POST", url)
            if url == "https://api.tavily.com/search":
                return httpx.Response(200, request=request, json={"results": [{
                    "title": "Java", "url": "https://example.org/java", "content": "Resultado de teste.",
                }]})
            self.assertEqual(url, "https://api.openai.com/v1/responses")
            self.assertEqual(kwargs["json"]["model"], "gpt-5-mini")
            payload = json.loads(kwargs["json"]["input"][-1]["content"])
            self.assertEqual(payload["dados_de_referencia"]["web"][0]["title"], "Java")
            self.assertFalse(kwargs["json"]["store"])
            return httpx.Response(200, request=request, json={"output": [{
                "content": [{"type": "output_text", "text": "Resposta de teste [1]."}],
            }]})

        with patch.dict(os.environ, OPENAI_API_KEY="test", TAVILY_API_KEY="test"), patch(
            "app.assistant.httpx.post", side_effect=fake_provider
        ):
            result = self.chat("Qual a versão do Java?", data={"mode": "web", "model": "gpt-5-mini"})
        reply = result["messages"][-1]
        self.assertEqual(reply["origin"], "openai")
        self.assertEqual(reply["sources"], [{"title": "Java", "url": "https://example.org/java"}])


if __name__ == "__main__":
    unittest.main()
