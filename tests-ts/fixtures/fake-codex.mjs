#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0\n");
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const failureCounter = process.env.FAKE_CODEX_FAILURE_COUNTER;
if (failureCounter && prompt.includes("独立提出判断")) {
  const count = existsSync(failureCounter) ? Number(readFileSync(failureCounter, "utf8")) : 0;
  writeFileSync(failureCounter, String(count + 1));
  if (count < 4) {
    process.stderr.write("transient fake failure\n");
    process.exit(1);
  }
}
const delayMilliseconds = Number(process.env.FAKE_CODEX_DELAY_MS ?? "0");
if (delayMilliseconds > 0 && prompt.includes("独立提出判断")) {
  await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}

let output = "阶段输出";
if (prompt.includes("只回复 READY") || prompt.includes("只回复 READY")) {
  output = "READY";
} else if (prompt.includes("一次性组局 Agent")) {
  const free = prompt.includes("模式：free");
  output = JSON.stringify({
    participants: [
      { id: "architect", cli: "codex", preset: "test", role: "架构主张" },
      { id: "reviewer", cli: "codex", preset: "test", role: "风险审阅" },
    ],
    report_agent_id: "reviewer",
    ...(free ? { moderator_agent_id: "architect" } : {}),
  });
} else if (prompt.includes("规划覆盖周期")) {
  output = JSON.stringify({ order: ["architect", "reviewer"] });
} else if (prompt.includes("评估是否已充分收敛")) {
  output = JSON.stringify({ speakers: [], converged: true, rationale: "覆盖周期已明确结论与风险" });
} else if (prompt.includes("只输出 JSON") && prompt.includes("disputes")) {
  const stance = prompt.includes("你是 architect") ? "立即迁移" : "分阶段迁移";
  output = JSON.stringify({ position: stance, disputes: [{ topic: "迁移节奏", stance, confidence: "high" }] });
} else if (prompt.includes("生成 Markdown 草稿")) {
  output = "# 草稿\n\n## 共识\n保留透明档案。";
} else if (prompt.includes("完成一次最终修订")) {
  output = "# 最终共同成果\n\n## 共识\n保留透明档案。\n\n## 未决争议\n迁移节奏仍需验证。\n\n## 假设与风险\n调用预算需要持续监控。";
} else if (prompt.includes("权威滚动摘要")) {
  output = "参与者同意保留透明档案，但迁移节奏仍有分歧。";
}

process.stdout.write(`${output}\n`);
