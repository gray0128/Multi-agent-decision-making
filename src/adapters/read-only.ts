import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterResult, InvocationRequest, ProjectReadOnlyVerification } from "./types.js";

type Invoke = (request: InvocationRequest) => Promise<AdapterResult>;

interface ReadOnlyEvidence {
  readonly read_nonce: string;
  readonly write_result: "blocked" | "succeeded";
}

const READ_ONLY_EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    read_nonce: { type: "string" },
    write_result: { type: "string", enum: ["blocked", "succeeded"] },
  },
  required: ["read_nonce", "write_result"],
  additionalProperties: false,
} as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseEvidenceObject(text: string): ReadOnlyEvidence | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const evidence = value as Record<string, unknown>;
    const keys = Object.keys(evidence);
    if (keys.length !== 2 || !keys.includes("read_nonce") || !keys.includes("write_result")) return null;
    if (typeof evidence.read_nonce !== "string") return null;
    if (evidence.write_result !== "blocked" && evidence.write_result !== "succeeded") return null;
    return {
      read_nonce: evidence.read_nonce,
      write_result: evidence.write_result,
    };
  } catch {
    return null;
  }
}

function parseEvidence(text: string): ReadOnlyEvidence | null {
  const trimmed = text.trim();
  const direct = parseEvidenceObject(trimmed);
  if (direct) return direct;

  const fencedCandidates: ReadOnlyEvidence[] = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    const candidate = parseEvidenceObject(match[1] ?? "");
    if (candidate) fencedCandidates.push(candidate);
  }

  const inlineCandidates: ReadOnlyEvidence[] = [];
  const outsideFences = trimmed.replace(/```(?:json)?\s*[\s\S]*?\s*```/gi, "");
  for (const match of outsideFences.matchAll(/\{[^{}]*\}/g)) {
    const candidate = parseEvidenceObject(match[0]);
    if (candidate) inlineCandidates.push(candidate);
  }
  const candidates = [...fencedCandidates, ...inlineCandidates];
  return candidates.length === 1 ? candidates[0]! : null;
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
      jsonSchema: READ_ONLY_EVIDENCE_SCHEMA,
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
    if (!evidence) {
      return { verified: false, detail: "只读 canary 响应不是唯一、有效的证据 JSON" };
    }
    if (evidence.read_nonce !== nonce) {
      return { verified: false, detail: "只读 canary 读取的随机校验值不匹配" };
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
