# RIMCO Studio

Bêta interne en français pour générer des vidéos automobiles RIMCO de cinq secondes, les consulter et télécharger le MP4. La V1 n’inclut pas l’approbation des vidéos ni leur édition après génération.

## Accès à la bêta

Le code V1 est fusionné dans `main` et le déploiement Production est prêt. Le mode Production reste en simulation. Un déploiement Preview séparé est configuré en mode réel pour permettre l’essai contrôlé de fal.ai.

L’invitation Supabase à `oury@odk-agency.com` a été envoyée. Son destinataire doit l’accepter et définir son mot de passe. Le premier utilisateur reçoit automatiquement le rôle administrateur. L’application est accessible sur [rimcostudio.vercel.app](https://rimcostudio.vercel.app); pour le test de génération, utiliser le Preview configuré en mode réel et se connecter avec le compte activé.

## Préparer la première génération

1. Connectez-vous avec le compte invité.
2. Dans la médiathèque, ajoutez le logo RIMCO et une vraie photo du véhicule à animer.
3. Faites valider ces médias par l’administration. La génération exige une photo véhicule validée; le logo validé est nécessaire à l’habillage de marque.
4. Dans le Studio, choisissez la photo, décrivez la scène et vérifiez le prix affiché avant de lancer.
5. Suivez la progression dans le Studio ou la bibliothèque. Une fois prête, la vidéo se visionne et se télécharge en MP4 depuis la bibliothèque.

Un seul essai réel fal.ai depuis l’application a été autorisé, dans le solde maximal de 1,047134 USD restant sous le plafond convenu de 2 USD. Aucun appel réel depuis l’application n’a encore été exécuté. Le projet de base de données ne contient pas de photo véhicule ou de logo à utiliser pour cet essai.

## Services et sécurité

- Supabase : projet `Rimco studio`, schéma et seed appliqués, buckets privés.
- Vercel : projet `rimcostudio`; Preview est en mode live; Production reste en simulation.
- fal.ai : clé stockée comme secret Vercel, jamais dans le navigateur ni dans Git.
- L’accès est privé, les inscriptions publiques sont désactivées et les médias nécessitent une authentification.
- Avant tout pilote commercial, vérifier que le plan Vercel utilisé autorise cet usage.

Les clés fal.ai et Supabase de service doivent être remplacées après le test contrôlé, car elles ont été exposées dans le contexte de travail. Mettre ensuite les nouvelles valeurs à jour dans Vercel.

## Développement

Le projet utilise Next.js App Router, TypeScript strict, Tailwind CSS, Supabase et pnpm. Les contrôles automatisés de la PR fusionnée couvrent lint, types, tests unitaires, build et E2E. Pour les commandes de développement local, consulter `package.json` et `AGENTS.md`.

Voir [docs/PROGRESS.md](docs/PROGRESS.md) pour l’état de livraison, [docs/DECISIONS.md](docs/DECISIONS.md) pour les choix d’architecture, et [DESIGN.md](DESIGN.md) pour la référence visuelle.
