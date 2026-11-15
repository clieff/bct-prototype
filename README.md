# TALK AFRICA

TALK AFRICA est une application de démonstration composée d’une interface web et d’une API FastAPI. Elle permet de tester la traduction, la synthèse vocale Africa TTS et des opérations financières simulées.

## Prérequis

- Python 3.12
- Git
- Git LFS, nécessaire pour récupérer les modèles volumineux
- Environ 1 Go d’espace libre pour les modèles, en plus de l’environnement Python
- Une connexion Internet pour cloner le dépôt et installer les dépendances. Certaines langues ou fonctions peuvent aussi télécharger un modèle Hugging Face si celui-ci manque localement.

Les dépendances installent PyTorch en mode CPU. Aucun GPU n’est nécessaire.

## 1. Cloner le projet et récupérer les modèles

Installez Git LFS sur votre ordinateur, puis ouvrez PowerShell, un terminal macOS ou un terminal Linux :

```bash
git lfs install
git clone https://github.com/clieff/bct-prototype.git
cd bct-prototype
git lfs pull
```

Les modèles sont stockés avec Git LFS et occupent environ 1 Go. La traduction anglais → français doit trouver ses fichiers complets dans `models/opus-mt-en-fr/`, notamment `pytorch_model.bin`. Sans Git LFS, Git peut récupérer de petits fichiers pointeurs à la place des vrais modèles et l’API ne démarrera pas.

Si le modèle est absent ou si le serveur signale des fichiers manquants, relancez `git lfs pull` depuis la racine du projet.

## 2. Créer l’environnement Python et installer les dépendances

### Windows PowerShell

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### macOS ou Linux

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

L’installation de PyTorch et des autres dépendances peut prendre quelques minutes.

## 3. Démarrer l’application

Depuis la racine du dépôt, démarrez le serveur sur le port `3000`.

### Windows PowerShell

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### macOS ou Linux

Après avoir activé l’environnement virtuel :

```bash
python -m uvicorn app.main:app --host 127.0.0.1 --port 3000
```

Au démarrage, l’API charge le modèle local anglais → français. Attendez le message `Modèle chargé avec succès` et `Application startup complete` avant d’envoyer une requête. Gardez le terminal ouvert pendant l’utilisation.

Ouvrez ensuite ces adresses dans un navigateur :

- Interface TALK AFRICA : <http://127.0.0.1:3000/>
- Documentation interactive de l’API : <http://127.0.0.1:3000/docs>
- Vérification de l’état de l’API : <http://127.0.0.1:3000/health>

## 4. Essayer une traduction

Dans PowerShell, envoyez une phrase anglaise vers le français :

```powershell
$body = @{
    text = "Good morning. How are you today?"
    source_lang = "en"
    target_lang = "fr"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:3000/translate" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body
```

L’API accepte également ces champs facultatifs :

- `protected_terms` : termes à conserver tels quels, sous forme de liste.
- `allow_short_segments` : mettre `true` pour demander la traduction d’un segment de moins de trois mots. Par défaut, ces segments sont ignorés pour éviter des sorties de mauvaise qualité.

Autres routes disponibles : `POST /translate-batch`, `POST /speak`, `GET /speak/languages`, `POST /fees`, `GET /balance`, `POST /transfer` et `POST /transfer/confirm`. Les opérations financières sont simulées; elles ne déplacent pas d’argent réel.

## Arrêter le serveur

Dans le terminal où Uvicorn tourne, appuyez sur `Ctrl+C`.

## Dépannage

### Le serveur ne démarre pas et signale un modèle absent ou incomplet

Vérifiez que Git LFS est installé, puis exécutez `git lfs pull` à la racine du dépôt. Le fichier `models/opus-mt-en-fr/pytorch_model.bin` doit être un gros fichier de modèle, et non un pointeur texte Git LFS.

### Le port 3000 est déjà utilisé

Arrêtez l’autre serveur ou choisissez un autre port, par exemple `3001` :

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 3001
```

Dans ce cas, ouvrez l’interface à <http://127.0.0.1:3001/>.

### Une traduction courte reste inchangée

Par défaut, l’application ne lance pas le modèle pour les segments de moins de trois mots. Dans une requête API, ajoutez `"allow_short_segments": true` pour autoriser ces segments. Le terminal affiche un message quand un segment est ignoré.

