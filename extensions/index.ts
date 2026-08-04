/**
 * @aiwayds/pi-sidebar-panel — Right-side sidebar panel for pi-coding-agent
 *
 * A standalone pi-coding-agent extension that renders a right-side TUI
 * overlay showing live Todos, Sub-agents, LSP and MCP status. Extracted from
 * the combined pi-ext-fan extension; this package contains only the sidebar
 * feature.
 *
 * The panel is OFF by default; enable it with /sidebar on. Control it with:
 *   /sidebar          — toggle on/off
 *   /sidebar on       — enable
 *   /sidebar off      — disable
 *   /sidebar status   — show current state
 */

// SDK 0.83.0 moved the Theme type out of pi-tui into pi-coding-agent; the
// custom() factory below receives exactly this Theme.
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, accessSync, readFileSync } from "node:fs";

const DONE_TTL_MS = 60_000; // completed todos / done agents auto-clear after 60s

// ═══════════════════════════════════════════════════════════════════
// Sidebar state
// ═══════════════════════════════════════════════════════════════════

// The only module-level toggle: default OFF — the panel stays hidden until
// explicitly enabled. Control with /sidebar [on|off|status].
let sidebarEnabled = false;

// Hide the sidebar when the terminal is too narrow for it to coexist with
// the main chat pane (38-col panel + ~62-col minimum main pane).
const MIN_TERM_WIDTH_FOR_SIDEBAR = 100;

// ── Todo ──

interface TodoTask {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	activeForm?: string;
}

let todoTasks: TodoTask[] = [];
const activeFormCache = new Map<number, string>();
const todoCompletedMs = new Map<number, number>(); // todo id → completion timestamp (local, since snapshots carry none)
const sweptTodoIds = new Set<number>(); // tombstone: completed todo ids whose 60s window was swept — must not re-arm

// Todo snapshots carry no completion timestamp, so record when we first
// observe each id as completed; drop timestamps for ids no longer present.
function recordTodoCompletionTimes(tasks: TodoTask[], now = Date.now()): void {
	const seen = new Set<number>();
	for (const t of tasks) {
		if (t.status === "completed") {
			// A swept (tombstoned) completed id must never re-arm the 60s
			// window — its auto-clear already fired.
			if (sweptTodoIds.has(t.id)) continue;
			seen.add(t.id);
			if (!todoCompletedMs.has(t.id)) todoCompletedMs.set(t.id, now);
		} else {
			// A fresh non-completed appearance clears any prior sweep state:
			// a future completion of this id is a genuine new event.
			todoCompletedMs.delete(t.id);
			sweptTodoIds.delete(t.id);
		}
	}
	for (const [id] of todoCompletedMs)
		if (!seen.has(id)) todoCompletedMs.delete(id);
}

function replayTodos(sessionManager: { getBranch(): Iterable<unknown> }): void {
	for (const entry of sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		const d = msg.details as { tasks?: TodoTask[] } | undefined;
		if (d?.tasks && Array.isArray(d.tasks)) {
			todoTasks = d.tasks.map((t) => ({ ...t }));
			recordTodoCompletionTimes(todoTasks);
			todoTasks = todoTasks.filter(
				(t) => !(t.status === "completed" && sweptTodoIds.has(t.id)),
			);
		}
	}
}

function syncTodos(details: { tasks?: TodoTask[] }): void {
	if (details?.tasks && Array.isArray(details.tasks)) {
		for (const t of todoTasks) activeFormCache.set(t.id, t.activeForm || "");
		todoTasks = details.tasks.map((t) => ({
			...t,
			activeForm: activeFormCache.get(t.id) || t.activeForm || "",
		}));
		recordTodoCompletionTimes(todoTasks);
		// Tombstoned completed tasks can't re-render via wholesale replace.
		todoTasks = todoTasks.filter(
			(t) => !(t.status === "completed" && sweptTodoIds.has(t.id)),
		);
		// If all tasks are completed or deleted, clear the sidebar todo list
		if (
			todoTasks.length > 0 &&
			todoTasks.every((t) => t.status === "completed" || t.status === "deleted")
		) {
			todoTasks = [];
		}
	}
}

// ── Sub-agents ──

interface AgentInfo {
	id: string;
	name: string;
	status: "running" | "done" | "error";
	startMs: number;
	endMs?: number;
	replayedAt?: number;
}

const activeAgents: Map<string, AgentInfo> = new Map();
const SPINNER = [
	"\u280b",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283c",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280f",
];

function onAgentStart(id: string, name: string): void {
	if (!id) return; // never store an anonymous entry (collides on key `undefined`)
	if (activeAgents.has(id) && activeAgents.get(id)!.status === "running")
		return;
	activeAgents.set(id, { id, name, status: "running", startMs: Date.now() });
}

function onAgentEnd(id: string | null, isError: boolean): void {
	// Only the exact agent id may be marked done — never fall back to an
	// arbitrary running agent (that corrupted state when ids didn't match).
	if (id && activeAgents.has(id)) {
		const target = activeAgents.get(id)!;
		target.status = isError ? "error" : "done";
		target.endMs = Date.now();
	}
	// Cap history: keep all running agents plus the most recent 10 finished.
	const entries = [...activeAgents.entries()];
	const running = entries.filter(([, a]) => a.status === "running");
	const finished = entries.filter(([, a]) => a.status !== "running").slice(-10);
	activeAgents.clear();
	for (const [k, v] of [...running, ...finished]) activeAgents.set(k, v);
}

// Reconstruct agents that finished before the sidebar was enabled, from the
// pi-subagents persisted per-agent records ({type:"custom",
// customType:"subagents:record", data:{id,type,description,status,
// startedAt,completedAt}}). Later records for the same id override earlier
// ones (resumed agents show their latest state). A live running entry wins
// only when it started after the record (restart case).
function replayAgents(sessionManager: {
	getBranch(): Iterable<unknown>;
}): void {
	const records = new Map<string, AgentInfo>();
	for (const entry of sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: {
				id?: string;
				type?: string;
				description?: string;
				status?: string;
				startedAt?: number;
				completedAt?: number;
			};
		};
		if (e.type !== "custom" || e.customType !== "subagents:record") continue;
		const d = e.data;
		if (!d?.id) continue;
		// A persisted record implies a terminal lifecycle; only completed maps to
		// done, everything else (failed/error/unknown) shows as error rather than
		// a perpetual spinner.
		const status = d.status === "completed" ? "done" : "error";
		records.set(d.id, {
			id: d.id,
			name: d.type || d.description || "sub-agent",
			status,
			startMs: d.startedAt ?? Date.now(),
			endMs: d.completedAt,
			replayedAt: Date.now(),
		});
	}
	for (const [id, info] of records) {
		const live = activeAgents.get(id);
		if (live && live.status === "running" && live.startMs > (info.startMs || 0))
			continue; // live restart is newer
		activeAgents.set(id, info);
	}
}

// ── Expiry sweep ──

// Completed todos and done/error agents auto-clear after DONE_TTL_MS (live
// sub-agents measured from completion; replayed historical agents instead get
// a 5-minute grace after being shown — kept separate on purpose). Exported so
// the regression harness can drive 60s eviction with a fake clock; the real
// interval in startSidebar calls it with the real clock every 5s.
export function pruneExpired(now = Date.now()): void {
	// todos: drop completed entries past TTL, keep the map in sync, and
	// tombstone swept ids so a later snapshot can't re-arm the 60s window.
	// The `?? now` fallback means a completed todo with no recorded timestamp
	// is never spuriously removed right away.
	const sweptNow: number[] = [];
	todoTasks = todoTasks.filter((t) => {
		if (
			t.status === "completed" &&
			(todoCompletedMs.get(t.id) ?? now) + DONE_TTL_MS <= now
		) {
			sweptNow.push(t.id);
			return false;
		}
		return true;
	});
	for (const id of sweptNow) sweptTodoIds.add(id);
	for (const [id, ms] of todoCompletedMs) {
		if (ms + DONE_TTL_MS <= now) {
			todoCompletedMs.delete(id);
			sweptTodoIds.add(id);
		}
	}
	// Prune done/error agents: live ones after 60s since completion;
	// replayed (historical) ones 5 minutes after being shown, so the
	// panel reflects current session activity without growing unbounded.
	for (const [id, agent] of activeAgents) {
		if (
			agent.status !== "running" &&
			agent.endMs &&
			(agent.replayedAt
				? now - agent.replayedAt > 300000
				: now - agent.endMs > DONE_TTL_MS)
		) {
			activeAgents.delete(id);
		}
	}
}

// ── LSP ──

interface LspEntry {
	name: string;
	command: string;
	available: boolean;
}
let lspEntries: LspEntry[] = [];

function commandExists(cmd: string, cwd: string): boolean {
	try {
		accessSync(cmd, undefined);
		return true;
	} catch {
		for (const dir of (process.env.PATH || "").split(path.delimiter)) {
			try {
				accessSync(path.join(dir, cmd), undefined);
				return true;
			} catch {
				/* */
			}
		}
		return false;
	}
}

async function scanLsp(cwd: string): Promise<void> {
	lspEntries = [];
	const cfg = path.join(cwd, ".pi", "lsp.json");
	const alt = path.join(os.homedir(), ".pi", "agent", "lsp.json");
	const configPath = existsSync(cfg) ? cfg : existsSync(alt) ? alt : null;
	if (!configPath) return;
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		if (config?.servers && typeof config.servers === "object") {
			for (const [name, serverCfg] of Object.entries(config.servers)) {
				const cmd = (serverCfg as { command?: string })?.command || "";
				if (cmd)
					lspEntries.push({
						name,
						command: cmd,
						available: commandExists(cmd, cwd),
					});
			}
		}
	} catch {
		/* */
	}
}

// ── MCP ──

interface McpEntry {
	name: string;
	command: string;
	running: boolean;
}
let mcpEntries: McpEntry[] = [];

async function scanMcp(pi: ExtensionAPI, cwd: string): Promise<void> {
	mcpEntries = [];
	const cfg = path.join(cwd, "mcp.json");
	const alt = path.join(os.homedir(), ".pi", "agent", "mcp.json");
	const configPath = existsSync(cfg) ? cfg : existsSync(alt) ? alt : null;
	if (!configPath) return;
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		if (config?.mcpServers && typeof config.mcpServers === "object") {
			for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
				const cmd =
					((serverCfg as Record<string, unknown>).command as string) || "";
				if (cmd) {
					let running = false;
					try {
						const procName = cmd.split("/").pop() || cmd.split(" ")[0] || "";
						if (procName) {
							const result = await pi.exec("pgrep", ["-f", procName], { cwd });
							running = (result.stdout || "").trim().length > 0;
						}
					} catch {
						/* best-effort: pgrep may be unavailable */
					}
					mcpEntries.push({ name, command: cmd, running });
				}
			}
		}
	} catch {
		/* */
	}
}

// ── Sidebar Component ──

let sidebarHandle: OverlayHandle | null = null;
let sidebarRefreshInterval: ReturnType<typeof setInterval> | null = null;
let sidebarDone: (() => void) | null = null;
let sidebarWidgetActive = false;
let sidebarTui: TUI | null = null; // stored for stopSidebar() cleanup
// v4: once-per-process startup clear — see the requestRender(true) call in
// the overlay factory below. In-process session switches must not re-clear.
let didStartupClear = false;
// Unsubscribe fns for the sub-agent EventBus listeners bound to the CURRENT
// session's bus. pi's EventBus is per-ResourceLoader (each /new, /resume,
// /continue -c, fork — and the auto-resume at startup — makes a fresh bus and
// re-runs this factory), so we re-bind on every factory invocation and drain
// the previous bus's listeners first. jiti caches this module across in-process
// session switches, which is exactly why the array must persist and be drained.
let agentEventUnsubs: Array<() => void> = [];

class SidebarComponent implements Component {
	private tui: TUI;
	private theme: Theme;
	private pi: ExtensionAPI;
	private cwd: string;

	constructor(tui: TUI, theme: Theme, pi: ExtensionAPI, cwd: string) {
		this.tui = tui;
		this.theme = theme;
		this.pi = pi;
		this.cwd = cwd;
	}

	private renderSection(th: Theme, title: string, lines: string[]): string[] {
		const result: string[] = [];
		result.push(th.bold(th.fg("accent", " " + title)));
		result.push(...lines);
		result.push("");
		return result;
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		// Per-section caps (NOT fixed heights): each section renders only as many
		// rows as it has content, so the panel never wastes space on blank
		// padding. Safe because pi-tui composites overlays into a full-height
		// frame every render (compositeOverlays pads to termHeight) and the
		// line-diff rewrites every changed row — including rows an overlay
		// vacates when it shrinks (they revert to main content and get
		// rewritten). Verified against pi-tui 0.80.3 dist/tui.js.
		const MAX_TODO_ROWS = 5;
		const MAX_LSP_ROWS = 3;
		const MAX_MCP_ROWS = 3;
		const entry = (s: string) => border("│") + padLine(s) + border("│");
		const lines: string[] = [];

		// Title bar
		lines.push(border(`\u256d${"\u2500".repeat(innerW)}\u256e`));
		lines.push(
			border("\u2502") +
				padLine(th.fg("accent", " Sidebar Panel")) +
				border("\u2502"),
		);
		lines.push(
			border("\u251c") + border("\u2500".repeat(innerW)) + border("\u2502"),
		);

		// Todos
		const visible = todoTasks.filter((t) => t.status !== "deleted");
		lines.push(
			border("\u2502") + padLine(th.fg("accent", " Todos")) + border("\u2502"),
		);
		const todoRows: string[] = [];
		if (visible.length === 0) {
			todoRows.push(entry(th.fg("dim", "   (empty)")));
		} else {
			for (const t of visible.slice(0, MAX_TODO_ROWS)) {
				// Completed todos disappear once past DONE_TTL_MS even if a later
				// snapshot re-includes them before the interval sweeps.
				if (t.status === "completed") {
					const ms = todoCompletedMs.get(t.id);
					if (ms !== undefined && Date.now() - ms > DONE_TTL_MS) continue;
				}
				const icon =
					t.status === "in_progress"
						? th.fg("accent", "●")
						: t.status === "pending"
							? th.fg("dim", "○")
							: th.fg("success", "✓");
				const id =
					t.status !== "completed"
						? th.fg("accent", `#${t.id} `)
						: th.fg("dim", `#${t.id} `);
				// Completed todos render dim (universal) + strikethrough (terminals
				// that support SGR 9, e.g. outside cmux, show the line) — same
				// style as completed sub-agents.
				const todoText =
					t.status === "completed"
						? th.fg(
								"dim",
								th.strikethrough(
									truncateToWidth(t.activeForm || t.subject, 30),
								),
							)
						: truncateToWidth(t.activeForm || t.subject, 30);
				todoRows.push(entry(` ${icon} ${id}${todoText}`));
			}
		}
		if (todoRows.length === 0) todoRows.push(entry(th.fg("dim", "   (empty)")));
		lines.push(...todoRows);
		lines.push(
			border("│") +
				padLine(th.fg("border", "─".repeat(innerW - 2))) +
				border("│"),
		);

		// Sub-agents
		const MAX_AGENT_ENTRIES = 3;
		const running = [...activeAgents.values()].filter(
			(a) => a.status === "running",
		);
		const recent = [...activeAgents.values()].filter(
			(a) => a.status !== "running",
		);
		const shown = [...running.slice(0, MAX_AGENT_ENTRIES)];
		if (shown.length < MAX_AGENT_ENTRIES) {
			shown.push(...recent.slice(-(MAX_AGENT_ENTRIES - shown.length)));
		}
		lines.push(
			border("│") +
				padLine(th.fg("accent", ` Sub-agents (${activeAgents.size})`)) +
				border("│"),
		);
		const agentRows: string[] = [];
		if (running.length === 0 && recent.length === 0) {
			agentRows.push(entry(th.fg("dim", "   (idle)")));
		} else {
			for (const a of shown) {
				const icon =
					a.status === "running"
						? th.fg(
								"accent",
								SPINNER[Math.floor(Date.now() / 100) % SPINNER.length],
							)
						: a.status === "done"
							? th.fg("success", "✓")
							: th.fg("error", "✗");
				const endMs =
					a.status === "running" ? Date.now() : (a.endMs ?? a.startMs);
				const elapsed = Math.round((endMs - a.startMs) / 1000);
				// Completed agents render dim (universal) + strikethrough (terminals
				// that support SGR 9, e.g. outside cmux, show the line).
				const agentText =
					a.status === "done"
						? th.fg(
								"dim",
								th.strikethrough(
									`${truncateToWidth(a.name, 26)} (${elapsed}s)`,
								),
							)
						: `${truncateToWidth(a.name, 26)} (${elapsed}s)`;
				agentRows.push(entry(` ${icon} ${agentText}`));
			}
		}
		lines.push(...agentRows);
		lines.push(
			border("│") +
				padLine(th.fg("border", "─".repeat(innerW - 2))) +
				border("│"),
		);

		// LSP
		lines.push(border("│") + padLine(th.fg("accent", " LSP")) + border("│"));
		const lspRows: string[] = [];
		if (lspEntries.length === 0) {
			lspRows.push(entry(th.fg("dim", "   (no config)")));
		} else {
			for (const e of lspEntries.slice(0, MAX_LSP_ROWS)) {
				const s = e.available ? th.fg("success", "✓") : th.fg("warning", "!");
				lspRows.push(entry(` ${s} ${e.name}`));
			}
		}
		lines.push(...lspRows);
		lines.push(
			border("│") +
				padLine(th.fg("border", "─".repeat(innerW - 2))) +
				border("│"),
		);

		// MCP
		lines.push(border("│") + padLine(th.fg("accent", " MCP")) + border("│"));
		const mcpRows: string[] = [];
		if (mcpEntries.length === 0) {
			mcpRows.push(entry(th.fg("dim", "   (no config)")));
		} else {
			for (const e of mcpEntries.slice(0, MAX_MCP_ROWS)) {
				const s = e.running ? th.fg("success", "▶") : th.fg("dim", "■");
				mcpRows.push(entry(` ${s} ${e.name}`));
			}
		}
		lines.push(...mcpRows);
		lines.push(
			border("│") +
				padLine(th.fg("border", "─".repeat(innerW - 2))) +
				border("│"),
		);

		// Bottom border
		lines.push(border(`\u2570${"\u2500".repeat(innerW)}\u256f`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

function registerSidebar(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// CRITICAL: extensions also load into sub-agent sessions (ctx.mode
		// "print"). Their session_start fires right after subagents:started and
		// must NOT touch the shared module state: clearing activeAgents there
		// would wipe live tracking at the exact moment agents spawn, and
		// resetSidebarState() would null the TUI overlay's handle + kill its
		// refresh interval — freezing the panel and leaving /sidebar off unable
		// to hide it (observed in sidebar-debug.log: widgetActive=false +
		// hasHandle=false while the zombie overlay stayed on screen).
		if (ctx?.mode !== "tui") return;

		// Re-bind the sub-agent EventBus listeners HERE (not at factory time):
		// the factory also runs for every sub-agent session, and binding there
		// let a sub-agent session drain the main TUI bus's listeners and steal
		// them onto its own bus — after which subagents:completed on the main
		// bus was never heard. Only real sessions fire a tui session_start, so
		// the listeners always stay on the user-facing session's bus.
		agentEventUnsubs.forEach((fn) => {
			try {
				fn();
			} catch {
				// Listener attached to an already-torn-down bus — safe to ignore.
			}
		});
		// SDK 0.83.0 types EventBus handlers as (data: unknown) => void; the
		// payload shapes below come from the pi-subagents EventBus contract, so
		// they are cast at the registration boundary (minimal version-skew fix).
		agentEventUnsubs = [
			pi.events.on("subagents:started", ((payload: {
				id: string;
				type?: string;
				description?: string;
			}) => {
				onAgentStart(
					payload.id,
					payload.type || payload.description || "sub-agent",
				);
			}) as (data: unknown) => void),

			pi.events.on("subagents:completed", ((payload: { id: string }) => {
				onAgentEnd(payload.id, false);
			}) as (data: unknown) => void),

			pi.events.on("subagents:failed", ((payload: { id: string }) => {
				onAgentEnd(payload.id, true);
			}) as (data: unknown) => void),
		];

		if (!sidebarEnabled) return;
		// A fresh session must start with a clean sub-agent slate: the
		// module-level activeAgents map survives in-process session switches,
		// and replaying the branch here would resurrect every historical
		// subagents:record from a resumed session (pi -c / continueRecent /
		// reload re-open the full history). Only an explicit mid-session
		// /sidebar on replays historical records.
		activeAgents.clear();
		// A session switch tears down the previous session's overlay (the framework
		// detaches extension-drawn components), but this module's state survives
		// in-process (jiti caches the same module instance). Reset the stale widget
		// flag + dangling handles so the fresh session's startSidebar() is not
		// blocked by the `if (sidebarWidgetActive) return;` guard.
		resetSidebarState();
		startSidebar(pi, ctx, { replay: false });
	});

	// Framework is about to tear down the session; stop the overlay while the
	// handle is still alive. Idempotent: stopSidebar() null-checks every field.
	pi.on("session_shutdown", async (_event, ctx) => {
		// Sub-agent sessions also fire session_shutdown; only a real TUI session
		// teardown may stop the overlay.
		if (ctx?.mode !== "tui") return;
		try {
			stopSidebar(ctx);
		} catch {
			// Dead handle from a previous teardown — pure state reset only.
			resetSidebarState();
		}
	});

	// The sub-agent EventBus listeners are registered in the session_start
	// handler above (TUI sessions only), NOT here: the factory runs for every
	// session — including each sub-agent's own "print" session — and binding
	// here would let a sub-agent session steal the listeners off the main bus.

	// Keep tool_result for todo sync only
	pi.on("tool_result", async (event, _ctx) => {
		if (!sidebarEnabled) return;
		if (event.toolName === "todo" && event.details) {
			syncTodos(event.details as { tasks?: TodoTask[] });
		}
	});
}

function startSidebar(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts?: { replay?: boolean },
): void {
	if (ctx.mode !== "tui") return;
	if (sidebarWidgetActive) return;

	const cwd = ctx.cwd || process.cwd();
	replayTodos(ctx.sessionManager!);
	scanLsp(cwd);
	scanMcp(pi, cwd);
	// Reconstruct agents that finished before the sidebar was enabled; live
	// (still-running or already-tracked) entries in activeAgents take priority.
	// Session start passes replay:false — historical records are only shown
	// for an explicit mid-session /sidebar on, never at startup.
	if (opts?.replay !== false) replayAgents(ctx.sessionManager!);

	ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			sidebarWidgetActive = true;
			// SDK 0.83.0's custom() done callback is (result: unknown) => void;
			// stopSidebar() calls it with no args — the result is irrelevant here.
			sidebarDone = done as () => void;
			sidebarTui = tui; // kept for stopSidebar() cleanup; renders driven by 5s interval
			// v4 FIX (cross-process ghost): pi-tui's first frame is fullRender(false)
			// — "assumes clean screen" (pi-tui dist/tui.js first-render path) — and
			// TUI.stop() deliberately leaves content on exit, so a restarted pi
			// inherits the previous process's screen; the line-diff only rewrites
			// rows later renders touch, leaving a stale sidebar generation + old
			// content next to the live panel (captured live in the user's Orca
			// terminal). requestRender(true) resets the diff state, so the next
			// frame runs fullRender(true): clear screen + repaint — the same
			// mechanism pi itself uses after SIGCONT / external editor / /reload.
			// Once per process: in-process /new or resume has valid diff state and
			// no residue, so it must not wipe the user's scrollback.
			if (!didStartupClear) {
				didStartupClear = true;
				tui.requestRender(true);
			}
			// OverlayHandle has NO refresh() method — only this setInterval-driven
			// tui.requestRender() repaints the sidebar. doRender's line-diff makes
			// idle cycles free (no terminal write when content is unchanged).
			if (sidebarRefreshInterval) clearInterval(sidebarRefreshInterval);
			sidebarRefreshInterval = setInterval(() => {
				if (!sidebarWidgetActive) return;
				pruneExpired();
				// Always request render; doRender's line-diff skips the terminal
				// write when content hasn't changed, so idle cycles are free.
				tui.requestRender();
			}, 5000);

			return new SidebarComponent(tui, theme, pi, cwd);
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-right",
				offsetX: -1,
				offsetY: 1,
				width: 38,
				nonCapturing: true,
				// Responsive hide: framework re-evaluates `visible` on every render /
				// terminal resize; when false the overlay is not drawn and does not
				// capture focus, so the sidebar never crowds a narrow terminal.
				visible: (termWidth) => termWidth >= MIN_TERM_WIDTH_FOR_SIDEBAR,
			},
			onHandle: (handle) => {
				sidebarHandle = handle;
				handle.unfocus();
			},
		},
	);
}

/** Pure state reset — never touches the (possibly dead) overlay handle. */
function resetSidebarState(): void {
	sidebarWidgetActive = false;
	sidebarTui = null;
	if (sidebarRefreshInterval) {
		clearInterval(sidebarRefreshInterval);
		sidebarRefreshInterval = null;
	}
	sidebarHandle = null;
	sidebarDone = null;
}

function stopSidebar(ctx?: ExtensionContext): void {
	sidebarWidgetActive = false;
	sidebarTui = null;
	if (sidebarRefreshInterval) {
		clearInterval(sidebarRefreshInterval);
		sidebarRefreshInterval = null;
	}
	if (sidebarHandle) {
		sidebarHandle.hide();
		sidebarHandle = null;
	}
	if (sidebarDone) {
		sidebarDone();
		sidebarDone = null;
	}
	// EventBus lifecycle listeners intentionally stay registered (process
	// lifetime): tracking is continuous across toggles, so nothing to unsub.
}

// ═══════════════════════════════════════════════════════════════════
// /sidebar command handler
// ═══════════════════════════════════════════════════════════════════

function registerSidebarCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sidebar", {
		description: "Toggle the sidebar panel on/off",
		handler: async (args: string, ctx) => {
			// SDK 0.83.0 narrowed ui.notify's type to "info" | "warning" | "error",
			// but the original feature handler used "success" at runtime — keep the
			// exact strings via a single minimal version-skew cast.
			const notify = (
				msg: string,
				severity: "success" | "info" | "warning" | "error",
			) => ctx.ui.notify(msg, severity as "info" | "warning" | "error");
			const trimmed = args?.trim() || "";

			if (trimmed === "status") {
				notify(`Sidebar: ${sidebarEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (trimmed === "on") {
				sidebarEnabled = true;
				startSidebar(pi, ctx);
				notify("Sidebar: enabled", "success");
				return;
			}

			if (trimmed === "off") {
				sidebarEnabled = false;
				stopSidebar(ctx);
				notify("Sidebar: disabled", "warning");
				return;
			}

			if (trimmed === "" || trimmed === "toggle") {
				const newVal = !sidebarEnabled;
				sidebarEnabled = newVal;
				if (newVal) startSidebar(pi, ctx);
				else stopSidebar(ctx);
				notify(
					`Sidebar: ${newVal ? "enabled" : "disabled"}`,
					newVal ? "success" : "warning",
				);
				return;
			}

			notify("Usage: /sidebar [on|off|status]", "error");
		},
	});
}

// ═══════════════════════════════════════════════════════════════════
// Default export
// ═══════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI): void {
	registerSidebar(pi);
	registerSidebarCommand(pi);
}
