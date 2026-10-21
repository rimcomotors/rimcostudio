# RIMCO Studio

Studio interne de création de vidéos publicitaires automobiles. L’utilisateur choisit un véhicule et ses références validées, un ou plusieurs lieux, un brief, le format et le niveau; le Studio prépare les plans, crée et contrôle les images-clés, anime les plans avec le fournisseur configuré, puis assemble le rendu avec l’habillage RIMCO.

## Fonctionnalités

- Parcours automatique, sans validation manuelle du storyboard ou des images-clés.
- Génération image-clé puis animation IA pour Standard, Pro et Premium.
- Références photo validées du véhicule et du lieu, suivis d’étapes et coûts, contrôles qualité et reprises bornées.
- Premium en 20 secondes de clips (4 plans de 5 s), auxquels s’ajoutent 2 secondes de logo dans le rendu final.
- Médiathèque et bibliothèque privées.

Les contrôles réduisent les erreurs visibles sans garantir l’identité parfaite du véhicule ni les performances d’une campagne. Les modèles, durées et tarifs actifs sont configurés dans Supabase.

## Technologies et développement

Next.js App Router, TypeScript, Tailwind CSS, Supabase, fal.ai, FFmpeg et pnpm. Variables documentées dans .env.example; développer en mode fournisseur mock et ne jamais ajouter de clés de production à Git.

Commandes : pnpm install --frozen-lockfile, pnpm dev, pnpm lint, pnpm typecheck, pnpm test, pnpm build, pnpm test:e2e. La CI vérifie lint, types, tests, build et E2E avec Supabase local et les fournisseurs simulés.

## Documentation

- Guide de reprise pour l’équipe : docs/PRISE_EN_MAIN.md (architecture, branches, PR, migrations et passation).
- docs/PROGRESS.md : avancement.
- docs/DECISIONS.md : décisions d’architecture.
- docs/PLAN.md : plan produit.
- docs/FAL_VALIDATION.md : références fal.ai.
- AGENTS.md : instructions projet.

## Git et livraison

main est la branche de référence et déclenche le déploiement Production Vercel. Créer une branche courte par fonctionnalité ou correction, ouvrir une PR ciblée vers main, attendre les contrôles CI et la revue, puis fusionner. Les branches fusionnées sont temporaires; leur historique reste dans Git et les PR. Voir le guide de reprise pour les conventions et les vérifications Supabase.
