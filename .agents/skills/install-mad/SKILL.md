---
name: install-mad
description: Install, initialize, configure, verify, upgrade, repair, or uninstall the TypeScript Multi Agent Decision (`mad`) CLI on macOS from a local checkout, the canonical Git repository, or an npm package tarball. Use whenever a user asks to set up this project on another computer, make `mad` available on PATH, create or repair `clis.toml`, validate or preflight AI CLI adapters, preserve an existing MAD installation while upgrading it, or remove the command and optionally its application data.
---

# Install Multi Agent Decision

Install the current TypeScript `mad` CLI as a global npm package. Preserve configuration and deliberation archives, distinguish static validation from paid model-backed preflight, and report external AI CLI readiness separately from installation success.

## Inspect before changing anything

Run read-only checks first:

```bash
uname -s
command -v node
node --version
command -v npm
npm --version
command -v mad
npm list --global --depth=0 multi-agent-decision
```

The package requires Node.js 22 or newer. macOS is the currently accepted end-user platform. If Node.js or npm is missing or too old, explain the prerequisite and install or upgrade it only within the user's authorization and the environment's approval policy. Use an official installation channel available on that machine, and do not silently alter shell startup files.

If `mad` already exists, resolve its path and inspect the global package before replacing it. Do not assume every command named `mad` belongs to this project.

## Choose the installation source

Use the first matching source:

1. Use a user-specified `.tgz` npm package tarball when provided.
2. Use a user-specified or current checkout when `package.json` declares `"name": "multi-agent-decision"`.
3. Otherwise clone the canonical repository into a user-approved destination:
   `https://github.com/gray0128/Multi-agent-decision-making.git`.

Honor a requested tag, commit, or branch. Do not silently replace it with the latest revision. A source checkout must be built before global installation because `dist/` is generated and is not stored in Git; therefore, do not install directly from the Git URL with `npm install --global git+...`.

## Install

### From a checkout

From the repository root, confirm the package identity, install the locked dependencies, build, and then install the built package globally:

```bash
node -p "require('./package.json').name"
npm ci
npm run build
npm install --global .
```

`npm ci` and the global install can access the network and modify the machine. Follow the environment's approval policy. Do not use `npm link` for a normal end-user installation because it leaves the command coupled to a mutable checkout.

### From a package tarball

Install an absolute, explicitly resolved path:

```bash
npm install --global /absolute/path/to/multi-agent-decision-VERSION.tgz
```

Do not use an unresolved glob when more than one tarball could match. A release tarball must contain `dist/cli/index.js`; if provenance or contents are uncertain, inspect it with `npm pack --dry-run` from its source checkout or `tar -tf` before installation.

### From the canonical repository

Clone the requested revision into a user-approved destination, then use the checkout workflow:

```bash
git clone https://github.com/gray0128/Multi-agent-decision-making.git /absolute/path/to/Multi-agent-decision-making
cd /absolute/path/to/Multi-agent-decision-making
npm ci
npm run build
npm install --global .
```

Use `git clone --branch <tag-or-branch>` when the user requested one. For a commit, clone first and then check out the exact commit. Do not discard or overwrite an existing destination.

## Resolve PATH

After installation, run:

```bash
command -v mad
mad --help
npm list --global --depth=0 multi-agent-decision
```

If npm reports success but `mad` is not found, inspect the global prefix:

```bash
npm prefix --global
```

On macOS and other Unix-like installations, the executable is normally under the prefix's `bin` directory. Explain the exact directory that must be added to PATH. Offer a shell-specific change, but do not edit startup files without permission and do not claim the current shell has reloaded.

## Initialize without losing data

The current default application directory is:

```text
~/Library/Application Support/MultiAgentDecisionTS/
```

Its CLI registry is `config/clis.toml`. For isolated testing, set `MAD_HOME` to a dedicated explicit directory; never repurpose `HOME`, `CODEX_HOME`, or another broad system variable.

Before initialization, check whether the registry exists. Then run:

```bash
mad init
```

`mad init` creates private config, archive, and runtime directories; probes supported executable names on PATH; and writes a `clis.toml` skeleton. It refuses to overwrite an existing registry. Treat that refusal as data protection, not as a failed installation.

Never run `mad init --force` unless the user explicitly requests registry regeneration and the existing `clis.toml` has first been copied to a clearly reported backup path. `--force` replaces the registry skeleton; it is not an installation repair command.

Initialization detects Codex, Claude Code, Reasonix, Grok, Pi, CodeBuddy, and Antigravity CLI (`agy`). It does not install them, authenticate them, or infer model IDs. Update the generated placeholders, invocation presets, and `[defaults.generator]` using models actually available to the user's accounts. Never put API keys, tokens, passwords, or login state in `clis.toml`; authentication remains owned by each external CLI.

## Validate and preflight

Use the checks in increasing order of side effects:

```bash
mad --help
mad config validate
```

`mad config validate` checks TOML schema, references, enums, and the default organizer without invoking a model. It is the default configuration verification.

The following command performs a real minimal `READY` invocation for every configured CLI/preset combination:

```bash
mad config check
```

Run `mad config check` only after telling the user that it uses existing external CLI authentication, sends model requests, and may consume quota or incur charges. Do not run a deliberation or start `mad serve` merely to verify installation.

A deliberation plan requires at least two temporary Agent roles. Those roles may share one trusted CLI/preset, although shared origins are not independent model corroboration. Do not claim that two different installed AI CLIs are a hard installation requirement.

Report:

- selected source and revision or tarball;
- resolved `mad` executable path and installed npm package entry;
- whether `mad --help` succeeded;
- whether initialization created a new registry or preserved an existing one;
- the exact `MAD_HOME` and `clis.toml` path in use;
- whether static validation passed;
- whether model-backed preflight was skipped, passed, or failed for any CLI/preset;
- missing external CLIs, model configuration, or authentication work;
- whether a new terminal is required for PATH changes.

Distinguish these states clearly: command installed, registry initialized, registry statically valid, and model-backed preflight ready.

## Upgrade or repair

Preserve `~/Library/Application Support/MultiAgentDecisionTS/`. Reinstalling the npm package must not reset `clis.toml` or remove deliberation archives.

For a local checkout, inspect the worktree before pulling. Only update the checkout when the user asked, and use a fast-forward-only pull when its state is safe:

```bash
git status --short
git pull --ff-only
npm ci
npm run build
npm install --global .
```

Do not discard local changes. If the user wants to keep the checkout at its current revision, omit the pull and rebuild that revision. For a new tarball, repeat `npm install --global` with its exact path.

After an upgrade or repair, rerun `command -v mad`, `mad --help`, and `mad config validate`. Run `mad config check` only with the model-backed preflight consent described above. Do not rerun `mad init` on a healthy existing registry.

## Uninstall

Only when explicitly requested, remove the global command:

```bash
npm uninstall --global multi-agent-decision
```

Verify that the npm package entry is gone and explain that uninstalling the command leaves configuration and deliberation archives under the application directory. Delete that directory only through a separate explicit request after resolving and displaying the exact target, warning that deletion is destructive, and following the environment's destructive-action approval policy.
