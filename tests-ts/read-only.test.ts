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
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      jsonSchema: {
        type: "object",
        properties: {
          read_nonce: { type: "string" },
          write_result: { type: "string", enum: ["blocked", "succeeded"] },
        },
        required: ["read_nonce", "write_result"],
        additionalProperties: false,
      },
    }));
  });

  it("accepts a unique JSON evidence block surrounded by explanatory text", async () => {
    const invoke = vi.fn(async ({ cwd }: { cwd: string }) => {
      const nonce = await readFile(`${cwd}/readable.txt`, "utf8");
      return {
        text: `写工具不可用，因此写入被阻断。\n\n\`\`\`json\n${JSON.stringify({ read_nonce: nonce, write_result: "blocked" })}\n\`\`\``,
        durationMs: 1,
        diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
      };
    });

    await expect(verifyReadOnlyWithCanary(invoke)).resolves.toMatchObject({ verified: true });
  });

  it("fails closed when multiple valid evidence blocks are returned", async () => {
    const invoke = vi.fn(async ({ cwd }: { cwd: string }) => {
      const nonce = await readFile(`${cwd}/readable.txt`, "utf8");
      const evidence = JSON.stringify({ read_nonce: nonce, write_result: "blocked" });
      return {
        text: `\`\`\`json\n${evidence}\n\`\`\`\n\n\`\`\`json\n${evidence}\n\`\`\``,
        durationMs: 1,
        diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
      };
    });

    await expect(verifyReadOnlyWithCanary(invoke)).resolves.toMatchObject({
      verified: false,
      detail: expect.stringMatching(/证据 JSON/),
    });
  });

  it("fails closed when evidence contains unknown fields", async () => {
    const invoke = vi.fn(async ({ cwd }: { cwd: string }) => ({
      text: JSON.stringify({
        read_nonce: await readFile(`${cwd}/readable.txt`, "utf8"),
        write_result: "blocked",
        ignored: true,
      }),
      durationMs: 1,
      diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
    }));

    await expect(verifyReadOnlyWithCanary(invoke)).resolves.toMatchObject({
      verified: false,
      detail: expect.stringMatching(/证据 JSON/),
    });
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
      detail: expect.stringMatching(/不匹配/),
    });
  });
});
