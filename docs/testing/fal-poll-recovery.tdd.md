# Vérification TDD — reprise du suivi fal

## Parcours couverts

- Les erreurs fal déterministes (400, 401, 403, 404, 422) arrêtent le suivi; les erreurs réseau, 429 et 5xx utilisent un backoff borné.
- La reprise manuelle réinterroge un identifiant existant et ne soumet pas de génération.
- Un appel accepte son endpoint persistant; l’absence d’un identifiant ou un coût incertain laisse la tâche à réconcilier.
- L’interface affiche les erreurs, réduit le polling à 15 secondes et laisse progresser les autres tâches.

## Preuves d’exécution

| Vérification | Commande | Résultat |
|---|---|---|
| Tests unitaires | `pnpm test` | PASS — 32 fichiers, 152 tests |
| Types TypeScript | `pnpm typecheck` | PASS |
| Règles ESLint | `pnpm lint` | PASS |
| Build production | `PROVIDERS_MODE=mock NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=fake SUPABASE_SERVICE_ROLE_KEY=fake FAL_KEY=fake LLM_MODEL=anthropic/claude-sonnet-5.5 FAL_WEBHOOK_SECRET=fake CRON_SECRET=fake USD_TO_EUR_RATE=0.92 EUR_TO_FCFA=655.957 pnpm build` | PASS — build Next.js complété |
| Espaces et conflits de patch | `git diff --check` | PASS |

La suite teste les délais 15/60/180 secondes, le plafond de reprises, la classification des statuts HTTP, l’envoi de `reasoning: true` requis par le modèle Vision configuré en production et la réutilisation de l’endpoint fal persisté.

## Limites

- Les tests n’appellent pas fal et ne lancent aucune génération payante.
- La migration `0027_fal_poll_recovery.sql` est créée, ajoutée à `supabase/setup.sql` et a été exécutée sur le projet Supabase de production pendant le déploiement de la PR 58.
- Les tâches déjà bloquées en production restent à réconcilier séparément; le déploiement du correctif ne les soumet pas à nouveau et ne modifie pas leur état distant.
- La couverture chiffrée n’a pas été mesurée.

## Contrat de récupération pour les agents

Pour chaque échec, consigner `status`, un résumé, les prochaines actions et les artefacts (tâche, déploiement ou fichier). Ajouter l’indice de cause racine, la reprise sûre et la condition d’arrêt. Une réponse fal 400/422 est déterministe : ne pas relancer automatiquement; examiner la requête et le détail fournisseur. Un 404 du connecteur GitHub sur un dépôt privé signifie que l’accès n’est pas disponible : arrêter après cette vérification, demander le rétablissement de l’accès et ne pas transférer le dépôt vers un autre éditeur. Une tâche fal acceptée ou de coût incertain reste en réconciliation; ne jamais la soumettre une seconde fois.
