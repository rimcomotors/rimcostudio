# Avancement de la V1

État vérifié le 8 octobre 2026. La V1 demandée permet de générer une vidéo de 5 secondes, la visionner puis télécharger son MP4. Elle ne comprend pas la validation ni l’édition après génération.

| Étape | État | Preuve / point restant |
| --- | --- | --- |
| 0. Socle | ☑ Livré | Next.js App Router, TypeScript, Supabase, interface française, migrations, seed et CI. Les contrôles de la CI GitHub passent. |
| 1. Accès | ◷ À reprendre après limite e-mail | Le compte `oury@odk-agency.com` est confirmé et les URL Auth sont corrigées. L’interface signale que le lien essayé est expiré ou déjà utilisé; Supabase a refusé un nouvel envoi pour dépassement de la limite e-mail. Le dernier accès Auth apparaît à 16:09. |
| 2. Médias | ◷ Code livré, médias à charger | La médiathèque utilise les buckets Supabase privés. Aucun logo ni photo véhicule RIMCO validé n’est fourni par le seed; les charger puis les valider depuis l’application. |
| 3. Génération | ◷ Prête à tester en live | Mode live activé dans Preview. Le parcours réel génération → stockage → post-production n’a pas encore été exécuté dans l’application. |
| 4. Validation et édition | Hors périmètre V1 | L’écran de validation est redirigé vers la bibliothèque. Il n’y a ni approbation ni édition par phrase dans le flux V1. |
| 5. Bibliothèque | ☑ Code livré | Les vidéos prêtes sont lisibles et téléchargeables par leur créateur. Le parcours réel reste à vérifier après activation du compte et ajout des médias. |
| 6. Budget et coûts | ☑ Code livré | Réservation transactionnelle, suivi et règles de prix présentes. Le dernier état documenté de l’ancien plafond était 0,952866 USD consommé sur 2 USD; l’utilisateur indique maintenant avoir défini 10 USD dans fal.ai. Le solde réel actuel n’a pas été relu. |
| 7. Vérifications | ☑ CI, ◷ parcours live | `checks` (lint, types, tests, build) et E2E passent dans GitHub Actions. Preview et Production sont READY. La génération réelle depuis l’application est en attente du compte et des médias. |

## Services

- **GitHub** — PR #1, #3, #4 et #5 sont fusionnées sur `main`. La V1 limite l’interface à la génération, la lecture et le téléchargement; la page `/validation` renvoie vers la bibliothèque.
- **Vercel** — projet `rimcostudio`. Le déploiement Production du commit `34621418e5690912a526e80caee4b31ec2aa24a6` et le déploiement Preview de la branche `codex/rimco-onboarding-v1` (commit `50f5d84cbc1934d4a7d55ea8095369c2f4b52f36`) sont `READY`. `PROVIDERS_MODE=live` est défini en Preview; FAL, Supabase et le modèle LLM y sont configurés. Production reste en mode mock.
- **Supabase** — projet `Rimco studio` (`hqgxhdekbifyranijvbq`), schéma et seed en place. Le compte Auth `oury@odk-agency.com` est confirmé. URL principale Auth `https://rimcostudio.vercel.app/connexion` et redirect `https://rimcostudio.vercel.app/**` enregistrés et revérifiés après rechargement. Une récupération a été acceptée puis vérifiée, mais l’application n’a pas conservé de session utilisable; la tentative de renvoi a été refusée par la limite d’e-mails. Aucun média n’est présent dans le seed.
- **Fournisseurs** — la clé FAL communiquée dans la conversation est enregistrée dans Vercel. La rotation de la clé FAL et de la clé Supabase de service est à effectuer après le test, puis Vercel doit être mis à jour.

## Contrôles vérifiés

- CI GitHub, run `37780443278` : jobs `checks` et `e2e` réussis.
- Déploiements Vercel Preview et Production : état `READY`.
- Génération réelle dans l’application : pas encore vérifiée; elle nécessite une récupération Auth valide, puis une photo véhicule et un logo RIMCO chargés et validés.
- Aucun nouvel appel payant fal n’a été lancé dans l’application. Un seul essai reste dans le plafond autorisé.

## Étapes pour terminer le test réel

1. Après le délai de limitation Auth, envoyer un nouveau lien de récupération et vérifier qu’il ouvre directement `/connexion`; définir le mot de passe depuis cet e-mail récent (valable 60 minutes).
2. Se connecter au Preview et charger un logo RIMCO et une photo de véhicule autorisés, puis valider ces médias.
3. Pour le nouveau prototype, lancer un montage de deux plans de 3 secondes et vérifier le traitement, la lecture et le téléchargement; vérifier le solde réel fal.ai avant les essais.
4. Révoquer/remplacer les clés FAL et Supabase de service exposées, puis actualiser les secrets Vercel.
5. Vérifier les conditions du plan Vercel avant tout usage client commercial.

## Prototype multi-plans (2026-10-12)

- Le Studio permet maintenant de préparer deux plans courts de 3 s et de demander leur assemblage en un clip d’environ 6 s en mode live Kling O3 Pro.
- Un plafond app de 10 USD par défaut est croisé avec le plafond métier EUR avant réservation. Le coût unitaire catalogue actuel donne une estimation de 0,672 USD par montage complet (deux générations de 3 s chacune); cette estimation dépend du tarif Fal configuré et ne lance aucun appel fournisseur par elle-même.
- Avant un essai connecté à Supabase, coller `supabase/setup.sql` actualisé dans l’éditeur SQL afin d’ajouter la table `video_shots`. Ne pas utiliser le bouton de génération tant que l’authentification, la photo véhicule validée et le déploiement Preview live ne sont pas prêts.
- Aucun test fournisseur payant ni déploiement n’a été lancé dans le cadre de ce changement. Contrôles locaux réussis : TypeScript, lint (un avertissement non bloquant dans `src/components/shell.tsx`), 37 tests unitaires et compilation Next.js.
