import hashlib
import hmac
import os
import re
import secrets
from collections import OrderedDict
from datetime import timedelta
from threading import Lock
from time import monotonic
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, SecretStr, StringConstraints
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import Account, LoginSession, as_utc, db_session, utcnow

router = APIRouter(prefix="/api/auth", tags=["Conta"])
SESSION_COOKIE = "gai_account"
SESSION_AGE = timedelta(days=7)
BrowserSession = Annotated[UUID, Header(alias="X-GAI-Session")]
Database = Annotated[Session, Depends(db_session)]
AuthToken = Annotated[str | None, Cookie(alias=SESSION_COOKIE)]
Email = Annotated[str, StringConstraints(strip_whitespace=True, max_length=254)]
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=100)]
WINDOW_SECONDS = 60
ATTEMPTS_PER_MINUTE = 15
attempts: OrderedDict[tuple[str, str], tuple[float, int]] = OrderedDict()
attempts_lock = Lock()


class LoginInput(BaseModel):
    email: Email
    password: SecretStr


class RegisterInput(LoginInput):
    name: DisplayName


def password_hash(password: str, salt: bytes) -> str:
    key = hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
    return f"{salt.hex()}:{key.hex()}"


def limit_auth(request: Request, action: str):
    key = (action, request.client.host if request.client else "unknown")
    now = monotonic()
    with attempts_lock:
        opened, count = attempts.get(key, (now, 0))
        if now - opened >= WINDOW_SECONDS:
            opened, count = now, 0
        if count >= ATTEMPTS_PER_MINUTE:
            retry_after = max(1, int(WINDOW_SECONDS - (now - opened)))
            raise HTTPException(429, "Muitas tentativas. Aguarde um minuto.", headers={"Retry-After": str(retry_after)})
        attempts[key] = (opened, count + 1)
        attempts.move_to_end(key)
        if len(attempts) > 2048:
            attempts.popitem(last=False)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def account_for_token(db: Session, token: str | None) -> Account | None:
    if not token or len(token) != 43:
        return None
    session = db.get(LoginSession, token_digest(token))
    if not session or as_utc(session.expires_at) <= utcnow():
        return None
    return db.get(Account, session.account_id)


def workspace_owner(browser: BrowserSession, db: Database, token: AuthToken = None) -> UUID:
    account = account_for_token(db, token)
    account_id = account.id if account else None
    if token:
        db.rollback()
    if account_id:
        return UUID(account_id)
    if browser.version != 4:
        raise HTTPException(422, "Identificador de navegador inválido.")
    return browser


Owner = Annotated[UUID, Depends(workspace_owner)]


def account_view(account: Account | None) -> dict | None:
    if account:
        return {"id": account.id, "name": account.name, "email": account.email}
    return None


def start_session(db: Session, account: Account, response: Response):
    token = secrets.token_urlsafe(32)
    db.execute(delete(LoginSession).where(LoginSession.expires_at < utcnow()))
    db.add(LoginSession(
        digest=token_digest(token), account_id=account.id, expires_at=utcnow() + SESSION_AGE,
    ))
    db.commit()
    response.set_cookie(
        SESSION_COOKIE, token, max_age=int(SESSION_AGE.total_seconds()), httponly=True,
        samesite="lax", secure=os.getenv("GAI_SECURE_COOKIES", "").casefold() == "true",
        path="/",
    )


@router.get("/me")
def me(browser: BrowserSession, db: Database, token: AuthToken = None):
    return {"account": account_view(account_for_token(db, token))}


@router.post("/register", status_code=201)
def register(data: RegisterInput, browser: BrowserSession, db: Database, response: Response, request: Request):
    limit_auth(request, "register")
    email = data.email.casefold()
    password = data.password.get_secret_value()
    if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(422, "Informe um e-mail válido.")
    if not 10 <= len(password) <= 128:
        raise HTTPException(422, "Use uma senha de 10 a 128 caracteres.")
    account = Account(name=data.name, email=email, password_hash=password_hash(password, secrets.token_bytes(16)))
    db.add(account)
    try:
        db.flush()
    except IntegrityError as error:
        raise HTTPException(409, "Este e-mail já está cadastrado.") from error
    start_session(db, account, response)
    return {"account": account_view(account)}


@router.post("/login")
def login(data: LoginInput, browser: BrowserSession, db: Database, response: Response, request: Request):
    limit_auth(request, "login")
    password = data.password.get_secret_value()
    if not 10 <= len(password) <= 128:
        raise HTTPException(401, "E-mail ou senha incorretos.")
    account = db.scalar(select(Account).where(Account.email == data.email.casefold()))
    salt = bytes.fromhex(account.password_hash.split(":", 1)[0]) if account else bytes(16)
    attempted_hash = password_hash(password, salt)
    if not account or not hmac.compare_digest(attempted_hash, account.password_hash):
        raise HTTPException(401, "E-mail ou senha incorretos.")
    start_session(db, account, response)
    return {"account": account_view(account)}


@router.post("/logout", status_code=204)
def logout(browser: BrowserSession, db: Database, response: Response, token: AuthToken = None):
    if token and len(token) == 43:
        db.execute(delete(LoginSession).where(LoginSession.digest == token_digest(token)))
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")
