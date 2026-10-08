---
name: RIMCO Studio
description: Interface de production vidéo automobile interne, conçue comme un atelier de précision expert, rassurant et premium.
colors:
  brand: "#c51e1c"
  brand-dark: "#831810"
  ink: "#253b4e"
  background: "#f5f5f3"
  surface: "#fbfbfa"
  muted: "#716d66"
  border: "#e4e1db"
  focus: "#c51e1c"
typography:
  display: Bebas Neue
  body: "Helvetica Neue, Helvetica, Arial, sans-serif"
---

# Overview

RIMCO Studio est un outil de production interne pour générer des vidéos automobiles, les visionner et télécharger leur MP4. La V1 ne comprend ni édition après génération ni validation des vidéos générées. Son registre est celui de l’atelier de précision : une interface experte et rassurante qui met le véhicule, les décisions de production et le coût au premier plan. Le rouge RIMCO porte l’identité et les actions importantes ; le bleu ardoise structure les informations. Les surfaces restent plates, calmes et séparées par des tons et des traits fins. L’interface est entièrement en français et vise WCAG 2.2 AA, la navigation clavier et la préférence de mouvement réduit.

# Colors

| Token | Valeur | Usage |
| --- | --- | --- |
| Brand red | `#c51e1c` | Navigation active, actions principales, état de marque |
| Brand burgundy | `#831810` | Surfaces rouges profondes et contraste de navigation |
| Ink | `#253b4e` | Titres, navigation secondaire et structure |
| Background | `#f5f5f3` | Fond général légèrement chaud |
| Surface | `#fbfbfa` | Zones de saisie et surfaces de travail |
| Muted | `#716d66` | Texte secondaire lisible |
| Border | `#e4e1db` | Séparateurs et contours discrets |
| Focus | `#c51e1c` | Anneau de focus clavier visible |

Utiliser le rouge avec intention et assez de présence pour rendre l’identité reconnaissable. Le bleu ardoise garde la hiérarchie lisible et le rouge ne remplace pas les libellés ou les états textuels. Contrôler le contraste de chaque paire de couleurs dans son contexte d’usage.

# Typography

Les titres utilisent Bebas Neue, avec une casse simple et une hiérarchie nette. Les textes, contrôles et données utilisent Helvetica Neue, Helvetica, Arial, sans-serif. Les prix FCFA et les états doivent rester faciles à parcourir ; ne pas employer la police d’affichage pour les paragraphes ou les petits libellés.

# Elevation

Le système privilégie les surfaces plates, les fonds légèrement teintés et les traits fins. Les ombres servent uniquement à signaler une superposition réelle, par exemple un menu flottant. Éviter les dégradés décoratifs, le verre, les panneaux empilés et les ombres larges.

# Components

- **Navigation** : menu latéral bordeaux sur grand écran, avec libellé visible, repère actif et icône SVG simple ; navigation compacte et défilable sur mobile.
- **Bouton principal** : rouge RIMCO, texte explicite, état de focus visible et états désactivé/en chargement compréhensibles.
- **Bouton secondaire** : surface neutre, contour fin, texte encre ; réservé aux actions de moindre priorité.
- **Champ** : libellé toujours visible, aide et erreur associées au champ, contour de focus net.
- **État** : associer une couleur à un mot ou une icône ; ne jamais compter sur la couleur seule.
- **Média** : conserver le ratio de la source et le logo officiel sans déformation, dégradé ni recoloration.
- **Données** : tableaux compacts, alignement stable des montants, FCFA sans décimales et séparateurs de milliers par espace insécable.

Tous les contrôles interactifs définissent les états repos, survol, focus, désactivé, erreur et chargement lorsque cela s’applique. Le mouvement reste bref et fonctionnel ; respecter `prefers-reduced-motion`.

# Do’s and Don’ts

**À faire**

- Montrer clairement l’étape de production, le responsable, le statut et le coût pertinent pour le rôle.
- Donner une rétroaction immédiate après une action et préserver le contexte de travail.
- Utiliser des icônes SVG sobres accompagnées de libellés lorsqu’une action n’est pas universelle.
- Rendre explicites les étapes de génération, de lecture et de téléchargement.

**À éviter**

- Les grilles répétitives de cartes KPI et les compositions SaaS génériques ou décoratives.
- Les emoji utilisés comme icônes, les modales sans nécessité et les contrôles sans libellé.
- Les indicateurs de statut uniquement colorés, les animations non essentielles et les mouvements qui ignorent la préférence système.
- Toute transformation du logo RIMCO ou tout changement de couleur du véhicule par le prompt.
