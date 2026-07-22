import { readFile } from "node:fs/promises";
import * as TOML from "@iarna/toml";
import { MadError } from "../core/errors.js";
import { SAFE_MAX_LIMITS } from "../core/limits.js";

export const ADAPTER_IDS = ["codex", "claude", "reasonix", "grok", "pi", "codebuddy", "agy"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface InvocationPresetOptions {
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly effort?: EffortLevel;
  readonly thinking?: ThinkingLevel;
}

export interface InvocationPreset {
  readonly id: string;
  readonly model: string;
  readonly contextBudget: number;
  readonly options: InvocationPresetOptions;
}

export interface CliConfig {
  readonly id: string;
  readonly adapter: AdapterId;
  readonly executable: string;
  readonly timeoutSeconds: number;
  readonly maxConcurrency: number;
  readonly presets: readonly InvocationPreset[];
}

export interface CliRegistry {
  readonly defaults: { readonly generator: { readonly cli: string; readonly preset: string } };
  readonly clis: readonly CliConfig[];
}

type JsonObject = Record<string, unknown>;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MadError("CONFIG", `${path} 必须是表`);
  }
  return value as JsonObject;
}

function assertKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new MadError("CONFIG", `${path} 包含未知字段：${extras.join(", ")}`);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MadError("CONFIG", `${path} 必须是非空字符串`);
  }
  return value.trim();
}

function idAt(value: unknown, path: string): string {
  const id = stringAt(value, path);
  if (!ID_PATTERN.test(id)) throw new MadError("CONFIG", `${path} 不是有效 ID`);
  return id;
}

function positiveIntegerAt(value: unknown, path: string, fallback?: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1) {
    throw new MadError("CONFIG", `${path} 必须是正整数`);
  }
  return resolved as number;
}

function boundedPositiveIntegerAt(value: unknown, path: string, maximum: number, fallback?: number): number {
  const resolved = positiveIntegerAt(value, path, fallback);
  if (resolved > maximum) throw new MadError("CONFIG", `${path} 必须是 1 到 ${maximum} 之间的整数`);
  return resolved;
}

function parsePreset(value: unknown, cliPath: string, adapter: AdapterId): InvocationPreset {
  const raw = objectAt(value, cliPath);
  assertKeys(raw, ["id", "model", "context_budget", "options"], cliPath);
  const optionsRaw = raw.options === undefined ? {} : objectAt(raw.options, `${cliPath}.options`);
  const allowedOptions = adapter === "codex" ? ["reasoning_effort"]
    : adapter === "claude" || adapter === "grok" ? ["effort"]
    : adapter === "pi" ? ["thinking"]
    : [];
  assertKeys(optionsRaw, allowedOptions, `${cliPath}.options`);
  const effort = optionsRaw.reasoning_effort;
  if (effort !== undefined && !CODEX_REASONING_EFFORTS.includes(effort as CodexReasoningEffort)) {
    throw new MadError(
      "CONFIG",
      `${cliPath}.options.reasoning_effort 必须是 ${CODEX_REASONING_EFFORTS.join(", ")} 之一`,
    );
  }
  const genericEffort = optionsRaw.effort;
  if (genericEffort !== undefined && !EFFORT_LEVELS.includes(genericEffort as EffortLevel)) {
    throw new MadError("CONFIG", `${cliPath}.options.effort 必须是 ${EFFORT_LEVELS.join(", ")} 之一`);
  }
  const thinking = optionsRaw.thinking;
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
    throw new MadError("CONFIG", `${cliPath}.options.thinking 必须是 ${THINKING_LEVELS.join(", ")} 之一`);
  }
  const options: InvocationPresetOptions = {
    ...(effort === undefined ? {} : { reasoningEffort: effort as CodexReasoningEffort }),
    ...(genericEffort === undefined ? {} : { effort: genericEffort as EffortLevel }),
    ...(thinking === undefined ? {} : { thinking: thinking as ThinkingLevel }),
  };
  const model = stringAt(raw.model, `${cliPath}.model`);
  if (model === "REPLACE_WITH_MODEL_ID") {
    throw new MadError("CONFIG", `${cliPath}.model 仍是模板占位符，请填写真实模型 ID`);
  }
  return {
    id: idAt(raw.id, `${cliPath}.id`),
    model,
    contextBudget: boundedPositiveIntegerAt(
      raw.context_budget,
      `${cliPath}.context_budget`,
      SAFE_MAX_LIMITS.contextBudget,
    ),
    options,
  };
}

function parseCli(value: unknown, index: number): CliConfig {
  const path = `clis[${index}]`;
  const raw = objectAt(value, path);
  assertKeys(raw, ["id", "adapter", "executable", "timeout_seconds", "max_concurrency", "presets"], path);
  const adapter = stringAt(raw.adapter, `${path}.adapter`);
  if (!ADAPTER_IDS.includes(adapter as AdapterId)) {
    throw new MadError("CONFIG", `${path}.adapter 尚未支持：${adapter}`);
  }
  if (!Array.isArray(raw.presets) || raw.presets.length === 0) {
    throw new MadError("CONFIG", `${path}.presets 至少需要一个调用预设`);
  }
  const presets = raw.presets.map((preset, presetIndex) => parsePreset(preset, `${path}.presets[${presetIndex}]`, adapter as AdapterId));
  const presetIds = new Set<string>();
  for (const preset of presets) {
    if (presetIds.has(preset.id)) throw new MadError("CONFIG", `${path} 包含重复调用预设：${preset.id}`);
    presetIds.add(preset.id);
  }
  return {
    id: idAt(raw.id, `${path}.id`),
    adapter: adapter as AdapterId,
    executable: raw.executable === undefined ? adapter : stringAt(raw.executable, `${path}.executable`),
    timeoutSeconds: positiveIntegerAt(raw.timeout_seconds, `${path}.timeout_seconds`, 300),
    maxConcurrency: positiveIntegerAt(raw.max_concurrency, `${path}.max_concurrency`, 1),
    presets,
  };
}

export function parseCliRegistry(value: unknown): CliRegistry {
  const root = objectAt(value, "config");
  assertKeys(root, ["defaults", "clis"], "config");
  const defaults = objectAt(root.defaults, "defaults");
  assertKeys(defaults, ["generator"], "defaults");
  const generator = objectAt(defaults.generator, "defaults.generator");
  assertKeys(generator, ["cli", "preset"], "defaults.generator");
  if (!Array.isArray(root.clis) || root.clis.length === 0) {
    throw new MadError("CONFIG", "clis 至少需要一个 CLI 配置");
  }
  const clis = root.clis.map(parseCli);
  const cliIds = new Set<string>();
  for (const cli of clis) {
    if (cliIds.has(cli.id)) throw new MadError("CONFIG", `包含重复 CLI ID：${cli.id}`);
    cliIds.add(cli.id);
  }
  const generatorCli = idAt(generator.cli, "defaults.generator.cli");
  const generatorPreset = idAt(generator.preset, "defaults.generator.preset");
  const selectedCli = clis.find((cli) => cli.id === generatorCli);
  if (!selectedCli) throw new MadError("CONFIG", `默认组局器引用未知 CLI：${generatorCli}`);
  if (!selectedCli.presets.some((preset) => preset.id === generatorPreset)) {
    throw new MadError("CONFIG", `默认组局器引用未知调用预设：${generatorCli}/${generatorPreset}`);
  }
  return { defaults: { generator: { cli: generatorCli, preset: generatorPreset } }, clis };
}

export async function loadCliRegistry(path: string): Promise<CliRegistry> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new MadError("CONFIG", `无法读取 CLI 配置：${path}`, { cause: error });
  }
  try {
    return parseCliRegistry(TOML.parse(text));
  } catch (error) {
    if (error instanceof MadError) throw error;
    throw new MadError("CONFIG", `CLI 配置不是有效 TOML：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function resolveInvocation(registry: CliRegistry, cliId: string, presetId: string): {
  cli: CliConfig;
  preset: InvocationPreset;
} {
  const cli = registry.clis.find((item) => item.id === cliId);
  if (!cli) throw new MadError("CONFIG", `未知 CLI：${cliId}`);
  const preset = cli.presets.find((item) => item.id === presetId);
  if (!preset) throw new MadError("CONFIG", `未知调用预设：${cliId}/${presetId}`);
  return { cli, preset };
}

export function buildConfigTemplate(
  installed: readonly AdapterId[],
  detectedExecutables: Readonly<Partial<Record<AdapterId, string>>> = {},
): string {
  const header = `# mad init 只探测可执行文件，不猜测模型、思考等级或默认组局器。\n` +
    `# executable 默认保存 PATH 中的命令名，避免 CLI 升级后版本目录失效。\n` +
    `# 填写下列占位符后运行 mad config validate / mad config check。\n\n` +
    `[defaults.generator]\ncli = "REPLACE_WITH_CLI_ID"\npreset = "REPLACE_WITH_PRESET_ID"\n`;
  if (!installed.length) return `clis = []\n\n${header}`;
  const sections = installed.map((adapter) => {
    const options = adapter === "codex"
      ? `\n# 可选：取消注释并选择思考等级。\n# [clis.presets.options]\n# reasoning_effort = "minimal|low|medium|high|xhigh"\n`
      : adapter === "claude" || adapter === "grok"
      ? `\n# 可选：取消注释并选择 effort。\n# [clis.presets.options]\n# effort = "low|medium|high|xhigh|max"\n`
      : adapter === "pi"
      ? `\n# 可选：取消注释并选择 thinking。\n# [clis.presets.options]\n# thinking = "off|minimal|low|medium|high|xhigh|max"\n`
      : "";
    const executable = (detectedExecutables[adapter] ?? adapter).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `[[clis]]\nid = "${adapter}"\nadapter = "${adapter}"\nexecutable = "${executable}"\ntimeout_seconds = 300\nmax_concurrency = 1\n\n` +
      `[[clis.presets]]\nid = "default"\nmodel = "REPLACE_WITH_MODEL_ID"\ncontext_budget = 64000\n${options}`;
  });
  return `${header}\n${sections.join("\n")}`;
}
