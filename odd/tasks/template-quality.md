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
| T3 | S3 | inline | done (RED→GREEN handoff.test) | 8e58839 |
| T4 | S4 | inline | done (RED→GREEN definition-validators.test) | 0b38c2a |
| T5 | S5 | inline | done (RED→GREEN handoff.test) | d343805 |
| T6 | S6 | inline | done (RED→GREEN definition-validators.test) | f5c65c3 |
| T7 | S7 | inline | done (RED→GREEN handoff.test) | 69d930a |
| T8 | S8 | delegated (context backstop: parent session past ~150k) | done (verifier: S8 met; gentle-ai review risk/resilience/reliability: approved) | 881de4d, be1877c, 21ae427 |

Route evidence: no Writer trigger (units are sequential edits of one template plus the backend; no parallel units of several minutes each), so the parent writes inline.

## Log

- L1 (2026-11-26) User: "listo, ahora quiero que explores estos proyectos: 1. https://github.com/cursor/plugins/tree/main/pstack 2. https://github.com/Gentleman-Programming/gentle-ai 3. si puedes revisar este video https://www.youtube.com/watch?v=zsCGS-Yzjnw sobre diseño quiero que extraigas de cada uno lo que pueda mejorar las skill y procesos que tenemos y los integremos para elevar la calidad actual"
- L2 (2026-11-26) Three read-only research agents reported (Engram `forge/research-quality-sources`). Proposal of 8 items; user chose "Todo, incluido el 8".
- L3 Explorer mapped step mechanics: step kinds in `packages/shared/src/index.ts:18`, contracts `handoff/contracts.ts`, validation `handoff/output-validator.ts`, send-back `domain/next-action.ts`, template paths `definition/template.ts:10`. "review" is taken (board column, run mode, review loop): S8's step id is `code_review`.
- L4 (2026-11-26) User chose "PRs encadenados a main" (stacked-to-main).
- L5 T1 done (032a7e4): `preexisting` counts in the security contract; skill requires a proving command and an origin per finding. gentle-ai review (risk lens) approved; advisory WARNING: the backend cannot verify that a finding is really pre-existing (agent-reported). Follow-up: the code_review step (T8) or a backend lockfile diff could cross-check it.
- L6 T2 done (49dd62f): development `tdd` extras + `tdd_evidence` exit flag (every unit/integration TC covered, git confirms each red_commit precedes the tip); input.md asks to question the premise from the second failure of a gate; developer prompt with one test per rule and two imagined edits. Assess: medium, under_budget (pending in slice).
- L7 T5 (d343805): `escalated` thread action; claims checked before acting, dismissals need proof. T6 (f5c65c3): FR `Source:` line checked word for word against intake.md, assumptions counted in the stage summary. T7 (69d930a): pr.md six sections, at most 40 lines, checked under `pr_created`. Slice PR1 assess since 032a7e4: medium, under_budget (354 lines), no review due. Checks: lint 0, typecheck 0, 417 tests, 14 e2e.
- L8 PR1 opened: #14 (feat/template-quality → main). T3 (8e58839): manifest `proves` per case, `criteria`/`requirements` verdicts checked (missing, unmet, unknown case); panel reads stored manifests with a lenient schema. T4 (0b38c2a): design validator needs color/radius/typography tokens and a `Library:` line per component; prompts name libraries, one standout per screen, worst-case data shots. Slice PR2: 179 lines, medium, no review due. Checks: 420 tests, 14 e2e.
- L9 PR2 opened: #15. T8 (881de4d) by a bounded writer: `code_review` step, `review-depth.ts` (passive → none, sensitive path or dangerous sink → 4 lenses, else reliability; size not an input), `review-diff.ts` (merge base..HEAD, all lenses on git error), contract + `review_clean` flag, reviewer/refuter agents, code-review skill, settings, web column, fake claude, ADR 0015. Parent fixed restart.test step count. 473 tests, 14 e2e. Risk item 2 (step permissions): independent verifier running, then gentle-ai review.
- L10 Independent verifier (Risk item 2): S8 met; blocker B1 (a repeated lens passed the lens check) fixed test-first in be1877c. gentle-ai review (risk, resilience, reliability; escalated item 2) approved with advisories; the SQL sink regex backtracking (a 300k-char line did not finish in 120 s) fixed test-first in 21ae427. Checks: 474 tests, 14 e2e.
- L11 Follow-ups (not in this feature): (1) report-time lens recompute can diverge from launch on a transient git error (reuse the `review_depth` event instead); (2) `.factory/**` and agent `.md` count as passive, so a task changing step settings gets no lens; dependency and CI files get only reliability; (3) the bare `Agent` tool lets code_review start a general-purpose subagent (restrict to the forge-review-* agents if Claude Code supports it); (4) git deny rules are prefix-based (`git -C . commit` passes), same as before; (5) diff text in the Review depth section of input.md is not marked as untrusted; (6) the backend cannot verify security's pre-existing classification (from T1 review).
- L12 Stop hook: unreviewed range 032a7e4..HEAD (T2-T7, T3, T4). gentle-ai four-lens review approved with advisories. Fixed: `tdd` was required by the contract even without `tdd_evidence` (contradicted PR #14's risk note); now the flag owns it, and the input.md criterion says what git checks (feat/template-quality, merged down the chain). New follow-ups: (7) `lenses` names a ReviewDepth on InputContext and a ReviewLens[] on ReportContext; (8) quoted diff headers (paths with quotes or control characters) parse as empty and fall to passive (fails open); (9) the linear-time test uses a 500 ms wall-clock bound.
