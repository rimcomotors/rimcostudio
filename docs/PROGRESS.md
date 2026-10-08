# Avancement de la V1

État vérifié le 8 octobre 2026. La V1 demandée permet de générer une vidéo de 5 secondes, la visionner puis télécharger son MP4. Elle ne comprend pas la validation ni l’édition après génération.

| Étape | État | Preuve / point restant |
| --- | --- | --- |
| 0. Socle | ☑ Livré | Next.js App Router, TypeScript, Supabase, interface française, migrations, seed et CI. Les contrôles de la CI GitHub passent. |
| 1. Accès | ◷ Invitation envoyée | Invitation Supabase envoyée à `oury@odk-agency.com`. Elle doit être acceptée et le mot de passe défini par le destinataire. Le premier profil reçoit le rôle admin. |
| 2. Médias | ◷ Code livré, médias à charger | La médiathèque utilise les buckets Supabase privés. Aucun logo ni photo véhicule RIMCO validé n’est fourni par le seed; les charger puis les valider depuis l’application. |
| 3. Génération | ◷ Prête à tester en live | Mode live activé dans Preview. Le parcours réel génération → stockage → post-production n’a pas encore été exécuté dans l’application. |
| 4. Validation et édition | Hors périmètre V1 | L’écran de validation est redirigé vers la bibliothèque. Il n’y a ni approbation ni édition par phrase dans le flux V1. |
| 5. Bibliothèque | ☑ Code livré | Les vidéos prêtes sont lisibles et téléchargeables par leur créateur. Le parcours réel reste à vérifier après activation du compte et ajout des médias. |
| 6. Budget et coûts | ☑ Code livré | Réservation transactionnelle, suivi et règles de prix présentes. Le budget fal externe a déjà consommé 0,952866 USD sur 2 USD; un seul essai d’application reste autorisé (maximum 1,047134 USD). |
| 7. Vérifications | ☑ CI, ◷ parcours live | `checks` (lint, types, tests, build) et E2E passent dans GitHub Actions. Preview et Production sont READY. La génération réelle depuis l’application est en attente du compte et des médias. |

## Services

- **GitHub** — PR #1 et PR #3 sont fusionnées sur `main`. La PR #3 retire le parcours de validation de l’interface et met la route `/validation` en redirection vers la bibliothèque.
- **Vercel** — projet `rimcostudio`. Le déploiement Production du commit `984e0064525d6e8f76fd811c7d937cf8a1cf03eb` est READY. Le déploiement Preview de la branche `codex/rimco-v1-copy-and-route` est READY. `PROVIDERS_MODE=live` est défini pour les environnements de préproduction; FAL, Supabase et le modèle LLM y sont configurés. Production reste en mode mock par défaut.
- **Supabase** — projet `Rimco studio` (`hqgxhdekbifyranijvbq`), schéma et seed en place. L’invitation Auth à `oury@odk-agency.com` a été envoyée; l’utilisateur n’a pas encore accepté. Aucun média n’est présent dans le seed.
- **Fournisseurs** — la clé FAL communiquée dans la conversation est enregistrée dans Vercel. La rotation de la clé FAL et de la clé Supabase de service est à effectuer après le test, puis Vercel doit être mis à jour.

## Contrôles vérifiés

- CI GitHub, run `37780443278` : jobs `checks` et `e2e` réussis.
- Déploiements Vercel Preview et Production : état `READY`.
- Génération réelle dans l’application : pas encore vérifiée; elle nécessite le compte activé, une photo véhicule validée et un logo RIMCO validé.
- Aucun nouvel appel payant fal n’a été lancé dans l’application. Un seul essai reste dans le plafond autorisé.

## Étapes pour terminer le test réel

1. Accepter l’invitation Supabase et définir un mot de passe.
2. Se connecter au Preview et charger un logo RIMCO et une photo de véhicule autorisés, puis valider ces médias.
3. Lancer une seule génération Standard et vérifier le traitement, la lecture et le téléchargement, sans dépasser le solde fal restant autorisé de 1,047134 USD.
4. Révoquer/remplacer les clés FAL et Supabase de service exposées, puis actualiser les secrets Vercel.
5. Vérifier les conditions du plan Vercel avant tout usage client commercial.
