// Configuration de base
const API_URL = "http://127.0.0.1:8000";
let currentAudio = null;
let currentAudioUrl = null;
let pendingTransfer = null;
let preparingTransfer = false;
let confirmingTransfer = false;
const MAX_AMOUNT = 10_000_000;

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : `Erreur du serveur (${response.status}).`,
    );
  }
  return data;
}

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

// Prépare un récapitulatif. Aucun débit n'a lieu avant le clic de confirmation.
async function envoyerTransaction() {
  if (preparingTransfer || confirmingTransfer) return;

  const beneficiary = document.getElementById("beneficiary").value.trim();
  const amount = Number(document.getElementById("amount").value);
  const targetLang = document.getElementById("lang").value;
  const status = document.getElementById("transfer-status");

  if (!beneficiary) {
    status.textContent = "Veuillez saisir le nom du bénéficiaire.";
    return;
  }
  if (beneficiary.length > 100) {
    status.textContent = "Le nom du bénéficiaire ne peut pas dépasser 100 caractères.";
    return;
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    status.textContent = `Le montant doit être un entier entre 1 et ${MAX_AMOUNT.toLocaleString("fr-FR")} FCFA.`;
    return;
  }

  preparingTransfer = true;
  document.getElementById("send-btn").disabled = true;
  status.textContent = "Préparation du récapitulatif…";

  try {
    const response = await fetch(`${API_URL}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: "default",
        beneficiary,
        amount,
      }),
    });
    const data = await readJsonResponse(response);
    if (!data.request_id || !data.confirmation?.audio_text ||
        !data.confirmation?.visual_code || !data.transaction) {
      throw new Error("Le serveur a renvoyé un récapitulatif incomplet.");
    }

    pendingTransfer = {
      requestId: data.request_id,
      beneficiary,
      amount,
      targetLang,
      audioText: data.confirmation.audio_text,
      visualCode: data.confirmation.visual_code,
    };
    document.getElementById("review-text").textContent = data.confirmation.audio_text;
    document.getElementById("review-code").textContent = data.confirmation.visual_code;
    document.getElementById("review-status").textContent =
      "Vérifiez le bénéficiaire, le montant et les frais avant de confirmer.";
    document.getElementById("review-audio-status").textContent = "";
    document.getElementById("transfer-review").showModal();
    status.textContent = "";
  } catch (error) {
    status.textContent = `Impossible de préparer le transfert : ${error.message}`;
  } finally {
    preparingTransfer = false;
    document.getElementById("send-btn").disabled = false;
  }
}

async function confirmerTransaction() {
  if (!pendingTransfer || confirmingTransfer) return;

  const transfer = pendingTransfer;
  const confirmButton = document.getElementById("confirm-transfer-btn");
  confirmButton.disabled = true;
  confirmingTransfer = true;
  document.getElementById("review-status").textContent = "Envoi en cours…";

  try {
    const response = await fetch(`${API_URL}/transfer/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: transfer.requestId }),
    });
    const data = await readJsonResponse(response);
    if (!data.transaction || !data.confirmation) {
      throw new Error("Le serveur a renvoyé un résultat incomplet.");
    }
    document.getElementById("transfer-review").close("confirmed");
    pendingTransfer = null;
    afficherResultat(data, transfer.targetLang);
  } catch (error) {
    document.getElementById("review-status").textContent =
      `Le transfert n'a pas pu être confirmé : ${error.message}`;
    if (error.message.includes("expiré")) {
      pendingTransfer = null;
      document.getElementById("transfer-review").close("expired");
      document.getElementById("transfer-status").textContent =
        "La préparation a expiré. Vérifiez les champs et recommencez.";
    }
  } finally {
    confirmingTransfer = false;
    confirmButton.disabled = false;
  }
}

// Affiche le résultat reçu après le débit effectif.
function afficherResultat(data, targetLang) {
  const box = document.getElementById("result-box");
  box.style.display = "block";

  document.getElementById("status-text").innerText =
    data.transaction.status === "success"
      ? "✅ Transaction Réussie"
      : "❌ Échec";
  document.getElementById("audio-text").innerText =
    data.confirmation.audio_text;
  document.getElementById("visual-code").innerText =
    data.confirmation.visual_code;

  // Générer la confirmation avec Africa TTS dans la langue sélectionnée.
  document.getElementById("audio-btn").onclick = () => {
    void lireTexte(
      data.confirmation.audio_text,
      targetLang,
      data.transaction.beneficiary,
    );
  };
}

// Traduit le texte de confirmation, puis demande un WAV au moteur Africa TTS.
async function lireTexte(
  texte,
  langue,
  beneficiaire,
  buttonId = "audio-btn",
  statusId = "audio-status",
) {
  const button = document.getElementById(buttonId);
  const status = document.getElementById(statusId);
  const codes = { ewondo: "ewo", fulfulde: "ful" };
  const langCode = codes[langue];
  button.disabled = true;
  status.textContent = "Préparation de la confirmation audio…";

  try {
    // Le catalogue évite de traduire le message avant de découvrir une langue absente.
    const catalogResponse = await fetch(`${API_URL}/speak/languages`);
    const catalogData = await catalogResponse.json();
    if (!catalogResponse.ok) {
      throw new Error(catalogData.detail || "Impossible de lire les langues du moteur vocal.");
    }
    if (!langCode || !catalogData.languages?.[langCode]) {
      const languageName = langue === "fulfulde" ? "Fulfulde (ful)" : langue;
      throw new Error(
        `${languageName} n'est pas encore pris en charge par Africa TTS. ` +
        `Langues disponibles : ${Object.values(catalogData.languages || {})
          .map((item) => item.name).join(", ")}.`
      );
    }

    const translationResponse = await fetch(`${API_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: texte,
        source_lang: "fr",
        target_lang: langue,
        protected_terms: beneficiaire ? [beneficiaire] : [],
        allow_short_segments: true,
      }),
    });
    const translationData = await translationResponse.json();
    if (!translationResponse.ok || translationData.error) {
      throw new Error(translationData.error?.message || "La traduction de la confirmation a échoué.");
    }
    if (!translationData.translated || translationData.translated.trim() === texte.trim()) {
      throw new Error("La confirmation n'a pas été traduite; aucun audio ne sera généré.");
    }

    const audioResponse = await fetch(`${API_URL}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: translationData.translated, lang_code: langCode }),
    });
    if (!audioResponse.ok) {
      const errorData = await audioResponse.json().catch(() => ({}));
      throw new Error(errorData.detail || "La génération audio a échoué.");
    }

    const audioBlob = await audioResponse.blob();
    stopCurrentAudio();
    currentAudioUrl = URL.createObjectURL(audioBlob);
    currentAudio = new Audio(currentAudioUrl);
    const playback = currentAudio;
    playback.addEventListener("ended", () => {
      if (currentAudio === playback) stopCurrentAudio();
    }, { once: true });
    playback.addEventListener("error", () => {
      if (currentAudio === playback) stopCurrentAudio();
    }, { once: true });
    await currentAudio.play();
    status.textContent = `Confirmation audio en ${catalogData.languages[langCode].name}.`;
  } catch (error) {
    status.textContent = `Audio indisponible : ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function extraireVirementDicte(texte) {
  if (/\d[.,]\d{1,2}(?!\d)/u.test(texte)) return null;
  const amountMatch = texte.match(
    /(?<!\d)(?:\d{1,3}(?:[ \u00a0\u202f.]\d{3})+|\d+)(?!\d)(?![.,]\d)/u,
  );
  const beneficiaryMatch = texte.match(
    /(?:^|[^\p{L}])(?:à|a|pour)\s+([\p{L}][\p{L}'’ -]{0,98}?)(?=\s+(?:\d|le\b|la\b|les\b|demain\b|aujourd'hui\b|pour\b)|[,;.!?]|$)/iu,
  );
  if (!amountMatch || !beneficiaryMatch) return null;

  const amount = Number(amountMatch[0].replace(/[ .\u00a0\u202f]/g, ""));
  const beneficiary = beneficiaryMatch[1].trim().replace(/[\s-]+$/g, "");
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT || !beneficiary) {
    return null;
  }
  return { amount, beneficiary };
}

// Reconnaissance vocale (ASR) via le navigateur
function dicterTexte() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = document.getElementById("transfer-status");
  const button = document.getElementById("mic-btn");
  if (!SpeechRecognition) {
    status.textContent = "La reconnaissance vocale n'est pas disponible dans ce navigateur.";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    button.disabled = true;
    button.innerText = "🎤 Écoute en cours…";
    status.textContent = "Dictez par exemple : « Envoyer 3 500 francs à Paul ».";
  };
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    const transfer = extraireVirementDicte(transcript);
    if (!transfer) {
      status.textContent =
        `Phrase entendue : « ${transcript} ». Montant ou bénéficiaire non reconnu; vérifiez-les manuellement.`;
      return;
    }
    document.getElementById("amount").value = String(transfer.amount);
    document.getElementById("beneficiary").value = transfer.beneficiary;
    status.textContent =
      `Champs remplis : ${transfer.amount.toLocaleString("fr-FR")} FCFA pour ${transfer.beneficiary}. Vérifiez-les avant l'envoi.`;
  };
  recognition.onerror = (event) => {
    status.textContent = `Reconnaissance vocale indisponible : ${event.error || "erreur inconnue"}.`;
  };
  recognition.onend = () => {
    button.disabled = false;
    button.innerText = "🎤 Dicter une phrase";
  };
  try {
    recognition.start();
  } catch (error) {
    button.disabled = false;
    button.innerText = "🎤 Dicter une phrase";
    status.textContent = `Impossible de démarrer le micro : ${error.message}`;
  };
}

document.getElementById("review-audio-btn").addEventListener("click", () => {
  if (!pendingTransfer) return;
  void lireTexte(
    pendingTransfer.audioText,
    pendingTransfer.targetLang,
    pendingTransfer.beneficiary,
    "review-audio-btn",
    "review-audio-status",
  );
});
document.getElementById("confirm-transfer-btn").addEventListener("click", confirmerTransaction);
document.getElementById("cancel-transfer-btn").addEventListener("click", () => {
  document.getElementById("transfer-review").close("cancelled");
});
document.getElementById("transfer-review").addEventListener("close", (event) => {
  stopCurrentAudio();
  if (event.target.returnValue !== "confirmed") pendingTransfer = null;
  event.target.returnValue = "";
});
