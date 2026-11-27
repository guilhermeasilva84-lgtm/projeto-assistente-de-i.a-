import hashlib
import heapq
import re
from collections import Counter
from pathlib import Path
from typing import Annotated
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, undefer

from .auth import Database, Owner
from .database import KnowledgeDocument, add_event, as_utc
from .documents import MAX_UPLOAD, STOP_WORDS, analyze_upload, extract_pdf, normalize

router = APIRouter(prefix="/api/documents", tags=["Biblioteca"])
LIBRARY_CAPACITY = 30
MIME_TYPES = {
    "pdf": "application/pdf",
    "excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def read_upload(attachment: UploadFile) -> tuple[str, bytes]:
    name = Path((attachment.filename or "").replace("\\", "/")).name[-255:]
    try:
        content = attachment.file.read(MAX_UPLOAD + 1)
    finally:
        attachment.file.close()
    if not content or len(content) > MAX_UPLOAD:
        raise HTTPException(413, "Envie um arquivo entre 1 byte e 8 MB.")
    return name, content


def word_counts(text: str) -> Counter:
    return Counter(
        token for token in re.findall(r"\b\w{3,}\b", normalize(text))
        if token not in STOP_WORDS and token not in {"tem", "sao", "qualquer", "fale", "informacao"}
    )


def build_document(owner: str, name: str, content: bytes, description: str) -> KnowledgeDocument:
    extension = Path(name).suffix.casefold()
    if extension == ".pdf":
        try:
            page_count, excerpts = extract_pdf(content)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except Exception as error:
            raise HTTPException(422, "Não foi possível ler o PDF.") from error
        units = page_count
        kind = "pdf"
    elif extension == ".xlsx":
        try:
            analysis = analyze_upload(name, content, "")
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        excerpts = []
        for sheet in analysis["sheets"]:
            columns = ", ".join(sheet["columns"])
            summary = f"Aba {sheet['sheet']}. {sheet['rows']} linhas. Colunas: {columns}."
            for metric, values in sheet["statistics"].items():
                summary += f" {metric}: total {values['sum']:g}, média {values['average']:g}."
            for ranking in sheet["rankings"]:
                if ranking["top"]:
                    first = ranking["top"][0]
                    group, metric = ranking["group"], ranking["metric"]
                    summary += f" Maior soma de {metric} por {group}: {first[group]}, {first[metric]:g}."
            excerpts.append({"sheet": sheet["sheet"], "text": summary})
        units = len(excerpts)
        kind = "excel"
    else:
        raise HTTPException(422, "Anexe um PDF ou uma planilha .xlsx.")
    return KnowledgeDocument(
        owner=owner, name=name, description=description, size=len(content), units=units,
        checksum=hashlib.sha256(content).hexdigest(), kind=kind, content=content,
        index_data={"excerpts": excerpts},
    )


def get_document(db: Session, owner: UUID, document_id: UUID) -> KnowledgeDocument:
    document = db.scalar(select(KnowledgeDocument).where(
        KnowledgeDocument.id == str(document_id), KnowledgeDocument.owner == str(owner),
    ))
    if document is None:
        raise HTTPException(404, "Documento não encontrado.")
    return document


def retrieve_knowledge(db: Session, owner: UUID, question: str) -> list[dict]:
    terms = set(word_counts(question))
    if not terms:
        return []
    documents = db.scalars(select(KnowledgeDocument).where(
        KnowledgeDocument.owner == str(owner)
    ).options(undefer(KnowledgeDocument.index_data)).order_by(KnowledgeDocument.created_at.desc(), KnowledgeDocument.id))
    candidates = {}
    for document in documents:
        metadata = set(word_counts(f"{document.name} {document.description}"))
        for excerpt in document.index_data["excerpts"]:
            words = word_counts(excerpt["text"])
            matches = terms & words.keys()
            filename_matches = terms & metadata
            if not matches and not filename_matches:
                continue
            score = 3 * len(matches) + sum(min(words[word], 3) for word in matches) + len(filename_matches)
            location = (document.id, excerpt.get("page"), excerpt.get("sheet"))
            if location not in candidates or score > candidates[location][0]:
                candidates[location] = (score, {
                    "document_id": document.id, "title": document.name, **excerpt,
                })
    top = heapq.nlargest(5, candidates.values(), key=lambda item: item[0])
    return [excerpt for _, excerpt in top]


def document_view(document: KnowledgeDocument) -> dict:
    return {
        "id": document.id, "name": document.name, "description": document.description,
        "kind": document.kind, "size": document.size, "units": document.units,
        "created_at": as_utc(document.created_at),
    }


@router.get("")
def list_documents(owner: Owner, db: Database):
    documents = db.scalars(select(KnowledgeDocument).where(
        KnowledgeDocument.owner == str(owner)
    ).order_by(KnowledgeDocument.created_at.desc()))
    return [document_view(document) for document in documents]


@router.post("", status_code=201)
def upload_document(
    owner: Owner, db: Database,
    attachment: Annotated[UploadFile, File()],
    description: Annotated[str, Form(max_length=240)] = "",
):
    name, content = read_upload(attachment)
    count = db.scalar(select(func.count()).select_from(KnowledgeDocument).where(
        KnowledgeDocument.owner == str(owner)
    ))
    if count >= LIBRARY_CAPACITY:
        raise HTTPException(409, f"A biblioteca comporta {LIBRARY_CAPACITY} arquivos.")
    document = build_document(str(owner), name, content, description.strip())
    db.add(document)
    add_event(db, str(owner), "document_added", document.name)
    try:
        db.commit()
    except IntegrityError as error:
        raise HTTPException(409, "Esse arquivo já existe na biblioteca.") from error
    return document_view(document)


@router.get("/{document_id}/download")
def download_document(document_id: UUID, owner: Owner, db: Database):
    document = get_document(db, owner, document_id)
    return Response(
        document.content, media_type=MIME_TYPES[document.kind],
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(document.name)}"},
    )


@router.delete("/{document_id}", status_code=204)
def remove_document(document_id: UUID, owner: Owner, db: Database):
    document = get_document(db, owner, document_id)
    add_event(db, str(owner), "document_removed", document.name)
    db.delete(document)
    db.commit()
