import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "forge_session";

/**
 * One-time login codes for the panel. `forge serve` and `forge login` print a
 * link with a code; opening it sets the session cookie. Codes live in memory.
 */
export class LoginCodes {
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  create(): string {
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, this.now() + this.ttlMs);
    return code;
  }

  consume(code: string): boolean {
    const expires = this.codes.get(code);
    this.codes.delete(code);
    return expires !== undefined && expires >= this.now();
  }
}

function sign(token: string, sid: string): string {
  return createHmac("sha256", token).update(`forge-session:${sid}`).digest("base64url");
}

/** `sid.signature`: stateless, so a backend restart keeps the panel logged in. */
export function sessionCookieValue(token: string): string {
  const sid = randomBytes(18).toString("base64url");
  return `${sid}.${sign(token, sid)}`;
}

export function verifySessionCookie(token: string, value: string | undefined): boolean {
  if (!value) return false;
  const [sid, signature, extra] = value.split(".");
  if (!sid || !signature || extra !== undefined) return false;
  const expected = Buffer.from(sign(token, sid));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

const LOCAL_NAMES = ["127.0.0.1", "localhost"];

/** Rejects other Host names, so a rebinding domain cannot reach the backend through the browser. */
export function isLocalHost(host: string | undefined, port: number): boolean {
  return LOCAL_NAMES.some((name) => host === `${name}:${port}`);
}

export function isLocalOrigin(origin: string | undefined, port: number): boolean {
  return LOCAL_NAMES.some((name) => origin === `http://${name}:${port}`);
}
