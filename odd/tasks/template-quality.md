# Template quality

Objective: raise the quality of Forge's template agents, skills and pipeline with practices taken from cursor/plugins pstack, Gentleman-Programming/gentle-ai and the video "UI Libraries for Claude Code (Ban the AI Look)". Branch `feat/template-quality`. Delivery: ask-on-risk → stacked-to-main (user, L4). Slices: PR1 = T1, T2, T5, T6, T7 (prompts and skills); PR2 = T3, T4 (validators); PR3 = T8 (code_review step + ADR). Test runner: vitest + Playwright.

## Specs

User request (L1): "quiero que extraigas de cada uno lo que pueda mejorar las skill y procesos que tenemos y los integremos para elevar la calidad actual". Chosen scope: "Todo, incluido el 8". Each spec below is a proposal item the user accepted, quoted as proposed.

- S1 Gates block only on what the change introduced, with proof: "Security frena hoy por cualquier hallazgo crítico, aunque ya estuviera en `main`. Pasaría a exigir un comando que lo reproduzca y a marcar si lo introdujo la tarea o ya existía; lo que ya existía queda como nota y no frena." Touches `forge-security`, `security-scan`.
- S2 Developer test discipline: "Un test que falla por cada regla, commiteado antes que el arreglo. Imaginar dos ediciones por test: si romper la conducta no lo hace fallar, el test no sirve. Evidencia RED/GREEN en `output.md`. Ante el segundo fallo de la misma verificación, revisar la hipótesis antes de seguir parchando." Touches `forge-developer`, `test-plan-authoring`.
- S3 Verify against the spec: "E2E devuelve cumplido o no cumplido por cada criterio de aceptación y por cada FR que cubre la tarea. Cada evidencia dice qué estado prueba. El backend rechaza el reporte si falta algún criterio." Touches `forge-tester`, evidence skills, the step report validator.
- S4 Design without the AI look: "`components.md` nombra la librería de cada componente (shadcn/Base UI, Sonner, Vaul, cmdk). `tokens.json` obliga a definir radio, colores y tipografía, y el validador lo verifica. Un solo elemento destacado por pantalla. Capturas también con datos de peor caso (vacío, nombres largos, 1000 filas)." Touches `forge-def-design`, `forge-designer`, the design validator.
- S5 Review fix with judgement: "Cada comentario del PR se trata como hipótesis: arreglarlo, descartarlo con prueba, o escalarlo si toca seguridad o datos. Respuestas que van directo al punto." Touches `forge-review-fixer`, `pr-thread-reply`.
- S6 Traceable requirements: "Cada FR cita textual la intake o queda marcado como supuesto." Touches `forge-def-requirements`, `forge-def-backlog`.
- S7 One-minute PR: "Máximo 40 líneas: Por qué, Qué cambió, Alcance, Tradeoffs, Radio de impacto, Verificación." Touches `forge-pr`, `pr-report`.
- S8 Code review step before the PR: "Revisores por lente más un refutador. La profundidad la decide el backend según el diff." New pipeline step, backend, ADR.

Assumption (A1): the template source is `fixtures/demo-project` (`.claude/` and `.factory/`), delivered to projects by template sync (ADR 0013).

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | done (RED→GREEN handoff.test; review risk: approved) | 032a7e4 |
| T2 | S2 | inline | done (RED→GREEN handoff.test; assess medium, under budget) | 49dd62f |
| T3 | S3 | inline | pending | |
| T4 | S4 | inline | pending | |
| T5 | S5 | inline | done (RED→GREEN handoff.test) | d343805 |
| T6 | S6 | inline | done (RED→GREEN definition-validators.test) | f5c65c3 |
| T7 | S7 | inline | done (RED→GREEN handoff.test) | 69d930a |
| T8 | S8 | inline | pending | |

Route evidence: no Writer trigger (units are sequential edits of one template plus the backend; no parallel units of several minutes each), so the parent writes inline.

## Log

- L1 (2026-11-26) User: "listo, ahora quiero que explores estos proyectos: 1. https://github.com/cursor/plugins/tree/main/pstack 2. https://github.com/Gentleman-Programming/gentle-ai 3. si puedes revisar este video https://www.youtube.com/watch?v=zsCGS-Yzjnw sobre diseño quiero que extraigas de cada uno lo que pueda mejorar las skill y procesos que tenemos y los integremos para elevar la calidad actual"
- L2 (2026-11-26) Three read-only research agents reported (Engram `forge/research-quality-sources`). Proposal of 8 items; user chose "Todo, incluido el 8".
- L3 Explorer mapped step mechanics: step kinds in `packages/shared/src/index.ts:18`, contracts `handoff/contracts.ts`, validation `handoff/output-validator.ts`, send-back `domain/next-action.ts`, template paths `definition/template.ts:10`. "review" is taken (board column, run mode, review loop): S8's step id is `code_review`.
- L4 (2026-11-26) User chose "PRs encadenados a main" (stacked-to-main).
- L5 T1 done (032a7e4): `preexisting` counts in the security contract; skill requires a proving command and an origin per finding. gentle-ai review (risk lens) approved; advisory WARNING: the backend cannot verify that a finding is really pre-existing (agent-reported). Follow-up: the code_review step (T8) or a backend lockfile diff could cross-check it.
- L6 T2 done (49dd62f): development `tdd` extras + `tdd_evidence` exit flag (every unit/integration TC covered, git confirms each red_commit precedes the tip); input.md asks to question the premise from the second failure of a gate; developer prompt with one test per rule and two imagined edits. Assess: medium, under_budget (pending in slice).
- L7 T5 (d343805): `escalated` thread action; claims checked before acting, dismissals need proof. T6 (f5c65c3): FR `Source:` line checked word for word against intake.md, assumptions counted in the stage summary. T7 (69d930a): pr.md six sections, at most 40 lines, checked under `pr_created`. Slice PR1 assess since 032a7e4: medium, under_budget (354 lines), no review due. Checks: lint 0, typecheck 0, 417 tests, 14 e2e.
