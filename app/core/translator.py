import logging
import re
from collections import Counter
from pathlib import Path
from threading import Lock
from typing import Callable, Mapping, Optional, Tuple

from .entity_detector import (
    ExtractedEntities,
    detect_entities,
    find_glossary_matches,
    find_numeric_matches,
)
from .glossary import Glossary


logger = logging.getLogger(__name__)
LanguagePair = Tuple[str, str]
PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCAL_MODELS_DIR = PROJECT_ROOT / "models"
TRANSLATION_MODELS_DIR = LOCAL_MODELS_DIR / "flagship-ai" / "cameroon-int8"
OPUS_EN_FR_MODEL_DIR = LOCAL_MODELS_DIR / "opus-mt-en-fr"
TRANSLATION_MODEL_FILES = (
    "config.json",
    "model.bin",
    "source.spm",
    "target.spm",
    "tokenizer_config.json",
    "vocab.json",
)


class TranslationResult:
    def __init__(
        self,
        translated: str,
        locked_terms: dict,
        entities: ExtractedEntities,
        fallback_used: bool,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
    ):
        self.translated = translated
        self.locked_terms = locked_terms
        self.entities = entities
        self.fallback_used = fallback_used
        self.error_code = error_code
        self.error_message = error_message


class LockedTranslator:
    REPO_ID = "flagship-ai/cameroon-int8"

    # Les noms de dossiers suivent exactement le dépôt Hugging Face.
    # Le modèle appelle le Fulfulde « fufulde » dans le nom de dossier.
    DEFAULT_MODEL_PAIRS = {
        ("en", "fr"): "english-francais",
        ("fr", "ewondo"): "francais-ewondo",
        ("fr", "fulfulde"): "francais-fufulde",
        ("fr", "fufulde"): "francais-fufulde",
        ("ewondo", "fr"): "ewondo-francais",
        ("fulfulde", "fr"): "fufulde-francais",
        ("fufulde", "fr"): "fufulde-francais",
    }
    PRIMARY_TARGET_PAIRS = {
        "ewondo": ("fr", "ewondo"),
        "fulfulde": ("fr", "fulfulde"),
    }
    LANGUAGE_ALIASES = {
        "ewo": "ewondo",
        "fufulde": "fulfulde",
    }

    def __init__(
        self,
        glossary: Glossary,
        nmt: Optional[Callable[[str, str], str]] = None,
        model_pairs: Optional[Mapping[LanguagePair, str]] = None,
    ):
        self.glossary = glossary
        # L'injection nmt reste disponible pour les tests unitaires.
        self._nmt = nmt
        self.model_pairs = dict(self.DEFAULT_MODEL_PAIRS)
        if model_pairs:
            self.model_pairs.update(model_pairs)

        # Les modèles sont téléchargés et chargés au premier usage de chaque paire.
        self._models = {}
        self._model_errors = {}
        self._model_lock = Lock()

    @property
    def model_status(self) -> dict:
        status = {}
        for language, pair in self.PRIMARY_TARGET_PAIRS.items():
            if pair in self._models:
                status[language] = "loaded"
            elif pair in self._model_errors:
                status[language] = "unavailable"
            else:
                status[language] = "not_loaded"
        return status

    @staticmethod
    def _select_non_overlapping_spans(spans):
        spans.sort(key=lambda item: (item[0], -(item[1] - item[0])))
        selected = []
        occupied_until = -1
        for span in spans:
            if span[0] < occupied_until:
                continue
            selected.append(span)
            occupied_until = span[1]
        return selected

    def _protect_sensitive_text(
        self, text: str, target_lang: str, protected_terms=()
    ):
        spans = []
        for start, end, value in find_numeric_matches(text):
            spans.append((start, end, "numeric", value, value))

        for start, end, term in find_glossary_matches(text, self.glossary.source_terms()):
            original = text[start:end]
            target = self.glossary.lookup(term, target_lang)
            spans.append((start, end, "glossary", original, target or original))

        # Les noms transmis séparément (ex. le bénéficiaire) ne partent jamais au NMT.
        for term in protected_terms or ():
            if not isinstance(term, str) or not term.strip():
                continue
            pattern = re.compile(
                rf"(?<!\w){re.escape(term.strip())}(?!\w)", re.IGNORECASE | re.UNICODE
            )
            for match in pattern.finditer(text):
                original = match.group(0)
                spans.append((match.start(), match.end(), "private", original, original))

        selected = self._select_non_overlapping_spans(spans)
        chunks = []
        locked_terms = {}
        fallback_used = False
        cursor = 0

        for start, end, kind, original, restored_value in selected:
            chunks.append((False, text[cursor:start]))
            # Ces segments restent hors du modèle puis sont réinsérés tels quels.
            chunks.append((True, restored_value))
            if kind == "glossary":
                locked_terms[original] = restored_value
                if restored_value == original:
                    # Un terme sensible sans traduction validée reste inchangé.
                    fallback_used = True
            cursor = end

        chunks.append((False, text[cursor:]))
        return chunks, locked_terms, fallback_used

    def _load_model(self, pair: LanguagePair):
        if self._nmt is not None:
            return None

        with self._model_lock:
            if pair in self._models:
                return self._models[pair]
            if pair in self._model_errors:
                raise RuntimeError(self._model_errors[pair])

            folder = self.model_pairs.get(pair)
            if not folder:
                raise LookupError("Aucun dossier de modèle n'est défini pour cette paire.")

            try:
                if pair == ("en", "fr"):
                    required_files = (
                        "config.json",
                        "generation_config.json",
                        "pytorch_model.bin",
                        "source.spm",
                        "target.spm",
                        "tokenizer_config.json",
                        "vocab.json",
                    )
                    missing_files = [
                        name
                        for name in required_files
                        if not (OPUS_EN_FR_MODEL_DIR / name).is_file()
                    ]
                    if missing_files:
                        raise FileNotFoundError(
                            "Le modèle anglais→français local est absent ou incomplet dans "
                            f"{OPUS_EN_FR_MODEL_DIR}. Lancez « python scripts/download_models.py » "
                            f"avant de démarrer la démonstration (fichiers manquants : "
                            f"{', '.join(missing_files)})."
                        )

                    from transformers import MarianMTModel, MarianTokenizer

                    tokenizer = MarianTokenizer.from_pretrained(
                        str(OPUS_EN_FR_MODEL_DIR),
                        local_files_only=True,
                    )
                    model = MarianMTModel.from_pretrained(
                        str(OPUS_EN_FR_MODEL_DIR),
                        local_files_only=True,
                    )
                    model.eval()
                    self._models[pair] = (tokenizer, model)
                    self._model_errors.pop(pair, None)
                    return self._models[pair]

                import ctranslate2
                from huggingface_hub import snapshot_download
                from transformers import MarianTokenizer

                # Le dossier du projet est la source prioritaire et le stockage durable.
                allow_patterns = [f"{folder}/*"]
                model_path = TRANSLATION_MODELS_DIR / folder
                model_is_ready = (
                    model_path.is_dir()
                    and ctranslate2.contains_model(str(model_path))
                    and all((model_path / name).is_file() for name in TRANSLATION_MODEL_FILES)
                )
                if not model_is_ready:
                    snapshot_path = snapshot_download(
                        repo_id=self.REPO_ID,
                        allow_patterns=allow_patterns,
                        local_dir=str(TRANSLATION_MODELS_DIR),
                    )
                    model_path = Path(snapshot_path) / folder
                model_is_ready = (
                    model_path.is_dir()
                    and ctranslate2.contains_model(str(model_path))
                    and all((model_path / name).is_file() for name in TRANSLATION_MODEL_FILES)
                )
                if not model_is_ready:
                    raise FileNotFoundError(f"Le dossier de modèle {folder} est incomplet.")

                # Le tokenizer est fourni dans le même sous-dossier que model.bin.
                tokenizer = MarianTokenizer.from_pretrained(
                    str(model_path), local_files_only=True
                )
                translator = ctranslate2.Translator(
                    str(model_path),
                    device="cpu",
                    compute_type="int8",
                    inter_threads=1,
                )
                self._models[pair] = (tokenizer, translator)
                self._model_errors.pop(pair, None)
                return self._models[pair]
            except Exception as error:
                self._model_errors[pair] = str(error)
                logger.warning(
                    "Modèle indisponible pour %s→%s (%s) : %s",
                    pair[0], pair[1], folder, error,
                )
                raise

    @staticmethod
    def _run_ctranslate2(model_bundle, text: str) -> str:
        tokenizer, translator = model_bundle
        source_tokens = tokenizer.convert_ids_to_tokens(tokenizer.encode(text))
        results = translator.translate_batch(
            [source_tokens],
            beam_size=4,
            max_decoding_length=256,
            repetition_penalty=1.15,
            no_repeat_ngram_size=3,
        )
        target_tokens = results[0].hypotheses[0]
        target_ids = tokenizer.convert_tokens_to_ids(target_tokens)
        return tokenizer.decode(target_ids, skip_special_tokens=True).strip()

    @staticmethod
    def _run_transformers(model_bundle, text: str) -> str:
        import torch

        tokenizer, model = model_bundle
        inputs = tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=512,
        )
        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                num_beams=4,
                max_new_tokens=256,
                renormalize_logits=True,
            )
        return tokenizer.decode(output_ids[0], skip_special_tokens=True).strip()

    @staticmethod
    def _has_translatable_content(text: str, allow_short_segments: bool = False) -> bool:
        words = re.findall(r"[^\W\d_]+", text, flags=re.UNICODE)
        return len(words) >= 1 if allow_short_segments else len(words) >= 3

    @staticmethod
    def _has_excessive_repetition(source: str, translated: str) -> bool:
        """Rejette une sortie NMT qui boucle sur un même mot hors du texte source."""
        source_words = re.findall(r"[^\W\d_]+", source.casefold(), flags=re.UNICODE)
        translated_words = re.findall(
            r"[^\W\d_]+", translated.casefold(), flags=re.UNICODE
        )
        if len(translated_words) < 12:
            return False

        source_counts = Counter(source_words)
        translated_counts = Counter(translated_words)
        return any(
            count >= 8 and count - source_counts.get(word, 0) >= 6
            for word, count in translated_counts.items()
        )

    @staticmethod
    def _translate_text_segment(
        text: str,
        translate_segment: Callable[[str], str],
        allow_short_segments: bool = False,
    ) -> Tuple[str, bool]:
        """Traduit un segment non numérique en conservant ses espaces de bord."""
        if not text or not text.strip():
            return text, False

        leading_length = len(text) - len(text.lstrip())
        trailing_length = len(text) - len(text.rstrip())
        end = len(text) - trailing_length if trailing_length else len(text)
        leading = text[:leading_length]
        core = text[leading_length:end]
        trailing = text[end:]

        # Les ponctuations seules restent intactes et n'ont pas besoin du modèle.
        if not re.search(r"[^\W\d_]", core, flags=re.UNICODE):
            return text, False
        if re.search(r"\d", core):
            raise ValueError("Une séquence numérique n'a pas été isolée avant traduction.")

        # Les fragments trop courts provoquent souvent des réponses répétitives.
        if not LockedTranslator._has_translatable_content(core, allow_short_segments):
            return text, True

        translated = translate_segment(core)
        if not isinstance(translated, str) or not translated.strip():
            raise ValueError("Le modèle n’a renvoyé aucun texte.")
        if re.search(r"\d", translated):
            raise ValueError("Le modèle a inventé un chiffre dans un segment sans montant.")
        if LockedTranslator._has_excessive_repetition(core, translated):
            raise ValueError("Le modèle a produit une répétition anormale.")
        return leading + translated + trailing, False

    @staticmethod
    def _numbers_are_unchanged(original: str, translated: str) -> bool:
        original_values = [value for _, _, value in find_numeric_matches(original)]
        translated_values = [value for _, _, value in find_numeric_matches(translated)]
        return original_values == translated_values

    @staticmethod
    def _fallback(
        text: str,
        entities: ExtractedEntities,
        locked_terms: dict,
        error_code: str,
        error_message: str,
    ) -> TranslationResult:
        # Retourne la phrase d'origine entière en cas de doute sur le modèle.
        return TranslationResult(
            translated=text,
            locked_terms=locked_terms,
            entities=entities,
            fallback_used=True,
            error_code=error_code,
            error_message=error_message,
        )

    def translate(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        protected_terms=(),
        allow_short_segments: bool = False,
    ) -> TranslationResult:
        if not isinstance(source_lang, str) or not isinstance(target_lang, str):
            return self._translate_pair(
                text, source_lang, target_lang, protected_terms, allow_short_segments
            )

        source_lang = source_lang.strip().lower()
        normalized_target = target_lang.strip().lower()
        target_lang = self.LANGUAGE_ALIASES.get(normalized_target, normalized_target)
        if source_lang != "en" or target_lang not in {"ewondo", "fulfulde"}:
            return self._translate_pair(
                text, source_lang, target_lang, protected_terms, allow_short_segments
            )

        if not isinstance(text, str) or not text.strip():
            return self._translate_pair(
                text, source_lang, target_lang, protected_terms, allow_short_segments
            )

        entities = (
            detect_entities(text, self.glossary.source_terms())
            if isinstance(text, str)
            else ExtractedEntities()
        )
        direct_error = None
        direct_pair = ("en", target_lang)

        # Un modèle direct peut être ajouté via model_pairs sans changer le pipeline.
        if direct_pair in self.model_pairs:
            direct_result = self._translate_pair(
                text, "en", target_lang, protected_terms, allow_short_segments
            )
            if direct_result.error_code is None:
                return direct_result
            direct_error = direct_result.error_message or direct_result.error_code

        # Le bundle Flagship fournit les paires vers/depuis le français.
        english_french = self._translate_pair(
            text, "en", "fr", protected_terms, allow_short_segments
        )
        if english_french.error_code:
            return self._fallback(
                text if isinstance(text, str) else "",
                entities,
                english_french.locked_terms,
                "pivot_failed",
                english_french.error_message
                or (
                    "La traduction anglaise vers "
                    f"{target_lang.capitalize()} a échoué pendant le passage par le français."
                ),
            )

        french_target = self._translate_pair(
            english_french.translated,
            "fr",
            target_lang,
            protected_terms,
            allow_short_segments,
        )
        if french_target.error_code:
            return self._fallback(
                text,
                entities,
                french_target.locked_terms,
                "pivot_failed",
                (
                    "La traduction du français vers "
                    f"{target_lang.capitalize()} a échoué ; le texte source est conservé."
                ),
            )

        return TranslationResult(
            translated=french_target.translated,
            locked_terms=french_target.locked_terms,
            entities=entities,
            fallback_used=(
                direct_error is not None
                or english_french.fallback_used
                or french_target.fallback_used
            ),
        )

    def _translate_pair(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        protected_terms=(),
        allow_short_segments: bool = False,
    ) -> TranslationResult:
        if not isinstance(text, str):
            return self._fallback(
                "", ExtractedEntities(), {}, "invalid_text", "Le texte à traduire est invalide."
            )

        if not text.strip():
            return self._fallback(
                "", ExtractedEntities(), {}, "empty_text", "Le texte à traduire est vide."
            )

        if not isinstance(source_lang, str) or not isinstance(target_lang, str):
            return self._fallback(
                text,
                detect_entities(text, self.glossary.source_terms()),
                {},
                "unsupported_language_pair",
                "La paire de langues demandée est invalide.",
            )

        source_lang = source_lang.strip().lower()
        target_lang = target_lang.strip().lower()
        entities = detect_entities(text, self.glossary.source_terms())

        if (source_lang, target_lang) not in self.model_pairs and self._nmt is None:
            return self._fallback(
                text,
                entities,
                {},
                "unsupported_language_pair",
                f"La paire {source_lang} vers {target_lang} n’est pas configurée.",
            )

        segments, locked_terms, fallback_used = self._protect_sensitive_text(
            text, target_lang, protected_terms
        )
        pair = (source_lang, target_lang)

        has_translatable_text = any(
            not protected and self._has_translatable_content(segment, allow_short_segments)
            for protected, segment in segments
        )
        if has_translatable_text and self._nmt is None:
            try:
                self._load_model(pair)
            except Exception as error:
                return self._fallback(
                    text,
                    entities,
                    locked_terms,
                    "model_unavailable",
                    (
                        str(error)
                        if isinstance(error, FileNotFoundError)
                        else "Le modèle de cette langue est indisponible ; le texte original est conservé."
                    ),
                )

        try:
            translated_parts = []
            skipped_short_segment = False
            for protected, segment in segments:
                if protected:
                    translated_parts.append(segment)
                    continue

                if self._nmt is not None:
                    translate_segment = lambda chunk: self._nmt(chunk, target_lang)
                elif pair == ("en", "fr"):
                    translate_segment = lambda chunk: self._run_transformers(
                        self._models[pair], chunk
                    )
                else:
                    translate_segment = lambda chunk: self._run_ctranslate2(
                        self._models[pair], chunk
                    )
                translated_segment, skipped = self._translate_text_segment(
                    segment, translate_segment, allow_short_segments
                )
                translated_parts.append(translated_segment)
                skipped_short_segment = skipped_short_segment or skipped

            translated = "".join(translated_parts)
            if not self._numbers_are_unchanged(text, translated):
                raise ValueError("Les données numériques ne correspondent plus au texte source.")
        except Exception:
            if self._nmt is not None:
                error_code = "nmt_failed"
            elif pair not in self._models:
                error_code = "model_unavailable"
            else:
                error_code = "translation_failed"
            return self._fallback(
                text,
                entities,
                locked_terms,
                error_code,
                "La traduction est indisponible ; le texte original est conservé.",
            )

        return TranslationResult(
            translated=translated,
            locked_terms=locked_terms,
            entities=entities,
            fallback_used=fallback_used or skipped_short_segment,
        )
