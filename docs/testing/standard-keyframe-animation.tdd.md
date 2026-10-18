# TDD — Images-clés et animation Standard

## Parcours couvert

Un utilisateur choisit Standard, un véhicule, un lieu, une durée et un format; le pipeline crée et contrôle une image-clé par plan, puis anime les images acceptées avec Wan 3.0. Les clips Wan durent exactement 5 secondes et sont assemblés pour produire 5, 10, 15 ou 20 secondes de séquences avant l’habillage final.

## Preuves

| Garantie | Tests | Résultat |
|---|---|---|
| Les trois niveaux activent la chaîne image-clé | `src/core/providers/fal-keyframes.test.ts` | PASS |
| Wan anime l’image-clé via `start_image_url`, en 5 s, au ratio sélectionné et sans audio généré | `src/core/providers/fal-keyframes.test.ts` | PASS |
| Wan refuse les durées et formats non pris en charge avant soumission | `src/core/providers/fal-keyframes.test.ts` | PASS |
| Standard découpe 5/10/15/20 s en 1/2/3/4 segments Wan de 5 s | `src/core/providers/storyboard-routing.test.ts`, `src/core/storyboard.test.ts` | PASS |
| L’animation attend des images-clés prêtes et une reprise qualité au maximum | `src/core/providers/fal-keyframes.test.ts` | PASS |

RED confirmé : la première exécution après modification des assertions a échoué sur l’activation Standard, l’ancien routage Wan de référence et les segments de 10 secondes. GREEN : `pnpm test -- src/core/providers/fal-keyframes.test.ts src/core/providers/storyboard-routing.test.ts src/core/storyboard.test.ts` a exécuté la suite Vitest complète et rapporté 29 fichiers / 117 tests réussis.

Vérifications supplémentaires : `pnpm typecheck`, `pnpm lint` et `git diff --check` réussis. Le build de production n’a pas pu être confirmé : `.next/lock` est resté présent après le premier lancement et Next.js a refusé le second en signalant qu’un autre build est déjà actif. Aucun appel fal payant ni migration Supabase distante n’a été lancé. Aucun test de génération réelle avec images n’a été effectué.
