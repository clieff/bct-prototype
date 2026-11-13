const test = require("node:test");
const assert = require("node:assert/strict");
const { getProtectedRanges, isUnchangedTranslation, shouldTranslate } = require("./content.js");

test("bloque les noms et les mentions de bénéficiaires", () => {
  for (const text of [
    "Amina Ngo Bell",
    "Jean a reçu un transfert de 3 500 FCFA",
    "Bénéficiaire : Jean | 3 500 FCFA",
    "Transfert pour Jean Paul : 3 500 FCFA",
  ]) {
    assert.equal(shouldTranslate(text), false, text);
  }
});

test("bloque les téléphones, références et numéros de compte", () => {
  for (const text of [
    "Téléphone 677 88 99 00 pour le transfert",
    "Numéro +237 677 88 99 00",
    "Contact +237 691-949-899",
    "Référence REF-883-2026",
    "Transaction TX-883-2026",
    "CM 001 2345 6789 01",
    "Numéro de compte : CM 001 2345 6789 01",
  ]) {
    assert.equal(shouldTranslate(text), false, text);
  }
});

test("n'envoie pas les lignes contenant uniquement un montant", () => {
  for (const text of ["250 000 FCFA", "-12 500 FCFA", "+180 000 FCFA", "3 500 francs"]) {
    assert.equal(shouldTranslate(text), false, text);
  }
});

test("laisse passer les libellés financiers sans donnée personnelle", () => {
  for (const text of [
    "Transfert de 3 500 FCFA",
    "Solde disponible : 25 000 FCFA",
    "Frais de transfert : 100 FCFA",
    "Bonjour, veuillez confirmer la transaction.",
    "Effectuer un transfert",
    "Consulter les frais",
    "Récapitulatif et confirmation",
    "Transactions récentes",
    "Connexion sécurisée",
    "Safinum Pay",
    "Nom du bénéficiaire",
    "Numéro de téléphone",
    "J'ai vérifié le nom et le numéro du bénéficiaire.",
    "Erreur : solde insuffisant pour effectuer le transfert.",
  ]) {
    assert.equal(shouldTranslate(text), true, text);
  }
});

test("accepte les titres et libellés généraux de la page", () => {
  for (const text of [
    "VOTRE COMPTE",
    "TRANSACTIONS RÉCENTES",
    "Paiement marchand",
    "Salaire reçu",
    "Numéro de téléphone",
    "Bonjour,",
    "La page se charge"
  ]) {
    assert.equal(shouldTranslate(text), true, text);
  }
});

test("protège aussi les dates et les URL seules", () => {
  for (const text of ["05 nov. 2026", "https://safinum.cm/hackathon-test", "www.safinum.cm"]) {
    assert.equal(shouldTranslate(text), false, text);
  }
});

test("masque les montants, dates et URL avant l'appel au traducteur", () => {
  const text = "Solde : +180 000 FCFA, le 05 nov. 2026 — https://safinum.cm";
  const protectedValues = getProtectedRanges(text).map(({ start, end }) => text.slice(start, end));
  assert.deepEqual(protectedValues, [
    "+180 000 FCFA",
    "05 nov. 2026",
    "https://safinum.cm"
  ]);
});

test("évite de dupliquer toute réponse identique à l'original", () => {
  assert.equal(
    isUnchangedTranslation("Frais de 1,5 %", {
      translated: "Frais de 1,5 %",
      fallback_used: true,
    }),
    true
  );
  assert.equal(
    isUnchangedTranslation("250 000 FCFA", {
      translated: "250 000 FCFA",
      fallback_used: false,
    }),
    true
  );
  assert.equal(
    isUnchangedTranslation("Solde disponible", {
      translated: "Solde ngu",
      fallback_used: false,
    }),
    false
  );
  assert.equal(
    isUnchangedTranslation("Message", {
      translated: "Message",
      fallback_used: true,
      error: { code: "translation_failed" },
    }),
    false
  );
});
