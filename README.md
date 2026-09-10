# Extraction automatique (version GitHub Actions)

Portage du script Google Apps Script en Node.js + GitHub Actions.
Plus besoin de Google Sheets : les données vivent dans `data/leads.csv`,
directement dans le dépôt Git.

## Comment ça marche

- `data/leads.csv` contient les colonnes : `url, email, reseaux_sociaux, siren, siret`.
- Le workflow `.github/workflows/scrape.yml` se déclenche automatiquement
  toutes les 15 minutes (cron GitHub Actions), traite les lignes non
  terminées pendant 4 minutes maximum, puis commit et push les résultats
  dans le dépôt.
- Comme dans la version Sheets, chaque exécution reprend là où la
  précédente s'est arrêtée : inutile de tout relancer à la main.
- Une ligne est considérée comme "à traiter" si sa colonne `email` est
  vide, sur `🔄 En cours...`, `Aucun e-mail trouvé`, `Erreur de connexion
  au site` ou `URL invalide ou vide` (comportement identique au script
  d'origine — ces lignes sont retentées à chaque cycle).

## Installation

1. Crée un nouveau dépôt GitHub (ou pousse ces fichiers dans un dépôt existant).
2. Remplis `data/leads.csv` avec tes URLs, une par ligne, colonne `url`
   uniquement (laisse les autres colonnes vides).
3. Vérifie que les **GitHub Actions sont activées** sur le dépôt
   (Settings → Actions → Allow all actions).
4. Vérifie que le workflow a le droit d'écrire dans le dépôt :
   Settings → Actions → General → Workflow permissions →
   **Read and write permissions**.
5. C'est tout : le workflow se lance automatiquement selon le cron, ou tu
   peux le déclencher tout de suite depuis l'onglet **Actions →
   Extraction automatique → Run workflow**.

## Lancer en local (facultatif)

```bash
npm install
npm run scrape
```

## Arrêter le traitement

Deux façons, comme le bouton "🛑 Arrêter" du script Sheets :

- **Arrêt temporaire (repris plus tard)** : crée un fichier vide
  `data/STOP` et commit/push-le. Tant qu'il existe, chaque exécution du
  workflow se termine immédiatement sans rien traiter. Supprime-le pour
  reprendre.
- **Arrêt définitif** : va dans l'onglet **Actions** du dépôt, ouvre le
  workflow "Extraction automatique", puis **Disable workflow** (menu
  "..." en haut à droite).

## Réglages

Variables d'environnement passées au script (modifiables dans
`.github/workflows/scrape.yml`) :

- `TIME_LIMIT_MS` : durée max de traitement par exécution (défaut
  240000 = 4 min).
- `DELAY_MS` : pause entre deux requêtes HTTP, pour rester poli envers
  les sites visités (défaut 300 ms).

## Différences avec la version Google Sheets

- Le stockage est un fichier CSV versionné par Git au lieu d'une feuille
  Google Sheets — tu peux toujours l'ouvrir/éditer avec Excel, Numbers,
  Google Sheets (import), etc.
- Le "bouton stop" devient un fichier `data/STOP`.
- La planification (`after(10s)` côté Apps Script) est remplacée par le
  cron du workflow GitHub Actions (`*/15 * * * *`), ajustable.
