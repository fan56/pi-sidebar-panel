# pi-sidebar-panel

A standalone [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that renders a live right-side sidebar panel in the TUI, showing your current **Todos**, **Sub-agents**, **LSP servers** and **MCP servers** at a glance.

[![npm version](https://img.shields.io/npm/v/@aiwayds/pi-sidebar-panel)](https://www.npmjs.com/package/@aiwayds/pi-sidebar-panel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Todos** — mirrors the agent's active `todo` tool state (pending / in-progress / completed), synced from `tool_result` events and replayed from the session branch on start.
- **Sub-agents** — live tracking of running, done and failed sub-agents with elapsed time, fed by [`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents) EventBus events and persisted session records. Done agents render dim + strikethrough.
- **LSP** — lists the language servers from `.pi/lsp.json` (or `~/.pi/agent/lsp.json`) and whether each server binary is available on `PATH`.
- **MCP** — lists the MCP servers from `mcp.json` (or `~/.pi/agent/mcp.json`) and whether each server process is currently running.

## Requirements

- pi >= 0.83.0.

### Dependencies by section

| Section | Requires install | Requires config | Notes |
| --- | --- | --- | --- |
| Todos | none | none | mirrors the agent's todo tool — empty until used |
| Sub-agents | `@tintinweb/pi-subagents` via `pi install` | none | EventBus events + session replay; section idle without it |
| LSP | none | `.pi/lsp.json` or `~/.pi/agent/lsp.json` | PATH check |
| MCP | none | `mcp.json` or `~/.pi/agent/mcp.json` | pgrep running check |

## Configuration

### lsp.json

The LSP section reads a `servers` object from the project file `.pi/lsp.json`, falling back to the global `~/.pi/agent/lsp.json` (project wins when both exist). Each entry's `command` is checked for availability on `PATH`.

```json
{
  "servers": {
    "typescript": { "command": "typescript-language-server" },
    "go": { "command": "gopls" },
    "python": { "command": "pyright-langserver", "args": ["--stdio"] }
  }
}
```

Only the `command` field is used by this panel; other fields (e.g. `args`) are ignored by the panel's display. If no `lsp.json` is found, the section shows `(no config)`.

### mcp.json

The MCP section reads an `mcpServers` object from the project file `mcp.json`, falling back to the global `~/.pi/agent/mcp.json` (project wins when both exist). For each entry it derives a process name from `command` (the basename) and runs `pgrep -f` to show the server as running or stopped.

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

If no `mcp.json` is found, the section shows `(no config)`.

## Installation

With the pi package manager:

```
pi install npm:@aiwayds/pi-sidebar-panel
```

Or add `"npm:@aiwayds/pi-sidebar-panel"` to the `packages` array in `~/.pi/agent/settings.json` and restart pi.

**Local development:** add the absolute path to this directory (e.g. `/path/to/pi-sidebar-panel`) to the `packages` array instead, or run `pi -e /path/to/pi-sidebar-panel`.

To enable the **Sub-agents** section, also install [`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents):

```
pi install npm:@tintinweb/pi-subagents
```

## Usage

The panel **auto-starts by default** at session start. Control it with the `/sidebar` command:

| Command | Effect |
| --- | --- |
| `/sidebar` | Toggle on/off |
| `/sidebar on` | Enable the panel |
| `/sidebar off` | Disable the panel |
| `/sidebar status` | Show current state |

## How it works

- The panel listens to the shared EventBus events `subagents:started` / `subagents:completed` / `subagents:failed` **continuously for the whole process lifetime** — regardless of whether the panel is visible. Agents that start or finish while the panel is hidden are still captured and appear when it is re-enabled.
- On start, the panel replays persisted `subagents:record` entries from the session branch, so agents that finished before the panel was enabled are reconstructed (latest record per id wins; a live running entry takes priority over a stale record).
- Done agents render **dim + strikethrough**. Note that strikethrough (SGR 9) is stripped by tmux/cmux when the terminal terminfo lacks `smxx`/`rmxx` — in that case the agent falls back to dim only.
- Live done/error history is pruned after **60 s**; replayed (historical) entries are pruned **5 minutes** after being shown, so the panel reflects current session activity without growing unbounded.
- The overlay is anchored top-right, non-capturing, and repaints on a 5 s interval (line-diffed, so idle cycles write nothing to the terminal).

## Development

```
npm install
npm test          # regression harness (node test/regression.mjs)
npm run typecheck # tsc --noEmit
```

## License

MIT
