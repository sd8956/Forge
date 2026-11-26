import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installService, renderUnit, uninstallService } from "./systemd.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in for systemctl that records its arguments. */
function fakeSystemctl() {
  const dir = mkdtempSync(join(tmpdir(), "forge-systemd-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  const bin = join(dir, "systemctl");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("systemd user service", () => {
  it("runs forge serve from the repository, keeps tmux sessions alive across restarts and carries the PATH", () => {
    const unit = renderUnit({ repo: "/home/me/forge", node: "/usr/bin/node", path: "/home/me/.local/bin:/usr/bin" });
    expect(unit).toContain("WorkingDirectory=/home/me/forge");
    expect(unit).toContain("ExecStart=/usr/bin/node --import tsx /home/me/forge/packages/backend/src/cli.ts serve");
    expect(unit).toContain("Environment=PATH=/home/me/.local/bin:/usr/bin");
    // Stopping or restarting the backend must not kill the step sessions in its cgroup.
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes paths with spaces", () => {
    expect(renderUnit({ repo: "/home/me/my forge", node: "/usr/bin/node", path: "/usr/bin" })).toContain('ExecStart=/usr/bin/node --import tsx "/home/me/my forge/packages/backend/src/cli.ts" serve');
  });

  it("installs, enables and starts the unit, and uninstalls it", () => {
    const sys = fakeSystemctl();
    const config = join(sys.dir, "config");
    const file = installService({ configHome: config, systemctl: sys.bin, repo: "/r", node: "/usr/bin/node", path: "/usr/bin" });
    expect(file).toBe(join(config, "systemd", "user", "forge.service"));
    expect(readFileSync(file, "utf8")).toContain("WorkingDirectory=/r");
    expect(sys.calls()).toEqual(["--user daemon-reload", "--user enable --now forge.service"]);
    expect(uninstallService({ configHome: config, systemctl: sys.bin })).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(sys.calls().slice(2)).toEqual(["--user disable --now forge.service", "--user daemon-reload"]);
    expect(uninstallService({ configHome: config, systemctl: sys.bin })).toBe(false);
  });
});
