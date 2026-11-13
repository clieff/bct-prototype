import unittest
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException

import app.main as main_module
from app.core.tts_engine import (
    UnsupportedLanguageError,
    generate_audio,
    supported_languages,
)
from app.main import SpeakRequest


class FakeAfricaTTS:
    sample_rate = 24_000

    def __init__(self):
        self.calls = []

    def generate(self, text, lang):
        self.calls.append((text, lang))
        return np.zeros(240, dtype=np.float32)


class TTSEngineTests(unittest.TestCase):
    def test_installed_catalog_has_ewondo_code(self):
        catalog = supported_languages()
        self.assertEqual(catalog["ewo"]["name"], "Ewondo")

    def test_unknown_language_fails_before_loading_engine(self):
        with patch("app.core.tts_engine._get_engine") as get_engine:
            with self.assertRaises(UnsupportedLanguageError):
                generate_audio("Bonjour", "zzx")
        get_engine.assert_not_called()

    def test_fulfulde_has_a_clear_error_when_absent_from_installed_catalog(self):
        if "ful" in supported_languages():
            self.skipTest("La version installée prend maintenant en charge le Fulfulde.")
        with self.assertRaisesRegex(UnsupportedLanguageError, "Fulfulde.*ful"):
            generate_audio("Jam", "ful")

    def test_ewondo_alias_returns_a_wav_byte_stream(self):
        engine = FakeAfricaTTS()
        with patch("app.core.tts_engine._get_engine", return_value=engine):
            wav_bytes = generate_audio("Mbolo", "ewondo")

        self.assertTrue(wav_bytes.startswith(b"RIFF"))
        self.assertEqual(wav_bytes[8:12], b"WAVE")
        self.assertEqual(engine.calls, [("Mbolo", "ewo")])

    def test_empty_text_is_rejected(self):
        with self.assertRaises(ValueError):
            generate_audio("   ", "ewo")


class SpeakEndpointTests(unittest.TestCase):
    def test_languages_route_reports_installed_catalog(self):
        response = main_module.speak_languages()
        self.assertEqual(response["languages"]["ewo"]["name"], "Ewondo")

    def test_returns_wav_response(self):
        wav_bytes = b"RIFF-test-WAVE"
        with patch.object(main_module, "generate_audio", return_value=wav_bytes):
            response = main_module.speak(SpeakRequest(text="Mbolo", lang_code="ewo"))

        self.assertEqual(response.media_type, "audio/wav")
        self.assertEqual(response.body, wav_bytes)

    def test_returns_clear_error_for_unsupported_language(self):
        with patch.object(
            main_module,
            "generate_audio",
            side_effect=UnsupportedLanguageError("Fulfulde (ful) n'est pas disponible."),
        ):
            with self.assertRaises(HTTPException) as caught:
                main_module.speak(SpeakRequest(text="Jam", lang_code="ful"))

        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("Fulfulde", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
