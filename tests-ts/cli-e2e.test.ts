import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appPaths } from "../src/core/paths.js";
import { startObserverServer } from "../src/server/observer.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "src", "cli", "index.ts");
const fake = join(root, "tests-ts", "fixtures", "fake-codex.mjs");

async function command(home: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    env: { ...process.env, MAD_HOME: home, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolveCode(value ?? -1));
  });
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("mad CLI end to end", () => {
  async function configure(home: string): Promise<void> {
    await chmod(fake, 0o755);
    const config = join(home, "config", "clis.toml");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, `[defaults.generator]\ncli = "codex"\npreset = "test"\n\n[[clis]]\nid = "codex"\nadapter = "codex"\nexecutable = "${fake}"\ntimeout_seconds = 10\nmax_concurrency = 1\n\n[[clis.presets]]\nid = "test"\nmodel = "fake-model"\ncontext_budget = 64000\n`);
  }

  it("rejects recursive deliberation from a participant process", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-recursive-"));
    await configure(home);
    const result = await command(home, ["deliberate", "递归调用", "--auto", "--auto-confirm-plan"], { MAD_PARTICIPANT: "1" });
    expect(result.code).toBe(30);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("禁止从参与者进程递归调用 mad");
  });

  it.each(["structured", "free"] as const)("runs an auto-confirmed %s deliberation with clean JSON stdout", async (mode) => {
    const home = await mkdtemp(join(tmpdir(), `mad-cli-${mode}-`));
    await configure(home);
    const result = await command(home, [
      "deliberate", "验证新架构", "--mode", mode, "--auto", "--auto-confirm-plan", "--format", "json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const machine = JSON.parse(result.stdout) as {
      status: string;
      mode: string;
      report: string;
      archive_path: string;
      warnings: string[];
      budget_usage: { timeout_seconds: number; context_budget: number };
    };
    expect(machine).toMatchObject({ status: "completed", mode });
    expect(machine.report).toContain("最终共同成果");
    expect(machine.warnings).toEqual([expect.stringContaining("独立模型交叉验证")]);
    expect(machine.budget_usage).toMatchObject({ timeout_seconds: 10, context_budget: 64_000 });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("审议档案：");
    expect(await readFile(join(machine.archive_path, "report.md"), "utf8")).toBe(machine.report);
    expect((await readFile(join(machine.archive_path, "state.json"), "utf8"))).toContain('"status": "completed"');
  }, 20_000);

  it("resumes only unfinished logical calls after a double invocation failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-resume-"));
    await configure(home);
    const counter = join(home, "failure-counter");
    const first = await command(home, [
      "deliberate", "验证恢复", "--mode", "structured", "--auto", "--auto-confirm-plan", "--format", "json",
    ], { FAKE_CODEX_FAILURE_COUNTER: counter });
    expect(first.code).toBe(30);
    expect(first.stdout).toBe("");
    const ids = await readdir(join(home, "deliberations"));
    expect(ids).toHaveLength(1);
    const archive = join(home, "deliberations", ids[0]!);
    expect(await readFile(join(archive, "state.json"), "utf8")).toContain('"status": "paused"');
    expect(await readFile(join(archive, "manifest.json"), "utf8")).toContain('"model": "fake-model"');
    await writeFile(join(home, "config", "clis.toml"), "broken = true\n");

    const resumed = await command(home, ["resume", ids[0]!, "--format", "json"], { FAKE_CODEX_FAILURE_COUNTER: counter });
    expect(resumed.code, resumed.stderr).toBe(0);
    const machine = JSON.parse(resumed.stdout) as { status: string; report: string };
    expect(machine.status).toBe("completed");
    expect(machine.report).toContain("最终共同成果");
  }, 20_000);

  it("runs guided checkpoints through the observer service without a TTY", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-observer-guided-"));
    await configure(home);
    const observer = await startObserverServer(appPaths(home));
    try {
      const child = spawn(process.execPath, [
        "--import", "tsx", cli, "deliberate", "观察服务引导", "--auto-confirm-plan", "--format", "json",
      ], {
        cwd: root,
        env: { ...process.env, MAD_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      let exited = false;
      const closed = new Promise<number>((resolveCode, reject) => {
        child.once("error", reject);
        child.once("close", (code) => { exited = true; resolveCode(code ?? -1); });
      });
      const answered = new Set<string>();
      const authorization = { Authorization: `Bearer ${observer.token}` };
      while (!exited) {
        const listing = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations`, { headers: authorization });
        const records = await listing.json() as Array<{ id: string }>;
        if (records[0]) {
          const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${records[0].id}`, { headers: authorization });
          const data = await response.json() as { checkpoint?: { checkpointId: string } | null };
          const checkpointId = data.checkpoint?.checkpointId;
          if (checkpointId && !answered.has(checkpointId)) {
            answered.add(checkpointId);
            await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${records[0].id}/respond`, {
              method: "POST",
              headers: { ...authorization, "Content-Type": "application/json" },
              body: JSON.stringify({ checkpointId, action: "continue" }),
            });
          }
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      }
      const code = await closed;
      expect(code, Buffer.concat(stderr).toString("utf8")).toBe(0);
      expect(answered.size).toBe(4);
      expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toMatchObject({ status: "completed" });
    } finally {
      await observer.close();
    }
  }, 20_000);

  it("treats the first Ctrl-C as a recoverable pause and terminates the active CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-interrupt-"));
    await configure(home);
    const child = spawn(process.execPath, [
      "--import", "tsx", cli, "deliberate", "中断恢复", "--auto", "--auto-confirm-plan", "--format", "json",
    ], {
      cwd: root,
      env: { ...process.env, MAD_HOME: home, FAKE_CODEX_DELAY_MS: "5000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let interrupted = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (!interrupted && Buffer.concat(stderr).toString("utf8").includes("审议已创建：")) {
        interrupted = true;
        setTimeout(() => child.kill("SIGINT"), 50);
      }
    });
    const code = await new Promise<number>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolveCode(value ?? -1));
    });
    expect(code, Buffer.concat(stderr).toString("utf8")).toBe(20);
    expect(Buffer.concat(stdout).toString("utf8")).toBe("");
    const [id] = await readdir(join(home, "deliberations"));
    expect(await readFile(join(home, "deliberations", id!, "state.json"), "utf8")).toContain('"status": "paused"');

    const resumed = await command(home, ["resume", id!, "--format", "json"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "completed" });
  }, 20_000);
});
