import json
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from app.core.entity_detector import detect_entities, find_numeric_matches
from app.core.glossary import Glossary
from app.core.translator import LockedTranslator

from app.main import (
    FeeRequest,
    TranslateErrorRequest,
    TranslateRequest,
    TransferRequest,
    fees,
    translate,
    translate_error,
    transfer,
)
from app.services import mock_financial

# Les tests unitaires utilisent une traduction identité pour ne pas contacter HF.
import app.main as main_module
main_module.translator = LockedTranslator(
    Glossary(), nmt=lambda protected_text, target_lang: protected_text
)


class FeeAndTransferTests(unittest.TestCase):
    def setUp(self):
        self.original_accounts = dict(mock_financial._ACCOUNTS)
        mock_financial._ACCOUNTS.clear()
        mock_financial._ACCOUNTS.update({"default": 50_000})

    def tearDown(self):
        mock_financial._ACCOUNTS.clear()
        mock_financial._ACCOUNTS.update(self.original_accounts)

    def test_fee_schedule_is_shared_with_transfer(self):
        self.assertEqual(fees(FeeRequest(amount=5_000))["fee"], 100)
        self.assertEqual(fees(FeeRequest(amount=5_001))["fee"], 200)
        self.assertEqual(fees(FeeRequest(amount=5_001))["total"], 5_201)

    def test_fee_rejects_non_integer_and_out_of_range_amounts(self):
        for value in (True, 0, -1, 10_000_001):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                FeeRequest(amount=value)

    def test_insufficient_funds_returns_clear_error_without_debit(self):
        response = transfer(TransferRequest(beneficiary="Marie", amount=50_001))
        self.assertEqual(response["transaction"]["status"], "failure")
        self.assertEqual(response["error"]["code"], "insufficient_funds")
        self.assertIn("50 201 FCFA", response["error"]["message"])
        self.assertIn("50 000 FCFA", response["error"]["message"])
        self.assertEqual(mock_financial.get_balance("default"), 50_000)
        self.assertEqual(response["confirmation"]["status"], "failure")

    def test_successful_transfer_debits_amount_and_fee(self):
        response = transfer(TransferRequest(beneficiary="Marie", amount=5_000))
        self.assertEqual(response["transaction"]["status"], "success")
        self.assertEqual(response["transaction"]["fee"], 100)
        self.assertEqual(response["transaction"]["balance_after"], 44_900)
        self.assertEqual(mock_financial.get_balance("default"), 44_900)


class TranslationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.glossary = Glossary()
        self.translator = LockedTranslator(
            self.glossary, nmt=lambda protected_text, target_lang: protected_text
        )

    def test_strict_regex_extracts_supported_integer_amounts(self):
        entities = detect_entities(
            "Solde 3 500 FCFA, frais 2.000 F, rejet 12,50 FCFA",
            self.glossary.source_terms(),
        )
        self.assertEqual(entities.amounts, ["3500", "2000"])

    def test_numeric_tokens_are_masked_and_restored_exactly(self):
        text = "Votre solde actuel est de 25 000 FCFA ; référence +237 677123456."
        model_inputs = []
        translator = LockedTranslator(
            self.glossary,
            nmt=lambda segment, target_lang: model_inputs.append(segment) or segment,
        )
        result = translator.translate(text, "fr", "ewondo")
        self.assertTrue(model_inputs)
        self.assertFalse(any(any(character.isdigit() for character in segment) for segment in model_inputs))
        self.assertIn("25 000 FCFA", result.translated)
        self.assertIn("+237 677123456", result.translated)
        self.assertEqual(
            [value for _, _, value in find_numeric_matches(text)],
            [value for _, _, value in find_numeric_matches(result.translated)],
        )

    def test_explicit_private_names_are_not_sent_to_the_translation_model(self):
        model_inputs = []
        translator = LockedTranslator(
            self.glossary,
            nmt=lambda segment, target_lang: model_inputs.append(segment) or "Mbolo",
        )
        result = translator.translate(
            "Veuillez envoyer le paiement à Jean demain.",
            "fr",
            "ewondo",
            protected_terms=["Jean"],
        )
        self.assertTrue(model_inputs)
        self.assertTrue(all("Jean" not in segment for segment in model_inputs))
        self.assertIn("Jean", result.translated)

    def test_unvalidated_glossary_term_stays_unchanged(self):
        result = self.translator.translate("Votre solde est de 500 FCFA.", "fr", "ewondo")
        self.assertIn("solde", result.translated.lower())
        self.assertEqual(result.locked_terms["solde"], "solde")
        self.assertTrue(result.fallback_used)

    def test_empty_text_returns_a_structured_error(self):
        response = translate(TranslateRequest(text="   "))
        self.assertEqual(response.status_code, 422)
        payload = json.loads(response.body)
        self.assertEqual(payload["error"]["code"], "empty_text")
        self.assertTrue(payload["fallback_used"])

    def test_translate_error_preserves_amount(self):
        response = translate_error(
            TranslateErrorRequest(text="Solde insuffisant : 25 000 FCFA")
        )
        self.assertIn("25 000 FCFA", response["translated"])
        self.assertEqual(response["entities"]["amounts"], ["25000"])

    def test_nmt_failure_falls_back_to_original(self):
        def broken_nmt(text, target_lang):
            raise RuntimeError("modèle indisponible")

        translator = LockedTranslator(self.glossary, nmt=broken_nmt)
        source = "Veuillez confirmer le transfert de 25 000 FCFA."
        result = translator.translate(source, "fr", "ewondo")
        self.assertEqual(result.translated, source)
        self.assertTrue(result.fallback_used)
        self.assertEqual(result.error_code, "nmt_failed")

    def test_short_segments_are_opt_in_for_full_page_translation(self):
        translator = LockedTranslator(
            self.glossary,
            nmt=lambda text, target_lang: f"EWONDO: {text}",
        )
        source = "VOTRE COMPTE"

        conservative = translator.translate(source, "fr", "ewondo")
        full_page = translator.translate(
            source, "fr", "ewondo", allow_short_segments=True
        )

        self.assertEqual(conservative.translated, source)
        self.assertTrue(conservative.fallback_used)
        self.assertEqual(full_page.translated, "EWONDO: VOTRE COMPTE")
        self.assertFalse(full_page.fallback_used)

    def test_nmt_cannot_replace_or_invent_amounts(self):
        translator = LockedTranslator(
            self.glossary,
            nmt=lambda text, target_lang: "Transfert de 999 FCFA",
        )
        source = "Veuillez confirmer le transfert de 25 000 FCFA."
        result = translator.translate(source, "fr", "ewondo")
        self.assertEqual(result.translated, source)
        self.assertEqual(result.error_code, "nmt_failed")

    def test_repetitive_nmt_output_falls_back_without_changing_amount(self):
        repeated_output = " ".join(["bod bëzimbi"] * 20)
        translator = LockedTranslator(
            self.glossary,
            nmt=lambda text, target_lang: repeated_output,
        )
        source = "Veuillez confirmer cette opération avant demain : 25 000 FCFA."
        result = translator.translate(source, "fr", "ewondo")
        self.assertEqual(result.translated, source)
        self.assertTrue(result.fallback_used)
        self.assertEqual(result.error_code, "nmt_failed")
        self.assertEqual(result.entities.amounts, ["25000"])

    def test_missing_language_model_falls_back_to_original(self):
        translator = LockedTranslator(self.glossary)
        source = "Veuillez lire ce message de paiement."
        with patch.object(translator, "_load_model", side_effect=FileNotFoundError()):
            result = translator.translate(source, "fr", "ewondo")
        self.assertEqual(result.translated, source)
        self.assertEqual(result.error_code, "model_unavailable")

    def test_inference_failure_falls_back_to_original(self):
        translator = LockedTranslator(self.glossary)
        translator._models[("fr", "ewondo")] = object()
        source = "Veuillez lire ce message de paiement."
        with patch.object(translator, "_run_ctranslate2", side_effect=RuntimeError()):
            result = translator.translate(source, "fr", "ewondo")
        self.assertEqual(result.translated, source)
        self.assertEqual(result.error_code, "translation_failed")

    def test_a_future_ewondo_model_can_be_configured_by_language_pair(self):
        self.assertEqual(LockedTranslator.REPO_ID, "flagship-ai/cameroon-int8")
        self.assertEqual(
            LockedTranslator.DEFAULT_MODEL_PAIRS[("fr", "ewondo")],
            "francais-ewondo",
        )
        self.assertEqual(
            LockedTranslator.DEFAULT_MODEL_PAIRS[("fr", "fulfulde")],
            "francais-fufulde",
        )
        self.assertEqual(set(LockedTranslator.PRIMARY_TARGET_PAIRS), {"ewondo", "fulfulde"})
        self.assertNotIn(("fr", "en"), LockedTranslator.DEFAULT_MODEL_PAIRS)


if __name__ == "__main__":
    unittest.main()
