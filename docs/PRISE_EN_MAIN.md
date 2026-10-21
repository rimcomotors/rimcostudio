# Reprise de RIMCO Studio par l’équipe

État préparé le 21 octobre 2026. Ce guide décrit l’état visible du dépôt; il ne remplace pas une vérification des consoles de production.

## État GitHub

- main pointe sur la PR #62, commit 9031f5404a1d59036487e0cf73f40c293d11c9e0. La PR est fusionnée et le contrôle affiché sur GitHub est vert.
- GitHub affiche zéro PR ouverte et 62 PR fermées.
- De nombreuses branches codex/ subsistent. Vérifier leurs PR et leurs commits uniques avant de les supprimer.
- La copie locale examinée était sur codex/premium-20s-stability; sa référence origin/main était antérieure au merge #62. Actualiser la copie depuis GitHub avant tout nouveau travail.
- La migration 0029_premium_twenty_and_atomic_submission.sql est dans le dépôt. Confirmer dans Supabase si elle a été appliquée avant de compter sur le verrou atomique en production.

## Carte technique

- Interface et parcours : src/app/ et src/components/
- Règles métier : src/core/
- Adaptateurs IA fal : src/core/providers/
- Routes API et traitement : src/app/api/
- Migrations : supabase/migrations/ et supabase/setup.sql
- Tests : fichiers *.test.*, e2e/ et .github/workflows/ci.yml
- Configuration : src/env.ts et .env.example

Flux général : brief et choix utilisateur → storyboard interne → références du véhicule et du lieu → image-clé par plan → contrôle qualité → animation IA → transfert privé → assemblage FFmpeg avec logo → bibliothèque. Un échec qualité terminal ne doit pas apparaître comme une vidéo terminée.

## Une fonctionnalité, une branche, une PR

Créer une branche dédiée par élément livrable et ne mettre qu’un objectif par PR : feat/<ticket>-<slug>, fix/<ticket>-<slug>, docs/<ticket>-<slug> ou chore/<ticket>-<slug>. Les commits suivent le format type(portée): description en français.

1. Partir de main à jour; ne pas empiler des fonctionnalités indépendantes.
2. Dans la PR, décrire le contexte, le comportement attendu, les migrations et les vérifications.
3. Mettre à jour les tests et la documentation touchée dans la même branche.
4. Attendre checks et e2e verts, puis demander une revue.
5. Après fusion, supprimer la branche si elle n’est plus utilisée. L’historique reste dans Git et la PR; les branches fusionnées ne sont pas des archives.
6. Documenter les dépendances et l’ordre de fusion si deux branches sont liées.

Pour nettoyer les branches historiques, classer chaque branche comme fusionnée, ouverte en PR, non fusionnée sans PR ou divergente. Préserver les branches avec des commits uniques jusqu’à décision de reprise ou d’archivage.

## Développement et revue

Commandes disponibles depuis un poste Node/pnpm : pnpm install --frozen-lockfile, pnpm lint, pnpm typecheck, pnpm test, pnpm build et pnpm test:e2e. La CI utilise les fournisseurs simulés et Supabase local pour les E2E. Ne lancer aucun appel fal payant en CI. Examiner le diff, les secrets, les coûts et les migrations avant fusion.

## Migrations et déploiement

- Ajouter les changements SQL dans une migration additive et versionnée, puis actualiser supabase/setup.sql selon les conventions du dépôt.
- Tester les migrations localement. Vérifier dans Supabase qu’elles sont réellement appliquées en production.
- Le merge dans main déclenche le déploiement Vercel; contrôler le build et l’URL de production.
- Vérifier les variables, secrets serveur et paramètres de marque dans les consoles; ne jamais en partager les valeurs.
- Avant un essai réel, vérifier tarif fal, solde, références validées et réservations. L’essai est payant.

## À confirmer à la reprise

1. Migration 0029 : confirmer l’application sur la base de production.
2. Branches codex/ : les trier; aucune PR n’est ouverte, mais certaines branches peuvent avoir des commits uniques.
3. Qualité visuelle : comparer Standard, Pro et Premium avec des photos approuvées; l’automatisation ne garantit pas une identité parfaite.
4. Configuration : vérifier les modèles, tarifs, accès et variables dans Supabase/Vercel.

## Sources

- Branche main : https://github.com/rimcomotors/rimcostudio/tree/main
- PR #62 : https://github.com/rimcomotors/rimcostudio/pull/62
- Branches : https://github.com/rimcomotors/rimcostudio/branches/all
- Pull requests : https://github.com/rimcomotors/rimcostudio/pulls
