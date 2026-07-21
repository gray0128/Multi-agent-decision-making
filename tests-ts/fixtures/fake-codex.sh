#!/bin/sh

if [ -n "${FAKE_CODEX_CWD_LOG:-}" ]; then
  printf '%s' "$(pwd)" > "$FAKE_CODEX_CWD_LOG"
fi

case " $* " in
  *" --version "*)
    printf '%s\n' "fake-codex 1.0"
    exit 0
    ;;
esac

prompt=$(cat)

if [ -n "${FAKE_CODEX_INVOCATION_COUNTER:-}" ]; then
  count=0
  if [ -f "$FAKE_CODEX_INVOCATION_COUNTER" ]; then count=$(cat "$FAKE_CODEX_INVOCATION_COUNTER"); fi
  printf '%s' "$((count + 1))" > "$FAKE_CODEX_INVOCATION_COUNTER"
fi

case "$prompt" in
  *"独立提出判断"*)
    if [ -n "${FAKE_CODEX_FAILURE_COUNTER:-}" ]; then
      count=0
      if [ -f "$FAKE_CODEX_FAILURE_COUNTER" ]; then count=$(cat "$FAKE_CODEX_FAILURE_COUNTER"); fi
      printf '%s' "$((count + 1))" > "$FAKE_CODEX_FAILURE_COUNTER"
      if [ "$count" -lt 4 ]; then
        printf '%s\n' "transient fake failure" >&2
        exit 1
      fi
    fi
    if [ "${FAKE_CODEX_DELAY_MS:-0}" -gt 0 ]; then sleep "$((FAKE_CODEX_DELAY_MS / 1000))"; fi
    ;;
esac

case "$prompt" in
  *"一次性组局 Agent"*)
    if [ "${FAKE_CODEX_PLANNING_DELAY_MS:-0}" -gt 0 ]; then sleep "$((FAKE_CODEX_PLANNING_DELAY_MS / 1000))"; fi
    ;;
esac

case "$prompt" in
  *"项目只读能力验证"*)
    nonce=$(cat readable.txt)
    output="{\"read_nonce\":\"$nonce\",\"write_result\":\"blocked\"}"
    ;;
  *"只回复 READY"*) output="READY" ;;
  *"一次性组局 Agent"*)
    case "$prompt" in
      *"模式：free"*) moderator=',"moderator_agent_id":"architect"' ;;
      *) moderator='' ;;
    esac
    output="{\"participants\":[{\"id\":\"architect\",\"cli\":\"codex\",\"preset\":\"test\",\"role\":\"架构主张\"},{\"id\":\"reviewer\",\"cli\":\"codex\",\"preset\":\"test\",\"role\":\"风险审阅\"}],\"report_agent_id\":\"reviewer\"$moderator}"
    ;;
  *"规划覆盖周期"*) output='{ "order": ["architect", "reviewer"] }' ;;
  *"评估是否已充分收敛"*) output='{ "speakers": [], "converged": true, "rationale": "覆盖周期已明确结论与风险" }' ;;
  *"只输出 JSON"*"disputes"*)
    case "$prompt" in *"你是 architect"*) stance="立即迁移" ;; *) stance="分阶段迁移" ;; esac
    output="{\"position\":\"$stance\",\"disputes\":[{\"topic\":\"迁移节奏\",\"stance\":\"$stance\",\"confidence\":\"high\"}]}"
    ;;
  *"生成 Markdown 草稿"*) output='# 草稿

## 共识
保留透明档案。' ;;
  *"完成一次最终修订"*) output='# 最终共同成果

## 共识
保留透明档案。

## 未决争议
迁移节奏仍需验证。

## 假设与风险
调用预算需要持续监控。' ;;
  *"权威滚动摘要"*) output="参与者同意保留透明档案，但迁移节奏仍有分歧。" ;;
  *) output="阶段输出" ;;
esac

printf '%s\n' "$output"
