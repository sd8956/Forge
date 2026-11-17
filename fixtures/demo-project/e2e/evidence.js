// Saves one screenshot per test step under EVIDENCE_DIR/<TC-id>/ and returns its path
// relative to EVIDENCE_DIR, ready for evidence/manifest.json.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.EVIDENCE_DIR ?? "test-results";
const counters = new Map();

export async function stepShot(page, tc, name) {
  const n = (counters.get(tc) ?? 0) + 1;
  counters.set(tc, n);
  const rel = join(tc, `${String(n).padStart(2, "0")}-${name}.png`);
  mkdirSync(join(root, tc), { recursive: true });
  await page.screenshot({ path: join(root, rel), fullPage: true });
  return rel;
}
