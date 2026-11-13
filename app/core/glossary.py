import json
from pathlib import Path
from typing import Dict, List

# On indique le chemin vers le fichier JSON (remonte de 2 dossiers)
GLOSSARY_PATH = Path(__file__).resolve().parents[2] / "data" / "glossary_financial.json"

class Glossary:
    def __init__(self, path: Path = GLOSSARY_PATH):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.terms = data["terms"]
        self.by_source: Dict[str, dict] = {}
        
        # On indexe les termes en français et en anglais pour la recherche
        for t in self.terms:
            self.by_source[t["fr"].lower()] = t
            self.by_source[t["en"].lower()] = t

    def source_terms(self) -> List[str]:
        return list(self.by_source.keys())

    def lookup(self, source_term: str, target_lang: str) -> str | None:
        entry = self.by_source.get(source_term.lower())
        if not entry:
            return None
        # Les termes financiers restent en anglais dans les sorties en ewondo.
        value = entry.get("en") if target_lang == "ewondo" else entry.get(target_lang)
        if not value or value == "TODO_VALIDATE":
            return None 
        return value
