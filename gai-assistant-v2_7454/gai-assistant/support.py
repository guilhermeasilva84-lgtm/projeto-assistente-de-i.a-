import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.schema import CreateSchema, DropSchema

from app import main


@contextmanager
def isolated_database():
    url = os.getenv("GAI_TEST_DATABASE_URL")
    if not url:
        with tempfile.TemporaryDirectory() as directory:
            engine = create_engine(f"sqlite:///{Path(directory) / 'test.db'}")
            try:
                yield engine
            finally:
                engine.dispose()
        return

    schema = f"gai_test_{uuid4().hex}"
    admin = create_engine(url)
    try:
        with admin.begin() as connection:
            connection.execute(CreateSchema(schema))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
        try:
            yield engine
        finally:
            engine.dispose()
            with admin.begin() as connection:
                connection.execute(DropSchema(schema, cascade=True))
    finally:
        admin.dispose()


class WorkspaceTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = self.enterContext(isolated_database())
        self.enterContext(patch.object(main.database, "engine", self.engine))
        self.enterContext(patch.dict(
            os.environ, OPENAI_API_KEY="", TAVILY_API_KEY="", GAI_SECURE_COOKIES="false",
        ))
        self.client = self.enterContext(TestClient(main.app))
        self.headers = {"X-GAI-Session": str(uuid4())}

    def chat(self, question, **kwargs):
        response = self.client.post(
            "/api/chat", headers=self.headers,
            data={"question": question, **kwargs.pop("data", {})}, **kwargs,
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()
