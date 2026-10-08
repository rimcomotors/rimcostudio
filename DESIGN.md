---
name: RIMCO Studio
description: Outil interne de génération et de consultation de vidéos automobiles, inspiré des captures produit de la présentation RIMCO Studio.
colors:
  brand: "#c51e1c"
  brand-dark: "#831810"
  ink: "#161619"
  background: "#f7f7f8"
  surface: "#ffffff"
  muted: "#626269"
  border: "#e2e2e5"
  focus: "#c51e1c"
typography:
  display: Bebas Neue
  body: "Helvetica Neue, Helvetica, Arial, sans-serif"
---

# Direction visuelle

La référence est constituée par les captures du Studio et de la bibliothèque présentes dans la présentation de la plateforme. L’interface produit reste claire, compacte et focalisée sur la tâche : fond de travail gris très pâle, navigation blanche, texte noir, traits fins et rouge RIMCO pour la sélection et l’action principale. Les diapositives noires et leurs accents violets servent au récit de présentation, pas au thème de l’application.

Le véhicule et son aperçu vidéo occupent la place visuelle principale lorsqu’un média est disponible. Les commandes de génération sont regroupées dans un panneau de travail; l’état et le prix sont faciles à repérer. Les surfaces sont plates et calmes, sans grilles décoratives, dégradés ou ombres larges. Le ton reste expert, rassurant et premium.

# Couleurs

| Token | Valeur | Usage |
| --- | --- | --- |
| Rouge RIMCO | `#c51e1c` | Bouton principal, sélection, repère de marque |
| Bordeaux | `#831810` | Liens d’action secondaires et accents de marque |
| Encre | `#161619` | Titres, texte principal et structure |
| Fond | `#f7f7f8` | Fond général de l’espace de travail |
| Surface | `#ffffff` | Navigation, formulaires et aperçu des données |
| Texte secondaire | `#626269` | Aide et métadonnées lisibles |
| Trait | `#e2e2e5` | Séparateurs et contours fins |
| Focus | `#c51e1c` | Repère clavier visible |

Réserver le rouge aux actions et sélections. Les états gardent un libellé textuel pour ne pas dépendre de la couleur. Vérifier le contraste de chaque paire dans son contexte.

# Typographie

Les grands titres peuvent utiliser Bebas Neue avec une hiérarchie nette, comme dans les captures. Helvetica Neue, Helvetica ou Arial servent aux textes, champs, boutons et données. Les prix FCFA et les états restent lisibles et compacts.

# Composants

- **Navigation** : barre latérale blanche avec marque rouge, icônes sobres et sélection sur fond rouge très pâle; navigation horizontale défilable sur mobile.
- **Bouton principal** : fond rouge RIMCO, libellé explicite, états désactivé et chargement compréhensibles.
- **Bouton secondaire** : fond blanc, trait fin, texte noir; réservé aux actions de moindre priorité.
- **Champs** : libellé visible, aide et erreur associées, focus rouge clairement perceptible.
- **Médias** : conserver leur ratio, privilégier les photos réelles de véhicule et ne jamais déformer, dégrader ou recolorer le logo.
- **État** : associer couleur et texte; afficher la progression de génération sans ambiguïté.
- **Données** : tableaux compacts, montants alignés, FCFA sans décimales et séparateurs de milliers par espace insécable.

Tous les contrôles ont des états repos, survol, focus, désactivé, erreur et chargement lorsque cela s’applique. Respecter la navigation clavier, WCAG 2.2 AA et `prefers-reduced-motion`.

# Périmètre V1

L’interface V1 permet de préparer une génération, suivre son état, consulter la vidéo terminée et télécharger le MP4. Les écrans de validation de vidéo et de modification par phrase ne font pas partie de cette version.
