import { describe, expect, it } from "vitest";
import { isLocalHost, isLocalOrigin, LoginCodes, readCookie, sessionCookieValue, verifySessionCookie } from "./panel-auth.js";

describe("panel auth", () => {
  it("accepts a login code exactly once and never after it expires", () => {
    let now = 0;
    const codes = new LoginCodes(() => now, 60_000);
    const code = codes.create();
    expect(codes.consume("wrong")).toBe(false);
    expect(codes.consume(code)).toBe(true);
    expect(codes.consume(code)).toBe(false);
    const late = codes.create();
    now = 60_001;
    expect(codes.consume(late)).toBe(false);
  });

  it("signs session cookies with the local token, so they survive a restart but not a token change", () => {
    const value = sessionCookieValue("token-a");
    expect(verifySessionCookie("token-a", value)).toBe(true);
    expect(verifySessionCookie("token-b", value)).toBe(false);
    expect(verifySessionCookie("token-a", `${value.split(".")[0]}.forged`)).toBe(false);
    expect(verifySessionCookie("token-a", undefined)).toBe(false);
    expect(verifySessionCookie("token-a", "no-dot")).toBe(false);
  });

  it("reads one cookie from a Cookie header", () => {
    expect(readCookie("a=1; forge_session=abc.def; b=2", "forge_session")).toBe("abc.def");
    expect(readCookie(undefined, "forge_session")).toBeUndefined();
  });

  it("only accepts local Host headers on the backend port (DNS rebinding)", () => {
    expect(isLocalHost("127.0.0.1:7420", 7420)).toBe(true);
    expect(isLocalHost("localhost:7420", 7420)).toBe(true);
    expect(isLocalHost("evil.example:7420", 7420)).toBe(false);
    expect(isLocalHost("127.0.0.1:9999", 7420)).toBe(false);
    expect(isLocalHost(undefined, 7420)).toBe(false);
  });

  it("only accepts the panel's own Origin for cookie-authenticated writes and WebSockets", () => {
    expect(isLocalOrigin("http://127.0.0.1:7420", 7420)).toBe(true);
    expect(isLocalOrigin("http://localhost:7420", 7420)).toBe(true);
    expect(isLocalOrigin("https://evil.example", 7420)).toBe(false);
    expect(isLocalOrigin("http://127.0.0.1:5173", 7420)).toBe(false);
    expect(isLocalOrigin(undefined, 7420)).toBe(false);
  });
});
