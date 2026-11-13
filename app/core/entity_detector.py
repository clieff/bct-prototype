import re
from dataclasses import dataclass, field
from typing import Iterable, List, Tuple


@dataclass
class ExtractedEntities:
    amounts: List[str] = field(default_factory=list)
    phone_numbers: List[str] = field(default_factory=list)
    glossary_terms: List[str] = field(default_factory=list)


# Montants entiers autorisés : 3500, 3 500, 3.500, 3,500 ou 3 500 FCFA.
# Les séparateurs décimaux sont volontairement refusés pour ne pas interpréter
# partiellement une valeur financière ambiguë.
AMOUNT_PATTERN = re.compile(
    r"(?<![\w.,])"
    r"(?P<number>(?:\d{1,3}(?:[ ,\.\u00a0\u202f]\d{3})+|\d+))"
    r"(?:[ \t\u00a0\u202f]*(?:F[ \t\u00a0\u202f]*CFA|FCFA|francs?|F))?"
    r"(?!\w|,\d|\.\d)",
    re.IGNORECASE,
)

# Capture les séquences numériques avec leur formatage et leur devise pour les
# remplacer par des marqueurs intacts pendant la traduction.
NUMERIC_TOKEN_PATTERN = re.compile(
    r"(?<!\d)[+-]?\d+(?:[ \t\u00a0\u202f.,'’]\d+)*"
    r"(?:[ \t\u00a0\u202f]*(?:F[ \t\u00a0\u202f]*CFA|FCFA|francs?|F))?"
    r"(?!\d)",
    re.IGNORECASE,
)

# Numéros camerounais avec ou sans indicatif (ex. 677123456, +237 677123456).
PHONE_PATTERN = re.compile(r"(?:\+?237[\s-]?)?\b6\d{8}\b")


def find_glossary_matches(text: str, glossary_terms: Iterable[str]) -> List[Tuple[int, int, str]]:
    """Retourne les termes complets du glossaire, sans correspondance partielle."""
    matches = []
    for term in sorted(set(glossary_terms), key=len, reverse=True):
        words = term.split()
        if not words:
            continue
        term_pattern = r"\s+".join(re.escape(word) for word in words)
        pattern = re.compile(rf"(?<!\w){term_pattern}(?!\w)", re.IGNORECASE)
        for match in pattern.finditer(text):
            matches.append((match.start(), match.end(), term))

    # En cas de chevauchement, le terme le plus long situé au même endroit gagne.
    matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    selected = []
    occupied_until = -1
    seen_terms = set()
    for start, end, term in matches:
        if start < occupied_until:
            continue
        if term not in seen_terms:
            selected.append((start, end, term))
            seen_terms.add(term)
        occupied_until = end
    return selected


def find_numeric_matches(text: str) -> List[Tuple[int, int, str]]:
    """Renvoie les montants, références et numéros exacts à protéger."""
    phone_matches = [
        (match.start(), match.end(), match.group(0))
        for match in PHONE_PATTERN.finditer(text)
    ]
    matches = list(phone_matches)

    for match in NUMERIC_TOKEN_PATTERN.finditer(text):
        start, end = match.span()
        if any(start < phone_end and end > phone_start for phone_start, phone_end, _ in phone_matches):
            continue
        matches.append((start, end, match.group(0)))

    matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    selected = []
    occupied_until = -1
    for start, end, value in matches:
        if start < occupied_until:
            continue
        selected.append((start, end, value))
        occupied_until = end
    return selected


def detect_entities(text: str, glossary_terms: List[str]) -> ExtractedEntities:
    entities = ExtractedEntities()
    if not isinstance(text, str) or not text:
        return entities

    phone_matches = list(PHONE_PATTERN.finditer(text))
    entities.phone_numbers = [match.group(0) for match in phone_matches]

    for match in AMOUNT_PATTERN.finditer(text):
        if any(match.start() < phone.end() and match.end() > phone.start() for phone in phone_matches):
            continue
        digits = re.sub(r"[ ,.\u00a0\u202f]", "", match.group("number"))
        # Limite stricte du mock financier ; les longues chaînes restent protégées,
        # mais ne sont pas présentées comme des montants calculables.
        if digits.isdigit() and len(digits) <= 7:
            entities.amounts.append(digits)

    entities.glossary_terms = [
        term for _, _, term in find_glossary_matches(text, glossary_terms)
    ]
    return entities
