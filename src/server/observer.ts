import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, readdir, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "../core/paths.js";
import { APP_JS, INDEX_HTML, STYLES_CSS } from "../web/index.js";
import { renderMarkdown } from "../web/markdown.js";
import { publishExclusiveJson } from "./mailbox.js";
import { ArchiveStore } from "../archive/store.js";
import { SERVER_HOST } from "./constants.js";

const ID = /^[a-zA-Z0-9_-]{1,80}$/;

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

export async function startObserverServer(paths: AppPaths, port = 0): Promise<ObserverServer> {
  await Promise.all([paths.home, paths.deliberations, paths.runtime].map(async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }));
  const token = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${SERVER_HOST}`);
      if (request.method === "GET" && url.pathname === "/") return send(response, 200, INDEX_HTML, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/styles.css") return send(response, 200, STYLES_CSS, "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js") return send(response, 200, APP_JS, "text/javascript; charset=utf-8");
      if (!url.pathname.startsWith("/api/") || !authorized(request, token)) return send(response, 401, "Unauthorized");
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
      const detailMatch = /^\/api\/deliberations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]!);
        if (!ID.test(id)) return send(response, 400, "Invalid id");
        return send(response, 200, JSON.stringify(await detail(paths, id)), "application/json; charset=utf-8");
      }
      const eventsMatch = /^\/api\/deliberations\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1]!);
        if (!ID.test(id)) return send(response, 400, "Invalid id");
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
        if (!ID.test(id)) return send(response, 400, "Invalid id");
        const requestPath = join(paths.runtime, "checkpoints", `${id}.request.json`);
        let pending: { checkpointId: string; actions: string[] };
        try {
          pending = await jsonFile(requestPath) as { checkpointId: string; actions: string[] };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return send(response, 409, "No current checkpoint");
          throw error;
        }
        let payload: Record<string, unknown>;
        try { payload = await body(request); } catch (error) {
          return send(response, 400, error instanceof Error ? error.message : String(error));
        }
        const guidance = payload.guidance ?? "";
        if (
          payload.checkpointId !== pending.checkpointId ||
          typeof payload.action !== "string" ||
          !pending.actions.includes(payload.action) ||
          typeof guidance !== "string" ||
          guidance.length > 5_000
        ) {
          return send(response, 409, "Stale or invalid checkpoint response");
        }
        const responsePath = join(paths.runtime, "checkpoints", `${id}.response.json`);
        if (!await publishExclusiveJson(responsePath, {
          checkpointId: payload.checkpointId,
          action: payload.action,
          guidance,
          at: new Date().toISOString(),
        })) return send(response, 409, "Checkpoint already answered");
        return send(response, 202, JSON.stringify({ accepted: true }), "application/json; charset=utf-8");
      }
      return send(response, 404, "Not found");
    } catch (error) {
      return send(response, 500, error instanceof Error ? error.message : String(error));
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
