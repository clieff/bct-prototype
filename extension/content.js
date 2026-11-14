(() => {
  "use strict";

  // Parcourt le texte DOM de la page ; les valeurs saisies dans les champs restent intactes.
  const TEXT_EXCLUSION_SELECTOR = "input, textarea, [contenteditable]:not([contenteditable='false']), script, style, noscript, template, [hidden], [aria-hidden='true'], [data-talk-africa-translation]";
  const ATTRIBUTE_EXCLUSION_SELECTOR = "script, style, noscript, template, [hidden], [aria-hidden='true'], [data-talk-africa-translation]";
  const TRANSLATABLE_ATTRIBUTES = [
    "title", "aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext",
    "alt", "placeholder", "value", "label", "data-tooltip", "data-bs-title", "data-original-title", "data-tippy-content"
  ];
  const TRANSLATION_ATTRIBUTE = "data-talk-africa-translation";
  const ORIGINAL_ATTRIBUTE = "data-talk-africa-original";
  const MAX_TRANSLATION_REQUEST_LENGTH = 1800;
  const MAX_TRANSLATION_CACHE_ENTRIES = 500;
  // L'API traduit chaque élément séquentiellement ; de petits lots gardent
  // chaque réponse dans la durée de vie du canal de messagerie Chrome.
  const TRANSLATION_BATCH_SIZE = 3;
  const TRANSLATION_BATCH_WINDOW_MS = 35;
  const ENGLISH_LANGUAGE_HINTS = /(?<![\p{L}])(?:the|your|you|is|are|can|from|with|for|of|and|balance|fees?|withdraw(?:al)?|deposit|account|payment|transfer|beneficiary|send|sent|receive|received|please|available|confirm|continue|cancel|amount|settings|welcome|hello|hi|good\s+morning|thank|current|history|recent|password|login|log\s+out|sign\s+(?:in|up)|home)(?![\p{L}])/giu;
  const FRENCH_LANGUAGE_HINTS = /(?<![\p{L}])(?:le|la|les|votre|vos|vous|est|sont|peut|de|des|du|avec|pour|solde|frais|retrait|dépôt|compte|paiement|transfert|bénéficiaire|envoyer|envoyé|reçu|disponible|confirmer|continuez|continuer|annuler|montant|paramètres|bienvenue|bonjour|bonsoir|salut|merci|actuel|historique|récent|consultez|consulter|voir|virement|mot\s+de\s+passe|connexion|accueil)(?![\p{L}])/giu;
  const FINANCIAL_NUMBER = /[+\-]?(?:\d{1,3}(?:[\s\u00a0\u202f.,]\d{3})+|\d+)(?:[.,]\d+)?(?:\s*(?:%|FCFA|CFA|XAF|F\s*CFA|francs?|F))?/giu;
  const URL_ONLY = /^\s*(?:(?:(?:https?|ftp):\/\/|www\.|mailto:|tel:)[^\s<>"']+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?)\s*$/i;
  const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\bmailto:[^\s<>"']+|\btel:[^\s<>"']+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
  const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;
  const MONTH_NAME = "(?:janv?(?:ier)?|févr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil?(?:let)?|août|sept?(?:embre)?|oct(?:obre)?|nov(?:embre)?|déc(?:embre)?)";
  const DATE_ONLY = new RegExp(`^\\s*\\d{1,2}\\s+${MONTH_NAME}\\.?\\s*(?:\\d{2,4})?\\s*$`, "iu");
  const MONTH_ONLY = new RegExp(`^\\s*${MONTH_NAME}\\.?\\s*$`, "iu");
  const DATE_PATTERN = new RegExp(`\\b\\d{1,2}\\s+${MONTH_NAME}(?:\\.?\\s+\\d{2,4})?\\b`, "giu");

  // Ces motifs sont volontairement conservateurs : en cas de doute, le texte
  // sensible reste dans la page et ne part jamais vers l'API de traduction.
  // Reconnaît les formats camerounais 6XX XX XX XX et 6XX XXX XXX.
  const PHONE_NUMBER = /(?:^|[^\d])(?:\+?237[\s().-]*)?6\d{2}(?:(?:[\s().-]*\d{2}){3}|(?:[\s().-]*\d{3}){2})(?!\d)|(?:^|[^\d])\+?\d(?:[\s().-]*\d){7,14}(?!\d)/;
  const REFERENCE = /\b(?:REF(?:ERENCE)?|RÉF(?:ÉRENCE)?)\s*[-:#_ ]?\s*[A-Z0-9]+(?:[-_/][A-Z0-9]+)+\b/i;
  const STRUCTURED_REFERENCE = /\b[A-Z]{2,}[-_]\d{2,}(?:[-_/][A-Z0-9]+)*\b/;
  const ACCOUNT_NUMBER = /\b(?:CM|CEMAC|ACC(?:OUNT)?)\s*[- ]\s*\d{3}(?:[\s-]+\d{2,}){2,}\b/i;
  const LABELED_IDENTIFIER = /(?:num(?:é|e)ro\s+de\s+(?:compte|référence)|réf(?:érence)?|reference|account\s+(?:number|no\.?))\s*[:#-]?\s*(?:[A-Z]{1,5}[\s-]+)?\d[\d\s/-]{3,}\d\b/i;
  const NUMBER_ONLY = /^\s*[+\-]?(?:\d[\d\s.,()/-]*\d|\d)\s*$/;
  const CURRENCY_ONLY = /^\s*[+\-]?(?:\d{1,3}(?:[\s.,]\d{3})+|\d+)\s*(?:FCFA|CFA|XAF|F\s*CFA|francs?|F)\s*$/i;
  const CURRENCY_LABEL_ONLY = /^\s*(?:FCFA|CFA|XAF|F\s*CFA|francs?|F)\s*$/i;
  const NAME_PART = "[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+(?:[-’'][A-ZÀ-ÖØ-Þ]?[a-zà-öø-ÿ]+)*";
  const PURE_NAME = new RegExp(`^\\s*(?:(?:M(?:me|lle)?|Monsieur|Madame)\\.?\\s+)?${NAME_PART}(?:[\\s'-]+${NAME_PART}){0,3}[.,]?\\s*$`, "u");
  const NAME_AFTER_LABEL = /(?:^|[^\p{L}])(?:nom|bénéficiaire|destinataire|client|recipient|beneficiary|customer|account holder)\s*[:：-]?\s*/giu;
  const NAME_AFTER_PREPOSITION = /(?:^|[^\p{L}])(?:à|a|pour|de|du|vers|chez|to|for|from)\s+/giu;
  const NAME_AFTER_GREETING = /(?:^|[^\p{L}])(?:bonjour|bonsoir|salut|hello|hi)\s*[,;:]?\s*/giu;
  const NAME_AT_SENTENCE_START = new RegExp(
    "(?:^|[.!?;:]\\s*)(" + NAME_PART + ")\\s+(?:has received|has sent|received|transferred|sent|paid|got|made|a reçu|a envoyé|a|est|vient|reçoit|recu|effectue|envoie|enverra|doit|confirme)\\b",
    "u"
  );
  const SINGLE_NAME = new RegExp(
    `^(?:(?:M(?:me|lle)?|Monsieur|Madame)\\.?\\s+)?${NAME_PART}(?:[\\s'-]+${NAME_PART}){0,2}(?=$|[\\s|,;.!?0-9])`,
    "u"
  );
  const NON_NAME_WORDS = new Set([
    "a", "à", "accueil", "alerte", "argent", "au", "aucun", "aux", "avec", "banque", "bénéficiaire", "bienvenue", "bonjour",
    "bonsoir", "ce", "cette", "ces", "choisissez", "choisir", "code", "commission", "compte", "confidentialité", "connexion",
    "confirmez", "confirmer", "confirmation", "consultez", "consulter", "courant", "dans", "de", "demain",
    "des", "dites", "disponible", "du", "effectué", "effectuer", "effectuez", "électricité", "en", "envoyer", "envoyez",
    "erreur", "est", "et", "f", "fcfa", "frais", "historique", "insuffisant", "j'ai", "je", "la", "le", "les", "paiement", "page", "charge", "reçu",
    "lancez", "lancer", "ligne", "madame", "mademoiselle", "marchand", "merci", "mobile", "montant", "motif",
    "monsieur", "money", "nom", "non", "nous", "numéro", "online", "opération", "paiement", "par", "pay", "pour", "sécurité", "sécurisée", "services",
    "récapitulatif", "renseigner", "renseignez", "référence", "récentes", "récent", "réussie", "safinum", "salaire", "solde", "succès", "sur",
    "tarif", "tarifs", "total", "transaction", "transactions", "transfert", "transférer", "une", "un", "valider", "validez", "vérifié",
    "vérifiez", "veuillez", "virement", "vous", "votre", "vos", "oui", "échec", "téléphone",
    "a", "an", "and", "available", "balance", "bank", "beneficiary", "cash", "confirm",
    "customer", "fee", "fees", "for", "from", "hello", "hi", "history", "is", "my",
    "name", "of", "on", "online", "or", "paid", "payment", "please", "recent",
    "recipient", "received", "send", "sent", "the", "to", "transfer", "transaction",
    "transactions", "wallet", "was", "withdrawal", "with", "your", "account", "amount",
    "deposit", "total", "card", "cards", "credit", "debit", "details", "fund", "funds", "service", "bill",
    "airtime", "utility", "loan", "withdraw", "home", "help", "profile", "settings", "invoice",
    "request", "payments", "international", "statement", "statements", "there", "how", "can", "click",
    "view", "select", "choose", "change", "update", "manage", "more", "information", "email", "phone",
    "number", "address", "here", "now", "back", "next", "previous", "country", "language", "currency",
    "start", "finish", "make", "open", "save", "edit", "check", "review", "go", "get", "send",
    "receive", "pay", "submit", "continue", "cancel", "log", "sign", "in", "up", "see", "all",
    "accounts", "support", "voir", "consulter", "créditer", "faire"
  ]);

  // L'état par nœud évite de redemander un texte déjà traité après une mutation DOM.
  let processedTextNodes = new WeakMap();
  let replacedTextNodes = new WeakMap();
  let settings = { enabled: true, sourceLang: "auto", targetLang: "ewondo", displayMode: "overlay" };
  let scanTimer = null;
  let activeAudio = null;
  let activeAudioUrl = null;
  let activeAudioButton = null;
  let pendingTranslations = [];
  let translationBatchTimer = null;
  let extensionContextUnavailable = false;
  let observer = null;
  let translationGeneration = 0;
  const translationRequestCache = new Map();
  const translatedAttributeRecords = new WeakMap();
  const translatedAttributeElements = new Set();
  const observedShadowRoots = new WeakSet();
  const translationMarkers = new Set();
  const replacedElements = new Set();
  let textTranslationMarkers = new WeakMap();

  function isExtensionContextError(error) {
    if (error?.code === "TALK_AFRICA_EXTENSION_CONTEXT_INVALIDATED") return true;
    const message = typeof error?.message === "string" ? error.message : String(error || "");
    return /extension context invalidated|message channel closed|message port closed|receiving end does not exist|cannot read properties of undefined.*sendmessage/i.test(message);
  }

  function createExtensionContextError() {
    const error = new Error("Le contexte TALK AFRICA a été rechargé ; actualisez cette page.");
    error.code = "TALK_AFRICA_EXTENSION_CONTEXT_INVALIDATED";
    return error;
  }

  function invalidateExtensionContext(error) {
    if (extensionContextUnavailable) return;
    extensionContextUnavailable = true;
    observer?.disconnect();
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (translationBatchTimer !== null) {
      clearTimeout(translationBatchTimer);
      translationBatchTimer = null;
    }
    pendingTranslations.splice(0).forEach((request) => {
      translationRequestCache.delete(request.cacheKey);
      request.reject(error);
    });
  }

  function isContextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function sendMessageSafely(message, callback) {
    const deliver = (response) => {
      if (typeof callback !== "function") return;
      try {
        callback(response);
      } catch (error) {
        console.error("TALK AFRICA Callback Error:", error);
      }
    };

    if (extensionContextUnavailable || !isContextValid()) {
      const error = createExtensionContextError();
      invalidateExtensionContext(error);
      const response = { error: "Extension context invalidated", code: error.code };
      deliver(response);
      return typeof callback === "function" ? undefined : Promise.resolve(response);
    }

    const request = new Promise((resolve) => {
      try {
        const runtime = globalThis.chrome.runtime;
        runtime.sendMessage(message, (response) => {
          let result = response;
          try {
            if (runtime.lastError) result = { error: runtime.lastError.message };
          } catch (error) {
            result = { error: error.message || "Extension context invalidated" };
          }
          if (!result) result = { error: "Réponse vide du service worker TALK AFRICA." };
          if (isExtensionContextError(new Error(result.error || ""))) {
            invalidateExtensionContext(new Error(result.error));
          }
          resolve(result);
        });
      } catch (error) {
        if (isExtensionContextError(error)) invalidateExtensionContext(error);
        resolve({ error: error.message || "Impossible d’envoyer le message TALK AFRICA." });
      }
    });

    if (typeof callback === "function") {
      request.then(deliver);
      return undefined;
    }
    return request;
  }

  function normalizeTargetLang(language) {
    return ["ewondo", "fulfulde"].includes(language) ? language : "ewondo";
  }

  function normalizeSourceLang(language) {
    return ["fr", "en"].includes(language) ? language : "auto";
  }

  function countLanguageHints(text, pattern) {
    pattern.lastIndex = 0;
    return Array.from(text.matchAll(pattern)).length;
  }

  function detectSourceLang(text = "", contextElement = null) {
    const preferred = normalizeSourceLang(settings.sourceLang);
    if (preferred !== "auto") return preferred;

    const englishHints = countLanguageHints(text, ENGLISH_LANGUAGE_HINTS);
    const frenchHints = countLanguageHints(text, FRENCH_LANGUAGE_HINTS);
    if (englishHints > frenchHints) return "en";
    if (frenchHints > englishHints) return "fr";

    let current = contextElement;
    while (current) {
      const language = current.getAttribute?.("lang") || "";
      const baseLanguage = language.trim().toLowerCase().split(/[-_]/)[0];
      if (baseLanguage === "en" || baseLanguage === "fr") return baseLanguage;
      current = current.parentElement || current.getRootNode?.().host || null;
    }
    const pageLanguage = document.documentElement?.getAttribute("lang") || "";
    return pageLanguage.trim().toLowerCase().split(/[-_]/)[0] === "en" ? "en" : "fr";
  }

  function normalizeDisplayMode(mode) {
    return mode === "replace" ? "replace" : "overlay";
  }

  // Fonction séparée pour que la politique de confidentialité soit vérifiable.
  function shouldTranslate(text) {
    if (typeof text !== "string" || !text.trim() || PUNCTUATION_ONLY.test(text)) return false;
    if (!/\p{L}/u.test(text) || URL_ONLY.test(text) || NUMBER_ONLY.test(text) ||
        CURRENCY_LABEL_ONLY.test(text) || CURRENCY_ONLY.test(text) ||
        DATE_ONLY.test(text) || MONTH_ONLY.test(text)) return false;
    return true;
  }

  function collectPatternRanges(text, pattern) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    return Array.from(text.matchAll(globalPattern), (match) => ({
      start: match.index,
      end: match.index + match[0].length
    }));
  }

  function getProperNameRanges(text) {
    const leadingLength = text.length - text.trimStart().length;
    const candidate = text
      .toLocaleLowerCase("fr")
      .replace(/(^|[^\p{L}])(\p{L})/gu, (_, separator, letter) =>
        separator + letter.toLocaleUpperCase("fr")
      );
    const ranges = [];
    const trimmedCandidate = candidate.trim();
    if (PURE_NAME.test(trimmedCandidate)) {
      const parts = trimmedCandidate.replace(/[.,]+$/g, "").split(/[\s'-]+/);
      const likelyNameParts = parts.filter((part) =>
        !["m", "mme", "mlle", "monsieur", "madame"].includes(part.toLocaleLowerCase("fr")) &&
        !NON_NAME_WORDS.has(part.toLocaleLowerCase("fr"))
      ).length;
      const hasHonorific = /^(?:M(?:me|lle)?|Monsieur|Madame)\.?\s+/u.test(trimmedCandidate);
      if ((parts.length > 1 && likelyNameParts >= 2) || (hasHonorific && likelyNameParts >= 1)) {
        const start = leadingLength;
        return [{ start, end: start + trimmedCandidate.length }];
      }
    }

    const looksLikeName = (value) => value.split(/[\s'-]+/).some((part) =>
      part && !["m", "mme", "mlle", "monsieur", "madame"].includes(part.toLocaleLowerCase("fr")) &&
      !NON_NAME_WORDS.has(part.toLocaleLowerCase("fr"))
    );

    for (const prefixPattern of [NAME_AFTER_LABEL, NAME_AFTER_PREPOSITION, NAME_AFTER_GREETING]) {
      for (const match of candidate.matchAll(new RegExp(prefixPattern.source, prefixPattern.flags))) {
        const nameOffset = match.index + match[0].length;
        const nameMatch = candidate.slice(nameOffset).match(SINGLE_NAME);
        if (nameMatch && looksLikeName(nameMatch[0])) {
          ranges.push({ start: nameOffset, end: nameOffset + nameMatch[0].length });
        }
      }
    }

    const sentencePattern = new RegExp(NAME_AT_SENTENCE_START.source, "gu");
    for (const match of candidate.matchAll(sentencePattern)) {
      const nameOffset = match.index + match[0].indexOf(match[1]);
      if (looksLikeName(match[1])) {
        ranges.push({ start: nameOffset, end: nameOffset + match[1].length });
      }
    }
    return ranges;
  }

  // Les données sensibles et noms probables restent dans le navigateur.
  function getProtectedRanges(text) {
    const ranges = [];
    for (const pattern of [
      FINANCIAL_NUMBER,
      DATE_PATTERN,
      URL_PATTERN,
      PHONE_NUMBER,
      REFERENCE,
      STRUCTURED_REFERENCE,
      ACCOUNT_NUMBER,
      LABELED_IDENTIFIER
    ]) ranges.push(...collectPatternRanges(text, pattern));
    ranges.push(...getProperNameRanges(text));
    ranges.sort((left, right) => left.start - right.start);
    return ranges.reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
  }

  function splitTextIntoChunks(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const hardEnd = Math.min(start + MAX_TRANSLATION_REQUEST_LENGTH, text.length);
      let end = hardEnd;
      if (hardEnd < text.length) {
        const wordBoundary = text.lastIndexOf(" ", hardEnd);
        if (wordBoundary > start + MAX_TRANSLATION_REQUEST_LENGTH * 0.6) {
          end = wordBoundary + 1;
        }
      }
      if (end <= start) end = hardEnd;
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  async function translateSafeText(text, targetLang, sourceLang) {
    if (!shouldTranslate(text)) {
      return { translated: text, changed: false, warning: null };
    }

    const ranges = getProtectedRanges(text);
    let cursor = 0;
    let translated = "";
    let warning = null;

    async function translateSegment(segment) {
      if (!segment || !segment.trim()) return segment;
      const chunks = splitTextIntoChunks(segment);
      const translatedChunks = await Promise.all(chunks.map(async (chunk) => {
        const leading = chunk.match(/^\s*/)?.[0] || "";
        const trailing = chunk.match(/\s*$/)?.[0] || "";
        const content = chunk.slice(leading.length, chunk.length - trailing.length);
        if (!content || !shouldTranslate(content)) return chunk;

        const result = await requestTranslation(content, sourceLang, targetLang);
        if (result.warning) {
          warning = warning || result.warning;
          return chunk;
        }
        return `${leading}${result.translated}${trailing}`;
      }));
      return translatedChunks.join("");
    }

    for (const range of ranges) {
      translated += await translateSegment(text.slice(cursor, range.start));
      translated += text.slice(range.start, range.end);
      cursor = range.end;
    }
    translated += await translateSegment(text.slice(cursor));

    return { translated, changed: translated !== text, warning };
  }

  function isUnchangedTranslation(source, response) {
    return !response?.error &&
      typeof response.translated === "string" &&
      response.translated.trim() === source.trim();
  }

  function removeTranslationMarker(marker) {
    translationMarkers.delete(marker);
    marker?.remove();
  }

  function removeTranslationAfterNode(textNode) {
    const associated = textTranslationMarkers.get(textNode);
    if (associated) removeTranslationMarker(associated);
    textTranslationMarkers.delete(textNode);
    let next = textNode.nextSibling;
    while (next?.nodeType === Node.ELEMENT_NODE && next.hasAttribute(TRANSLATION_ATTRIBUTE)) {
      const marker = next;
      next = next.nextSibling;
      removeTranslationMarker(marker);
    }
  }

  function releaseActiveAudio() {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio = null;
    }
    if (activeAudioUrl) {
      URL.revokeObjectURL(activeAudioUrl);
      activeAudioUrl = null;
    }
    activeAudioButton = null;
  }

  function createAudioLink(translatedText, targetLang) {
    const link = document.createElement("span");
    link.setAttribute(TRANSLATION_ATTRIBUTE, "true");
    translationMarkers.add(link);
    link.setAttribute("role", "button");
    link.setAttribute("aria-label", "Écouter la traduction");
    link.setAttribute("tabindex", "0");
    link.title = "Écouter la traduction";
    link.textContent = "🔊 Écouter";
    Object.assign(link.style, {
      cursor: "pointer",
      fontSize: "11px",
      color: "#4f46e5",
      textDecoration: "underline",
      whiteSpace: "nowrap",
      background: "transparent",
      border: "0",
      borderRadius: "0",
      boxShadow: "none",
      padding: "0"
    });

    async function playAudio(event) {
      if (extensionContextUnavailable || !isContextValid()) {
        invalidateExtensionContext(createExtensionContextError());
        return;
      }
      try {
        event.preventDefault();
        event.stopPropagation();
        if (activeAudio && !activeAudio.paused && activeAudioButton === link) {
          releaseActiveAudio();
          return;
        }
        releaseActiveAudio();
        link.setAttribute("aria-disabled", "true");

        const response = await sendMessageSafely({
          type: "TALK_AFRICA_SPEAK",
          payload: { text: translatedText, target_lang: targetLang }
        });
        if (!response?.audioBase64) {
          throw new Error(response?.error || "Audio indisponible.");
        }
        if (extensionContextUnavailable || !isContextValid()) {
          invalidateExtensionContext(createExtensionContextError());
          return;
        }

        const binary = atob(response.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        activeAudioUrl = URL.createObjectURL(
          new Blob([bytes], { type: response.mimeType || "audio/wav" })
        );
        activeAudio = new Audio(activeAudioUrl);
        activeAudioButton = link;
        activeAudio.addEventListener("ended", releaseActiveAudio, { once: true });
        activeAudio.addEventListener("error", releaseActiveAudio, { once: true });
        await activeAudio.play();
      } catch (error) {
        if (isExtensionContextError(error) || !isContextValid()) {
          invalidateExtensionContext(error);
          return;
        }
        console.warn("TALK AFRICA : lecture audio indisponible.", error);
        try {
          link.title = error?.message || "Audio indisponible";
          link.setAttribute("aria-label", link.title);
        } catch (uiError) {
          if (isExtensionContextError(uiError)) invalidateExtensionContext(uiError);
        }
      } finally {
        try {
          if (!extensionContextUnavailable && isContextValid()) {
            link.removeAttribute("aria-disabled");
          }
        } catch (error) {
          if (isExtensionContextError(error)) invalidateExtensionContext(error);
        }
      }
    }

    link.addEventListener("click", playAudio);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") void playAudio(event);
    });

    return link;
  }

  function createTranslationBoxAfterNode(textNode, translatedText, audioText = null, targetLang = settings.targetLang) {
    const parent = textNode.parentElement;
    if (!parent || !textNode.isConnected) return;

    const box = document.createElement("span");
    box.setAttribute(TRANSLATION_ATTRIBUTE, "true");
    translationMarkers.add(box);
    textTranslationMarkers.set(textNode, box);
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    const label = document.createElement("span");
    label.textContent = `🌍 ${translatedText}`;
    box.appendChild(label);
    if (audioText) box.appendChild(createAudioLink(audioText, targetLang));

    // Conteneur en ligne discret pour ne pas imposer un grand panneau au site.
    Object.assign(box.style, {
      display: "flex",
      alignItems: "center",
      gap: "7px",
      boxSizing: "border-box",
      width: "fit-content",
      margin: "2px 0 4px",
      padding: "2px 0",
      border: "0",
      borderRadius: "0",
      background: "transparent",
      color: "#374151",
      font: "13px/1.4 'Inter', system-ui, sans-serif",
      whiteSpace: "normal"
    });
    label.style.flex = "1 1 auto";

    let svg = parent.namespaceURI === "http://www.w3.org/2000/svg" ? parent.closest("svg") : null;
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    if (svg?.parentNode) svg.parentNode.insertBefore(box, svg.nextSibling);
    else parent.insertBefore(box, textNode.nextSibling);
  }

  function restoreReplacedText() {
    replacedElements.forEach((element) => {
      try {
        const savedNodes = JSON.parse(element.getAttribute(ORIGINAL_ATTRIBUTE));
        if (Array.isArray(savedNodes)) {
          savedNodes.forEach((saved) => {
            let node = element.childNodes[saved.index];
            if (node?.nodeType !== Node.TEXT_NODE || node.nodeValue !== saved.translated) {
              node = Array.from(element.childNodes).find((candidate) =>
                candidate.nodeType === Node.TEXT_NODE && candidate.nodeValue === saved.translated
              );
            }
            // Ne remplace pas une valeur que le site a changée depuis la traduction.
            if (node?.nodeType === Node.TEXT_NODE && node.nodeValue === saved.translated) {
              node.nodeValue = saved.original;
            }
          });
        }
      } catch (error) {
        console.warn("TALK AFRICA : impossible de restaurer un nœud texte.", error);
      }
      element.removeAttribute(ORIGINAL_ATTRIBUTE);
    });
    replacedElements.clear();
  }

  function scheduleTranslationBatch(delay = TRANSLATION_BATCH_WINDOW_MS) {
    if (extensionContextUnavailable || translationBatchTimer !== null) return;
    translationBatchTimer = setTimeout(() => {
      translationBatchTimer = null;
      flushTranslationBatch();
    }, delay);
  }

  function flushTranslationBatch() {
    if (extensionContextUnavailable) return;
    if (translationBatchTimer !== null) {
      clearTimeout(translationBatchTimer);
      translationBatchTimer = null;
    }
    if (!pendingTranslations.length) return;

    const batch = pendingTranslations.splice(0, TRANSLATION_BATCH_SIZE);
    sendMessageSafely({
      type: "TALK_AFRICA_TRANSLATE_BATCH",
      payload: {
        items: batch.map(({ text, sourceLang, targetLang }) => ({
          text,
          source_lang: sourceLang,
          target_lang: targetLang,
          allow_short_segments: true
        }))
      }
    })
      .then((response) => {
        if (response?.error) throw new Error(response.error);
        if (!Array.isArray(response?.results) || response.results.length !== batch.length) {
          throw new Error(response?.error || "Réponse de traduction groupée invalide");
        }
        response.results.forEach((item, index) => {
          if (!item || typeof item.translated !== "string" || !item.translated.trim()) {
            translationRequestCache.delete(batch[index].cacheKey);
            batch[index].reject(new Error("Réponse de traduction invalide"));
            return;
          }
          const result = {
            translated: item.translated.trim(),
            warning: item.error?.message || null,
            unchanged: isUnchangedTranslation(batch[index].text, item)
          };
          if (result.warning) {
            translationRequestCache.delete(batch[index].cacheKey);
          }
          batch[index].resolve(result);
        });
      })
      .catch((error) => batch.forEach((request) => {
        translationRequestCache.delete(request.cacheKey);
        request.reject(error);
      }))
      .finally(() => {
        if (pendingTranslations.length) scheduleTranslationBatch(0);
      });
  }

  function requestTranslation(text, sourceLang, targetLang) {
    const cacheKey = `${sourceLang}\u0000${targetLang}\u0000${text}`;
    const cached = translationRequestCache.get(cacheKey);
    if (cached) return cached;

    const promise = new Promise((resolve, reject) => {
      pendingTranslations.push({ text, sourceLang, targetLang, cacheKey, resolve, reject });
      if (pendingTranslations.length >= TRANSLATION_BATCH_SIZE) {
        flushTranslationBatch();
      } else {
        scheduleTranslationBatch();
      }
    });
    if (translationRequestCache.size >= MAX_TRANSLATION_CACHE_ENTRIES) {
      const oldestKey = translationRequestCache.keys().next().value;
      if (oldestKey !== undefined) translationRequestCache.delete(oldestKey);
    }
    translationRequestCache.set(cacheKey, promise);
    promise.catch(() => translationRequestCache.delete(cacheKey));
    return promise;
  }

  function getReplacementRecords(element) {
    if (!element?.hasAttribute(ORIGINAL_ATTRIBUTE)) return [];
    try {
      const records = JSON.parse(element.getAttribute(ORIGINAL_ATTRIBUTE));
      return Array.isArray(records) ? records : [];
    } catch (_) {
      return [];
    }
  }

  function isReplacementTextNode(textNode) {
    const liveRecord = replacedTextNodes.get(textNode);
    if (liveRecord && liveRecord.translated === textNode.nodeValue) return true;

    const parent = textNode.parentElement;
    if (!parent) return false;
    const index = Array.prototype.indexOf.call(parent.childNodes, textNode);
    return getReplacementRecords(parent).some((record) =>
      record.index === index && record.translated === textNode.nodeValue
    );
  }

  function saveAndReplaceTextNode(textNode, original, translated) {
    const parent = textNode.parentElement;
    if (!parent) return false;
    const index = Array.prototype.indexOf.call(parent.childNodes, textNode);
    const records = getReplacementRecords(parent);
    const existing = records.findIndex((record) => record.index === index);
    const record = { index, original, translated };
    if (existing >= 0) records[existing] = record;
    else records.push(record);
    parent.setAttribute(ORIGINAL_ATTRIBUTE, JSON.stringify(records));
    replacedElements.add(parent);
    textNode.nodeValue = translated;
    replacedTextNodes.set(textNode, record);
    return true;
  }

  function translateElementAttributes(element) {
    if (!element?.isConnected || element.closest(ATTRIBUTE_EXCLUSION_SELECTOR)) return;

    let records = translatedAttributeRecords.get(element);
    if (!records) {
      records = new Map();
      translatedAttributeRecords.set(element, records);
    }

    for (const attributeName of TRANSLATABLE_ATTRIBUTES) {
      if (!element.hasAttribute(attributeName)) continue;
      if (attributeName === "value" &&
          (element.tagName !== "INPUT" || !["button", "submit", "reset"].includes((element.getAttribute("type") || "text").toLowerCase()))) {
        continue;
      }
      if (attributeName === "label" && !["OPTION", "OPTGROUP"].includes(element.tagName)) continue;
      let original = element.getAttribute(attributeName) || "";
      if (!shouldTranslate(original)) continue;

      let existing = records.get(attributeName);
      if (existing && original === existing.translated) {
        if (detectSourceLang(existing.original, element) === existing.sourceLang &&
            settings.targetLang === existing.targetLang) continue;
        element.setAttribute(attributeName, existing.original);
        original = existing.original;
        records.delete(attributeName);
        existing = null;
      }
      if (existing && original === existing.original && existing.translated === null) continue;
      if (existing && original === existing.original && existing.translated !== null) {
        records.delete(attributeName);
      }

      const generation = translationGeneration;
      const sourceLang = detectSourceLang(original, element);
      const targetLang = settings.targetLang;
      const record = { original, translated: null, sourceLang, targetLang, generation };
      records.set(attributeName, record);
      translatedAttributeElements.add(element);

      void requestTranslation(original, sourceLang, targetLang)
        .then((result) => {
          if (extensionContextUnavailable || !isContextValid()) {
            invalidateExtensionContext(createExtensionContextError());
            return;
          }
          if (translationGeneration !== generation || !settings.enabled ||
              settings.targetLang !== targetLang || records.get(attributeName) !== record ||
              !element.isConnected || element.getAttribute(attributeName) !== original || result.warning) {
            if (records.get(attributeName) === record &&
                (!element.isConnected || element.getAttribute(attributeName) !== original || result.warning)) {
              records.delete(attributeName);
              if (records.size === 0) translatedAttributeElements.delete(element);
            }
            return;
          }
          if (detectSourceLang(original, element) !== sourceLang) {
            records.delete(attributeName);
            if (records.size === 0) translatedAttributeElements.delete(element);
            scheduleScan();
            return;
          }
          if (result.changed) {
            record.translated = result.translated;
            element.setAttribute(attributeName, result.translated);
          } else {
            records.delete(attributeName);
          }
          if (records.size === 0) translatedAttributeElements.delete(element);
        })
        .catch((error) => {
          if (isExtensionContextError(error) || !isContextValid()) {
            invalidateExtensionContext(error);
            return;
          }
          if (records.get(attributeName) === record) records.delete(attributeName);
          if (records.size === 0) translatedAttributeElements.delete(element);
          console.warn(`TALK AFRICA : traduction indisponible pour l’attribut ${attributeName}.`, error);
        });
    }
  }

  async function translateTextNode(textNode) {
    const parent = textNode.parentElement;
    if (extensionContextUnavailable || !settings.enabled || !parent || !textNode.isConnected || isReplacementTextNode(textNode)) return;
    if (parent.closest(TEXT_EXCLUSION_SELECTOR)) return;

    const original = textNode.nodeValue || "";
    if (!shouldTranslate(original)) return;

    const targetLang = settings.targetLang;
    const sourceLang = detectSourceLang(original, parent);
    const displayMode = settings.displayMode;
    const key = `${sourceLang}\u0000${targetLang}\u0000${displayMode}\u0000${original}`;
    if (processedTextNodes.get(textNode) === key) return;
    processedTextNodes.set(textNode, key);
    removeTranslationAfterNode(textNode);

    try {
      const result = await translateSafeText(original, targetLang, sourceLang);
      if (extensionContextUnavailable || !isContextValid()) {
        invalidateExtensionContext(createExtensionContextError());
        return;
      }
      if (!settings.enabled || settings.targetLang !== targetLang ||
          sourceLang !== detectSourceLang(original, parent) ||
          settings.displayMode !== displayMode || !textNode.isConnected ||
          textNode.nodeValue !== original) return;

      if (!result.changed) {
        if (result.warning && displayMode === "overlay") {
          createTranslationBoxAfterNode(
            textNode,
            "Traduction indisponible ; le texte original est conservé.",
            null,
            targetLang
          );
        }
        return;
      }

      if (displayMode === "replace" || parent.tagName === "OPTION") {
        if (saveAndReplaceTextNode(textNode, original, result.translated)) {
          if (parent.tagName !== "OPTION" && textNode.parentElement.namespaceURI !== "http://www.w3.org/2000/svg") {
            const audioLink = createAudioLink(result.translated, targetLang);
            textNode.parentElement.insertBefore(audioLink, textNode.nextSibling);
          }
        }
      } else {
        createTranslationBoxAfterNode(textNode, result.translated, result.translated, targetLang);
      }
    } catch (error) {
      if (isExtensionContextError(error) || !isContextValid()) {
        invalidateExtensionContext(error);
        return;
      }
      // Une panne API ne doit jamais interrompre le site tiers.
      console.warn("TALK AFRICA : traduction indisponible pour ce nœud texte.", error);
      if (settings.enabled && settings.displayMode === "overlay" &&
          settings.targetLang === targetLang && textNode.isConnected && isContextValid()) {
        try {
          createTranslationBoxAfterNode(
            textNode,
            "Traduction indisponible ; le texte original est conservé.",
            null,
            targetLang
          );
        } catch (uiError) {
          if (isExtensionContextError(uiError)) invalidateExtensionContext(uiError);
        }
      }
    }
  }

  function scanPage() {
    if (extensionContextUnavailable || !settings.enabled || !document.body) return;
    for (const marker of translationMarkers) {
      if (!marker.isConnected) translationMarkers.delete(marker);
    }
    for (const element of translatedAttributeElements) {
      if (!element.isConnected) translatedAttributeElements.delete(element);
    }
    for (const element of replacedElements) {
      if (!element.isConnected) replacedElements.delete(element);
    }
    if (document.documentElement) {
      translateElementAttributes(document.documentElement);
    }
    const textNodes = [];
    const roots = [document.body];
    const visitedRoots = new Set();
    while (roots.length) {
      const root = roots.pop();
      if (!root || visitedRoots.has(root)) continue;
      visitedRoots.add(root);
      if (root.nodeType === Node.ELEMENT_NODE) translateElementAttributes(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent) continue;
        if (parent.closest(TEXT_EXCLUSION_SELECTOR)) continue;
        textNodes.push(node);
      }

      for (const element of root.querySelectorAll?.("*") || []) {
        translateElementAttributes(element);
        if (element.shadowRoot && !observedShadowRoots.has(element.shadowRoot)) {
          observedShadowRoots.add(element.shadowRoot);
          if (observer) observer.observe(element.shadowRoot, getObserverOptions());
          roots.push(element.shadowRoot);
        } else if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      }
    }
    textNodes.forEach((node) => void translateTextNode(node));
  }

  function scheduleScan() {
    if (extensionContextUnavailable) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, 500);
  }

  function getObserverOptions() {
    return {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class", "style", "hidden", "aria-hidden", "lang", "contenteditable", "type",
        ...TRANSLATABLE_ATTRIBUTES
      ]
    };
  }

  function hasPageMutation(records) {
    return records.some((record) => {
      if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (!parent?.hasAttribute(ORIGINAL_ATTRIBUTE)) return true;
        return !getReplacementRecords(parent).some((saved) =>
          saved.translated === record.target.nodeValue
        );
      }

      if (record.type === "attributes") {
        const translated = translatedAttributeRecords.get(record.target)?.get(record.attributeName);
        if (translated && record.target.getAttribute(record.attributeName) === translated.translated) return false;
        return !record.target.closest(`[${TRANSLATION_ATTRIBUTE}]`);
      }

      const changedNodes = [...record.addedNodes, ...record.removedNodes];
      return changedNodes.some((node) => {
        if (node.nodeType === Node.TEXT_NODE) return true;
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        return !node.matches(`[${TRANSLATION_ATTRIBUTE}]`) &&
          !node.closest(`[${TRANSLATION_ATTRIBUTE}]`);
      });
    });
  }

  function clearTranslations() {
    translationGeneration += 1;
    releaseActiveAudio();
    restoreReplacedText();
    replacedTextNodes = new WeakMap();
    for (const element of translatedAttributeElements) {
      const records = translatedAttributeRecords.get(element);
      records?.forEach((record, attributeName) => {
        if (record.translated !== null && element.getAttribute(attributeName) === record.translated) {
          element.setAttribute(attributeName, record.original);
        }
        records.delete(attributeName);
      });
    }
    translatedAttributeElements.clear();
    for (const marker of translationMarkers) marker.remove();
    translationMarkers.clear();
    textTranslationMarkers = new WeakMap();
  }

  // Expose la fonction uniquement aux tests Node ; Chrome ne définit pas `module`.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { shouldTranslate, isUnchangedTranslation, getProtectedRanges };
    return;
  }

  // Les réglages seront partagés avec popup.js via chrome.storage.sync.
  chrome.storage.sync.get({
    enabled: true,
    sourceLang: "auto",
    targetLang: "ewondo",
    displayMode: "overlay"
  }, (saved) => {
    settings = {
      enabled: saved.enabled !== false,
      sourceLang: normalizeSourceLang(saved.sourceLang),
      targetLang: normalizeTargetLang(saved.targetLang),
      displayMode: normalizeDisplayMode(saved.displayMode)
    };
    scanPage();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      if (!settings.enabled) {
        clearTranslations();
        processedTextNodes = new WeakMap();
      }
    }
    if (changes.sourceLang) {
      settings.sourceLang = normalizeSourceLang(changes.sourceLang.newValue);
      clearTranslations();
      processedTextNodes = new WeakMap();
    }
    if (changes.targetLang) {
      settings.targetLang = normalizeTargetLang(changes.targetLang.newValue);
      clearTranslations();
      // Autorise une nouvelle traduction dans la langue choisie.
      processedTextNodes = new WeakMap();
    }
    if (changes.displayMode) {
      settings.displayMode = normalizeDisplayMode(changes.displayMode.newValue);
      clearTranslations();
      processedTextNodes = new WeakMap();
    }

    if (settings.enabled) scanPage();
    else clearTranslations();
  });

  // Observe les nouveaux blocs et les textes mis à jour par les pages dynamiques.
  observer = new MutationObserver((records) => {
    if (hasPageMutation(records)) scheduleScan();
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, getObserverOptions());
  }
})();
