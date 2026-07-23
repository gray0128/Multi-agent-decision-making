import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, readdir, realpath, stat, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createAdapter } from "../adapters/index.js";
import { loadCliRegistry, resolveInvocation, type CliRegistry } from "../adapters/config.js";
import { redactAdapterDiagnostic } from "../adapters/redact.js";
import type { PreflightResult } from "../adapters/types.js";
import { DEFAULT_LIMITS, SAFE_MAX_LIMITS, resolveLimits } from "../core/limits.js";
import type { AppPaths } from "../core/paths.js";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "../web/index.js";
import { renderMarkdown } from "../web/markdown.js";
import { publishExclusiveJson } from "./mailbox.js";
import { ArchiveStore } from "../archive/store.js";
import { SERVER_HOST } from "./constants.js";
import {
  ActiveLaunchConflict,
  LaunchCoordinator,
  type DeliberationProcessLauncher,
  type WebLaunchRequest,
} from "./launch-coordinator.js";

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,80}$/;

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function jsonLines(path: string): Promise<unknown[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function send(response: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  send(response, status, JSON.stringify({
    ...details,
    code,
    message: redactAdapterDiagnostic(message),
  }), "application/json; charset=utf-8");
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > 65_536) throw new Error("请求体过大");
    chunks.push(value);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

async function checkpoint(paths: AppPaths, id: string): Promise<unknown | null> {
  try {
    return await jsonFile(join(paths.runtime, "checkpoints", `${id}.request.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function detail(paths: AppPaths, id: string): Promise<Record<string, unknown>> {
  const root = join(paths.deliberations, id);
  const archive = new ArchiveStore(paths.deliberations, id);
  const [manifest, state, events, transcript, pending] = await Promise.all([
    archive.readManifest(),
    archive.readState(),
    archive.readEvents(),
    jsonLines(join(root, "transcript.jsonl")),
    checkpoint(paths, id),
  ]);
  let report = "";
  try { report = await readFile(join(root, "report.md"), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const renderedTranscript = transcript.map((record) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return record;
    const typed = record as Record<string, unknown>;
    return {
      ...typed,
      contentHtml: renderMarkdown(typeof typed.content === "string" ? typed.content : ""),
    };
  });
  return {
    manifest,
    state,
    events,
    transcript: renderedTranscript,
    checkpoint: pending,
    report,
    reportHtml: renderMarkdown(report),
  };
}

export interface ObserverServer {
  readonly token: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface ObserverServerDependencies {
  readonly loadRegistry?: () => Promise<CliRegistry>;
  readonly checkInvocation?: (
    cli: CliRegistry["clis"][number],
    preset: CliRegistry["clis"][number]["presets"][number],
  ) => Promise<PreflightResult>;
  readonly launchDeliberation?: DeliberationProcessLauncher;
}

interface PublicLaunchCli {
  readonly id: string;
  readonly presets: readonly {
    readonly id: string;
    readonly model: string;
    readonly contextBudget: number;
    readonly options: CliRegistry["clis"][number]["presets"][number]["options"];
    readonly available: boolean;
    readonly reason?: string;
  }[];
}

export async function startObserverServer(
  paths: AppPaths,
  port = 0,
  dependencies: ObserverServerDependencies = {},
): Promise<ObserverServer> {
  await Promise.all([paths.home, paths.deliberations, paths.runtime].map(async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }));
  const coordinator = new LaunchCoordinator(paths, dependencies.launchDeliberation);
  let launchOptionsCache: { expiresAt: number; registry: CliRegistry; clis: readonly PublicLaunchCli[] } | undefined;
  const token = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${SERVER_HOST}`);
      if (request.method === "GET" && url.pathname === "/") return send(response, 200, INDEX_HTML, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/styles.css") return send(response, 200, STYLES_CSS, "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js") return send(response, 200, APP_JS, "text/javascript; charset=utf-8");
      if (!url.pathname.startsWith("/api/") || !authorized(request, token)) {
        return sendError(response, 401, "UNAUTHORIZED", "Unauthorized");
      }
      if (request.method === "GET" && url.pathname === "/api/launch-options") {
        if (!launchOptionsCache || launchOptionsCache.expiresAt <= Date.now()) {
          const registry = await (dependencies.loadRegistry ?? (() => loadCliRegistry(paths.config)))();
          const check = dependencies.checkInvocation ?? ((cli, preset) => createAdapter(cli, preset).check(process.cwd()));
          const clis = await Promise.all(registry.clis.map(async (cli) => ({
            id: cli.id,
            presets: await Promise.all(cli.presets.map(async (preset) => {
              try {
                const result = await check(cli, preset);
                return {
                  id: preset.id,
                  model: preset.model,
                  contextBudget: preset.contextBudget,
                  options: preset.options,
                  available: result.ready,
                  ...(result.ready ? {} : { reason: redactAdapterDiagnostic(result.detail ?? "预检失败") }),
                };
              } catch (error) {
                return {
                  id: preset.id,
                  model: preset.model,
                  contextBudget: preset.contextBudget,
                  options: preset.options,
                  available: false,
                  reason: redactAdapterDiagnostic(error instanceof Error ? error.message : String(error)),
                };
              }
            })),
          })));
          launchOptionsCache = { expiresAt: Date.now() + 30_000, registry, clis };
        }
        const { registry, clis } = launchOptionsCache!;
        const activeId = await coordinator.currentDeliberationId();
        const active = activeId ? { id: activeId } : null;
        return send(response, 200, JSON.stringify({
          defaults: {
            mode: "structured",
            interaction: "guided",
            organizer: registry.defaults.generator,
            limits: DEFAULT_LIMITS,
          },
          limitRange: {
            minimums: Object.fromEntries(Object.keys(SAFE_MAX_LIMITS).map((key) => [key, 1])),
            maximums: SAFE_MAX_LIMITS,
          },
          clis,
          activeDeliberation: active,
          canLaunch: active === null,
        }), "application/json; charset=utf-8");
      }
      const launchMatch = /^\/api\/launches\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && launchMatch) {
        const requestId = decodeURIComponent(launchMatch[1]!);
        if (!REQUEST_ID.test(requestId)) return sendError(response, 400, "INVALID_REQUEST_ID", "Invalid request id");
        const record = await coordinator.read(requestId);
        return record
          ? send(response, 200, JSON.stringify(record), "application/json; charset=utf-8")
          : sendError(response, 404, "LAUNCH_NOT_FOUND", "Launch request not found");
      }
      if (request.method === "POST" && url.pathname === "/api/launches") {
        let payload: Record<string, unknown>;
        try { payload = await body(request); } catch (error) {
          return sendError(response, 400, "INVALID_REQUEST_BODY", error instanceof Error ? error.message : String(error));
        }
        const allowed = ["requestId", "topic", "mode", "interaction", "workspace", "organizer", "limits"];
        const extras = Object.keys(payload).filter((key) => !allowed.includes(key));
        if (extras.length) return sendError(response, 400, "UNKNOWN_FIELDS", `Unknown fields: ${extras.join(", ")}`);
        if (typeof payload.requestId !== "string" || !REQUEST_ID.test(payload.requestId)) {
          return sendError(response, 400, "INVALID_REQUEST_ID", "Invalid request id");
        }
        const existing = await coordinator.read(payload.requestId);
        if (existing) {
          return send(response, 200, JSON.stringify(existing), "application/json; charset=utf-8");
        }
        if (typeof payload.topic !== "string" || !payload.topic.trim() || payload.topic.trim().length > 5_000) {
          return sendError(response, 400, "INVALID_TOPIC", "topic must be 1 to 5000 characters");
        }
        if (payload.mode !== "structured" && payload.mode !== "free") {
          return sendError(response, 400, "INVALID_MODE", "Invalid mode");
        }
        const interaction = payload.interaction ?? "guided";
        if (interaction !== "guided" && interaction !== "auto") {
          return sendError(response, 400, "INVALID_INTERACTION", "Invalid interaction");
        }
        const activeId = await coordinator.currentDeliberationId(payload.requestId);
        if (activeId) {
          return sendError(response, 409, "ACTIVE_DELIBERATION", "当前 MAD_HOME 已有活动审议", {
            activeDeliberation: { id: activeId },
          });
        }
        const registry = await (dependencies.loadRegistry ?? (() => loadCliRegistry(paths.config)))();
        let organizer: WebLaunchRequest["organizer"];
        if (payload.organizer !== undefined) {
          if (typeof payload.organizer !== "object" || payload.organizer === null || Array.isArray(payload.organizer)) {
            return sendError(response, 400, "INVALID_ORGANIZER", "organizer must be an object");
          }
          const value = payload.organizer as Record<string, unknown>;
          if (Object.keys(value).some((key) => !["cli", "preset"].includes(key)) ||
            typeof value.cli !== "string" || typeof value.preset !== "string") {
            return sendError(response, 400, "INVALID_ORGANIZER", "Invalid organizer");
          }
          try { resolveInvocation(registry, value.cli, value.preset); } catch (error) {
            return sendError(response, 400, "INVALID_ORGANIZER", error instanceof Error ? error.message : String(error));
          }
          organizer = { cli: value.cli, preset: value.preset };
        }
        let limits: WebLaunchRequest["limits"];
        if (payload.limits !== undefined) {
          if (typeof payload.limits !== "object" || payload.limits === null || Array.isArray(payload.limits)) {
            return sendError(response, 400, "INVALID_LIMITS", "limits must be an object");
          }
          const value = payload.limits as Record<string, unknown>;
          const limitKeys = ["maxParticipants", "maxCalls", "maxDiscussionWindows", "timeoutSeconds", "contextBudget", "globalConcurrency"];
          if (Object.keys(value).some((key) => !limitKeys.includes(key))) {
            return sendError(response, 400, "INVALID_LIMITS", "Invalid limits fields");
          }
          try { limits = resolveLimits(value); } catch (error) {
            return sendError(response, 400, "INVALID_LIMITS", error instanceof Error ? error.message : String(error));
          }
        }
        let workspace: string | undefined;
        if (payload.workspace !== undefined) {
          if (typeof payload.workspace !== "string" || !payload.workspace.trim() || payload.workspace.length > 4_096) {
            return sendError(response, 400, "INVALID_WORKSPACE", "Invalid workspace");
          }
          const requestedWorkspace = payload.workspace.trim();
          if (!isAbsolute(requestedWorkspace)) {
            return sendError(response, 400, "INVALID_WORKSPACE", "Workspace must be an absolute path");
          }
          try {
            workspace = await realpath(requestedWorkspace);
            if (!(await stat(workspace)).isDirectory()) {
              return sendError(response, 400, "INVALID_WORKSPACE", "Workspace must be a directory");
            }
          } catch {
            return sendError(response, 400, "INVALID_WORKSPACE", "Workspace does not exist or is not accessible");
          }
        }
        const launchRequest: WebLaunchRequest = {
          requestId: payload.requestId,
          topic: payload.topic.trim(),
          mode: payload.mode,
          interaction,
          ...(workspace ? { workspace } : {}),
          ...(organizer ? { organizer } : {}),
          ...(limits ? { limits } : {}),
        };
        let record;
        try {
          record = await coordinator.launch(launchRequest);
        } catch (error) {
          if (error instanceof ActiveLaunchConflict) {
            return sendError(response, 409, "ACTIVE_DELIBERATION", error.message, {
              activeDeliberation: { id: error.deliberationId },
            });
          }
          throw error;
        }
        const status = record.status === "failed" ? 500 : record.status === "planning" ? 201 : 202;
        if (record.status === "failed") {
          return sendError(response, status, "LAUNCH_FAILED", record.error ?? "启动失败", { ...record });
        }
        return send(response, status, JSON.stringify(record), "application/json; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/api/deliberations") {
        await mkdir(paths.deliberations, { recursive: true, mode: 0o700 });
        const entries = await readdir(paths.deliberations, { withFileTypes: true });
        const loaded = await Promise.all(entries.filter((entry) => entry.isDirectory() && ID.test(entry.name)).map(async (entry) => {
          try {
            const value = await detail(paths, entry.name);
            const manifest = value.manifest as { id: string; question: string; mode: string; createdAt: string };
            const state = value.state as { status: string };
            return { id: manifest.id, question: manifest.question, mode: manifest.mode, createdAt: manifest.createdAt, status: state.status };
          } catch {
            return null;
          }
        }));
        const records = loaded.filter((record): record is NonNullable<typeof record> => record !== null);
        records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return send(response, 200, JSON.stringify(records), "application/json; charset=utf-8");
      }
      const agentIdMatch = /^\/api\/deliberations\/([^/]+)\/agent-id$/.exec(url.pathname);
      if (request.method === "POST" && agentIdMatch) {
        const id = decodeURIComponent(agentIdMatch[1]!);
        if (!ID.test(id)) return sendError(response, 400, "INVALID_DELIBERATION_ID", "Invalid id");
        const archive = new ArchiveStore(paths.deliberations, id);
        const [manifest, state] = await Promise.all([archive.readManifest(), archive.readState()]);
        if (manifest.plan || !["planning", "waiting_checkpoint"].includes(state.status)) {
          return sendError(response, 409, "PLAN_EDITS_CLOSED", "Deliberation is not accepting plan edits");
        }
        const existing = new Set((manifest.planning?.candidatePlan?.participants ?? []).map((agent) => agent.id));
        let agentId = "";
        do { agentId = `agent-${randomBytes(6).toString("hex")}`; } while (existing.has(agentId));
        return send(response, 201, JSON.stringify({ id: agentId }), "application/json; charset=utf-8");
      }
      const detailMatch = /^\/api\/deliberations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]!);
        if (!ID.test(id)) return sendError(response, 400, "INVALID_DELIBERATION_ID", "Invalid id");
        return send(response, 200, JSON.stringify(await detail(paths, id)), "application/json; charset=utf-8");
      }
      const eventsMatch = /^\/api\/deliberations\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1]!);
        if (!ID.test(id)) return sendError(response, 400, "INVALID_DELIBERATION_ID", "Invalid id");
        let offset = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
        if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const publish = async (): Promise<void> => {
          const events = await new ArchiveStore(paths.deliberations, id).readEvents();
          while (offset < events.length) {
            response.write(`id:${offset}\ndata:${JSON.stringify(events[offset])}\n\n`);
            offset += 1;
          }
        };
        await publish();
        const timer = setInterval(() => void publish().catch(() => response.end()), 500);
        request.once("close", () => clearInterval(timer));
        return;
      }
      const respondMatch = /^\/api\/checkpoints\/([^/]+)\/respond$/.exec(url.pathname);
      if (request.method === "POST" && respondMatch) {
        const id = decodeURIComponent(respondMatch[1]!);
        if (!ID.test(id)) return sendError(response, 400, "INVALID_DELIBERATION_ID", "Invalid id");
        const requestPath = join(paths.runtime, "checkpoints", `${id}.request.json`);
        let pending: {
          checkpointId: string;
          kind?: string;
          actions: string[];
          data?: { candidateVersion?: unknown };
        };
        try {
          pending = await jsonFile(requestPath) as { checkpointId: string; actions: string[] };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return sendError(response, 409, "NO_CURRENT_CHECKPOINT", "No current checkpoint");
          }
          throw error;
        }
        let payload: Record<string, unknown>;
        try { payload = await body(request); } catch (error) {
          return sendError(response, 400, "INVALID_REQUEST_BODY", error instanceof Error ? error.message : String(error));
        }
        const guidance = payload.guidance ?? "";
        if (pending.kind === "plan_confirmation") {
          const allowed = new Set(["checkpointId", "action", "candidateVersion", "guidance", "data"]);
          const extras = Object.keys(payload).filter((key) => !allowed.has(key));
          if (extras.length) return sendError(response, 400, "UNKNOWN_FIELDS", `Unknown fields: ${extras.join(", ")}`);
          if (payload.candidateVersion !== pending.data?.candidateVersion) {
            return sendError(response, 409, "STALE_CANDIDATE_VERSION", "Stale candidate version");
          }
          if (payload.action === "replace" && (
            typeof payload.data !== "object" || payload.data === null || Array.isArray(payload.data)
          )) return sendError(response, 400, "INVALID_REPLACEMENT_PLAN", "Replacement plan must be an object");
          if (payload.action !== "replace" && payload.data !== undefined) {
            return sendError(response, 400, "UNEXPECTED_PLAN_DATA", "Checkpoint action does not accept plan data");
          }
        }
        if (
          payload.checkpointId !== pending.checkpointId ||
          typeof payload.action !== "string" ||
          !pending.actions.includes(payload.action) ||
          typeof guidance !== "string" ||
          guidance.length > 5_000
        ) {
          return sendError(response, 409, "INVALID_CHECKPOINT_RESPONSE", "Stale or invalid checkpoint response");
        }
        const responsePath = join(paths.runtime, "checkpoints", `${id}.response.json`);
        if (!await publishExclusiveJson(responsePath, {
          checkpointId: payload.checkpointId,
          action: payload.action,
          guidance,
          ...(payload.data === undefined ? {} : { data: payload.data }),
          at: new Date().toISOString(),
        })) return sendError(response, 409, "CHECKPOINT_ALREADY_ANSWERED", "Checkpoint already answered");
        return send(response, 202, JSON.stringify({ accepted: true }), "application/json; charset=utf-8");
      }
      return sendError(response, 404, "NOT_FOUND", "Not found");
    } catch (error) {
      return sendError(
        response,
        500,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, SERVER_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法确定观察服务端口");
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const heartbeat = join(paths.runtime, "server.json");
  const temporary = `${heartbeat}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ pid: process.pid, port: address.port, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, heartbeat);
  return {
    token,
    port: address.port,
    url: `http://${SERVER_HOST}:${address.port}/#token=${encodeURIComponent(token)}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      try { await unlink(heartbeat); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
  };
}
