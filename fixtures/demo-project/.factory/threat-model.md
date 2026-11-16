# Threat model (STRIDE) — demo-project

| Component | Threat | STRIDE | Mitigation | Severity if missing |
| --- | --- | --- | --- | --- |
| Client page | Todo title injected as HTML/script (stored XSS) | Tampering, Information disclosure | Render with `textContent`; never `innerHTML` with user data | High |
| API `/api/todos` | Oversized or endless request body exhausts memory | Denial of service | Cap bodies at 10 KB, answer 413 | Medium |
| API `/api/todos` | Malformed JSON crashes the server | Denial of service | Parse in try/catch, answer 400 | Medium |
| Server | Listening on all interfaces exposes the app | Information disclosure | Bind to `127.0.0.1` | Medium |
| Repository | Secrets (tokens, keys) committed | Information disclosure | No secrets in code; gitleaks in the security step | High |
| Dependencies | Known-vulnerable packages | Elevation of privilege | No runtime dependencies; osv-scanner on lockfiles | High for critical CVEs |
| Static files | Path traversal to read files outside `public/` | Information disclosure | Serve a fixed allowlist of files | High |
