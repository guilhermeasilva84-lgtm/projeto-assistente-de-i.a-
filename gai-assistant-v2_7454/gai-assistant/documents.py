import hashlib
import io
import json
import math
import re
import unicodedata
from collections import Counter
from functools import lru_cache
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile

import chromadb
import pandas as pd
from openpyxl import load_workbook
from pypdf import PdfReader

MAX_UPLOAD = 8 * 1024 * 1024
MAX_PAGES = 150
MAX_SHEETS = 10
MAX_CELLS = 240_000
MAX_EXPANDED = 48 * 1024 * 1024
STOP_WORDS = set(
    "a as o os de da das do dos em um uma e ou que qual quais como por para com no na "
    "nos nas se este esse esta essa documento arquivo pdf me sobre".split()
)


def normalize(text: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFKD", text.casefold())
        if not unicodedata.combining(char)
    )


def embedding(text: str) -> list[float]:
    weights = [0.0] * 1024
    words = Counter(re.findall(r"\b\w{2,}\b", normalize(text)))
    for word, count in words.items():
        if word not in STOP_WORDS:
            digest = hashlib.blake2s(word.encode(), digest_size=4).digest()
            index = int.from_bytes(digest[:2], "big") % len(weights)
            weights[index] += (1 if digest[2] % 2 else -1) * (1 + math.log(count))
    norm = math.sqrt(sum(weight * weight for weight in weights)) or 1
    return [weight / norm for weight in weights]


@lru_cache(maxsize=1)
def vector_store():
    return chromadb.EphemeralClient()


def extract_pdf(data: bytes) -> tuple[int, list[dict]]:
    pdf = PdfReader(io.BytesIO(data))
    if pdf.is_encrypted:
        raise ValueError("Este PDF está protegido por senha.")
    if len(pdf.pages) > MAX_PAGES:
        raise ValueError(f"O PDF pode ter até {MAX_PAGES} páginas.")

    chunks = []
    for page_number, page in enumerate(pdf.pages, 1):
        content = page.get_contents()
        if content is not None and len(content.get_data()) > 2_000_000:
            raise ValueError("O conteúdo de uma das páginas excede o limite de processamento.")
        text = re.sub(r"\s+", " ", page.extract_text() or "").strip()
        for start in range(0, len(text), 840):
            chunks.append({"text": text[start:start + 1050], "page": page_number})
        if len(chunks) > 2000:
            raise ValueError("O PDF excede o limite de texto extraído.")
    if not chunks:
        raise ValueError("Este PDF não contém texto selecionável. Use um PDF com texto ou OCR.")

    return len(pdf.pages), chunks


def pdf_context(data: bytes, name: str, question: str) -> dict:
    page_count, chunks = extract_pdf(data)
    query = normalize(question)
    if re.search(r"resum|sintese|visao geral|do que (trata|fala)", query):
        count = min(7, len(chunks))
        indexes = [round(i * (len(chunks) - 1) / max(1, count - 1)) for i in range(count)]
        excerpts = [chunks[i] for i in indexes]
    else:
        store = vector_store()
        collection = store.create_collection(f"pdf-{uuid4()}", embedding_function=None)
        try:
            collection.add(
                ids=[str(i) for i in range(len(chunks))],
                embeddings=[embedding(chunk["text"]) for chunk in chunks],
                documents=[chunk["text"] for chunk in chunks],
                metadatas=[{"page": chunk["page"]} for chunk in chunks],
            )
            result = collection.query(
                query_embeddings=[embedding(question)], n_results=min(6, len(chunks))
            )
            excerpts = [
                {"page": meta["page"], "text": text}
                for text, meta in zip(result["documents"][0], result["metadatas"][0])
            ]
        finally:
            store.delete_collection(collection.name)

    return {"type": "pdf", "name": name, "page_count": page_count, "excerpts": excerpts}


def clean_cells(frame: pd.DataFrame) -> list:
    return json.loads(frame.to_json(orient="records", date_format="iso"))


def excel_context(data: bytes, name: str, question: str) -> dict:
    with ZipFile(io.BytesIO(data)) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_EXPANDED:
            raise ValueError("A planilha descompactada excede o limite de tamanho.")

    book = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
    query = normalize(question)
    summaries = []
    consumed_cells = 0
    try:
        if len(book.worksheets) > MAX_SHEETS:
            raise ValueError(f"A planilha pode ter até {MAX_SHEETS} abas.")
        for sheet in book.worksheets:
            if sheet.max_row and sheet.max_column:
                if sheet.max_row * sheet.max_column + consumed_cells > MAX_CELLS:
                    raise ValueError("A planilha pode ter até 240 mil células.")
            rows = []
            for row in sheet.values:
                consumed_cells += max(1, len(row))
                if consumed_cells > MAX_CELLS:
                    raise ValueError("A planilha pode ter até 240 mil células.")
                if any(value is not None for value in row):
                    rows.append(row)
            if not rows:
                continue
            headers = []
            for i, value in enumerate(rows[0]):
                label = str(value).strip()[:140] if value is not None else f"Coluna {i + 1}"
                while label in headers:
                    label += f" ({i + 1})"
                headers.append(label)
            frame = pd.DataFrame(rows[1:], columns=headers)
            numbers = frame.select_dtypes(include="number")
            stats = {
                col: {
                    "sum": float(numbers[col].sum()), "average": float(numbers[col].mean()),
                    "min": float(numbers[col].min()), "max": float(numbers[col].max()),
                }
                for col in numbers if not numbers[col].dropna().empty
            }
            group_labels = [
                col for col in frame if col not in stats and 0 < frame[col].nunique() <= 2000
            ]
            group_labels.sort(
                key=lambda col: (
                    normalize(col) not in query,
                    not bool(re.search(r"vendedor|representante|consultor|colaborador", normalize(col))),
                )
            )
            metrics = sorted(
                stats,
                key=lambda col: (
                    normalize(col) not in query,
                    not bool(re.search(r"vend|receita|fatur|quant|valor|total", normalize(col))),
                ),
            )
            rankings = []
            for group in group_labels[:2]:
                for metric in metrics[:2]:
                    totals = frame.groupby(group, dropna=True, sort=False)[metric].sum(min_count=1)
                    totals = totals.dropna()
                    rankings.append({
                        "group": group,
                        "metric": metric,
                        "top": clean_cells(totals.nlargest(5).reset_index()),
                        "bottom": clean_cells(totals.nsmallest(5).reset_index()),
                    })
            sample = frame.iloc[:8, :18].copy()
            for column in sample.select_dtypes(include="object"):
                sample[column] = sample[column].map(
                    lambda value: value[:160] if isinstance(value, str) else value
                )
            summaries.append({
                "sheet": sheet.title, "rows": len(frame), "columns": headers[:30],
                "statistics": dict(list(stats.items())[:12]),
                "rankings": rankings, "sample": clean_cells(sample),
            })
    finally:
        book.close()

    if not summaries:
        raise ValueError("Nenhuma aba com dados foi encontrada.")
    summaries.sort(key=lambda sheet: normalize(sheet["sheet"]) not in query)
    return {"type": "excel", "name": name, "sheets": summaries}


def analyze_upload(name: str, data: bytes, question: str) -> dict:
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".xlsx"}:
        raise ValueError("Anexe um arquivo PDF ou Excel (.xlsx).")
    try:
        if suffix == ".pdf":
            return pdf_context(data, name, question)
        return excel_context(data, name, question)
    except ValueError:
        raise
    except (OSError, KeyError, TypeError, RuntimeError, EOFError, IndexError):
        raise ValueError("Não foi possível ler o arquivo. Verifique se ele está íntegro.") from None
    except Exception:
        raise ValueError("O formato do arquivo é inválido ou o conteúdo não pôde ser processado.") from None
