---
name: security-scan
description: Forge security step procedure. Run Semgrep, gitleaks and osv-scanner on the task branch, then confirm or discard each finding against threat-model.md and the OWASP Top 10, and write security-report.md with severities. Critical or high confirmed findings mean failed.
---

# Security scan

Scope: the changes of the task branch against its base (both named in `input.md`). Save raw tool output
in your output directory (`<out>` below) and cite it in the report.

## 1. Deterministic tools (always, in this order)

Use the literal **base commit** and output directory from `input.md`. Write each command with those
values typed in: no shell variables, no `$(...)`, no `cd`, no pipes. Commands built that way need no
permission prompt; anything else stops the pipeline until a person answers.

```bash
semgrep scan --config p/default --config .semgrep/forge.yml --metrics off --baseline-commit <base-commit> --json --output <out>/semgrep.json --quiet .
gitleaks git --log-opts=<base-commit>..HEAD --report-format json --report-path <out>/gitleaks.json --redact .
osv-scanner scan source --lockfile package-lock.json --format json --output-file <out>/osv.json
```

- `.semgrep/forge.yml` holds the project rules (for example reflected HTML in raw Node responses, which
  `p/default` misses). Registry packs alone are not enough: always review the diff yourself.
- gitleaks exits 1 when it finds leaks; that is a result, not an error.
- osv-scanner exits 1 when it finds vulnerabilities. Pass the lockfile explicitly: a task worktree lives
  under an ignored folder, so a recursive scan (`-r .`) finds nothing. If the project has no lockfile,
  record "no dependencies scanned".
- If a tool cannot run at all (missing, no network for Semgrep rules), report `blocked` and say which.
- Read the JSON reports with the Read tool, not with scripts.

## 2. Review

1. Read `git diff <base-commit>..HEAD` in full.
2. For every tool finding, decide **confirmed** or **discarded** with a one-line reason. Discard only with
   evidence (test file, unreachable code, false-positive pattern).
3. Review the diff yourself against every row of `.factory/threat-model.md` and the OWASP Top 10 (XSS,
   injection, path traversal, missing input limits, secrets, unsafe defaults). Add findings the tools
   missed.

## 3. Severity

Use the threat model's "Severity if missing" column when a finding matches a row; otherwise:
critical (remote code execution, auth bypass, secret with write access), high (XSS, path traversal,
committed secret, known exploitable CVE), medium (missing limit, DoS vector, weak default), low (hardening).

## 4. `security-report.md`

```markdown
# Security report — <TASK> (attempt n)

Base: <sha> · Head: <sha> · Tools: semgrep <v>, gitleaks <v>, osv-scanner <v>

| # | Source | File:line | Severity | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |

## Threat model check
One line per threat-model row: mitigated, not affected, or finding #n.

## For development (only when failed)
Exactly what to change for each confirmed critical or high finding.
```

## 5. Outcome

- `findings` in the frontmatter counts **confirmed** findings by severity (always required).
- Any confirmed critical or high: status `failed`. The backend refuses `done` in that case.
- Otherwise `done`; medium and low are listed for the PR.
