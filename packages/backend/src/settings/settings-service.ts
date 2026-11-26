import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import { shellQuote } from "../runner/tmux.js";

const KEY = "forge.settings";

/** A program name or path, never a shell line: it is run directly with the project path as its only argument. */
const command = z.string().trim().regex(/^[\w./+-]+$/, "A program name or path, such as code or /usr/bin/thunar");

export const settingsPatch = z
  .object({
    maxConcurrency: z.number().int().min(1).max(10),
    usagePausePercent: z.number().int().min(1).max(100),
    auth: z.enum(["subscription", "api_key"]),
    editorCommand: command,
    fileManagerCommand: command,
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatch>;

/** Anthropic API keys look like `sk-ant-<kind>-<secret>`. */
export const apiKeyInput = z.object({ key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "Not an Anthropic API key (sk-ant-...)") });

export interface EffectiveSettings {
  maxConcurrency: number;
  usagePausePercent: number;
  auth: "subscription" | "api_key";
  apiKey: { configured: boolean; last4: string | null };
  /** Opens a project in the editor ("Open in editor"). */
  editorCommand: string;
  /** Opens a project's folder ("Open folder"). */
  fileManagerCommand: string;
}

export class SettingsError extends Error {}

/**
 * Forge-wide settings the panel can change. Stored values win over the
 * environment defaults. The API key lives only in a 0600 file in Forge's home:
 * never in the database, a response or a session's environment. Sessions get
 * it through Claude Code's `apiKeyHelper`, which runs a command to print it.
 */
export class SettingsService {
  constructor(
    private readonly config: ForgeConfig,
    private readonly store: PlanStore,
  ) {}

  private get keyFile(): string {
    return join(this.config.home, "anthropic-api-key");
  }

  private stored(): SettingsPatch {
    const parsed = settingsPatch.safeParse(this.store.getSetting(KEY) ?? {});
    return parsed.success ? parsed.data : {};
  }

  get(): EffectiveSettings {
    const s = this.stored();
    const key = existsSync(this.keyFile) ? readFileSync(this.keyFile, "utf8").trim() : "";
    return {
      maxConcurrency: s.maxConcurrency ?? this.config.maxConcurrency,
      usagePausePercent: s.usagePausePercent ?? this.config.usagePausePercent,
      auth: s.auth === "api_key" && key ? "api_key" : "subscription",
      apiKey: { configured: Boolean(key), last4: key ? key.slice(-4) : null },
      editorCommand: s.editorCommand ?? "code",
      fileManagerCommand: s.fileManagerCommand ?? "xdg-open",
    };
  }

  update(patch: SettingsPatch): EffectiveSettings {
    if (patch.auth === "api_key" && !existsSync(this.keyFile)) throw new SettingsError("Save an API key before switching to it");
    this.store.setSetting(KEY, { ...this.stored(), ...patch });
    this.store.recordEvent("queue", "global", "settings_changed", { ...patch });
    return this.get();
  }

  saveApiKey(key: string): EffectiveSettings {
    writeFileSync(this.keyFile, key, { mode: 0o600 });
    // The event says that a key was saved, never which one.
    this.store.recordEvent("queue", "global", "api_key_saved", { last4: key.slice(-4) });
    return this.get();
  }

  removeApiKey(): EffectiveSettings {
    if (this.get().auth === "api_key") throw new SettingsError("Switch back to the subscription before removing the key in use");
    rmSync(this.keyFile, { force: true });
    this.store.recordEvent("queue", "global", "api_key_removed", {});
    return this.get();
  }

  /** The `apiKeyHelper` command for session settings, or null to use the subscription login. */
  apiKeyHelper(): string | null {
    return this.get().auth === "api_key" ? `cat ${shellQuote(this.keyFile)}` : null;
  }
}
