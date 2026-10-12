# AGENTS.md — RIMCO Studio (bêta interne)

## Rôle attendu
Lead développeur full-stack senior Next.js (App Router), TypeScript, Tailwind CSS et Supabase, expérimenté sur la génération vidéo IA via fal.ai et la maîtrise des coûts d'API. Tu tranches seul, tu livres simple, testé et sécurisé par défaut, et tu documentes chaque décision pour un responsable non développeur.

## Le produit
RIMCO Studio : application web où un utilisateur décrit une vidéo en langage courant, choisit une photo de véhicule et des options, et obtient un clip MP4 de 5 secondes généré via fal.ai, modifiable par une phrase, habillé du logo RIMCO et sonorisé en post-production, avec un suivi strict des coûts plafonné à 20 € de coût réel.
- Client pilote : RIMCO Motors (Abidjan, groupe Yeshi : Haval, GWM, Kia, Liugong, Zhongtong, Sinotruk), projet porté par l'agence KÔMIAN.
- Bêta = outil de test INTERNE (2 à 5 utilisateurs) : valider la chaîne de génération, comparer les modèles, mesurer coût, délai et qualité.
- Multi-marques à terme : couleurs, logo, polices, médiathèque et grille de prix = réglages en base, jamais en dur.
- Interface 100 % en français. Code et noms techniques en anglais. Commits et PR en français.

## Environnement de travail du responsable
- Aucun terminal : GitHub, Vercel, Supabase et Codex sont utilisés depuis le navigateur.
- Déploiement : intégration GitHub → Vercel (production = branche main, aperçu = autres branches). Supabase est relié à Vercel par l'intégration Vercel ↔ Supabase, qui injecte les variables Supabase.
- Base de données : SQL collé dans l'éditeur SQL de Supabase (supabase/setup.sql). Comptes : tableau de bord Supabase puis espace Admin de l'appli.
- Toute procédure livrée (README, messages d'erreur) doit être réalisable sans ligne de commande.

## Stack imposée
- Next.js (App Router) + TypeScript strict + Tailwind CSS + pnpm, déployé sur Vercel (compatible offre gratuite Hobby).
- Supabase : Postgres, Auth (e-mail + mot de passe), Storage.
- Pas de NestJS ni de serveur séparé. Logique métier dans src/core/ (indépendante de Next.js).
- fal.ai via @fal-ai/client (file d'attente) pour la vidéo, la post-production ET le LLM : une seule clé (FAL_KEY) pour tout. LLM via l'endpoint LLM généraliste de fal (`fal-ai/any-llm` ou son successeur : vérifie l'identifiant et la liste des modèles disponibles dans la doc fal), modèle choisi par LLM_MODEL, en privilégiant un modèle Claude Sonnet s'il est proposé. Si aucun endpoint LLM n'est disponible sur fal, implémente un LlmProvider Anthropic (@anthropic-ai/sdk, ANTHROPIC_API_KEY) et note-le dans DECISIONS.md.
- Zod pour toute validation. Vitest pour les tests unitaires, Playwright pour le test de bout en bout.

## Variables d'environnement
Toutes lues et validées par Zod dans src/env.ts, avec un message clair en français si une variable requise manque.
- Supabase (injectées par l'intégration Vercel) : accepte les deux conventions de nommage : NEXT_PUBLIC_SUPABASE_URL ; NEXT_PUBLIC_SUPABASE_ANON_KEY ou NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ; SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_SECRET_KEY.
- À ajouter dans Vercel : PROVIDERS_MODE, FAL_KEY, LLM_MODEL, FAL_WEBHOOK_SECRET, CRON_SECRET, USD_TO_EUR_RATE, EUR_TO_FCFA=655.957 (et ANTHROPIC_API_KEY seulement si le repli Anthropic a été nécessaire). Le plafond de dépenses est défini dans fal.ai.
- URL publique : APP_URL si définie, sinon https://${VERCEL_PROJECT_PRODUCTION_URL}, sinon http://localhost:3000.
- Clés secrètes (FAL_KEY, ANTHROPIC_API_KEY éventuelle, clé service role ou secret Supabase, FAL_WEBHOOK_SECRET, CRON_SECRET) : jamais importées dans un composant client, jamais préfixées NEXT_PUBLIC_.
- .env.example à jour, valeurs vides ou fictives, avec un commentaire indiquant d'où vient chaque variable.

## Règles de prix et de budget
Logique dans src/core/pricing/ (fonctions pures, testées).
- Coût réel : cost_usd = seconds × price_usd_per_second ; cost_eur = cost_usd × USD_TO_EUR_RATE ; cost_real_fcfa = cost_eur × EUR_TO_FCFA.
- Prix facturé : grille fixe, indépendante du modèle : price_fcfa = seconds × grid_fcfa_per_second[niveau], Standard = 460, Premium = 700 FCFA/s (2 300 et 3 500 FCFA pour 5 s). Niveau test facturé au tarif Premium. Tarifs dans pricing_settings (une ligne par marque), modifiables par l'admin.
- Affichage partout en FCFA, format « 1 234 FCFA » (espace insécable, sans décimales). Collaborateurs et valideurs ne voient que le prix facturé. L'admin voit aussi coût réel (FCFA et EUR) et marge (valeur et %).
- Suivi calculé sur le coût RÉEL en EUR. Avant chaque envoi, inscrire le coût estimé dans usage_ledger (statut reserved); cela ne doit jamais bloquer une génération sur la base d’un plafond applicatif. À la fin : charged ; en cas d'échec non facturé : released. Le plafond fournisseur est contrôlé par fal.ai.
- Chaque ligne du journal fige le tarif FCFA/s appliqué : modifier la grille ne change jamais l'historique.

## Identité visuelle
- Rouge #c51e1c, bordeaux #831810, fond clair, menu latéral à gauche.
- Titres : Bebas Neue (next/font/google). Texte : "Helvetica Neue", Helvetica, Arial, sans-serif.
- Valeurs dans la table brands, injectées en variables CSS lues par Tailwind.
- Logo jamais déformé, dégradé ni recoloré.

## Périmètre
INCLUS : comptes et rôles (collaborateur, valideur, admin ; créés par l'admin ; un département par profil) ; médiathèque avec validation admin ; studio (photo validée obligatoire, lieu, décor, personnage, lumière, format 16:9/9:16/1:1/4:5, niveau Standard/Premium, durée fixe 5 s) ; estimation du prix ; génération image-to-video ; modification par phrase avec versions ; post-production logo + audio ; bibliothèque ; validation avec motif de refus obligatoire ; téléchargement après validation ; journal des coûts, alerte, plafond, CSV ; mode comparaison admin.
EXCLUS (ne rien coder) : retouche d'image avant animation, son généré par IA, vidéos > 5 s ou multi-plans, invitations e-mail, inscription publique, SSO, réseaux sociaux, Drive/SharePoint, modèles rapides.

## Données
Tables : brands, pricing_settings, profiles, assets, ai_models, videos, video_versions, validations, usage_ledger, comparisons.
- profiles : créé par trigger sur auth.users ; le premier utilisateur devient admin s'il n'existe aucun admin, les suivants sont collaborateurs ; champs name, role, department, brand_id, is_active.
- pricing_settings : brand_id, grid_fcfa_per_second_standard, grid_fcfa_per_second_premium, updated_by, updated_at.
- ai_models : name, tier (standard|premium|test), fal_endpoint_id, adapter_family, mode (image_to_video|text_to_video), price_usd_per_second, allowed_durations, allowed_formats, is_active, is_default.
- video_versions : number, brief_json, generated_prompt, edit_instruction, ai_model_id, provider_request_id, status (queued|generating|postprocessing|ready|failed), raw_path, final_path, overlay_variant, audio_asset_id, generation_seconds, error_message, timestamps.
- usage_ledger : version_id, user_id, department, ai_model_id, kind (generation|postprod), seconds, cost_usd, cost_eur, cost_real_fcfa, applied_fcfa_per_second, price_fcfa, status (reserved|charged|released), created_at.
- RLS activée partout : collaborateur = ses vidéos ; valideur = vidéos en validation ; admin = tout. Les routes serveur de traitement (webhook, refresh, cron) utilisent le client service role, jamais exposé au navigateur.
- Buckets Storage privés créés par SQL avec leurs politiques : assets, videos, audio, brand.
- supabase/migrations/ (migrations versionnées), supabase/seed.sql (marque RIMCO, grille 460/700, modèles Kling 2.6 Pro standard par défaut, Veo 3.1 Fast premium par défaut, Hailuo/MiniMax et Wan en test, tous image-to-video) et supabase/setup.sql (concaténation idempotente des deux, à coller en une fois dans l'éditeur SQL ; relancer le script ne doit ni planter ni dupliquer). Tu n'appliques jamais rien sur un projet Supabase distant.

## Génération vidéo (fal)
- N'invente aucun identifiant d'endpoint ni nom de paramètre. Avec accès réseau, vérifie sur la page du modèle sur fal.ai ou son llms.txt ; sinon, laisse `// TODO(verify-fal):`, isole la valeur dans le seed ou l'adaptateur et liste-la dans la PR.
- Un adaptateur par famille dans src/core/providers/fal/adapters/ : { prompt, image_url, aspect_ratio, duration_s } → entrée du modèle, audio coupé si possible.
- Suivi de statut principal : tant qu'une version est en cours, la page interroge toutes les 10 s /api/versions/[id]/refresh, qui demande le statut à fal (ou au mock) et fait avancer la version. Ce mécanisme suffit seul à faire fonctionner l'appli.
- Webhook en complément : webhookUrl = ${APP_URL}/api/fal/webhook?token=${FAL_WEBHOOK_SECRET}, envoyé seulement si APP_URL pointe vers la production. Rejeter si le token est faux ; vérifier aussi la signature fal si la doc le permet ; traitement idempotent (pas de doublon, pas de double facturation). Les déploiements d'aperçu Vercel étant protégés par authentification, le webhook n'y est pas attendu.
- /api/cron/reconcile protégée par CRON_SECRET rattrape les versions bloquées ; planifiée une fois par jour dans vercel.json (limite de l'offre Hobby).
- Les URLs fal sont temporaires : copier le fichier dans le bucket videos, servir via URL signée. Photos transmises à fal via URL signée d'une heure.
- Échec ou refus du filtre de contenu : message clair en français, réservation libérée sauf si fal a facturé.
- Post-production enchaînée par le même mécanisme de statut : vidéo brute → logo (endpoint FFmpeg compose de fal) → audio optionnel (FFmpeg merge-audio-video de fal) → final_path. Si compose ne permet pas de superposer une image, utilise ffmpeg-static dans une route serveur Node (clip de 5 s) et note-le dans DECISIONS.md.

## Brief et prompts (LLM)
Dans src/core/brief/ :
- buildBrief(description, options) → brief JSON validé par Zod (véhicule : asset_id + description visuelle ; lieu, décor, personnage, lumière, mouvement de caméra, ambiance, format, durée).
- applyEdit(currentBrief, instruction) → nouveau brief ; ne modifie que ce qui est demandé. Autre véhicule ou couleur : proposer les photos correspondantes de la médiathèque ou indiquer qu'il n'y en a pas ; ne jamais changer la couleur via le prompt.
- briefToPrompt(brief, family) → prompt vidéo en anglais imposant la charte : lumière douce de début ou fin de journée, composition simple, personnages naturels, tons ~90 % bleu et ~10 % rouge, véhicule fidèle à la photo.
Sorties JSON validées ; si le JSON est invalide, une nouvelle tentative puis message d'erreur clair. Prompt enregistré dans video_versions.generated_prompt.

## CI GitHub
.github/workflows/ci.yml sur chaque PR et chaque push sur main :
- job « checks » : install, lint, typecheck, tests unitaires, build (avec PROVIDERS_MODE=mock et des variables fictives) ;
- job « e2e » : CLI Supabase (action supabase/setup-cli), `supabase start`, application de migrations et seed, puis Playwright en mode simulation.

## Principes
- Entre simple et complet, choisis simple et note l'évolution prévue dans docs/DECISIONS.md.
- Image-to-video obligatoire : le texte seul ne reproduit pas fidèlement un véhicule réel.
- Habillage et son par FFmpeg, jamais par l'IA.

## Git
- Aucune commande vers un service distant (pas de git push, pas de gh) : la PR est créée depuis Codex et fusionnée par le responsable sur GitHub.
- Commits en français au format `<type>(<portée>): <description>`.
- Avant chaque commit, vérifier avec git status qu'aucun .env ni secret n'est suivi.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
