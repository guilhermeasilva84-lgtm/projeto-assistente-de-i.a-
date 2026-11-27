import csv
import io
from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from .assistant import IntegrationError, classify_ticket
from .auth import Database, Owner
from .database import (
    Conversation, DemoSeed, KnowledgeDocument, WorkTicket, WorkspaceEvent,
    add_event, as_utc, utcnow,
)
from .demo import DEMO_TICKETS, demo_documents
from .knowledge import LIBRARY_CAPACITY

router = APIRouter(prefix="/api", tags=["Central de TI"])
Status = Literal["open", "in_progress", "resolved", "closed"]
Priority = Literal["Baixa", "Média", "Alta", "Crítica"]
STATUSES = {"open": "Aberto", "in_progress": "Em andamento", "resolved": "Resolvido", "closed": "Encerrado"}
ACTIVE_STATUSES = ("open", "in_progress")
SLA_HOURS = {"Baixa": 72, "Média": 24, "Alta": 8, "Crítica": 4}

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=5000)]


class TicketInput(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=140)]
    description: Description
    system: ShortText = "Não informado"
    category: ShortText = "Suporte técnico"
    priority: Priority = "Média"
    status: Status = "open"


class TicketEdit(TicketInput):
    version: int


class TriageInput(BaseModel):
    description: Description


def ticket_view(ticket: WorkTicket, now: datetime | None = None) -> dict:
    due_at = as_utc(ticket.due_at)
    resolved_at = as_utc(ticket.resolved_at) if ticket.resolved_at else None
    return {
        "id": ticket.id, "title": ticket.title, "description": ticket.description,
        "system": ticket.system, "category": ticket.category, "priority": ticket.priority,
        "status": ticket.status, "version": ticket.version,
        "due_at": due_at, "created_at": as_utc(ticket.created_at),
        "updated_at": as_utc(ticket.updated_at), "resolved_at": resolved_at,
        "overdue": (resolved_at or now or utcnow()) > due_at,
    }


def ticket_rows(owner: UUID):
    return select(WorkTicket).where(WorkTicket.owner == str(owner)).order_by(
        WorkTicket.updated_at.desc(), WorkTicket.id,
    )


def new_ticket(owner: str, data: TicketInput, created_at: datetime, updated_at: datetime) -> WorkTicket:
    due_at = created_at + timedelta(hours=SLA_HOURS[data.priority])
    return WorkTicket(
        owner=owner, **data.model_dump(), due_at=due_at, created_at=created_at,
        updated_at=updated_at, resolved_at=updated_at if data.status not in ACTIVE_STATUSES else None,
    )


@router.get("/tickets")
def list_tickets(owner: Owner, db: Database):
    now = utcnow()
    return [ticket_view(ticket, now) for ticket in db.scalars(ticket_rows(owner))]


@router.post("/tickets", status_code=201)
def create_ticket(data: TicketInput, owner: Owner, db: Database):
    now = utcnow()
    ticket = new_ticket(str(owner), data, now, now)
    db.add(ticket)
    add_event(db, str(owner), "ticket_created", ticket.title)
    db.commit()
    return ticket_view(ticket)


@router.post("/tickets/triage")
def triage_ticket(data: TriageInput, owner: Owner):
    try:
        ticket, origin = classify_ticket(data.description)
    except IntegrationError as error:
        raise HTTPException(502, str(error)) from error
    return {"classification": ticket.model_dump(), "origin": origin}


@router.put("/tickets/{ticket_id}")
def update_ticket(ticket_id: UUID, data: TicketEdit, owner: Owner, db: Database):
    ticket = db.scalar(ticket_rows(owner).where(WorkTicket.id == str(ticket_id)))
    if ticket is None:
        raise HTTPException(404, "Chamado não encontrado.")
    if ticket.version != data.version:
        raise HTTPException(409, "O chamado foi alterado. Reabra o registro para atualizar a versão.")
    now = utcnow()
    priority_changed = data.priority != ticket.priority
    status_changed = data.status != ticket.status
    for field, value in data.model_dump(exclude={"version"}).items():
        setattr(ticket, field, value)
    if priority_changed:
        ticket.due_at = as_utc(ticket.created_at) + timedelta(hours=SLA_HOURS[data.priority])
    if data.status in ACTIVE_STATUSES:
        ticket.resolved_at = None
    elif ticket.resolved_at is None:
        ticket.resolved_at = now
    ticket.updated_at = now
    add_event(
        db, str(owner), "ticket_updated",
        f"{ticket.title} · {STATUSES[ticket.status]}" if status_changed else ticket.title,
    )
    try:
        db.commit()
    except StaleDataError as error:
        raise HTTPException(409, "O chamado foi atualizado em outra sessão.") from error
    return ticket_view(ticket)


def spreadsheet_cell(value: str) -> str:
    if value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n")):
        return "'" + value
    return value


@router.get("/tickets/export.csv")
def export_tickets(owner: Owner, db: Database):
    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(["ID", "Título", "Sistema", "Categoria", "Prioridade", "Situação", "Prazo UTC", "Resolvido em UTC"])
    for ticket in db.scalars(ticket_rows(owner)):
        writer.writerow([spreadsheet_cell(str(value)) for value in (
            ticket.id, ticket.title, ticket.system, ticket.category, ticket.priority,
            STATUSES[ticket.status], as_utc(ticket.due_at).isoformat(),
            as_utc(ticket.resolved_at).isoformat() if ticket.resolved_at else "",
        )])
    return Response(
        output.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="gai-chamados.csv"'},
    )


@router.get("/workspace/summary")
def summary(owner: Owner, db: Database):
    key = str(owner)
    now = utcnow()
    counts = dict(db.execute(select(WorkTicket.status, func.count()).where(
        WorkTicket.owner == key
    ).group_by(WorkTicket.status)).all())
    active = select(func.count()).select_from(WorkTicket).where(
        WorkTicket.owner == key, WorkTicket.status.in_(ACTIVE_STATUSES),
    )
    events = db.scalars(select(WorkspaceEvent).where(WorkspaceEvent.owner == key).order_by(
        WorkspaceEvent.id.desc()
    ).limit(8))
    return {
        "statuses": {status: counts.get(status, 0) for status in STATUSES},
        "active": sum(counts.get(status, 0) for status in ACTIVE_STATUSES),
        "urgent": db.scalar(active.where(WorkTicket.priority.in_(("Alta", "Crítica")))),
        "overdue": db.scalar(active.where(WorkTicket.due_at < now)),
        "documents": db.scalar(select(func.count()).select_from(KnowledgeDocument).where(KnowledgeDocument.owner == key)),
        "conversations": db.scalar(select(func.count()).select_from(Conversation).where(Conversation.owner == key)),
        "demo_loaded": db.get(DemoSeed, key) is not None,
        "events": [
            {"id": event.id, "action": event.action, "target": event.target, "created_at": as_utc(event.created_at)}
            for event in events
        ],
    }


@router.post("/workspace/demo")
def seed_demo(owner: Owner, db: Database):
    key = str(owner)
    if db.get(DemoSeed, key):
        return {"loaded": False}
    db.add(DemoSeed(owner=key))
    try:
        db.flush()
        now = utcnow()
        for title, description, system, category, priority, status, hours in DEMO_TICKETS:
            created = now - timedelta(hours=hours)
            updated = now - timedelta(hours=max(0, hours - 2))
            data = TicketInput(
                title=title, description=description, system=system, category=category,
                priority=priority, status=status,
            )
            db.add(new_ticket(key, data, created, updated))
        checksums = set(db.scalars(select(KnowledgeDocument.checksum).where(KnowledgeDocument.owner == key)))
        for doc in demo_documents(key):
            if len(checksums) < LIBRARY_CAPACITY and doc.checksum not in checksums:
                db.add(doc)
                checksums.add(doc.checksum)
        add_event(db, key, "demo_loaded", "Chamados e documentos fictícios")
        db.commit()
    except IntegrityError as error:
        db.rollback()
        if db.get(DemoSeed, key):
            return {"loaded": False}
        raise HTTPException(409, "A biblioteca mudou durante a carga. Tente novamente.") from error
    return {"loaded": True}
