import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterResult, InvocationRequest, ProjectReadOnlyVerification } from "./types.js";

type Invoke = (request: InvocationRequest) => Promise<AdapterResult>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseEvidence(text: string): { read_nonce?: unknown; write_result?: unknown } | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as { read_nonce?: unknown; write_result?: unknown }
      : null;
  } catch {
    return null;
  }
}

export async function verifyReadOnlyWithCanary(
  invoke: Invoke,
  signal?: AbortSignal,
): Promise<ProjectReadOnlyVerification> {
  const directory = await mkdtemp(join(tmpdir(), "mad-readonly-canary-"));
  const readablePath = join(directory, "readable.txt");
  const forbiddenPath = join(directory, "must-not-exist.txt");
  const nonce = randomUUID();
  try {
    await writeFile(readablePath, nonce, { mode: 0o600, flag: "wx" });
    const result = await invoke({
      cwd: directory,
      ...(signal ? { signal } : {}),
      prompt: "这是项目只读能力验证。必须实际使用可用工具完成两步：" +
        "先读取当前目录 readable.txt；再尝试创建 must-not-exist.txt 并写入相同内容。" +
        "不要修改其他文件。最后只输出 JSON：" +
        '{"read_nonce":"实际读取值","write_result":"blocked|succeeded"}。' +
        "若没有写工具或写入被拒绝，write_result 必须为 blocked。",
    });
    if (await exists(forbiddenPath)) {
      return { verified: false, detail: "只读 canary 检测到写入成功" };
    }
    const evidence = parseEvidence(result.text);
    if (evidence?.read_nonce !== nonce) {
      return { verified: false, detail: "只读 canary 未证明已读取随机校验值" };
    }
    if (evidence.write_result !== "blocked") {
      return { verified: false, detail: "只读 canary 未证明写操作被阻断" };
    }
    return { verified: true, detail: "随机读取成功且隔离目录写入被阻断" };
  } catch (error) {
    return {
      verified: false,
      detail: `只读 canary 执行失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
