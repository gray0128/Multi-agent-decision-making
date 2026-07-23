import { spawn } from "node:child_process";
import type { AppPaths } from "../core/paths.js";
import { startObserverServer, type ObserverServer } from "./observer.js";

export interface ObserverPageLaunch {
  readonly observer: ObserverServer;
  readonly browserError?: Error;
}

interface LaunchDependencies {
  readonly start?: typeof startObserverServer;
  readonly open?: (url: string) => Promise<void>;
}

export async function openBrowser(url: string, platform = process.platform): Promise<void> {
  const [command, args] = platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export async function launchObserverPage(
  paths: AppPaths,
  port = 0,
  dependencies: LaunchDependencies = {},
): Promise<ObserverPageLaunch> {
  const observer = await (dependencies.start ?? startObserverServer)(paths, port);
  try {
    await (dependencies.open ?? openBrowser)(observer.url);
    return { observer };
  } catch (error) {
    return { observer, browserError: error instanceof Error ? error : new Error(String(error)) };
  }
}
