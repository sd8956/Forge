---
name: evidence-manifest
description: Format of evidence/manifest.json in the Forge e2e step. Links every TC of the test plan to its FR ids, its result and its evidence files. The backend validates it. Use in the e2e step after running the tests.
---

# Evidence manifest

Write `<out>/evidence/manifest.json`:

```json
{
  "task": "TASK-001",
  "cases": [
    {
      "id": "TC-01",
      "frs": ["FR-001"],
      "result": "passed",
      "files": ["TC-01/01-open-page.png", "TC-01/02-add-todo.png", "playwright/<test-dir>/trace.zip", "playwright/<test-dir>/video.webm"]
    }
  ]
}
```

## Rules (the backend checks them)

- **Every** `TC-xx` of the test plan has exactly one entry, including unit cases.
- `result` is `passed`, `failed` or `skipped`, taken from `results.json` (read it with the Read tool), never guessed.
- Write the manifest with the Write tool, not with a script.
- `files` are paths **relative to the manifest's directory** and must exist. Every case needs at least one.
  - E2E cases: the step screenshots, plus the video and trace of that test.
  - Unit cases: run `make check`, write its output to `<out>/evidence/make-check.log` with the Write tool,
    and list `make-check.log`.
- `frs` come from the test plan's "Covers" line.
- `done` requires every case `passed` with files; otherwise report `failed`. The frontmatter
  `tests.total` must equal the number of cases.
