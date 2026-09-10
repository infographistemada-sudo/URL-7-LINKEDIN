// scrape.js
// Portage Node.js du script Google Apps Script d'extraction automatique
// (emails, réseaux sociaux, SIREN/SIRET) à partir d'une liste d'URLs.
//
// Fonctionne en "cycles" comme la version Sheets : chaque exécution
// traite les lignes non terminées du CSV pendant un temps limité (pour
// rester compatible avec les workflows GitHub Actions déclenchés par cron),
// puis s'arrête proprement. Le prochain déclenchement planifié reprend là
// où le précédent s'est arrêté.

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const iconv = require("iconv-lite");
const jschardet = require("jschardet");

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data", "leads.csv");
const STOP_FILE = process.env.STOP_FILE || path.join(__dirname, "..", "data", "STOP");
// Limite de temps par exécution (par défaut 4 minutes, pour laisser de la
// marge au workflow GitHub Actions pour committer les résultats).
const TIME_LIMIT_MS = parseInt(process.env.TIME_LIMIT_MS || "240000", 10);
// Petite pause entre deux requêtes pour rester poli envers les sites visités.
const DELAY_MS = parseInt(process.env.DELAY_MS || "300", 10);
// Nombre d'URLs traitées EN PARALLÈLE. Avec plusieurs milliers de lignes,
// un traitement séquentiel (1 à la fois) est beaucoup trop lent : monter
// la concurrence accélère très nettement le débit global.
const CONCURRENCE = parseInt(process.env.CONCURRENCE || "8", 10);
// Timeout par requête HTTP : évite qu'un site lent ou muet ne bloque tout
// le script indéfiniment (fetch n'a pas de timeout par défaut).
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);

const COLONNES = ["url", "email", "reseaux_sociaux", "siren", "siret"];

// Noms de colonnes acceptés en entrée (insensible à la casse/accents) pour
// chaque champ reconnu. Permet de lire des CSV dont l'en-tête ne correspond
// pas exactement au format attendu (export Excel, autre outil, etc.).
const SYNONYMES_COLONNES = {
  url: ["url", "site", "site web", "website", "lien", "adresse", "adresse web"],
  email: ["email", "e-mail", "mail", "courriel"],
  reseaux_sociaux: ["reseaux_sociaux", "reseaux sociaux", "rs", "social", "social media"],
  siren: ["siren"],
  siret: ["siret"],
};

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RS_REGEX = /href=["'](https?:\/\/(?:www\.)?(?:facebook|instagram)\.com\/[^"']+)["']/gi;
const SIREN_REGEX = /\b\d{3}[ \u00A0]?\d{3}[ \u00A0]?\d{3}\b/g;
const SIRET_REGEX = /\b\d{3}[ \u00A0]?\d{3}[ \u00A0]?\d{3}[ \u00A0]?\d{5}\b/g;

const STATUTS_A_REPRENDRE = new Set([
  "",
  "🔄 En cours...",
  "Aucun e-mail trouvé",
  "Erreur de connexion au site",
  "URL invalide ou vide",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------
// Lecture / écriture du CSV
// ----------------------------------------------------------------------
// Convertit un buffer brut en texte UTF-8, quel que soit l'encodage d'origine
// (UTF-8, UTF-8 avec BOM, Windows-1252/Latin1 — encodage typique d'un export
// Excel français, UTF-16, etc.).
function decoderEnUtf8(buffer) {
  // BOM UTF-16 LE/BE explicites
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer, "utf16be").replace(/^\uFEFF/, "");
  }
  // BOM UTF-8 explicite
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf8").replace(/^\uFEFF/, "");
  }
  // Pas de BOM : on laisse jschardet deviner (utile pour les fichiers
  // exportés depuis Excel en Windows-1252/ISO-8859-1, très courant en FR).
  const detection = jschardet.detect(buffer);
  const encodingDetecte = (detection && detection.encoding || "utf-8").toLowerCase();
  if (encodingDetecte.includes("utf-8") || encodingDetecte.includes("ascii")) {
    return buffer.toString("utf8");
  }
  if (iconv.encodingExists(encodingDetecte)) {
    return iconv.decode(buffer, encodingDetecte);
  }
  // Repli si l'encodage détecté n'est pas géré : Windows-1252 est le cas
  // le plus fréquent pour un CSV "bizarre" produit sous Windows.
  return iconv.decode(buffer, "windows-1252");
}

// Devine le séparateur (virgule, point-virgule ou tabulation) en comptant
// les occurrences sur les premières lignes non vides.
function detecterSeparateur(texte) {
  const premieresLignes = texte.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 5);
  const candidats = [",", ";", "\t"];
  let meilleur = ",";
  let meilleurScore = -1;
  for (const sep of candidats) {
    const score = premieresLignes.reduce((total, ligne) => total + ligne.split(sep).length - 1, 0);
    if (score > meilleurScore) {
      meilleurScore = score;
      meilleur = sep;
    }
  }
  return meilleurScore > 0 ? meilleur : ",";
}

function normaliserNomColonne(nom) {
  return (nom || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // retire les accents
}

// Retrouve, pour chaque champ reconnu (url, email, ...), le nom de colonne
// réellement utilisé dans le fichier source.
function detecterCorrespondanceColonnes(nomsColonnesSource) {
  const normalises = nomsColonnesSource.map(normaliserNomColonne);
  const correspondance = {};
  for (const [champ, synonymes] of Object.entries(SYNONYMES_COLONNES)) {
    const synonymesNormalises = synonymes.map(normaliserNomColonne);
    const index = normalises.findIndex((n) => synonymesNormalises.includes(n));
    if (index !== -1) correspondance[champ] = nomsColonnesSource[index];
  }
  return correspondance;
}

function chargerDonnees() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`Fichier introuvable : ${DATA_FILE}`);
  }

  const buffer = fs.readFileSync(DATA_FILE);
  const texte = decoderEnUtf8(buffer).replace(/^\uFEFF/, "");
  const separateur = detecterSeparateur(texte);

  // 1ère tentative : on suppose qu'il y a un en-tête.
  const avecEntete = parse(texte, {
    columns: true,
    delimiter: separateur,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const correspondance = avecEntete.length > 0
    ? detecterCorrespondanceColonnes(Object.keys(avecEntete[0]))
    : {};

  if (correspondance.url) {
    // En-tête reconnu : on mappe chaque champ vers sa colonne source.
    return avecEntete.map((ligne) => ({
      url: (ligne[correspondance.url] || "").toString().trim(),
      email: (ligne[correspondance.email] || "").toString().trim(),
      reseaux_sociaux: (ligne[correspondance.reseaux_sociaux] || "").toString().trim(),
      siren: (ligne[correspondance.siren] || "").toString().trim(),
      siret: (ligne[correspondance.siret] || "").toString().trim(),
    }));
  }

  // 2e tentative : pas d'en-tête reconnu (fichier "juste une liste d'URLs",
  // avec ou sans première ligne de titre non standard). On relit sans
  // en-tête et on prend la première colonne comme URL.
  const sansEntete = parse(texte, {
    columns: false,
    delimiter: separateur,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return sansEntete
    .map((champs) => (champs[0] || "").toString().trim())
    .filter((valeur) => valeur !== "" && !/^https?:\/\/(?:www\.)?(?:url|site|lien|website)/i.test(valeur))
    // Si la première ligne ressemble à un intitulé de colonne plutôt qu'à
    // une vraie URL (ex: "URL", "Site"), on l'ignore.
    .filter((valeur) => /^https?:\/\//i.test(valeur) || valeur === "")
    .map((url) => ({ url, email: "", reseaux_sociaux: "", siren: "", siret: "" }));
}

function sauvegarderDonnees(lignes) {
  const csv = stringify(lignes, { header: true, columns: COLONNES });
  // BOM UTF-8 ajouté pour qu'Excel (notamment sous Windows/FR) affiche
  // correctement les accents à l'ouverture du fichier. On normalise aussi
  // toujours vers une sortie standard : séparateur virgule, en-tête fixe,
  // même si le fichier d'entrée utilisait un autre format.
  fs.writeFileSync(DATA_FILE, "\uFEFF" + csv, "utf8");
}

// ----------------------------------------------------------------------
// Utilitaires d'extraction (logique identique au script Apps Script)
// ----------------------------------------------------------------------
function extraireRacineDomaine(url) {
  const match = url.match(/^https?:\/\/(?:www\.)?([^/?#]+)(?:[/?#]|$)/i);
  if (!match) return "";
  const domaineComplet = match[1].toLowerCase();
  const parts = domaineComplet.split(".");
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

function extraireTextePur(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function analyserCodePourEmails(codeHtml, domaineRacine) {
  const trouves = codeHtml.match(EMAIL_REGEX);
  if (!trouves) return [];
  return [...new Set(trouves)].filter((email) => {
    if (email.match(/\.(png|jpg|jpeg|gif|webp|svg|css|js|woff|woff2)$/i)) return false;
    const extensionEmail = email.split("@")[1].toLowerCase();
    const motsCles = domaineRacine.split(/[-_]/);
    return motsCles.some((mot) => mot.length > 2 && extensionEmail.includes(mot));
  });
}

function analyserCodePourRS(codeHtml) {
  const trouves = [];
  let match;
  RS_REGEX.lastIndex = 0;
  while ((match = RS_REGEX.exec(codeHtml)) !== null) {
    trouves.push(match[1]);
  }
  return [...new Set(trouves)];
}

function chercherNumeros(texte, regex, longueurAttendue) {
  const trouves = texte.match(regex);
  if (!trouves) return [];
  return [...new Set(trouves)]
    .map((num) => num.trim())
    .filter((num) => num.replace(/\s/g, "").length === longueurAttendue);
}

function extraireLiensSecondaires(codeHtml, urlRacineInitiale) {
  const hrefRegex = /href=["']([^"']*(?:contact|about|propos|mention|legal|cgv)[^"']*)["']/gi;
  let urlRacine = urlRacineInitiale;
  if (urlRacine.endsWith("/")) urlRacine = urlRacine.slice(0, -1);
  const liens = [];
  let match;
  while ((match = hrefRegex.exec(codeHtml)) !== null) {
    const lien = match[1];
    if (lien.startsWith("http")) liens.push(lien);
    else if (lien.startsWith("/")) liens.push(urlRacine + lien);
    else if (!lien.startsWith("mailto:") && !lien.startsWith("tel:")) liens.push(urlRacine + "/" + lien);
  }
  return [...new Set(liens)].slice(0, 3);
}

async function recupererContenuWeb(url) {
  console.log(`   ↳ requête : ${url}`);
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), FETCH_TIMEOUT_MS);

  const tenterFetch = (async () => {
    const reponse = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: controleur.signal,
    });
    return await reponse.text();
  })();

  // Filet de sécurité : si pour une raison quelconque l'AbortController ne
  // coupe pas réellement la requête (ça peut arriver avec certaines
  // connexions qui restent ouvertes côté serveur), on force quand même la
  // suite du script au bout de FETCH_TIMEOUT_MS + 5s.
  const timeoutSecours = new Promise((resolve) =>
    setTimeout(() => resolve(""), FETCH_TIMEOUT_MS + 5000)
  );

  try {
    return await Promise.race([tenterFetch, timeoutSecours]);
  } catch (e) {
    return "";
  } finally {
    clearTimeout(minuteur);
  }
}

// ----------------------------------------------------------------------
// Traitement d'une ligne
// ----------------------------------------------------------------------
async function traiterLigne(ligne) {
  const url = ligne.url;

  if (url === "" || !/^https?:\/\//i.test(url)) {
    ligne.email = "URL invalide ou vide";
    return;
  }

  const domaineRacine = extraireRacineDomaine(url);

  try {
    const codeHtmlAccueil = await recupererContenuWeb(url);
    const textAccueil = extraireTextePur(codeHtmlAccueil);

    let emails = analyserCodePourEmails(codeHtmlAccueil, domaineRacine);
    let reseauxSociaux = analyserCodePourRS(codeHtmlAccueil);
    let sirens = chercherNumeros(textAccueil, SIREN_REGEX, 9);
    let sirets = chercherNumeros(textAccueil, SIRET_REGEX, 14);

    const liensSecondaires = extraireLiensSecondaires(codeHtmlAccueil, url);

    for (const lienSecondaire of liensSecondaires) {
      if (emails.length > 0 && sirens.length > 0 && sirets.length > 0) break;
      await sleep(DELAY_MS);
      const codeHtmlSec = await recupererContenuWeb(lienSecondaire);
      const textSec = extraireTextePur(codeHtmlSec);

      emails = [...new Set(emails.concat(analyserCodePourEmails(codeHtmlSec, domaineRacine)))];
      reseauxSociaux = [...new Set(reseauxSociaux.concat(analyserCodePourRS(codeHtmlSec)))];
      sirens = [...new Set(sirens.concat(chercherNumeros(textSec, SIREN_REGEX, 9)))];
      sirets = [...new Set(sirets.concat(chercherNumeros(textSec, SIRET_REGEX, 14)))];
    }

    sirens = sirens.filter((siren) => !sirets.some((siret) => siret.replace(/\s/g, "").includes(siren.replace(/\s/g, ""))));

    ligne.email = emails.length > 0 ? emails.join(", ") : "Aucun e-mail trouvé";
    ligne.reseaux_sociaux = reseauxSociaux.length > 0 ? reseauxSociaux.join(", ") : "Aucun RS trouvé";
    ligne.siren = sirens.length > 0 ? sirens.join(" / ") : "Non trouvé";
    ligne.siret = sirets.length > 0 ? sirets.join(" / ") : "Non trouvé";
  } catch (erreur) {
    ligne.email = "Erreur de connexion au site";
  }
}

// ----------------------------------------------------------------------
// Boucle principale
// ----------------------------------------------------------------------
async function main() {
  if (fs.existsSync(STOP_FILE)) {
    console.log(`⏹️  Fichier STOP détecté (${STOP_FILE}) : aucun traitement effectué.`);
    console.log("   Supprimez ce fichier pour relancer le traitement au prochain cycle.");
    return;
  }

  const lignes = chargerDonnees();
  console.log(`📄 ${lignes.length} ligne(s) chargée(s) depuis ${DATA_FILE}.`);

  const aTraiter = lignes.filter((l) => STATUTS_A_REPRENDRE.has(l.email));
  console.log(`🔎 ${aTraiter.length} ligne(s) à traiter dans ce cycle.`);

  if (aTraiter.length === 0) {
    console.log("🎉 Toutes les lignes ont déjà été traitées avec succès !");
    return;
  }

  const heureDebut = Date.now();
  let traitees = 0;
  let indexCourant = 0;

  while (indexCourant < aTraiter.length) {
    if (Date.now() - heureDebut > TIME_LIMIT_MS) {
      console.log(`⏳ Limite de temps atteinte (${TIME_LIMIT_MS} ms). Reprise au prochain cycle.`);
      break;
    }

    // On traite plusieurs lignes en parallèle (CONCURRENCE à la fois) au
    // lieu d'une seule à la fois : avec plusieurs milliers de lignes, un
    // traitement strictement séquentiel serait beaucoup trop lent.
    const lot = aTraiter.slice(indexCourant, indexCourant + CONCURRENCE);
    indexCourant += lot.length;

    lot.forEach((ligne) => {
      ligne.email = "🔄 En cours...";
    });
    sauvegarderDonnees(lignes);

    await Promise.all(lot.map((ligne) => traiterLigne(ligne)));

    // Une seule écriture disque par lot (au lieu d'une par ligne) : avec
    // 18 000+ lignes, réécrire tout le CSV à chaque ligne serait très
    // coûteux en I/O.
    sauvegarderDonnees(lignes);

    traitees += lot.length;
    for (const ligne of lot) {
      console.log(`(${traitees}/${aTraiter.length}) ${ligne.url} -> ${ligne.email}`);
    }
  }

  const restantes = lignes.filter((l) => STATUTS_A_REPRENDRE.has(l.email)).length;
  if (restantes === 0) {
    console.log("🎉 L'intégralité du fichier a été traitée avec succès !");
  } else {
    console.log(`ℹ️  ${restantes} ligne(s) restent à traiter. Elles seront reprises au prochain déclenchement.`);
  }
}

main()
  .then(() => {
    // Sortie forcée : certaines connexions HTTP mal fermées (keep-alive,
    // socket resté ouvert côté serveur) peuvent sinon empêcher Node de se
    // terminer de lui-même, ce qui bloquerait le job GitHub Actions jusqu'au
    // timeout sans raison apparente.
    process.exit(0);
  })
  .catch((err) => {
    console.error("Erreur fatale :", err);
    process.exit(1);
  });
