"""Warm the default Hugging Face cache with the OPUS translation models."""

MODEL_REPO_IDS = (
    "Helsinki-NLP/opus-mt-en-fr",
    "Helsinki-NLP/opus-mt-fr-en",
)


def main() -> None:
    from transformers import MarianMTModel, MarianTokenizer

    # Sans chemin local, Transformers stocke les fichiers dans le cache Hugging Face.
    for model_id in MODEL_REPO_IDS:
        MarianTokenizer.from_pretrained(model_id)
        MarianMTModel.from_pretrained(model_id)
        print(f"Modèle prêt dans le cache Hugging Face ({model_id}).")


if __name__ == "__main__":
    main()
