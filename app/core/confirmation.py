def build_transfer_preview(amount: int, fee: int, beneficiary: str):
    """Prépare le récapitulatif que l'utilisateur doit vérifier avant l'envoi."""
    total = amount + fee
    audio_text = (
        f"Vérifiez le transfert. Vous allez envoyer {amount} francs à {beneficiary}. "
        f"Frais : {fee} francs. Total : {total} francs. "
        "Confirmez uniquement si le bénéficiaire et le montant sont corrects."
    )
    visual_code = f"{beneficiary} | {amount} FCFA + {fee} FCFA frais = {total} FCFA"
    return {
        "status": "pending_confirmation",
        "audio_text": audio_text,
        "visual_code": visual_code,
        "total": total,
    }


def build_confirmation(response, amount: int, fee: int, beneficiary: str):
    total = amount + fee
    if response.status != "success":
        error = response.error or "Le transfert a échoué. Aucun montant n’a été débité."
        return {
            "status": "failure",
            "audio_text": error,
            "visual_code": error,
            "total": total,
        }

    audio_text = (
        f"Transfert effectué. {amount} francs ont été envoyés à {beneficiary}. "
        f"Frais : {fee} francs. Total : {total} francs. "
    )
    visual_code = f"{beneficiary} | {amount} FCFA + {fee} FCFA frais = {total} FCFA"
    return {
        "status": "success",
        "audio_text": audio_text,
        "visual_code": visual_code,
        "total": total,
    }
