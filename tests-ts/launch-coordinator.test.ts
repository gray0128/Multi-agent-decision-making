import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveStore } from "../src/archive/store.js";
import { appPaths } from "../src/core/paths.js";
import { LaunchCoordinator } from "../src/server/launch-coordinator.js";

describe("launch coordinator", () => {
  it("recovers a delayed archive without changing the idempotent deliberation mapping", async () => {
    const home = await mkdtemp(join(tmpdir(), "mad-launch-recovery-"));
    const paths = appPaths(home);
    const requestId = "delayed-request";
    const deliberationId = "delayed-deliberation";
    await Promise.all([
      mkdir(join(paths.runtime, "launches"), { recursive: true }),
      mkdir(paths.deliberations, { recursive: true }),
    ]);
    await writeFile(join(paths.runtime, "launches", `${requestId}.json`), JSON.stringify({
      requestId,
      deliberationId,
      status: "spawned",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const coordinator = new LaunchCoordinator(paths);
    expect(await coordinator.read(requestId)).toMatchObject({
      requestId,
      deliberationId,
      status: "failed",
      errorCode: "ARCHIVE_NOT_READY",
    });
    expect(await coordinator.currentDeliberationId()).toBe(deliberationId);
    await new ArchiveStore(paths.deliberations, deliberationId).create({
      schemaVersion: 1,
      id: deliberationId,
      createdAt: new Date().toISOString(),
      question: "延迟建档",
      mode: "structured",
      interaction: "guided",
      planning: {
        organizer: { cli: "codex", preset: "deep" },
        limits: {
          maxParticipants: 4,
          maxCalls: 40,
          maxDiscussionWindows: 4,
          timeoutSeconds: 300,
          contextBudget: 64_000,
        },
        autoConfirmPlan: false,
        allowRegeneration: true,
        projectMode: false,
        generation: 0,
      },
    });

    const recovered = await coordinator.read(requestId);

    expect(recovered).toMatchObject({ requestId, deliberationId, status: "planning" });
    expect(recovered?.error).toBeUndefined();
  });
});
