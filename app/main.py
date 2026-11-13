import secrets
import time
from threading import Lock

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, StrictBool, StrictInt, StrictStr, field_validator
from fastapi.staticfiles import StaticFiles

from app.core.confirmation import build_confirmation, build_transfer_preview
from app.core.glossary import Glossary
from app.core.translator import LockedTranslator
from app.core.tts_engine import (
    AudioGenerationError,
    UnsupportedLanguageError,
    generate_audio,
    supported_languages,
)
from app.services import mock_financial


app = FastAPI(title="BCT API", version="0.2.0")
app.mount("/static", StaticFiles(directory="static"), name="static")

glossary = Glossary()
translator = LockedTranslator(glossary)
MAX_AMOUNT = 10_000_000
TRANSFER_CONFIRMATION_TTL_SECONDS = 300
_PENDING_TRANSFERS = {}
_PENDING_TRANSFERS_LOCK = Lock()


@app.get("/")
def home():
    """Affiche la démo BCT quand on ouvre directement l'adresse du serveur."""
    return FileResponse("static/index.html")


class TranslateRequest(BaseModel):
    text: StrictStr = Field(max_length=4000)
    source_lang: StrictStr = "fr"
    target_lang: StrictStr = "ewondo"
    protected_terms: list[StrictStr] = Field(default_factory=list, max_length=20)
    allow_short_segments: StrictBool = False


class TranslateBatchRequest(BaseModel):
    items: list[TranslateRequest] = Field(min_length=1, max_length=20)


class TranslateErrorRequest(BaseModel):
    text: StrictStr = Field(max_length=1000)
    source_lang: StrictStr = "fr"
    target_lang: StrictStr = "ewondo"


class SpeakRequest(BaseModel):
    text: StrictStr = Field(max_length=4000)
    lang_code: StrictStr = Field(min_length=2, max_length=16)


class FeeRequest(BaseModel):
    amount: StrictInt = Field(gt=0, le=MAX_AMOUNT)


class TransferRequest(BaseModel):
    sender: StrictStr = "default"
    beneficiary: StrictStr = Field(min_length=1, max_length=100)
    amount: StrictInt = Field(gt=0, le=MAX_AMOUNT)

    @field_validator("beneficiary")
    @classmethod
    def beneficiary_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Le bénéficiaire ne peut pas être vide.")
        return value


class TransferConfirmationRequest(BaseModel):
    request_id: StrictStr = Field(min_length=32, max_length=128)


def _translation_payload(result):
    payload = {
        "translated": result.translated,
        "locked_terms": result.locked_terms,
        "entities": {
            "amounts": result.entities.amounts,
            "phone_numbers": result.entities.phone_numbers,
            "glossary_terms": result.entities.glossary_terms,
        },
        "fallback_used": result.fallback_used,
    }
    if result.error_code:
        payload["error"] = {
            "code": result.error_code,
            "message": result.error_message,
        }
    return payload


def _translation_response(result):
    payload = _translation_payload(result)
    if result.error_code in {
        "invalid_text",
        "empty_text",
        "unsupported_source_language",
        "unsupported_target_language",
        "unsupported_language_pair",
    }:
        return JSONResponse(status_code=422, content=payload)
    return payload


@app.get("/health")
def health():
    return {
        "status": "ok",
        "glossary_terms": len(glossary.terms),
        "models": translator.model_status,
    }


@app.post("/translate")
def translate(req: TranslateRequest):
    result = translator.translate(
        req.text,
        req.source_lang,
        req.target_lang,
        req.protected_terms,
        req.allow_short_segments,
    )
    return _translation_response(result)


@app.post("/translate-batch")
def translate_batch(req: TranslateBatchRequest):
    """Traduit un petit lot de textes dans une seule requête HTTP."""
    results = []
    for item in req.items:
        result = translator.translate(
            item.text,
            item.source_lang,
            item.target_lang,
            item.protected_terms,
            item.allow_short_segments,
        )
        results.append(_translation_payload(result))
    return {"results": results}


@app.post("/translate-error")
def translate_error(req: TranslateErrorRequest):
    """Traduit un message d'erreur en protégeant chiffres et termes financiers."""
    result = translator.translate(req.text, req.source_lang, req.target_lang)
    return _translation_response(result)


@app.get("/speak/languages")
def speak_languages():
    """Expose les codes entraînés afin que l'interface signale les langues absentes."""
    try:
        return {"languages": supported_languages()}
    except AudioGenerationError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/speak")
def speak(req: SpeakRequest):
    """Renvoie une confirmation audio WAV dans la langue demandée."""
    if not req.text.strip():
        raise HTTPException(status_code=422, detail="Le texte à prononcer ne peut pas être vide.")
    try:
        audio_bytes = generate_audio(req.text, req.lang_code)
    except UnsupportedLanguageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except AudioGenerationError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": 'inline; filename="bct-confirmation.wav"'},
    )


@app.post("/fees")
def fees(req: FeeRequest):
    fee = mock_financial.calculate_fee(req.amount)
    return {
        "amount": req.amount,
        "fee": fee,
        "total": req.amount + fee,
        "currency": "FCFA",
    }


def transfer(req: TransferRequest):
    """Exécute un transfert après validation de l'intention de confirmation."""
    response = mock_financial.transfer(req.sender, req.beneficiary, req.amount)
    confirmation = build_confirmation(
        response, req.amount, response.fee, req.beneficiary
    )
    transaction = {
        "status": response.status,
        "amount": response.amount,
        "fee": response.fee,
        "beneficiary": response.beneficiary,
        "reference": response.reference,
        "balance_after": response.balance_after,
    }

    payload = {"transaction": transaction, "confirmation": confirmation}
    if response.error:
        transaction["error"] = response.error
        payload["error"] = {
            "code": "insufficient_funds",
            "message": response.error,
        }
    return payload


def _discard_expired_transfer_intents(now: float) -> None:
    expired = [
        request_id
        for request_id, item in _PENDING_TRANSFERS.items()
        if item["expires_at"] <= now
    ]
    for request_id in expired:
        _PENDING_TRANSFERS.pop(request_id, None)


@app.post("/transfer")
def prepare_transfer(req: TransferRequest):
    """Prépare un récapitulatif sans débiter le compte."""
    fee = mock_financial.calculate_fee(req.amount)
    total = req.amount + fee
    balance = mock_financial.get_balance(req.sender)
    if balance < total:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Solde insuffisant. Solde disponible : {balance} FCFA ; "
                f"total requis : {total} FCFA."
            ),
        )

    now = time.time()
    request_id = secrets.token_urlsafe(24)
    expires_at = now + TRANSFER_CONFIRMATION_TTL_SECONDS
    with _PENDING_TRANSFERS_LOCK:
        _discard_expired_transfer_intents(now)
        _PENDING_TRANSFERS[request_id] = {
            "request": req.model_copy(deep=True),
            "expires_at": expires_at,
            "response": None,
        }

    return {
        "request_id": request_id,
        "expires_in_seconds": TRANSFER_CONFIRMATION_TTL_SECONDS,
        "transaction": {
            "status": "pending_confirmation",
            "beneficiary": req.beneficiary,
            "amount": req.amount,
            "fee": fee,
            "total": total,
            "balance_before": balance,
        },
        "confirmation": build_transfer_preview(req.amount, fee, req.beneficiary),
    }


@app.post("/transfer/confirm")
def confirm_transfer(req: TransferConfirmationRequest):
    """Débite le compte une seule fois après confirmation du récapitulatif."""
    now = time.time()
    with _PENDING_TRANSFERS_LOCK:
        _discard_expired_transfer_intents(now)
        pending = _PENDING_TRANSFERS.get(req.request_id)
        if pending is None:
            raise HTTPException(
                status_code=410,
                detail="Cette confirmation a expiré ou a déjà été supprimée. Préparez à nouveau le transfert.",
            )
        if pending["response"] is None:
            pending["response"] = transfer(pending["request"])
        return pending["response"]


@app.get("/balance")
def balance(sender: str = "default"):
    return {"sender": sender, "balance": mock_financial.get_balance(sender)}
