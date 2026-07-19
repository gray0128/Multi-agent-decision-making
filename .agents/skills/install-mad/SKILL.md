---
name: install-mad
description: Install, initialize, verify, upgrade, or uninstall the Multi Agent Decision (`mad`) CLI on macOS from a local checkout, the canonical Git repository, or a Python wheel. Use when a user asks to set up this project on another computer, repair a `mad` installation, make the command available on PATH, initialize `agents.toml`, check detected AI CLI participants, upgrade an existing installation, or remove the tool.
---

# Install Multi Agent Decision

Install `mad` as an isolated Python tool with `uv`. Preserve existing configuration and explain separately which external AI CLIs are ready.

## Inspect first

Run read-only checks before changing the machine:

```bash
uname -s
command -v uv
command -v python3.12
command -v mad
```

Require macOS and Python 3.12. This project currently declares `>=3.12,<3.13` and does not formally support other operating systems.

If `uv` or Python 3.12 is missing, report the missing prerequisite and install it only within the user's authorization and the environment's approval policy. Use the official installation channel available on that machine. Do not alter shell startup files silently.

## Choose the source

Use the first matching source:

1. Use a user-specified wheel when provided.
2. Use a user-specified or current checkout when its `pyproject.toml` declares `name = "multi-agent-decision"`.
3. Otherwise install from the canonical repository:
   `https://github.com/gray0128/Multi-agent-decision-making.git`.

Honor a requested tag, commit, branch, or wheel version. Do not silently replace it with the latest revision.

## Install

For a local checkout, run from its repository root:

```bash
uv tool install .
```

For a wheel:

```bash
uv tool install /absolute/path/to/multi_agent_decision-VERSION-py3-none-any.whl
```

For the canonical Git repository:

```bash
uv tool install "git+https://github.com/gray0128/Multi-agent-decision-making.git"
```

Do not use `uv sync` for an end-user installation; that creates a development environment rather than the globally available isolated `mad` tool.

If `uv` reports that the tool already exists, inspect the installed command and ask whether the user wants an upgrade or forced reinstall before replacing it.

## Resolve PATH

After a successful install, run:

```bash
command -v mad
mad --help
```

If `mad` is not found, explain that `uv`'s tool bin directory is not on PATH. Offer:

```bash
uv tool update-shell
```

Run it only after telling the user that it updates shell configuration. Ask the user to start a new terminal afterward; do not claim the current shell has automatically reloaded.

## Initialize safely

Initialize the application and display detected participants:

```bash
mad init
mad agents
```

`mad init` is safe for an existing installation because it does not overwrite an existing registry. Never run `mad init --force` unless the user explicitly requests regeneration and the existing file has been backed up.

The default data directory is:

```text
~/Library/Application Support/MultiAgentDecision/
```

For an isolated test, set `MAD_HOME` to a dedicated explicit directory. Do not repurpose `HOME` or `CODEX_HOME`.

Check the `mad agents` output. A usable deliberation needs at least two enabled, installed, authenticated AI CLIs that support non-interactive invocation. Supported adapters include Codex, Claude Code, Reasonix, Grok, Pi, CodeBuddy, and Antigravity CLI (`agy`). Installation of `mad` does not install or authenticate those external CLIs.

Do not write API keys, tokens, passwords, or login state into `agents.toml`. Authentication remains owned by each external CLI.

## Verify

Treat these as the default verification commands:

```bash
mad --help
mad agents
```

Do not start `mad serve` or run a paid/model-backed deliberation merely to verify installation. Run a real deliberation only when the user asks for an end-to-end test and understands it invokes external AI services.

Report:

- installation source;
- resolved `mad` executable path;
- whether initialization succeeded;
- enabled and unavailable Agent IDs;
- missing prerequisites or authentication work;
- whether a new terminal is required for PATH changes.

Do not report the installation as fully ready for deliberation when fewer than two Agents are enabled and usable.

## Upgrade

Preserve `~/Library/Application Support/MultiAgentDecision/`; upgrades must not reset `agents.toml` or delete deliberation archives.

From a local checkout:

```bash
git pull --ff-only
uv tool install --force .
```

Only pull when the user asked to update the checkout and local repository state makes a fast-forward safe. Do not discard local changes.

From the canonical repository:

```bash
uv tool install --force "git+https://github.com/gray0128/Multi-agent-decision-making.git"
```

For a wheel, repeat `uv tool install --force` with the new wheel path. Re-run `mad --help` and `mad agents` afterward.

## Uninstall

When explicitly requested, remove the installed tool with:

```bash
uv tool uninstall multi-agent-decision
```

Explain that this leaves application data and audit archives in the Application Support directory. Delete that directory only through a separate, explicit user request after showing the exact target and warning that the removal is destructive.
