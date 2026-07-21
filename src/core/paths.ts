import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MadError } from "./errors.js";

export const DELIBERATION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export function assertDeliberationId(id: string): string {
  if (!DELIBERATION_ID_PATTERN.test(id)) throw new MadError("USAGE", `无效的审议 ID：${id}`);
  return id;
}

export interface AppPaths {
  readonly home: string;
  readonly config: string;
  readonly deliberations: string;
  readonly runtime: string;
}

export function resolveAppHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.MAD_HOME?.trim();
  if (override) return resolve(override);
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "MultiAgentDecisionTS");
  }
  const dataHome = environment.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "multi-agent-decision-ts");
}

export function appPaths(home = resolveAppHome()): AppPaths {
  return {
    home,
    config: join(home, "config", "clis.toml"),
    deliberations: join(home, "deliberations"),
    runtime: join(home, "runtime"),
  };
}
