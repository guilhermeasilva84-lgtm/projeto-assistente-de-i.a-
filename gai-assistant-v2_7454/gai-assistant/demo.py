from datetime import timedelta
from io import BytesIO

from openpyxl import Workbook
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from .database import utcnow
from .knowledge import build_document

DEMO_TICKETS = (
    ("Equipe financeira sem acesso ao TOTVS", "O login retorna acesso negado para o financeiro durante o fechamento.", "TOTVS", "Acesso", "Crítica", "in_progress", 6),
    ("VPN expira durante o expediente", "A conexão cai depois de alguns minutos para usuários no trabalho remoto.", "VPN", "Conectividade", "Alta", "open", 3),
    ("Atualizar acesso ao relatório comercial", "Adicionar a nova analista ao grupo de leitura do relatório.", "Power BI", "Acesso", "Média", "open", 4),
    ("Orientação para assinatura digital", "Solicitante precisa do procedimento para configurar a assinatura no Outlook.", "Outlook", "Orientação", "Baixa", "open", 1),
    ("Falha no envio do relatório diário", "O disparo automático foi restaurado após revisão da fila.", "Oracle", "Operação", "Alta", "resolved", 32),
    ("Documentar a troca de senha", "Procedimento publicado e revisado com a equipe de suporte.", "Microsoft 365", "Documentação", "Baixa", "closed", 56),
)


def guide_pdf() -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({
            NameObject("/F1"): DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
                NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
            }),
        }),
    })
    lines = [
        "Runbook de Acesso | Central de TI",
        "",
        "TOTVS: Falha de login",
        "Confirme a mensagem de erro e o horário da ocorrência.",
        "Verifique a VPN, o status da conta e a política de bloqueio.",
        "Se o acesso estiver bloqueado, encaminhe para Gestão de Identidades.",
        "",
        "VPN: Conexão instável",
        "Confirme o cliente de VPN e a versão instalada.",
        "Colete os horários das quedas e valide a conectividade local.",
        "",
        "SLA: Ocorrência crítica",
        "Prazo-alvo de 4 horas para resolução em caso de impacto crítico.",
    ]
    stream = DecodedStreamObject()
    operations = ["BT /F1 12 Tf 45 742 Td"]
    for index, line in enumerate(lines):
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        if index:
            operations.append("0 -23 Td")
        operations.append(f"({escaped}) Tj")
    operations.append("ET")
    stream.set_data(" ".join(operations).encode("cp1252"))
    page[NameObject("/Contents")] = stream
    target = BytesIO()
    writer.write(target)
    return target.getvalue()


def sales_xlsx() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Vendas"
    for row in (
        ("Vendedor", "Vendas", "Região"), ("Felipe", 800, "Sudeste"),
        ("Ana", 950, "Sul"), ("Felipe", 430, "Sudeste"), ("Lívia", 610, "Nordeste"),
        ("Ana", 210, "Sul"), ("Lívia", 105, "Nordeste"),
    ):
        sheet.append(row)
    target = BytesIO()
    workbook.save(target)
    workbook.close()
    return target.getvalue()


def demo_documents(owner: str):
    for name, content, description in (
        ("Runbook de acesso.pdf", guide_pdf(), "Procedimentos de suporte para TOTVS, VPN e incidentes críticos."),
        ("Vendas por equipe.xlsx", sales_xlsx(), "Amostra fictícia de vendas por vendedor e por região."),
    ):
        yield build_document(owner, name, content, description)
