import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UNIT_NAME = "forge.service";

/** systemd unit values with spaces must be quoted. */
const q = (value: string) => (/\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);

/**
 * A systemd user unit that runs `forge serve` from the repository, so Forge
 * comes back after a reboot (at login). `KillMode=process` stops only the
 * backend: step sessions live in tmux and must outlive a backend restart, as
 * they do when it is run by hand. PATH is captured at install time, because a
 * user service does not get the shell's PATH (claude, gh, tmux, engram).
 */
export function renderUnit(opts: { repo: string; node: string; path: string }): string {
  return [
    "[Unit]",
    "Description=Forge local software factory",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${opts.repo}`,
    `ExecStart=${q(opts.node)} --import tsx ${q(join(opts.repo, "packages", "backend", "src", "cli.ts"))} serve`,
    `Environment=PATH=${opts.path}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

interface ServiceOptions {
  /** `$XDG_CONFIG_HOME`, by default `~/.config`. */
  configHome: string;
  systemctl: string;
}

export const unitPath = (configHome: string) => join(configHome, "systemd", "user", UNIT_NAME);

export function installService(opts: ServiceOptions & { repo: string; node: string; path: string }): string {
  const file = unitPath(opts.configHome);
  mkdirSync(join(opts.configHome, "systemd", "user"), { recursive: true });
  writeFileSync(file, renderUnit(opts));
  execFileSync(opts.systemctl, ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync(opts.systemctl, ["--user", "enable", "--now", UNIT_NAME], { stdio: "inherit" });
  return file;
}

/** Stops and removes the unit; false when it was not installed. Running tmux sessions are left alone. */
export function uninstallService(opts: ServiceOptions): boolean {
  const file = unitPath(opts.configHome);
  if (!existsSync(file)) return false;
  execFileSync(opts.systemctl, ["--user", "disable", "--now", UNIT_NAME], { stdio: "inherit" });
  rmSync(file);
  execFileSync(opts.systemctl, ["--user", "daemon-reload"], { stdio: "inherit" });
  return true;
}
