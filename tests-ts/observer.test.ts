import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveStore } from "../src/archive/store.js";
import { appPaths } from "../src/core/paths.js";
import type { DeliberationManifest } from "../src/core/types.js";
import { startObserverServer } from "../src/server/observer.js";
import { observerIsOnline } from "../src/server/mailbox.js";
import { APP_JS } from "../src/web/index.js";

describe("authenticated observer service", () => {
  it("renders structured event details instead of dropping them", () => {
    expect(APP_JS).toContain("durationMs");
    expect(APP_JS).toContain("logicalCallId");
    expect(APP_JS).toContain("d.message");
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
    await mkdir(join(paths.deliberations, "broken"));
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
      const heartbeat = await readFile(join(paths.runtime, "server.json"), "utf8");
      expect(heartbeat).not.toContain(observer.token);
      expect(await observerIsOnline(paths.runtime)).toBe(true);
    } finally {
      await observer.close();
    }
    expect(await observerIsOnline(paths.runtime)).toBe(false);
  });
});
