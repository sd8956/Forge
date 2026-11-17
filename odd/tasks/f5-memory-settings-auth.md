# F5 — Memory, Settings, API key and Maestro

Objective: the sidebar's Memory and Settings panels from the design, an API key as an alternative to the subscription, and Maestro for mobile projects. Branch `feat/f5-memory-settings-auth`, stacked on `feat/review-authors-and-board` (PR #8). Delivery: work-unit commits; push/PR decided by the user. Test runner: vitest + Playwright.

## Specs

- S1 Memory: "Por proyecto muestra lo que los pasos guardaron en Engram: buscar, filtrar por tarea o paso (`TASK-001/review`), ver el contenido y saltar al run. Es de solo lectura."
- S2 Settings: "Globales (en la base, por encima de las variables de entorno): límite de sesiones, umbral de uso y autenticación. Del proyecto (modo de permisos, autores extra de la review, intervalo de polling): se muestran desde `project.yaml` con la indicación de editarlo ahí, porque ese archivo sigue siendo la fuente de verdad."
- S3 API key: "Se elige en Settings: Suscripción (por defecto) o API key. La key se guarda en un archivo 0600 en el home de Forge. Nunca va a la base ni a los logs. Las sesiones la leen con el setting `apiKeyHelper` de Claude Code, no por variable de entorno, así el agente no la ve con `env`. Lo verifico en la documentación antes de escribir código." Real test optional (needs the person's key).
- S4 Maestro (v2 in docs/): "Cuando el intake detecta la plataforma mobile, la etapa de test strategy elige Maestro. El paso e2e corre los flows con `make e2e` y deja capturas como evidencia, con una skill `maestro-evidence`." Real test needs Maestro CLI, Java 17 and the Android SDK with an emulator (global installs: ask first).
- S5 Exit gate: Memory and Settings work in the panel with real data; a step runs authenticated with an API key if the person provides one; a small mobile project runs a Maestro flow to its PR only if the tooling is installed; `test`, `lint`, `typecheck` and e2e green.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | done | c2307f8 |
| T2 | S2 | inline | done | d6dd3d1 |
| T3 | S3 | inline | done | d6dd3d1 |
| T4 | S4 | inline | done | 34d636b |
| T5 | S5 | inline | done | closed with tests for the API key and Maestro (person's decision); docs/runs/f5.md |

## Log

- L1 (2026-11-17) User: "1. ¿no tiene sentido que tenga en cuenta todos los comentarios sin importar el usuario? 2. Tiene sentido ... 3. Por ahora esto no lo hagamo 4. De acuerdo 5. Hagamos todo" → points 1, 2, 4 done in PR #8; point 5 is this feature. L2 User: "apruebo el plan pero primero terminemos con mi duda anterior ¿que pasa si apago el equipo en medio de una sesión en curso?" → answered (reconcile relaunches the same step; no auto-start on boot).
- L3 T1-T4 done inline. Verified in docs: apiKeyHelper works from --settings and ranks above the subscription login. Memory checked against the real Engram (demo-project 19 memories, daily-tasks 9, each linked to its run); Settings shows the effective limits. 382 tests + 13 Playwright green (fake Engram added to the e2e). Pending: real API key run (person's key, costs credits) and real Maestro run (global installs).
- L4 User: "esta parte de la interfaz se ve mal" → project settings as a two-column list with a commands table (43e3eb9). User: "cerremos la fase 5 con los tests" → API key and Maestro real runs not done; report in docs/runs/f5.md.
