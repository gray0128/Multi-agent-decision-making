import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointMailbox } from "../src/server/mailbox.js";

describe("checkpoint mailbox", () => {
  it("uses the first valid response file and consumes it", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "mad-mailbox-"));
    const mailbox = new CheckpointMailbox(runtime, "d1");
    const waiting = mailbox.wait(
      { kind: "draft", summary: "草稿完成", actions: ["continue", "cancel"] },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { action: "continue", guidance: "保留未决争议" };
      },
    );
    const response = await waiting;
    expect(response).toMatchObject({ action: "continue", guidance: "保留未决争议" });
    await expect(readFile(join(runtime, "checkpoints", "d1.request.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(runtime, "checkpoints", "d1.response.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second claimant without overwriting the winner", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "mad-mailbox-race-"));
    const mailbox = new CheckpointMailbox(runtime, "d2");
    const wait = mailbox.wait({ kind: "challenge", summary: "完成", actions: ["continue", "cancel"] });
    let checkpointId = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const pending = JSON.parse(await readFile(join(runtime, "checkpoints", "d2.request.json"), "utf8")) as { checkpointId: string };
        checkpointId = pending.checkpointId;
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    expect(checkpointId).not.toBe("");
    expect(await mailbox.submit(checkpointId, "cancel")).toBe(true);
    expect(await mailbox.submit(checkpointId, "continue")).toBe(false);
    expect((await wait).action).toBe("cancel");
  });

  it("reuses a pending checkpoint ID and consumes a response left by a crashed waiter", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "mad-mailbox-resume-"));
    await mkdir(join(runtime, "checkpoints"));
    const mailbox = new CheckpointMailbox(runtime, "d3");
    expect(await mailbox.submit("cp-recovered", "continue", "沿用决定")).toBe(true);
    const response = await mailbox.wait(
      { kind: "draft", summary: "草稿", actions: ["continue", "cancel"] },
      undefined,
      undefined,
      undefined,
      "cp-recovered",
    );
    expect(response).toMatchObject({ checkpointId: "cp-recovered", action: "continue", guidance: "沿用决定" });
  });

  it("keeps request and response files when authoritative decision persistence fails", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "mad-mailbox-commit-failure-"));
    const mailbox = new CheckpointMailbox(runtime, "d4");
    const waiting = mailbox.wait(
      { kind: "draft", summary: "草稿", actions: ["continue"] },
      async () => ({ action: "continue" }),
      undefined,
      undefined,
      undefined,
      async () => { throw new Error("state commit failed"); },
    );
    await expect(waiting).rejects.toThrow(/state commit failed/);
    await expect(readFile(join(runtime, "checkpoints", "d4.request.json"), "utf8")).resolves.toContain("draft");
    await expect(readFile(join(runtime, "checkpoints", "d4.response.json"), "utf8")).resolves.toContain("continue");
  });
});
