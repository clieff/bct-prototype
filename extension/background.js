// Relaye les demandes du content script vers l'API FastAPI locale.
const TRANSLATION_REQUEST_DELAY_MS = 100;
let translationStartQueue = Promise.resolve();
let lastTranslationRequestAt = 0;

function waitForTranslationStartSlot() {
  const previousSlot = translationStartQueue;
  let releaseSlot;
  translationStartQueue = new Promise((resolve) => {
    releaseSlot = resolve;
  });

  return previousSlot.catch(() => undefined).then(async () => {
    const waitMs = TRANSLATION_REQUEST_DELAY_MS - (Date.now() - lastTranslationRequestAt);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastTranslationRequestAt = Date.now();
  }).finally(() => releaseSlot());
}

async function queueTranslationRequest(path, payload, expectedCount = 0) {
  // On espace les départs, mais chaque requête se poursuit sans bloquer les autres onglets.
  await waitForTranslationStartSlot();
  const response = await fetch(`http://127.0.0.1:8000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);

  const data = await response.json();
  if (path === "/translate-batch" &&
      (!Array.isArray(data.results) || data.results.length !== expectedCount ||
       data.results.some((item) => typeof item.translated !== "string"))) {
    throw new Error("Réponse de traduction groupée invalide");
  }
  if (path === "/translate" && typeof data.translated !== "string") {
    throw new Error("Réponse de traduction invalide");
  }
  return data;
}

async function requestAudio(payload) {
  const response = await fetch("http://127.0.0.1:8000/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    let detail = "Synthèse vocale indisponible.";
    try {
      const data = await response.json();
      if (typeof data.detail === "string") detail = data.detail;
    } catch (_) { /* La réponse peut être vide ou non JSON. */ }
    throw new Error(detail);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return {
    audioBase64: btoa(binary),
    mimeType: response.headers.get("content-type") || "audio/wav"
  };
}

function isValidTranslationItem(item) {
  return Boolean(item && typeof item.text === "string" && item.text.trim() &&
    item.text.length <= 2000 && ["fr", "en"].includes(item.source_lang) &&
    ["ewondo", "fulfulde"].includes(item.target_lang));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["BCT_TRANSLATE", "BCT_TRANSLATE_BATCH", "BCT_SPEAK"].includes(message.type)) {
    return false;
  }

  let responseSent = false;
  const respondOnce = (response) => {
    if (responseSent) return;
    responseSent = true;
    try {
      sendResponse(response);
    } catch (error) {
      // Le canal peut déjà être fermé si Chrome a rechargé l'extension.
      console.warn("BCT : canal de réponse fermé.", error);
    }
  };
  const respondWithError = (error, fallbackMessage = "Impossible de contacter le serveur BCT.") => {
    console.error("BCT Background Error:", error);
    respondOnce({ error: error?.message || fallbackMessage });
  };

  try {
    const payload = message.payload || {};

    if (message.type === "BCT_SPEAK") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const targetLang = payload.target_lang;
      const langCode = targetLang === "ewondo" ? "ewo" : targetLang === "fulfulde" ? "ful" : null;
      if (!text || text.length > 4000 || !langCode) {
        respondOnce({ error: "Demande audio invalide." });
        return false;
      }

      void requestAudio({ text, lang_code: langCode })
        .then(respondOnce)
        .catch((error) => respondWithError(error, "Impossible de générer l’audio."));
      return true;
    }

    if (message.type === "BCT_TRANSLATE_BATCH") {
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0 || items.length > 20 || !items.every(isValidTranslationItem)) {
        respondOnce({ error: "Demande groupée de traduction invalide." });
        return false;
      }

      const body = {
        items: items.map((item) => ({
          text: item.text.trim(),
          source_lang: item.source_lang,
          target_lang: item.target_lang,
          allow_short_segments: true,
          protected_terms: Array.isArray(item.protected_terms) ? item.protected_terms : []
        }))
      };
      void queueTranslationRequest("/translate-batch", body, items.length)
        .then(respondOnce)
        .catch((error) => respondWithError(error));
      return true;
    }

    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text || text.length > 2000 ||
        !["fr", "en"].includes(payload.source_lang) ||
        !["ewondo", "fulfulde"].includes(payload.target_lang)) {
      respondOnce({ error: "Demande de traduction invalide." });
      return false;
    }

    void queueTranslationRequest("/translate", {
      text,
      source_lang: payload.source_lang,
      target_lang: payload.target_lang
    })
      .then(respondOnce)
      .catch((error) => respondWithError(error));
    return true;
  } catch (error) {
    respondWithError(error);
    return false;
  }
});
