"""Moteur de synthèse vocale pour les langues prises en charge par Africa TTS."""

from __future__ import annotations

import io
import logging
from pathlib import Path
from threading import Lock

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCAL_TTS_MODEL_DIR = PROJECT_ROOT / "models" / "africa-tts"
TTS_REPO_ID = "AfriSpeech/africa-tts"
TTS_MODEL_FILES = ("config.yaml", "model.safetensors", "tokenizer.json")

# Les noms utilisés par l'interface sont convertis en codes ISO 639-3.
LANGUAGE_ALIASES = {
    "ewondo": "ewo",
    "fulfulde": "ful",
}

_engine = None
_engine_lock = Lock()
_generation_lock = Lock()


class UnsupportedLanguageError(ValueError):
    """Levée quand Africa TTS ne possède pas de voix entraînée pour ce code."""


class AudioGenerationError(RuntimeError):
    """Levée si le chargement ou la synthèse vocale échoue."""


def supported_languages() -> dict[str, dict]:
    """Retourne le catalogue réellement exposé par la version installée."""
    try:
        from africa_tts.languages import languages
    except ImportError as error:
        raise AudioGenerationError(
            "Africa TTS n'est pas installé. Installez-le avec « pip install africa-tts »."
        ) from error
    return languages()


def _normalize_language_code(lang_code: str) -> str:
    if not isinstance(lang_code, str) or not lang_code.strip():
        raise UnsupportedLanguageError("Le code de langue est obligatoire.")
    normalized = lang_code.strip().lower()
    return LANGUAGE_ALIASES.get(normalized, normalized)


def _get_engine():
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                try:
                    from africa_tts import AfricaTTS
                    from huggingface_hub import snapshot_download

                    model_is_ready = (
                        all((LOCAL_TTS_MODEL_DIR / name).is_file() for name in TTS_MODEL_FILES)
                        and any((LOCAL_TTS_MODEL_DIR / "voices").glob("*.wav"))
                    )
                    if not model_is_ready:
                        snapshot_download(
                            repo_id=TTS_REPO_ID,
                            allow_patterns=[*TTS_MODEL_FILES, "voices/*.wav"],
                            local_dir=str(LOCAL_TTS_MODEL_DIR),
                        )

                    _engine = AfricaTTS.load(
                        name=str(LOCAL_TTS_MODEL_DIR),
                        download=False,
                    )
                except Exception as error:
                    logger.exception("Impossible de charger Africa TTS.")
                    raise AudioGenerationError(
                        "Le moteur Africa TTS n'a pas pu charger son modèle vocal. "
                        "Vérifiez que le modèle est présent dans le dossier models/."
                    ) from error
    return _engine


def generate_audio(text: str, lang_code: str) -> bytes:
    """Génère un fichier WAV en mémoire pour le code ISO 639-3 demandé."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Le texte à prononcer ne peut pas être vide.")

    normalized_code = _normalize_language_code(lang_code)
    catalog = supported_languages()
    if normalized_code not in catalog:
        requested_name = LANGUAGE_ALIASES.get(lang_code.strip().lower(), lang_code.strip())
        if normalized_code == "ful":
            message = (
                "Fulfulde (ful) n'est pas disponible dans la liste des langues entraînées "
                "par Africa TTS. Aucune voix par défaut n'a été utilisée."
            )
        else:
            message = (
                f"La langue « {requested_name} » ({normalized_code}) n'est pas prise en charge "
                "par le catalogue Africa TTS installé."
            )
        raise UnsupportedLanguageError(message)

    try:
        import soundfile as sf

        # L'accès au moteur est sérialisé pour protéger le modèle partagé en CPU.
        with _generation_lock:
            engine = _get_engine()
            audio = engine.generate(text.strip(), lang=normalized_code)

        if audio is None or len(audio) == 0:
            raise RuntimeError("Africa TTS a produit un flux audio vide.")

        output = io.BytesIO()
        sf.write(
            output,
            audio,
            engine.sample_rate,
            format="WAV",
            subtype="PCM_16",
        )
        return output.getvalue()
    except AudioGenerationError:
        raise
    except Exception as error:
        logger.exception("La synthèse Africa TTS a échoué pour le code %s.", normalized_code)
        raise AudioGenerationError(
            "Africa TTS n'a pas pu générer l'audio demandé. Réessayez dans un instant."
        ) from error
