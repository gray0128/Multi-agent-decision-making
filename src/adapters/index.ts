import { MadError } from "../core/errors.js";
import type { CliConfig, InvocationPreset } from "./config.js";
import { CodexAdapter } from "./codex.js";
import { GenericCliAdapter } from "./generic.js";
import type { CliAdapter } from "./types.js";

export function createAdapter(cli: CliConfig, preset: InvocationPreset): CliAdapter {
  switch (cli.adapter) {
    case "codex":
      return new CodexAdapter(cli, preset);
    case "claude":
    case "reasonix":
    case "grok":
    case "pi":
    case "codebuddy":
    case "agy":
      return new GenericCliAdapter(cli, preset);
    default:
      throw new MadError("CONFIG", `尚未实现适配器：${String(cli.adapter)}`);
  }
}

export * from "./config.js";
export type * from "./types.js";
