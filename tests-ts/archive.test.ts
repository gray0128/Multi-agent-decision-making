import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActiveDeliberationLock, ArchiveStore } from "../src/archive/store.js";
import { parseArchiveEvent } from "../src/archive/schema.js";
import type { DeliberationManifest, FrozenInvocation, InvocationResult } from "../src/core/types.js";

function manifest(id: string): DeliberationManifest {
  return {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    question: "比较方案",
    mode: "structured",
    interaction: "auto",
    planConfirmation: "auto-first-valid",
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
}

describe("transparent archive", () => {
  it("rejects structurally invalid archive events", () => {
    expect(() => parseArchiveEvent({ id: "e1", at: "now", type: "" })).toThrow(/event.type/);
  });

  it("rejects deliberation IDs that escape the archive root", () => {
    expect(() => new ArchiveStore("/tmp/mad-archives", "../../outside"))
      .toThrow(/审议 ID/);
  });

  it("freezes inputs and commits one authoritative result exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-archive-"));
    const store = new ArchiveStore(root, "d1");
    await store.create(manifest("d1"));
    const manifestOnDisk = await readFile(join(store.path, "manifest.json"), "utf8");
    expect(manifestOnDisk).toContain('"schema_version": 1');
    expect(manifestOnDisk).not.toContain('"schemaVersion"');
    const frozen: FrozenInvocation = {
      logicalCallId: "call-1",
      kind: "contribution",
      agentId: "a",
      prompt: "frozen prompt",
      invocation: { cli: "codex", preset: "deep" },
      createdAt: new Date().toISOString(),
    };
    const result: InvocationResult = {
      logicalCallId: "call-1",
      text: "answer",
      completedAt: new Date().toISOString(),
      durationMs: 10,
    };
    await store.freezeInvocation(frozen);
    expect(await store.commitInvocation(result)).toBe(true);
    expect(await store.commitInvocation({ ...result, text: "duplicate" })).toBe(false);
    const state = await store.readState();
    expect(state.pendingInvocations).toEqual({});
    expect(state.guidance).toEqual([]);
    expect(state.completedInvocations["call-1"]?.text).toBe("answer");
    const transcriptRecord = {
      logicalCallId: "call-1", id: "record-1", at: result.completedAt, stage: "independent",
      agentId: "a", invocation: { cli: "codex", preset: "deep" }, content: "answer",
    };
    await store.ensureTranscript(transcriptRecord);
    await store.ensureTranscript({ ...transcriptRecord, id: "duplicate" });
    expect((await readFile(join(store.path, "transcript.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    const events = (await readFile(join(store.path, "events.jsonl"), "utf8")).trim().split("\n");
    expect(events).toHaveLength(3);
  });

  it("persists accepted checkpoint decisions across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-checkpoint-state-"));
    const store = new ArchiveStore(root, "d1");
    await store.create(manifest("d1"));
    await store.setPendingCheckpoint("structured:draft", "cp-1", {
      kind: "draft", summary: "草稿", actions: ["continue", "cancel"],
    });
    await store.recordCheckpointDecision("structured:draft", { action: "continue", guidance: "补充证据" });
    const recovered = await new ArchiveStore(root, "d1").readState();
    expect(recovered.pendingCheckpoint).toBeUndefined();
    expect(recovered.checkpointDecisions["structured:draft"]).toMatchObject({
      action: "continue", guidance: "补充证据",
    });
  });

  it("allows only one active deliberation lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-lock-"));
    const path = join(root, "runtime", "active.lock");
    const first = new ActiveDeliberationLock(path);
    const second = new ActiveDeliberationLock(path);
    await first.acquire("d1");
    await expect(second.acquire("d2")).rejects.toThrow(/已有活动审议/);
    await first.release();
    await second.acquire("d2");
    await second.release();
  });

  it("compares frozen inputs by authority fields rather than recovery timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-frozen-"));
    const store = new ArchiveStore(root, "d1");
    await store.create(manifest("d1"));
    const invocation: FrozenInvocation = {
      logicalCallId: "pending", kind: "contribution", agentId: "a", prompt: "same prompt",
      invocation: { cli: "codex", preset: "deep" }, createdAt: "2026-01-01T00:00:00.000Z",
    };
    await store.freezeInvocation(invocation);
    await expect(store.freezeInvocation({ ...invocation, createdAt: "2026-02-01T00:00:00.000Z" })).resolves.toBeUndefined();
    await expect(store.freezeInvocation({ ...invocation, prompt: "changed" })).rejects.toThrow(/冻结输入不一致/);
  });

  it("reclaims a lock only when its recorded owner process is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-stale-lock-"));
    const path = join(root, "runtime", "active.lock");
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(path, JSON.stringify({ deliberationId: "dead", pid: 99_999_999 }));
    const lock = new ActiveDeliberationLock(path);
    await lock.acquire("recovered");
    expect(await readFile(path, "utf8")).toContain('"deliberationId":"recovered"');
    await lock.release();
  });

  it("does not remove a lock that has been replaced by another owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-lock-owner-"));
    const path = join(root, "runtime", "active.lock");
    const first = new ActiveDeliberationLock(path);
    await first.acquire("d1");
    await writeFile(path, JSON.stringify({
      deliberationId: "d2",
      pid: process.pid,
      ownerId: "replacement-owner",
      acquiredAt: new Date().toISOString(),
    }));
    await first.release();
    expect(await readFile(path, "utf8")).toContain("replacement-owner");
  });

  it("redacts nested secrets at the diagnostics persistence boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-archive-redaction-"));
    const store = new ArchiveStore(root, "d1");
    await store.create(manifest("d1"));
    const environmentSecret = "test-secret-value-123456";
    process.env.MAD_ARCHIVE_TEST_SECRET = environmentSecret;
    const circular: Record<string, unknown> = { password: "plain-password" };
    circular.self = circular;
    try {
      await store.appendDiagnostic({
        authorization: "Bearer exposed-token-123456",
        nested: { stderr: `token=${environmentSecret}`, circular },
      });
      const persisted = await readFile(join(store.path, "diagnostics.jsonl"), "utf8");
      expect(persisted).not.toContain(environmentSecret);
      expect(persisted).not.toContain("plain-password");
      expect(persisted).not.toContain("exposed-token-123456");
      expect(persisted).toContain("[REDACTED]");
      expect(persisted).toContain("[CIRCULAR]");
    } finally {
      delete process.env.MAD_ARCHIVE_TEST_SECRET;
    }
  });

  it("rejects invalid manifest and state values at the shared archive boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-archive-schema-"));
    const store = new ArchiveStore(root, "d1");
    await store.create(manifest("d1"));
    const invalidManifest = JSON.parse(await readFile(join(store.path, "manifest.json"), "utf8")) as Record<string, unknown>;
    invalidManifest.mode = "unknown";
    await writeFile(join(store.path, "manifest.json"), JSON.stringify(invalidManifest));
    await expect(store.readManifest()).rejects.toThrow(/manifest.mode/);

    await store.writeManifest(manifest("d1"));
    const validState = JSON.parse(await readFile(join(store.path, "state.json"), "utf8")) as Record<string, unknown>;
    const invalidState = structuredClone(validState);
    invalidState.status = "unknown";
    await writeFile(join(store.path, "state.json"), JSON.stringify(invalidState));
    await expect(store.readState()).rejects.toThrow(/state.status/);

    validState.pendingCheckpoint = {
      key: "structured:draft", checkpointId: "cp-1", kind: "draft", summary: "草稿", actions: "continue",
    };
    await writeFile(join(store.path, "state.json"), JSON.stringify(validState));
    await expect(store.readState()).rejects.toThrow(/pendingCheckpoint.actions/);
  });
});
