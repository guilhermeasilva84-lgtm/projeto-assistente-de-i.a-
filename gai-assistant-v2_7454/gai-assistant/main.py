from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session, defer
from sqlalchemy.orm.exc import StaleDataError

from . import auth, database, knowledge, workspace
from .auth import Owner
from .assistant import IntegrationError, Mode, Model, answer, capabilities
from .database import ROOT, Base, Conversation, Message, add_event, as_utc, new_conversation, utcnow
from .documents import analyze_upload


@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(database.engine)
    yield


app = FastAPI(title="GAI Assistant", version="2.0.0", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(workspace.router)
app.include_router(knowledge.router)


def conversation_view(conversation: Conversation) -> dict:
    return {
        "id": conversation.id, "title": conversation.title,
        "updated_at": as_utc(conversation.updated_at), "attachment": conversation.attachment_name,
    }


def message_view(message: Message) -> dict:
    return {"id": message.id, "role": message.role, "text": message.text, **message.details}


def get_conversation(db: Session, conversation_id: UUID, owner: UUID) -> Conversation:
    conversation = db.scalar(select(Conversation).where(
        Conversation.id == str(conversation_id), Conversation.owner == str(owner)
    ).options(defer(Conversation.attachment_data)))
    if conversation is None:
        raise HTTPException(404, "Conversa não encontrada.")
    return conversation


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def config():
    return capabilities()


@app.get("/api/conversations")
def conversations(owner: Owner):
    with Session(database.engine) as db:
        rows = db.scalars(select(Conversation).where(
            Conversation.owner == str(owner)
        ).options(defer(Conversation.attachment_data)).order_by(
            Conversation.updated_at.desc()
        ).limit(100))
        return [conversation_view(row) for row in rows]


@app.get("/api/conversations/{conversation_id}")
def conversation_history(conversation_id: UUID, owner: Owner):
    with Session(database.engine) as db:
        conversation = get_conversation(db, conversation_id, owner)
        messages = db.scalars(select(Message).where(
            Message.conversation_id == conversation.id
        ).order_by(Message.id))
        return {**conversation_view(conversation), "messages": [message_view(row) for row in messages]}


@app.post("/api/chat")
def chat(
    owner: Owner,
    question: Annotated[str, Form(min_length=1, max_length=6000)],
    model: Annotated[Model, Form()] = "gpt-5",
    mode: Annotated[Mode, Form()] = "chat",
    conversation_id: Annotated[UUID | None, Form()] = None,
    attachment: Annotated[UploadFile | None, File()] = None,
    document_id: Annotated[UUID | None, Form()] = None,
):
    question = question.strip()
    if not question:
        raise HTTPException(422, "Digite uma pergunta.")
    if attachment and document_id:
        raise HTTPException(422, "Use um anexo ou um arquivo da biblioteca por vez.")
    file_name, file_data = knowledge.read_upload(attachment) if attachment else (None, None)

    with Session(database.engine, expire_on_commit=False) as db:
        if document_id:
            selected = knowledge.get_document(db, owner, document_id)
            file_name, file_data = selected.name, selected.content
        if file_name and mode == "chat":
            mode = "document"
        if conversation_id:
            conversation = get_conversation(db, conversation_id, owner)
            previous = db.scalars(select(Message).where(
                Message.conversation_id == conversation.id
            ).order_by(Message.id.desc()).limit(14)).all()
        else:
            conversation = new_conversation(str(owner), question[:97] + ("…" if len(question) > 97 else ""))
            previous = []
        if file_data is None and conversation.attachment_name and mode in {"chat", "document"}:
            mode = "document"
        document = None
        try:
            if file_data is not None:
                document = analyze_upload(file_name, file_data, question)
            elif mode == "document" and conversation.attachment_name:
                document = analyze_upload(conversation.attachment_name, conversation.attachment_data, question)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        references = knowledge.retrieve_knowledge(db, owner, question) if mode == "knowledge" else None
        history = [{"role": row.role, "content": row.text} for row in reversed(previous)]
        # Release the read transaction before contacting an external provider.
        if conversation_id:
            db.expunge(conversation)
        db.rollback()
        try:
            result = answer(question, history, model, mode, document, references)
        except IntegrationError as error:
            raise HTTPException(502, str(error)) from error

        if file_data is not None:
            conversation.attachment_name = file_name
            conversation.attachment_data = file_data
        conversation.updated_at = utcnow()
        db.add(conversation)
        if not conversation_id:
            db.flush()
            add_event(db, str(owner), "conversation_created", conversation.title)
        user_message = Message(
            conversation_id=conversation.id, role="user", text=question,
            details={"attachment": file_name} if file_name is not None else {},
        )
        assistant_message = Message(
            conversation_id=conversation.id, role="assistant",
            text=result["text"], details=result["details"],
        )
        db.add_all([user_message, assistant_message])
        try:
            db.commit()
        except StaleDataError as error:
            db.rollback()
            raise HTTPException(409, "A conversa mudou durante a resposta. Reabra a conversa e tente novamente.") from error
        return {
            "conversation": conversation_view(conversation),
            "messages": [message_view(user_message), message_view(assistant_message)],
        }


@app.get("/api/{unmatched:path}", include_in_schema=False)
def unknown_api(unmatched: str):
    raise HTTPException(404, "Rota não encontrada.")


if (ROOT / "frontend" / "dist" / "index.html").is_file():
    app.mount("/", StaticFiles(directory=ROOT / "frontend" / "dist", html=True), name="frontend")
