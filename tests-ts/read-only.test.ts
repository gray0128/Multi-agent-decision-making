import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { verifyReadOnlyWithCanary } from "../src/adapters/read-only.js";

describe("project read-only runtime canary", () => {
  it("passes only after reading the nonce and reporting the write as blocked", async () => {
    const invoke = vi.fn(async ({ cwd }: { cwd: string }) => ({
      text: JSON.stringify({ read_nonce: await readFile(`${cwd}/readable.txt`, "utf8"), write_result: "blocked" }),
      durationMs: 1,
      diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
    }));

    await expect(verifyReadOnlyWithCanary(invoke)).resolves.toMatchObject({ verified: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the invocation can create the sentinel", async () => {
    const invoke = vi.fn(async ({ cwd }: { cwd: string }) => {
      const nonce = await readFile(`${cwd}/readable.txt`, "utf8");
      await writeFile(`${cwd}/must-not-exist.txt`, nonce);
      return {
        text: JSON.stringify({ read_nonce: nonce, write_result: "blocked" }),
        durationMs: 1,
        diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
      };
    });

    await expect(verifyReadOnlyWithCanary(invoke)).resolves.toMatchObject({
      verified: false,
      detail: expect.stringMatching(/写入/),
    });
  });

  it("fails closed when the response does not prove the nonce was read", async () => {
    const invoke = vi.fn(async () => ({
      text: JSON.stringify({ read_nonce: "guessed", write_result: "blocked" }),
      durationMs: 1,
      diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
    }));

    await expect(verifyReadOnlyWithCanary(invoke)).resolves.toMatchObject({
      verified: false,
      detail: expect.stringMatching(/读取/),
    });
  });
});
