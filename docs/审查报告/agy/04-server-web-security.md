# Server, Web Interface, local Authentication, and Workspace Security Compliance Review

## 1. Review Scope and Methods

This review verifies the compliance of the local server, web interface, dynamic authentication, checkpoints/SIGINT handling, and workspace read-only safety with the target architecture defined in `docs/TypeScript目标架构.md` (§10 Checkpoint Actions, §11 Observation Service and Page, §12 Local Authentication, §15 Workspace and Security, and §16 related).

The review was performed by inspecting the following source code and tests, and running the test suite:
- **Server and Mailbox**:
  - [src/server/constants.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/constants.ts)
  - [src/server/observer.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts)
  - [src/server/mailbox.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/mailbox.ts)
- **Frontend / Web**:
  - [src/web/index.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts)
  - [src/web/markdown.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/markdown.ts)
- **Checkpoints and Deliberation Loops**:
  - [src/cli/index.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts)
  - [src/core/structured.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts)
  - [src/core/discussion.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts)
- **Security & Workspace Safety**:
  - [src/adapters/read-only.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/read-only.ts)
  - [src/adapters/codex.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/codex.ts)
  - [src/adapters/generic.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/generic.ts)
  - [src/core/planning.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts)
- **Unit and E2E Tests**:
  - [tests-ts/observer.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/observer.test.ts)
  - [tests-ts/read-only.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/read-only.test.ts)
  - [tests-ts/mailbox.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/mailbox.test.ts)
  - [tests-ts/interrupt.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/interrupt.test.ts)
  - [tests-ts/cli-e2e.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/cli-e2e.test.ts)

---

## 2. Conforming Items

### 2.1 Checkpoint Actions and SIGINT Handling (§10)

- **Checkpoint Actions**: Supported checkpoint actions are mapped to the core deliberation state and strictly checked.
  - In [src/cli/index.ts:L264-309](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L264-309) (`coordinatedStructuredCheckpoint`), the structured deliberation checkpoint supports `["continue", "guide", "pause", "cancel"]`.
  - In [src/cli/index.ts:L311-351](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L311-351) (`coordinatedDiscussionCheckpoint`), the free discussion checkpoint supports `["continue", "guide", "end", "pause", "cancel"]`.
  - Core discussion transitions (e.g. `action === "end"`) successfully terminate deliberation loop and proceed to reporting in `DiscussionController` (see `src/core/discussion.ts`).
  - Core errors are thrown appropriately: `action === "pause"` throws `MadError("PAUSED")` and `action === "cancel"` throws `MadError("CANCELLED")`. (Refer to [src/core/structured.ts:L220-221](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts#L220-221) and `src/core/discussion.ts:L244-245`).
- **SIGINT / Interrupt handling**:
  - The CLI registers a single SIGINT event listener using an `AbortController` in [src/cli/index.ts:L445-447](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L445-447).
  - The abort signal triggers process-level termination of child CLI tasks. In [src/adapters/process.ts:L55-60](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/process.ts#L55-60), the runner detects the abort signal and terminates child processes via group-SIGTERM (and fallback SIGKILL after 2s).
  - The CLI gracefully handles the abort, sets the deliberation status to `paused`, and exits with exit code `20` (`EXIT_CODES.PAUSED`) as defined in [src/core/errors.ts:L32](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/errors.ts#L32), ensuring full recoverability.
- **First Response Wins**:
  - The checkpoint coordination mailbox uses atomic file manipulation (creating a temp file and linking it via `link()`) in [src/server/mailbox.ts:L22-34](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/mailbox.ts#L22-34). The first process to write to `response.json` succeeds, and any subsequent writes fail with `EEXIST` (first response wins).
  - The mailbox `wait` loop monitors for a matching `checkpointId` in [src/server/mailbox.ts:L78-83](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/mailbox.ts#L78-83), discarding stale, repeated, or mismatched responses.

### 2.2 Observation Service and Page (§11)

- **Independent Execution & File Mailbox**:
  - The observation service is started independently via `mad serve` ([src/cli/index.ts:L714-726](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L714-726)). It runs as a detached process without interfering with active deliberations.
  - Communication is strictly structured through a user-private mailbox directory under `paths.runtime/checkpoints` ([src/server/observer.ts:L59-66](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L59-66)). The server cannot mutate the deliberation archives directly; it only writes one-shot `response.json` response files.
- **Static Page with no Frameworks**:
  - The frontend assets (`INDEX_HTML`, `STYLES_CSS`, and `APP_JS`) are served as static strings directly by the server in [src/server/observer.ts:L117-119](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L117-119).
  - The scripts in [src/web/index.ts:L20-33](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts#L20-33) (`APP_JS`) are pure vanilla JavaScript. No frontend frameworks, router libraries, or global state stores are loaded.
- **Independent Markdown Sanitization**:
  - All Markdown processing is performed on the server. [src/server/observer.ts:L87, L97](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L87) invokes `renderMarkdown` before serving text.
  - `renderMarkdown` in [src/web/markdown.ts:L4-25](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/markdown.ts#L4-25) utilizes `marked` for parsing and `sanitizeHtml` to strip out execution scripts or styles (preventing HTML injection).
- **SSE Stream Format**:
  - The EventStream API endpoint `/api/deliberations/:id/events` in [src/server/observer.ts:L144-167](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L144-167) only reads and streams committed, structured archive events (`events.jsonl`).
  - No token streams, raw console outputs, or reasoning traces are exposed to the stream. Individual participant contents are only displayable after they have been formally committed to the transcript ledger (`invocation.committed` event, which triggers fetching the full transcript).

### 2.3 Local Authentication (§12)

- **Strict Localhost Binding**:
  - The observation server listens exclusively on `127.0.0.1` as defined by `SERVER_HOST` in [src/server/constants.ts:L1](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/constants.ts#L1). This prevents any LAN or public accessibility.
- **Dynamic Bearer Token**:
  - Every server start generates a cryptographically random token: `randomBytes(32).toString("base64url")` ([src/server/observer.ts:L113](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L113)).
  - The token is served to the page via a URL fragment `#token=...` ([src/server/observer.ts:L222](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L222)).
  - The token is NOT saved to the local heartbeat file `server.json` ([src/server/observer.ts:L215-218](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L215-218)).
- **Fragment Extraction and SessionStorage**:
  - The frontend reads the URL fragment hash, writes it to `sessionStorage` under `'mad-observer-token'`, and immediately strips it from the address bar using `history.replaceState()` ([src/web/index.ts:L21](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts#L21)).
  - Authentication checks utilize a constant-time comparison helper `timingSafeEqual` in [src/server/observer.ts:L38-43](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L38-43) to block timing attacks on the Bearer header.

### 2.4 Workspace Safety and Security (§15)

- **Direct Read-Only Authorization**:
  - Project deliberation relies on the explicit command-line argument `--workspace <path>` ([src/cli/index.ts:L409](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L409)) which translates directly to a `direct-read-only` workspace specification, recorded directly in `manifest.json`.
  - Risk warnings are printed to `stderr` and written directly to the event logs ([src/cli/index.ts:L414, L474](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L414)).
- **Canary Capability Checks**:
  - Before starting a project deliberation, every unique CLI/preset combination is preflighted. In [src/core/planning.ts:L197](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L197), the system checks if the adapter supports read-only constraints (`projectReadOnlyCapability !== "unsupported"`).
  - The system runs the runtime check `verifyProjectReadOnly` ([src/core/planning.ts:L213](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L213)).
  - The actual runtime test is implemented in [src/adapters/read-only.ts:L30-68](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/read-only.ts#L30-68) (`verifyReadOnlyWithCanary`). It constructs a temporary directory, writes a random UUID nonce to `readable.txt`, instructs the CLI to read it and attempt to create `must-not-exist.txt` in the same directory, and verifies that the output correctly reports the nonce and that writing was blocked.

---

## 3. Deviations/Issues Found

**No deviations or compliance issues were found.**

The codebase fully maps to all specifications, and the TypeScript implementation behaves correctly. Security practices (such as private permissions `0o700` and `0o600` on directories and database files, constant-time token comparison, and sandbox-based execution) are strictly followed.

---

## 4. Summary and Rating

The TypeScript server, web client, local authentication, and security checkpoint logic are implemented to the highest standards. All parts of the target architecture are successfully realized and covered by comprehensive automated tests (including unit and end-to-end integration tests).

### Final Rating: **Green (Fully Compliant)**
