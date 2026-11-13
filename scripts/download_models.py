"""Download the local English-to-French model used by the demo."""

from pathlib import Path

from huggingface_hub import snapshot_download


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_REPO_ID = "Helsinki-NLP/opus-mt-en-fr"
MODEL_DIR = PROJECT_ROOT / "models" / "opus-mt-en-fr"
MODEL_FILES = (
    "config.json",
    "generation_config.json",
    "pytorch_model.bin",
    "source.spm",
    "target.spm",
    "tokenizer_config.json",
    "vocab.json",
)


def main() -> None:
    missing_files = [name for name in MODEL_FILES if not (MODEL_DIR / name).is_file()]
    if not missing_files:
        print(f"Modele EN vers FR deja pret dans {MODEL_DIR}")
        return

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_REPO_ID,
        allow_patterns=list(MODEL_FILES),
        local_dir=str(MODEL_DIR),
    )

    missing_files = [name for name in MODEL_FILES if not (MODEL_DIR / name).is_file()]
    if missing_files:
        raise RuntimeError(
            "Téléchargement incomplet; fichiers absents : " + ", ".join(missing_files)
        )

    print(f"Modele EN vers FR telecharge dans {MODEL_DIR}")


if __name__ == "__main__":
    main()
