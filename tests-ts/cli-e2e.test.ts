import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appPaths } from "../src/core/paths.js";
import { startObserverServer } from "../src/server/observer.js";
import { ActiveDeliberationLock } from "../src/archive/store.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "src", "cli", "index.ts");
const fake = join(root, "tests-ts", "fixtures", "fake-codex.sh");

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
    const executable = join(home, "fake-codex.sh");
    await copyFile(fake, executable);
    await chmod(executable, 0o755);
    const config = join(home, "config", "clis.toml");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, `[defaults.generator]\ncli = "codex"\npreset = "test"\n\n[[clis]]\nid = "codex"\nadapter = "codex"\nexecutable = "${executable}"\ntimeout_seconds = 30\nmax_concurrency = 1\n\n[[clis.presets]]\nid = "test"\nmodel = "fake-model"\ncontext_budget = 64000\n`);
  }

  it("stores a PATH-resolved command name in the initialized CLI registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-init-"));
    const bin = join(home, "bin");
    const executable = join(bin, "codex");
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\necho 'codex-cli test'\n");
    await chmod(executable, 0o755);

    const result = await command(home, ["init"], { PATH: bin });

    expect(result.code, result.stderr).toBe(0);
    const registry = await readFile(join(home, "config", "clis.toml"), "utf8");
    expect(registry).toContain('executable = "codex"');
    expect(registry).not.toContain(executable);
  });

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
      "--global-concurrency", "2",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const machine = JSON.parse(result.stdout) as {
      status: string;
      mode: string;
      report: string;
      archive_path: string;
      warnings: string[];
      budget_usage: { timeout_seconds: number; context_budget: number; global_concurrency: number };
    };
    expect(machine).toMatchObject({ status: "completed", mode });
    expect(machine.report).toContain("最终共同成果");
    expect(machine.warnings).toEqual([expect.stringContaining("独立模型交叉验证")]);
    expect(machine.budget_usage).toMatchObject({ timeout_seconds: 30, context_budget: 64_000, global_concurrency: 2 });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("来源约束：");
    expect(result.stderr).toContain("审议档案：");
    expect(await readFile(join(machine.archive_path, "report.md"), "utf8")).toBe(machine.report);
    expect((await readFile(join(machine.archive_path, "state.json"), "utf8"))).toContain('"status": "completed"');
  }, 45_000);

  it("uses the explicit workspace for probe and every project invocation", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-workspace-"));
    const workspace = await mkdtemp(join(tmpdir(), "mad-explicit-workspace-"));
    const cwdLog = join(home, "cwd-log");
    await configure(home);
    const result = await command(home, [
      "deliberate", "检查工作目录", "--workspace", workspace, "--auto", "--auto-confirm-plan", "--format", "json",
    ], { FAKE_CODEX_CWD_LOG: cwdLog });
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(cwdLog, "utf8")).toBe(await realpath(workspace));
    expect(result.stderr.match(/^警告：/gm)).toHaveLength(2);
    expect(result.stderr).toContain("完整目录只读授权");
    expect(result.stderr).toContain("来源约束：");
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
    expect(resumed.stderr).toContain("来源约束：");
    const machine = JSON.parse(resumed.stdout) as { status: string; report: string };
    expect(machine.status).toBe("completed");
    expect(machine.report).toContain("最终共同成果");
  }, 20_000);

  it("acquires the global lock before resume preflight invokes a CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-resume-lock-"));
    await configure(home);
    const failureCounter = join(home, "failure-counter");
    const first = await command(home, [
      "deliberate", "锁前预检", "--auto", "--auto-confirm-plan", "--format", "json",
    ], { FAKE_CODEX_FAILURE_COUNTER: failureCounter });
    expect(first.code).toBe(30);
    const [id] = await readdir(join(home, "deliberations"));
    const invocationCounter = join(home, "invocation-counter");
    await writeFile(invocationCounter, "0");
    const lock = new ActiveDeliberationLock(join(home, "runtime", "active.lock"));
    await lock.acquire("other-deliberation");
    try {
      const resumed = await command(home, ["resume", id!], { FAKE_CODEX_INVOCATION_COUNTER: invocationCounter });
      expect(resumed.code).toBe(5);
      expect(await readFile(invocationCounter, "utf8")).toBe("0");
    } finally {
      await lock.release();
    }
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
      let authorization = { Authorization: `Bearer ${observer.token}` };
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

  it("requires a version-bound web plan confirmation before automatic execution", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-web-plan-"));
    await configure(home);
    const observer = await startObserverServer(appPaths(home));
    try {
      const id = "web-plan-1";
      const child = spawn(process.execPath, [
        "--import", "tsx", cli, "deliberate", "网页确认方案", "--auto", "--web-plan", "--id", id, "--format", "json",
      ], {
        cwd: root,
        env: { ...process.env, MAD_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const authorization = { Authorization: `Bearer ${observer.token}` };
      type PlanCheckpoint = {
        checkpointId: string;
        data: {
          generation: number;
          candidateVersion: number;
          validationError?: string;
          candidatePlan: { participants: Array<{ id: string; cli: string; preset: string; role: string }> };
        };
      };
      let checkpoint: PlanCheckpoint | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
          if (response.ok) {
            const data = await response.json() as { checkpoint?: typeof checkpoint };
            if (data.checkpoint?.data?.candidatePlan) { checkpoint = data.checkpoint; break; }
          }
        } catch { /* archive is still initializing */ }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(checkpoint).toBeTruthy();
      const stale = await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId: checkpoint!.checkpointId, action: "confirm", candidateVersion: 99 }),
      });
      expect(stale.status).toBe(409);
      const invalidPlan = {
        ...checkpoint!.data.candidatePlan,
        participants: checkpoint!.data.candidatePlan.participants.map((agent, index) => ({
          ...agent,
          role: index === 0 ? "" : agent.role,
        })),
      };
      expect((await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: checkpoint!.checkpointId,
          action: "replace",
          candidateVersion: checkpoint!.data.candidateVersion,
          data: invalidPlan,
        }),
      })).status).toBe(202);
      let retryCheckpoint: PlanCheckpoint | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
        const data = await response.json() as { checkpoint?: PlanCheckpoint };
        if (data.checkpoint && data.checkpoint.checkpointId !== checkpoint!.checkpointId) { retryCheckpoint = data.checkpoint; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(retryCheckpoint?.data.candidateVersion).toBe(checkpoint!.data.candidateVersion);
      expect(retryCheckpoint?.data.validationError).toMatch(/role/);
      checkpoint = retryCheckpoint;
      const replacement = {
        ...checkpoint!.data.candidatePlan,
        participants: checkpoint!.data.candidatePlan.participants.map((agent, index) => ({
          ...agent,
          role: index === 0 ? "网页修改后的角色" : agent.role,
        })),
      };
      const validated = await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: checkpoint!.checkpointId,
          action: "replace",
          candidateVersion: checkpoint!.data.candidateVersion,
          data: replacement,
        }),
      });
      expect(validated.status).toBe(202);
      let revised: PlanCheckpoint | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
        const data = await response.json() as { checkpoint?: PlanCheckpoint };
        if (data.checkpoint && data.checkpoint.checkpointId !== checkpoint!.checkpointId) { revised = data.checkpoint; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(revised?.data.candidateVersion).toBe(checkpoint!.data.candidateVersion + 1);
      expect(revised?.data.candidatePlan.participants[0]?.role).toBe("网页修改后的角色");
      const regroupedResponse = await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: revised!.checkpointId,
          action: "regroup",
          candidateVersion: revised!.data.candidateVersion,
          guidance: "重新关注交付风险",
        }),
      });
      expect(regroupedResponse.status).toBe(202);
      let regrouped: PlanCheckpoint | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
        const data = await response.json() as { checkpoint?: PlanCheckpoint };
        if (data.checkpoint && data.checkpoint.checkpointId !== revised!.checkpointId) { regrouped = data.checkpoint; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(regrouped?.data.generation).toBe(revised!.data.generation + 1);
      expect(regrouped?.data.candidateVersion).toBe(0);
      const accepted = await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: regrouped!.checkpointId,
          action: "confirm",
          candidateVersion: regrouped!.data.candidateVersion,
        }),
      });
      expect(accepted.status).toBe(202);
      const code = await new Promise<number>((resolveCode, reject) => {
        child.once("error", reject);
        child.once("close", (value) => resolveCode(value ?? -1));
      });
      expect(code, Buffer.concat(stderr).toString("utf8")).toBe(0);
      expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toMatchObject({ status: "completed" });
      expect(await readFile(join(home, "deliberations", id, "manifest.json"), "utf8")).toContain('"planConfirmation": "interactive"');
      expect(await readFile(join(home, "deliberations", id, "events.jsonl"), "utf8")).toContain('"plan.regrouped"');
    } finally {
      await observer.close();
    }
  }, 20_000);

  it("cancels a web planning checkpoint while preserving its archive and releasing the lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-web-cancel-"));
    await configure(home);
    let observer = await startObserverServer(appPaths(home));
    const id = "web-cancel-1";
    try {
      const child = spawn(process.execPath, [
        "--import", "tsx", cli, "deliberate", "取消网页规划", "--auto", "--web-plan", "--id", id,
      ], {
        cwd: root,
        env: { ...process.env, MAD_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let authorization = { Authorization: `Bearer ${observer.token}` };
      let checkpoint: { checkpointId: string; data: { candidateVersion: number } } | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
        if (response.ok) {
          const data = await response.json() as { checkpoint?: typeof checkpoint };
          if (data.checkpoint) { checkpoint = data.checkpoint; break; }
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(checkpoint).toBeTruthy();
      await observer.close();
      observer = await startObserverServer(appPaths(home));
      authorization = { Authorization: `Bearer ${observer.token}` };
      const recovered = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
      expect((await recovered.json() as { checkpoint: { checkpointId: string } }).checkpoint.checkpointId).toBe(checkpoint!.checkpointId);
      expect((await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: checkpoint!.checkpointId,
          action: "cancel",
          candidateVersion: checkpoint!.data.candidateVersion,
        }),
      })).status).toBe(202);
      const code = await new Promise<number>((resolveCode, reject) => {
        child.once("error", reject);
        child.once("close", (value) => resolveCode(value ?? -1));
      });
      expect(code).toBe(21);
      expect(await readFile(join(home, "deliberations", id, "state.json"), "utf8")).toContain('"status": "cancelled"');
      await expect(readFile(join(home, "runtime", "active.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await observer.close();
    }
  }, 20_000);

  it("pauses a web planning checkpoint on Ctrl-C and releases the active lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-web-pause-"));
    await configure(home);
    const observer = await startObserverServer(appPaths(home));
    const id = "web-pause-1";
    const child = spawn(process.execPath, [
      "--import", "tsx", cli, "deliberate", "暂停网页规划", "--auto", "--web-plan", "--id", id,
    ], {
      cwd: root,
      env: { ...process.env, MAD_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      const authorization = { Authorization: `Bearer ${observer.token}` };
      let checkpointReady = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
        if (response.ok) {
          const data = await response.json() as { checkpoint?: { kind?: string } };
          if (data.checkpoint?.kind === "plan_confirmation") { checkpointReady = true; break; }
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(checkpointReady).toBe(true);
      child.kill("SIGINT");
      const code = await Promise.race([
        new Promise<number>((resolveCode, reject) => {
          child.once("error", reject);
          child.once("close", (value) => resolveCode(value ?? -1));
        }),
        new Promise<number>((resolveCode) => setTimeout(() => resolveCode(-999), 2_000)),
      ]);
      if (code === -999) child.kill("SIGKILL");
      expect(code, Buffer.concat(stderr).toString("utf8")).toBe(20);
      expect(await readFile(join(home, "deliberations", id, "state.json"), "utf8")).toContain('"status": "paused"');
      await expect(readFile(join(home, "runtime", "active.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const resumed = spawn(process.execPath, ["--import", "tsx", cli, "resume", id, "--format", "json"], {
        cwd: root,
        env: { ...process.env, MAD_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resumedStdout: Buffer[] = [];
      const resumedStderr: Buffer[] = [];
      resumed.stdout.on("data", (chunk: Buffer) => resumedStdout.push(chunk));
      resumed.stderr.on("data", (chunk: Buffer) => resumedStderr.push(chunk));
      let resumedCheckpoint: { checkpointId: string; data: { candidateVersion: number } } | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/${id}`, { headers: authorization });
        if (response.ok) {
          const data = await response.json() as { checkpoint?: typeof resumedCheckpoint };
          if (data.checkpoint?.data) { resumedCheckpoint = data.checkpoint; break; }
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(resumedCheckpoint).toBeTruthy();
      expect((await fetch(`http://127.0.0.1:${observer.port}/api/checkpoints/${id}/respond`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: resumedCheckpoint!.checkpointId,
          action: "confirm",
          candidateVersion: resumedCheckpoint!.data.candidateVersion,
        }),
      })).status).toBe(202);
      const resumedCode = await new Promise<number>((resolveCode, reject) => {
        resumed.once("error", reject);
        resumed.once("close", (value) => resolveCode(value ?? -1));
      });
      expect(resumedCode, Buffer.concat(resumedStderr).toString("utf8")).toBe(0);
      expect(JSON.parse(Buffer.concat(resumedStdout).toString("utf8"))).toMatchObject({ status: "completed" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await observer.close();
    }
  }, 20_000);

  it("launches a detached planning process from the authenticated console HTTP boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-console-launch-"));
    await configure(home);
    const browserBin = join(home, "browser-bin");
    await mkdir(browserBin);
    for (const commandName of ["open", "xdg-open"]) {
      const executable = join(browserBin, commandName);
      await writeFile(executable, "#!/bin/sh\nexit 1\n");
      await chmod(executable, 0o755);
    }
    const server = spawn(process.execPath, ["--import", "tsx", cli, "serve"], {
      cwd: root,
      env: { ...process.env, MAD_HOME: home, PATH: `${browserBin}:/bin:/usr/bin` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    let resolveAddress!: (value: { origin: string; token: string }) => void;
    const address = new Promise<{ origin: string; token: string }>((resolveAddressPromise) => { resolveAddress = resolveAddressPromise; });
    server.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      const text = Buffer.concat(stderr).toString("utf8");
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([^\s]+)/.exec(text);
      if (match) resolveAddress({ origin: match[1]!, token: decodeURIComponent(match[2]!) });
    });
    try {
      const { origin, token } = await address;
      const authorization = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const launched = await fetch(`${origin}/api/launches`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({
          requestId: "console-e2e-request",
          topic: "--auto",
          mode: "structured",
          interaction: "auto",
        }),
      });
      expect([201, 202]).toContain(launched.status);
      const record = await launched.json() as { deliberationId: string };
      let checkpoint: { checkpointId: string; data: { candidateVersion: number } } | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await fetch(`${origin}/api/deliberations/${record.deliberationId}`, { headers: authorization });
        if (response.ok) {
          const data = await response.json() as { checkpoint?: typeof checkpoint };
          if (data.checkpoint) { checkpoint = data.checkpoint; break; }
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(checkpoint).toBeTruthy();
      expect((await fetch(`${origin}/api/checkpoints/${record.deliberationId}/respond`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({
          checkpointId: checkpoint!.checkpointId,
          action: "confirm",
          candidateVersion: checkpoint!.data.candidateVersion,
        }),
      })).status).toBe(202);
      let completed = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const response = await fetch(`${origin}/api/deliberations/${record.deliberationId}`, { headers: authorization });
        const data = await response.json() as { state: { status: string } };
        if (data.state.status === "completed") { completed = true; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(completed).toBe(true);
      expect(await readFile(join(home, "runtime", "launches", "console-e2e-request.json"), "utf8")).toContain(record.deliberationId);
    } finally {
      server.kill("SIGTERM");
      await new Promise<void>((resolveClosed) => server.once("close", () => resolveClosed()));
    }
  }, 30_000);

  it("treats the first Ctrl-C as a recoverable pause and terminates the active CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-cli-interrupt-"));
    await configure(home);
    const child = spawn(process.execPath, [
      "--import", "tsx", cli, "deliberate", "中断恢复", "--auto", "--auto-confirm-plan", "--format", "json",
    ], {
      cwd: root,
      env: { ...process.env, MAD_HOME: home, FAKE_CODEX_PLANNING_DELAY_MS: "5000" },
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
    const planningManifest = JSON.parse(await readFile(join(home, "deliberations", id!, "manifest.json"), "utf8")) as { plan?: unknown; planning?: unknown };
    expect(planningManifest.plan).toBeUndefined();
    expect(planningManifest.planning).toBeTruthy();

    const resumed = await command(home, ["resume", id!, "--format", "json"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "completed" });
  }, 20_000);
});
