import { mkdtemp, readFile } from "node:fs/promises";
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
});
