# F1 — single-task pipeline to a real PR

Objective: Phase 1. One backlog task runs plan → design → development → security → e2e → pr in sequence and ends in `waiting_review` with a real PR. Branch `feat/f1-single-task-pipeline`. Delivery: work-unit commits, single PR at the end (push/PR decided by the user). Test runner: vitest (`pnpm test`).

## Specs

- S1 Pipeline YAML: "`.factory/pipeline.yaml` en el proyecto destino: pasos, agente, modelo por defecto, settings, criterio de salida, máximo de intentos y a qué paso vuelve cuando falla (seguridad → desarrollo, E2E → desarrollo). Validado con zod al cargar."
- S2 Run entity: "`queued → running → (waiting_review | needs_human | failed | cancelled)`, con contador de intentos por bucle. Transiciones como tabla, con tests unitarios. Si se agotan los intentos, pasa a `needs_human`."
- S3 Handoff builder: "arma el `input.md` de cada paso a partir de la tarea, los `output.md` y artefactos de los pasos anteriores, y el contrato de salida del paso. Define y valida el esquema de `output.md` (frontmatter con status, summary, artifacts) para cada paso."
- S4 Memory: "MemoryAdapter + EngramAdapter: los agentes usan Engram por MCP; el backend lo lee por su API HTTP (`search`, `listByTask`). Verifica la API real de Engram antes de implementarla. Cada observación guardada lleva el proyecto y la referencia `TASK-xxx/<paso>`."
- S5 Agents: "`forge-planner`, `forge-designer`, `forge-developer`, `forge-security`, `forge-tester`, `forge-pr`, con el modelo y las herramientas de la tabla *Agents and skills per step* de `docs/` y permisos mínimos por paso."
- S6 Skills: "`forge-step-protocol` (ya existe; ajústala si hace falta), `test-plan-authoring`, `repo-conventions`, `security-scan`, `playwright-evidence`, `evidence-manifest` y `pr-report`." security-scan: "corre Semgrep, gitleaks y osv-scanner; Claude confirma o descarta cada hallazgo contra `threat-model.md`. Crítico o alto → `failed` y vuelve a desarrollo." playwright-evidence: "levanta la app con `make up`, ejecuta cada `TC-xx` del test plan y guarda una captura por paso, video y trace. Los casos quedan como specs versionadas en `e2e/`." evidence-manifest: "escribe `evidence/manifest.json`, que liga cada TC con su FR, su resultado y sus archivos."
- S7 Development Stop hook: "corre `make check` (build, lint, unit) y bloquea si está en rojo."
- S8 PR step: "`gh pr create` con plantilla: resumen, FR cubiertos, tabla de TC con resultados, resumen de seguridad y riesgos. Las evidencias se quedan locales en `.factory/runs/`; en el PR va el resumen en texto."
- S9 CLI: "`pnpm forge run-task --project <ruta> --task TASK-001`, `pnpm forge status <run-id>` y `pnpm forge resume <run-id>`."
- S10 Tests: unit (run state machine, YAML loading, handoff builder, `output.md` validation); integration with the fake `claude`: "el pipeline completo, más un caso donde E2E falla una vez y se recupera, y uno donde se agotan los intentos y termina en `needs_human`"; "Ejecución real sobre el repo sandbox, documentada en `docs/runs/f1.md`."
- S11 Exit gate:
  - "Una tarea real del sandbox termina en un PR abierto, con `test-report.md` (todos los TC con evidencia) y `security-report.md`, y el run queda en `waiting_review`."
  - "Un fallo forzado (un TC que falla, o una vulnerabilidad sembrada) devuelve la tarea a desarrollo y se recupera."
  - "Al agotarse los intentos, el run pasa a `needs_human` sin intervención manual."
  - "Todos los `output.md` validan contra su esquema, y Engram tiene entradas etiquetadas `TASK-xxx/<paso>`."
  - "Matar el backend a mitad del pipeline y ejecutar `resume` retoma en el paso correcto, sin duplicar."
  - "Todas las transiciones ocurren por `report_step` o hooks; nada lee la pantalla."
  - "`pnpm test`, `pnpm lint` y `pnpm typecheck` en verde."
- S12 Out of scope: "el panel web, el Vigía de PRs ni el paso "Review fix" (Fase 2), ni el orquestador, el DAG o el paralelismo (Fase 3). El pipeline termina en `waiting_review`."
- S13 Work style: "Implementa y prueba paso por paso con el `claude` falso. Haz solo una ejecución real completa al final, y otra para el fallo forzado". "Cada desviación de `docs/` va como ADR." Final report in `docs/runs/f1.md`: "tiempo y número de sesiones por paso, dónde se atascó el pipeline, qué agente o skill hay que mejorar, y qué cambiarías antes de la Fase 2."

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T0 | S13 | inline | done | 432cd40 |
| T1 | S1 | inline | done | 6a6c9b1 |
| T2 | S2 | inline | done | 0bbe9e7 |
| T3 | S2 | inline | done | 344548f |
| T4 | S3 | inline | done | 0130837 |
| T5 | S4 | inline | done | 063e7a4 |
| T6 | S2, S7, S9 | inline | done | a82b372 |
| T7 | S9 | inline | done | a82b372 |
| T8 | S5, S6, S8 | inline | done | 38793c4 |
| T9 | S10 | inline | done | 7023930 |
| T10 | S10, S11, S13 | inline | pending | |

T0 CLAUDE.md + scanners; T1 pipeline loader; T2 run machine + next-action; T3 run table; T4 handoff + output.md validation; T5 memory adapter; T6 RunService (advance, reconcile, resume, make check gate); T7 CLI; T8 fixture web app, agents, skills, settings; T9 fake-claude integration; T10 real runs + docs/runs/f1.md. Route evidence: units depend on each other; no Writer trigger; all inline.

## Log

- L1 (2026-11-16) Original request: Forge Phase 1 prompt (pasted), "Alcance de esta sesión: Fase 1 (pipeline de una tarea)" with deliverables S1–S10, exit gate S11, work style S13.
- L2 (2026-11-16) User: "Si apruebo el plan". Approved: plan as presented (pipeline.yaml and output.md schemas, backend-validated exit criteria at report_step, attempt directories, skill subset ADR), plus `brew install semgrep gitleaks osv-scanner`, Playwright Chromium download to `~/.cache/ms-playwright`, and creating private repo `sd8956/forge-sandbox` with `gh`.
- L3 Findings before code: repo has no `CLAUDE.md` (only the fixture's); demo fixture is a CLI, so it becomes a minimal web app for Playwright; Engram HTTP API verified live on 127.0.0.1:7437 (`GET /search?q=&project=`, `GET /observations?project=`; no topic_key filter).
- L4 (2026-11-16) Implementation T0–T9 done; 125 tests green 3× in a row; lint/typecheck green. Bug found by integration tests: same tmux name per step let the delayed close of attempt n kill attempt n+1; sessions now named `forge-<TASK>-<step>-<attempt>` (ADR 0004). ADRs 0004 (backend validates outputs, attempt dirs) and 0005 (skills subset, web fixture, run-task CLI, trust preflight, Engram scope). Tools installed: semgrep 1.185.0, gitleaks 8.30.1, osv-scanner 2.7.1, Playwright chromium-1255.
- Next: T10 — create private repo sd8956/forge-sandbox, sandbox copy, real full run (TASK-001), forced failure run (seeded secret on feat/TASK-002), docs/runs/f1.md.
