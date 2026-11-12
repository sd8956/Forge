import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOKEN_HEADER = "x-forge-token";

/**
 * The token survives restarts on purpose: running tmux sessions keep the
 * settings rendered with it, so a new token would cut them off.
 */
export function loadOrCreateToken(home: string): string {
  const file = join(home, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function readToken(home: string): string {
  const file = join(home, "token");
  if (!existsSync(file)) throw new Error(`No token at ${file}. Start the backend first: pnpm forge serve`);
  return readFileSync(file, "utf8").trim();
}

export function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
