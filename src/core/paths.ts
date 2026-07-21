import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
