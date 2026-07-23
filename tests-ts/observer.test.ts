import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveStore } from "../src/archive/store.js";
import { appPaths } from "../src/core/paths.js";
import type { DeliberationManifest } from "../src/core/types.js";
import { startObserverServer } from "../src/server/observer.js";
import { observerIsOnline } from "../src/server/mailbox.js";
import { launchObserverPage } from "../src/server/launch.js";
import { APP_JS, INDEX_HTML, STYLES_CSS, WEB_ASSET_VERSION } from "../src/web/index.js";

interface ObserverUiTestApi {
  transcriptHtml(records: unknown[]): string;
  timelineHtml(data: Record<string, unknown>): string;
  outcomeHtml(data: Record<string, unknown>): string;
  appendStreamEvent(event: Record<string, unknown>): void;
  navigateTimelineTarget(targetId: string): void;
  refreshTranscript(id: string): Promise<void>;
  setArchiveState(id: string, data: Record<string, unknown>): void;
}

function loadObserverUiTestApi(
  documentOverrides: Record<string, unknown> = {},
  browserOverrides: { fetch?: (...args: unknown[]) => Promise<unknown> } = {},
): ObserverUiTestApi {
  const testApi: Partial<ObserverUiTestApi> = {};
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  };
  const document = {
    querySelector: () => null,
    getElementById: () => null,
    ...documentOverrides,
  };
  const browserGlobal = { __MAD_OBSERVER_TEST__: testApi };
  const evaluate = new Function(
    "document", "location", "sessionStorage", "localStorage", "history", "window",
    "requestAnimationFrame", "getComputedStyle", "fetch", "navigator", "globalThis", APP_JS,
  );
  evaluate(
    document,
    { hash: "", pathname: "/" },
    storage(),
    storage(),
    { replaceState: () => undefined },
    {},
    (callback: () => void) => callback(),
    () => ({ display: "block" }),
    browserOverrides.fetch ?? (() => Promise.reject(new Error("unexpected fetch"))),
    { clipboard: { writeText: () => Promise.resolve() } },
    browserGlobal,
  );
  return testApi as ObserverUiTestApi;
}

describe("authenticated observer service", () => {
  it("serves browser JavaScript that parses successfully", () => {
    expect(() => new Function(APP_JS)).not.toThrow();
  });

  it("ships the compact archive layout and table treatment", () => {
    expect(WEB_ASSET_VERSION).toBe(2);
    expect(INDEX_HTML).toContain('id="toggle-index"');
    expect(STYLES_CSS).toContain("--content-size:15px");
    expect(STYLES_CSS).toContain(".archive-layout");
    expect(STYLES_CSS).toContain(".anchor-rail");
    expect(STYLES_CSS).toContain(".table-scroll");
    expect(STYLES_CSS).toContain("position:sticky");
  });

  it("renders body and programmatic output as distinct structures", () => {
    const ui = loadObserverUiTestApi();
    const html = ui.transcriptHtml([
      { id: "body-1", stage: "independent", agentId: "analyst", at: "2026-07-23T10:00:00Z", contentHtml: "<p>正文</p>" },
      { id: "flow-1", stage: "planning", agentId: "planner", at: "2026-07-23T10:01:00Z", contentHtml: "<pre>流程</pre>" },
    ]);

    expect(html).toContain('id="output-body-1" class="transcript-entry body-output"');
    expect(html).toContain('id="output-flow-1" class="transcript-entry process-output"');
    expect(html).toContain('<details class="process-details">');
    expect(html).toContain("正文 · 独立陈述");
    expect(html).toContain("流程 · 候选方案规划");
  });

  it("keeps report drafts and reviews expanded and visible in the default timeline", () => {
    const ui = loadObserverUiTestApi();
    const records = [
      { id: "draft-1", stage: "report_draft", agentId: "reporter", at: "2026-07-23T10:02:00Z", contentHtml: "<p>成果草稿</p>" },
      { id: "review-1", stage: "review", agentId: "reviewer", at: "2026-07-23T10:03:00Z", contentHtml: "<p>审核意见</p>" },
    ];

    const transcriptHtml = ui.transcriptHtml(records);
    expect(transcriptHtml).toContain('id="output-draft-1" class="transcript-entry body-output"');
    expect(transcriptHtml).toContain('id="output-review-1" class="transcript-entry body-output"');
    expect(transcriptHtml).not.toContain("查看程序化内容");

    const timelineHtml = ui.timelineHtml({
      manifest: { createdAt: "2026-07-23T10:00:00Z" },
      state: {}, checkpoint: null, report: "", transcript: records, events: [],
    });
    expect(timelineHtml).toContain('class="timeline-item " href="#archive=&amp;anchor=output-draft-1"');
    expect(timelineHtml).toContain('class="timeline-item " href="#archive=&amp;anchor=output-review-1"');
    expect(timelineHtml).toContain("成果草稿");
    expect(timelineHtml).toContain("成果审核");
  });

  it("renders timeline anchors and binds a streamed event for navigation", () => {
    let insertedEvent = "";
    let insertedTimeline = "";
    let scrolled = false;
    const processLog = { open: false };
    const target = {
      closest: () => processLog,
      scrollIntoView: () => { scrolled = true; },
    };
    const streamedLink: { dataset: { target: string }; onclick?: (event: { preventDefault(): void }) => void } = {
      dataset: { target: "event-stream-1" },
    };
    const events = { insertAdjacentHTML: (_position: string, html: string) => { insertedEvent = html; } };
    const timeline = {
      lastElementChild: streamedLink,
      insertAdjacentHTML: (_position: string, html: string) => { insertedTimeline = html; },
    };
    const rail = { classList: { remove: () => undefined } };
    const ui = loadObserverUiTestApi({
      querySelector: (selector: string) => ({ "#events": events, ".timeline-list": timeline, ".anchor-rail": rail }[selector] ?? null),
      getElementById: (id: string) => id === "event-stream-1" ? target : null,
    });

    const timelineHtml = ui.timelineHtml({
      manifest: { createdAt: "2026-07-23T10:00:00Z" },
      state: {}, checkpoint: null, report: "",
      transcript: [{ id: "body-1", stage: "independent", agentId: "analyst", at: "2026-07-23T10:01:00Z" }],
      events: [{ id: "old-1", type: "round.started", at: "2026-07-23T10:02:00Z" }],
    });
    expect(timelineHtml).toContain('data-target="output-body-1"');
    expect(timelineHtml).toContain('data-target="event-old-1"');

    ui.appendStreamEvent({ id: "stream-1", type: "round.completed", at: "2026-07-23T10:03:00Z" });
    expect(insertedEvent).toContain('id="event-stream-1"');
    expect(insertedTimeline).toContain('data-target="event-stream-1"');
    expect(streamedLink.onclick).toBeTypeOf("function");
    streamedLink.onclick?.({ preventDefault: () => undefined });
    expect(processLog.open).toBe(true);
    expect(scrolled).toBe(true);
  });

  it("merges events received during a transcript refresh and rejects stale archive writes", async () => {
    const transcript = { innerHTML: "" };
    const events = { innerHTML: "" };
    const detail = { querySelector: () => null, querySelectorAll: () => [] };
    let resolveSecond: ((response: unknown) => void) | undefined;
    const snapshots = [
      Promise.resolve({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          manifest: { createdAt: "2026-07-23T10:00:00Z" }, state: {}, checkpoint: null, report: "",
          transcript: [], events: [{ id: "snapshot-1", type: "snapshot", at: "2026-07-23T10:01:00Z" }],
        }),
      }),
      new Promise(resolve => { resolveSecond = resolve; }),
    ];
    const ui = loadObserverUiTestApi({
      querySelector: (selector: string) => ({ "#detail": detail, "#transcript": transcript, "#events": events }[selector] ?? null),
    }, { fetch: async () => snapshots.shift()! });
    ui.setArchiveState("archive-a", {
      events: [{ id: "live-1", type: "live", at: "2026-07-23T10:02:00Z" }],
    });

    await ui.refreshTranscript("archive-a");
    expect(events.innerHTML).toContain("snapshot");
    expect(events.innerHTML).toContain("live");

    const staleRefresh = ui.refreshTranscript("archive-a");
    ui.setArchiveState("archive-b", { events: [] });
    resolveSecond?.({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        manifest: { createdAt: "2026-07-23T10:00:00Z" }, state: {}, checkpoint: null, report: "",
        transcript: [], events: [{ id: "stale-1", type: "stale", at: "2026-07-23T10:03:00Z" }],
      }),
    });
    await staleRefresh;
    expect(events.innerHTML).not.toContain("stale");
  });

  it("omits the outcome section when the archive has no report", () => {
    const ui = loadObserverUiTestApi();
    expect(ui.outcomeHtml({ report: "", reportHtml: "" })).toBe("");
    expect(ui.outcomeHtml({ report: "# 结论", reportHtml: "<h1>结论</h1>" })).toContain('id="outcome"');
  });

  it("opens the authenticated observer URL after starting the service", async () => {
    const opened: string[] = [];
    const observer = {
      token: "secret",
      port: 4321,
      url: "http://127.0.0.1:4321/#token=secret",
      close: async () => undefined,
    };

    const launched = await launchObserverPage(appPaths("/tmp/mad-observer-launch-test"), 0, {
      start: async () => observer,
      open: async (url) => { opened.push(url); },
    });

    expect(launched.observer).toBe(observer);
    expect(launched.browserError).toBeUndefined();
    expect(opened).toEqual([observer.url]);
  });

  it("renders structured event details instead of dropping them", () => {
    expect(APP_JS).toContain("durationMs");
    expect(APP_JS).toContain("logicalCallId");
    expect(APP_JS).toContain("d.message");
  });

  it("extracts messages from JSON API errors", () => {
    expect(APP_JS).toContain("content-type");
    expect(APP_JS).toContain("payload.message||payload.error||payload.code");
  });

  it("distinguishes a rejected plan edit from the last valid candidate", () => {
    expect(APP_JS).toContain("本次修改未通过校验；上一版候选方案仍有效。");
  });

  it("exposes authenticated safe launch options and the three-step entry", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-launch-options-"));
    const paths = appPaths(home);
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(join(paths.runtime, "active.lock"), JSON.stringify({
      deliberationId: "active-1",
      pid: process.pid,
    }));
    const observer = await startObserverServer(paths, 0, {
      loadRegistry: async () => ({
        defaults: { generator: { cli: "codex", preset: "deep" } },
        clis: [{
          id: "codex",
          adapter: "codex",
          executable: "/secret/bin/codex",
          timeoutSeconds: 300,
          maxConcurrency: 2,
          presets: [{
            id: "deep",
            model: "gpt-safe",
            contextBudget: 64_000,
            options: { reasoningEffort: "high" },
          }],
        }],
      }),
      checkInvocation: async () => ({ ready: false, detail: "token=super-secret unavailable" }),
    });
    try {
      const endpoint = `http://127.0.0.1:${observer.port}/api/launch-options`;
      expect((await fetch(endpoint)).status).toBe(401);
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${observer.token}` } });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("/secret/bin/codex");
      expect(text).not.toContain("super-secret");
      expect(JSON.parse(text)).toMatchObject({
        defaults: { mode: "structured", interaction: "guided", organizer: { cli: "codex", preset: "deep" } },
        clis: [{ id: "codex", presets: [{ id: "deep", model: "gpt-safe", available: false }] }],
        activeDeliberation: { id: "active-1" },
        canLaunch: false,
      });
      expect(APP_JS).toContain("launch-deliberation");
      expect(APP_JS).toContain("wizard-steps");
    } finally {
      await observer.close();
    }
  });

  it("reports an in-flight launch as active before the CLI acquires its lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-launch-pending-options-"));
    const paths = appPaths(home);
    await mkdir(join(paths.runtime, "launches"), { recursive: true });
    await writeFile(join(paths.runtime, "launches", "pending-request.json"), JSON.stringify({
      requestId: "pending-request",
      deliberationId: "pending-deliberation",
      status: "spawned",
      createdAt: new Date().toISOString(),
    }));
    const observer = await startObserverServer(paths, 0, {
      loadRegistry: async () => ({
        defaults: { generator: { cli: "codex", preset: "deep" } },
        clis: [{
          id: "codex", adapter: "codex", executable: "codex", timeoutSeconds: 300, maxConcurrency: 1,
          presets: [{ id: "deep", model: "gpt-safe", contextBudget: 64_000, options: {} }],
        }],
      }),
      checkInvocation: async () => ({ ready: true }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${observer.port}/api/launch-options`, {
        headers: { Authorization: `Bearer ${observer.token}` },
      });
      expect(await response.json()).toMatchObject({
        activeDeliberation: { id: "pending-deliberation" },
        canLaunch: false,
      });
    } finally {
      await observer.close();
    }
  });

  it("returns a redacted JSON envelope for unexpected API failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-observer-error-envelope-"));
    const observer = await startObserverServer(appPaths(home), 0, {
      loadRegistry: async () => { throw new Error("token=unexpected-secret registry failed"); },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${observer.port}/api/launch-options`, {
        headers: { Authorization: `Bearer ${observer.token}` },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      const text = await response.text();
      expect(text).not.toContain("unexpected-secret");
      expect(JSON.parse(text)).toMatchObject({ code: "INTERNAL_ERROR", message: expect.stringContaining("[REDACTED]") });
    } finally {
      await observer.close();
    }
  });

  it("rejects an invalid workspace before creating a launch record or spawning", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-launch-workspace-validation-"));
    const paths = appPaths(home);
    const workspaceFile = join(home, "not-a-directory.txt");
    await writeFile(workspaceFile, "not a directory");
    let spawnCount = 0;
    const observer = await startObserverServer(paths, 0, {
      loadRegistry: async () => ({
        defaults: { generator: { cli: "codex", preset: "deep" } },
        clis: [{
          id: "codex", adapter: "codex", executable: "codex", timeoutSeconds: 300, maxConcurrency: 1,
          presets: [{ id: "deep", model: "gpt-safe", contextBudget: 64_000, options: {} }],
        }],
      }),
      launchDeliberation: async () => { spawnCount += 1; },
    });
    try {
      const endpoint = `http://127.0.0.1:${observer.port}/api/launches`;
      const headers = { Authorization: `Bearer ${observer.token}`, "Content-Type": "application/json" };
      for (const [requestId, workspace] of [
        ["relative-workspace", "relative/path"],
        ["missing-workspace", join(home, "missing")],
        ["file-workspace", workspaceFile],
      ]) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ requestId, topic: "检查工作目录", mode: "structured", workspace }),
        });
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({ code: "INVALID_WORKSPACE", message: expect.any(String) });
      }
      expect(spawnCount).toBe(0);
      await expect(readFile(join(paths.runtime, "launches", "relative-workspace.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await observer.close();
    }
  });

  it("idempotently launches an independent planning deliberation", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-web-launch-"));
    const paths = appPaths(home);
    const spawned: string[] = [];
    const registry = {
      defaults: { generator: { cli: "codex", preset: "deep" } },
      clis: [{
        id: "codex", adapter: "codex" as const, executable: "codex", timeoutSeconds: 300, maxConcurrency: 1,
        presets: [{ id: "deep", model: "gpt-safe", contextBudget: 64_000, options: {} }],
      }],
    };
    const observer = await startObserverServer(paths, 0, {
      loadRegistry: async () => registry,
      launchDeliberation: async (request, id) => {
        spawned.push(id);
        const archive = new ArchiveStore(paths.deliberations, id);
        await archive.create({
          schemaVersion: 1,
          id,
          createdAt: new Date().toISOString(),
          question: request.topic,
          mode: request.mode,
          interaction: request.interaction,
          planning: {
            organizer: registry.defaults.generator,
            limits: { maxParticipants: 5, maxCalls: 60, maxDiscussionWindows: 6, timeoutSeconds: 300, contextBudget: 128_000, globalConcurrency: 6 },
            autoConfirmPlan: false,
            allowRegeneration: true,
            projectMode: false,
            generation: 0,
            candidateVersion: 0,
          },
        });
        await writeFile(join(paths.runtime, "active.lock"), JSON.stringify({ deliberationId: id, pid: process.pid }));
      },
    });
    try {
      const endpoint = `http://127.0.0.1:${observer.port}/api/launches`;
      const authorization = { Authorization: `Bearer ${observer.token}`, "Content-Type": "application/json" };
      const payload = { requestId: "request-1", topic: "是否发布？", mode: "structured" };
      const missing = await fetch(`${endpoint}/missing-request`, { headers: authorization });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "LAUNCH_NOT_FOUND", message: expect.any(String) });
      expect((await fetch(endpoint, { method: "POST", body: JSON.stringify(payload) })).status).toBe(401);
      const first = await fetch(endpoint, { method: "POST", headers: authorization, body: JSON.stringify(payload) });
      expect(first.status).toBe(201);
      const firstBody = await first.json() as { deliberationId: string; status: string };
      expect(firstBody.status).toBe("planning");
      const repeated = await fetch(endpoint, { method: "POST", headers: authorization, body: JSON.stringify(payload) });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ deliberationId: firstBody.deliberationId, status: "planning" });
      expect(spawned).toEqual([firstBody.deliberationId]);
      expect((await fetch(endpoint, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ ...payload, requestId: "request-2", surprise: true }),
      })).status).toBe(400);
      const conflict = await fetch(endpoint, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ ...payload, requestId: "request-2", topic: "另一项审议" }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "ACTIVE_DELIBERATION",
        activeDeliberation: { id: firstBody.deliberationId },
      });
      expect(await readFile(join(paths.runtime, "launches", "request-1.json"), "utf8")).toContain(firstBody.deliberationId);
    } finally {
      await observer.close();
    }
    const persisted = JSON.parse(await readFile(join(paths.runtime, "launches", "request-1.json"), "utf8")) as { deliberationId: string };
    const restarted = await startObserverServer(paths, 0, {
      loadRegistry: async () => registry,
      launchDeliberation: async () => { throw new Error("must not spawn an idempotent retry"); },
    });
    try {
      const repeated = await fetch(`http://127.0.0.1:${restarted.port}/api/launches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${restarted.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "request-1", topic: "是否发布？", mode: "structured" }),
      });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ deliberationId: persisted.deliberationId });
      expect(spawned).toEqual([persisted.deliberationId]);
    } finally {
      await restarted.close();
    }
  });

  it("persists and redacts a spawn failure without reporting a successful launch", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-web-launch-failure-"));
    const paths = appPaths(home);
    const observer = await startObserverServer(paths, 0, {
      loadRegistry: async () => ({
        defaults: { generator: { cli: "codex", preset: "deep" } },
        clis: [{
          id: "codex", adapter: "codex", executable: "codex", timeoutSeconds: 300, maxConcurrency: 1,
          presets: [{ id: "deep", model: "gpt-safe", contextBudget: 64_000, options: {} }],
        }],
      }),
      launchDeliberation: async () => { throw new Error("token=highly-secret spawn failed"); },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${observer.port}/api/launches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${observer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "failed-request", topic: "失败启动", mode: "structured" }),
      });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("highly-secret");
      expect(text).toContain("[REDACTED]");
      expect(JSON.parse(text)).toMatchObject({
        code: "LAUNCH_FAILED",
        message: expect.stringContaining("[REDACTED]"),
        status: "failed",
      });
      const persisted = await readFile(join(paths.runtime, "launches", "failed-request.json"), "utf8");
      expect(persisted).toContain('"status": "failed"');
      expect(persisted).not.toContain("highly-secret");
    } finally {
      await observer.close();
    }
  });

  it("binds locally, protects APIs, and accepts a checkpoint response only once", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-observer-"));
    const paths = appPaths(home);
    await mkdir(paths.deliberations, { recursive: true });
    const archive = new ArchiveStore(paths.deliberations, "d1");
    const manifest: DeliberationManifest = {
      schemaVersion: 1,
      id: "d1",
      createdAt: new Date().toISOString(),
      question: "观察测试",
      mode: "structured",
      interaction: "guided",
      planConfirmation: "interactive",
      plan: {
        organizer: { cli: "codex", preset: "deep" },
        participants: [
          { id: "a", invocation: { cli: "codex", preset: "deep" }, role: "主张" },
          { id: "b", invocation: { cli: "codex", preset: "deep" }, role: "审阅" },
        ],
        reportAgentId: "b",
        limits: { maxParticipants: 4, maxCalls: 40, maxDiscussionWindows: 6, timeoutSeconds: 300, contextBudget: 64_000 },
      },
    };
    await archive.create(manifest);
    await archive.writeReport("# 报告\n\n| 项 | 值 |\n|---|---|\n| 安全 | <script>alert(1)</script> |");
    const broken = join(paths.deliberations, "broken");
    await mkdir(broken);
    await Promise.all([
      writeFile(join(broken, "manifest.json"), JSON.stringify({
        schema_version: 1, id: "broken", createdAt: new Date().toISOString(), question: "坏档案",
        mode: "unknown", interaction: "auto",
      })),
      writeFile(join(broken, "state.json"), JSON.stringify({
        schema_version: 1, status: "running", updatedAt: new Date().toISOString(), callAttempts: 0,
        guidance: [], pendingInvocations: {}, completedInvocations: {}, checkpointDecisions: {},
      })),
      writeFile(join(broken, "events.jsonl"), ""),
      writeFile(join(broken, "transcript.jsonl"), ""),
    ]);
    await mkdir(join(paths.runtime, "checkpoints"), { recursive: true });
    await writeFile(join(paths.runtime, "checkpoints", "d1.request.json"), JSON.stringify({
      checkpointId: "cp-1", kind: "independent", summary: "等待确认", actions: ["continue", "cancel"],
    }));
    const observer = await startObserverServer(paths);
    try {
      expect(observer.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect((await fetch(`http://127.0.0.1:${observer.port}/`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${observer.port}/api/deliberations`)).status).toBe(401);
      const authorization = { Authorization: `Bearer ${observer.token}` };
      const list = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations`, { headers: authorization });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject([{ id: "d1", status: "planning" }]);
      expect((await fetch(`http://127.0.0.1:${observer.port}/missing`, { headers: authorization })).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${observer.port}/api/missing`, { headers: authorization })).status).toBe(404);
      const detail = await fetch(`http://127.0.0.1:${observer.port}/api/deliberations/d1`, { headers: authorization });
      const detailBody = await detail.json() as { reportHtml: string };
      expect(detailBody.reportHtml).toContain("<table>");
      expect(detailBody.reportHtml).not.toContain("<script");
      const endpoint = `http://127.0.0.1:${observer.port}/api/checkpoints/d1/respond`;
      const first = await fetch(endpoint, {
        method: "POST", headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId: "cp-1", action: "continue" }),
      });
      expect(first.status).toBe(202);
      const second = await fetch(endpoint, {
        method: "POST", headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId: "cp-1", action: "continue" }),
      });
      expect(second.status).toBe(409);
      const malformed = await fetch(endpoint, {
        method: "POST", headers: { ...authorization, "Content-Type": "application/json" }, body: "[]",
      });
      expect(malformed.status).toBe(400);
      const heartbeat = await readFile(join(paths.runtime, "server.json"), "utf8");
      expect(heartbeat).not.toContain(observer.token);
      expect(await observerIsOnline(paths.runtime)).toBe(true);
    } finally {
      await observer.close();
    }
    expect(await observerIsOnline(paths.runtime)).toBe(false);
  });
});
