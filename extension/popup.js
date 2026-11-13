"use strict";

const enabledCheckbox = document.getElementById("enabled");
const sourceLangSelect = document.getElementById("sourceLang");
const langSelect = document.getElementById("lang");
const displayModeSelect = document.getElementById("displayMode");
const statusDiv = document.getElementById("status");

function showStatus(message, isError = false) {
  statusDiv.textContent = message;
  statusDiv.dataset.error = String(isError);
}

function reloadActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      showStatus("Réglage enregistré, mais l’onglet n’a pas pu être actualisé.", true);
      return;
    }
    const activeTab = tabs && tabs[0];
    if (activeTab && Number.isInteger(activeTab.id)) {
      chrome.tabs.reload(activeTab.id, () => {
        if (chrome.runtime.lastError) {
          showStatus("Réglage enregistré, mais l’onglet n’a pas pu être actualisé.", true);
        }
      });
    }
  });
}

function saveSettings(values, successMessage, reloadTab = false) {
  chrome.storage.sync.set(values, () => {
    if (chrome.runtime.lastError) {
      showStatus("Impossible d’enregistrer les réglages.", true);
      return;
    }

    showStatus(successMessage);
    if (reloadTab) reloadActiveTab();
  });
}

chrome.storage.sync.get({
  enabled: true,
  sourceLang: "auto",
  targetLang: "ewondo",
  displayMode: "overlay"
}, (saved) => {
  if (chrome.runtime.lastError) {
    showStatus("Impossible de lire les réglages.", true);
    return;
  }

  enabledCheckbox.checked = saved.enabled !== false;
  sourceLangSelect.value = ["fr", "en"].includes(saved.sourceLang) ? saved.sourceLang : "auto";
  langSelect.value = saved.targetLang === "fulfulde" ? "fulfulde" : "ewondo";
  displayModeSelect.value = saved.displayMode === "replace" ? "replace" : "overlay";
  showStatus("Prêt");
});

enabledCheckbox.addEventListener("change", () => {
  saveSettings(
    { enabled: enabledCheckbox.checked },
    enabledCheckbox.checked ? "Traduction activée" : "Traduction désactivée"
  );
});

sourceLangSelect.addEventListener("change", () => {
  const sourceName = { auto: "automatique", fr: "français", en: "anglais" }[sourceLangSelect.value];
  saveSettings({ sourceLang: sourceLangSelect.value }, `Langue source : ${sourceName}`);
});

langSelect.addEventListener("change", () => {
  saveSettings({ targetLang: langSelect.value }, "Langue mise à jour");
});

displayModeSelect.addEventListener("change", () => {
  saveSettings(
    { displayMode: displayModeSelect.value },
    "Mode d’affichage mis à jour",
    true
  );
});
