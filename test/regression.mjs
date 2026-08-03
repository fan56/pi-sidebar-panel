// Regression harness for @aiwayds/pi-sidebar-panel: default-ON behavior,
// D1-D3 subagent fixes, replay via session branch, continuous collection
// across /sidebar off/on, prune guard, title + strikethrough styling, and
// static source checks.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let createJiti;
try {
	({ createJiti } = require("jiti/lib/jiti.cjs"));
} catch {
	({ createJiti } = require("jiti"));
}
const jiti = createJiti(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// ── stubs ──
const eventListeners = new Map();
const piEvents = {
	on(channel, cb) {
		if (!eventListeners.has(channel)) eventListeners.set(channel, []);
		eventListeners.get(channel).push(cb);
		return () => {};
	},
};
const piOnHandlers = new Map();
const commands = new Map();
const pi = {
	events: piEvents,
	on(name, cb) {
		if (!piOnHandlers.has(name)) piOnHandlers.set(name, []);
		piOnHandlers.get(name).push(cb);
	},
	registerCommand(name, def) {
		commands.set(name, def);
	},
	async exec() {
		return { stdout: "" };
	},
};

const theme = {
	bold: (s) => s,
	fg: (c, s) => (c === "dim" ? `<dim>${s}</dim>` : s),
	strikethrough: (s) => `~~${s}~~`, // marker so the harness can assert styling
};

let capturedFactory = null;
let capturedOpts = null;
const uiStub = {
	custom(factory, opts) {
		capturedFactory = factory;
		capturedOpts = opts;
		if (opts?.onHandle) opts.onHandle({ hide() {}, unfocus() {}, focus() {} });
	},
	notify() {},
	addAutocompleteProvider() {},
};
const makeCtx = (branch) => ({
	mode: "tui",
	cwd: "/tmp",
	sessionManager: { getBranch: () => branch },
	ui: uiStub,
});

let failures = 0;
const check = (cond, label) => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
};

// ── load the extension ──
const mod = jiti(join(here, "../extensions/index.ts"));
const loadDefault = mod.default || mod;
loadDefault(pi);

check(
	commands.has("sidebar") && !commands.has("ext") && !commands.has("think"),
	"command 'sidebar' registered (not ext/think)",
);
// Bus listeners are deferred to the TUI session_start: the factory also runs
// for every sub-agent's own "print" session, which must never bind (and steal)
// the main session's listeners.
check(
	(eventListeners.get("subagents:started") || []).length === 0,
	"factory does NOT bind bus listeners (deferred to tui session_start)",
);
const emit = (ch, p) => {
	for (const cb of eventListeners.get(ch) || []) cb(p);
};
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

// DEFAULT ON: session_start alone must start the sidebar (no command first)
const sessionStartHandlers = piOnHandlers.get("session_start") || [];
check(sessionStartHandlers.length === 1, "session_start handler registered");
for (const cb of sessionStartHandlers) cb({}, makeCtx([]));
check(
	capturedFactory !== null,
	"DEFAULT ON: startSidebar ran from session_start without any command",
);
check(
	(eventListeners.get("subagents:started") || []).length === 1,
	"tui session_start binds the started listener exactly once",
);

// NARROW: overlay auto-hides below MIN_TERM_WIDTH_FOR_SIDEBAR (100) via the
// `visible` callback in overlayOptions; only termWidth matters, not height.
check(
	capturedOpts !== null &&
		typeof capturedOpts.overlayOptions?.visible === "function",
	"NARROW: captured overlayOptions.visible callback",
);
const visible = capturedOpts?.overlayOptions?.visible || (() => true);
check(visible(99) === false, "NARROW: visible(99) is false (below 100 hides)");
check(
	visible(100) === true,
	"NARROW: visible(100) is true (at threshold shows)",
);
check(
	visible(101) === true && visible(160) === true,
	"NARROW: visible(101) and visible(160) are true (wider shows)",
);
check(
	visible(50, 200) === false,
	"NARROW: visible(50, 200) is false (height ignored, width narrow)",
);
check(
	visible(160, 1) === true,
	"NARROW: visible(160, 1) is true (height ignored, width wide)",
);

// D1: events emitted before the sidebar rendered are shown done after render
emit("subagents:started", { id: "early", type: "geo-researcher" });
emit("subagents:completed", { id: "early" });

let component = null;
const renderOnce = () => {
	if (!component)
		component = capturedFactory({ requestRender() {} }, theme, {}, () => {});
	return component.render(38).join("\n");
};

let out = renderOnce();
check(
	out.includes(" Sidebar Panel"),
	"title: rendered output contains ' Sidebar Panel'",
);
check(out.includes("Sub-agents (1)"), "D1: pre-start agent tracked");
check(
	out.includes("geo-researcher") && out.includes("\u2713"),
	"D1: early agent shown done",
);

// D3: unknown id must not corrupt a running agent
emit("subagents:started", { id: "run1", type: "research-agent" });
emit("subagents:completed", { id: "ghost-unknown" });
out = renderOnce();
const runLine = out.split("\n").find((l) => l.includes("research-agent")) || "";
check(
	SPINNER.some((c) => runLine.includes(c)),
	"D3: running agent untouched by unknown-id completion",
);
emit("subagents:failed", { id: "run1" });
out = renderOnce();
check(
	out.includes("\u2717") && out.includes("research-agent"),
	"run1 marked error",
);

// STRK+DIM: done agents show ~~...~~ + <dim>, running/failed do not
const doneLine =
	out.split("\n").find((l) => l.includes("geo-researcher")) || "";
check(
	doneLine.includes("~~") && doneLine.includes("<dim>"),
	`STRK+DIM: done agent struck & dimmed [${doneLine.trim()}]`,
);
const errLine = out.split("\n").find((l) => l.includes("research-agent")) || "";
check(
	!errLine.includes("~~") && !errLine.includes("<dim>"),
	"STRK+DIM: error agent NOT struck/dimmed",
);

// toggle off/on with replay branch (continuous collection across /sidebar off→on)
const sidebarHandler = commands.get("sidebar").handler;
sidebarHandler("off", makeCtx([]));
emit("subagents:started", { id: "hidden", type: "explorer-agent" });
emit("subagents:completed", { id: "hidden" });
const histEnd = Date.now() - 60_000;
const branch = [
	{
		type: "custom",
		customType: "subagents:record",
		data: {
			id: "hist",
			type: "security-auditor",
			status: "completed",
			startedAt: Date.now() - 120_000,
			completedAt: histEnd,
		},
	},
];
sidebarHandler("on", makeCtx(branch));
out = renderOnce();
check(
	out.includes("Sub-agents (4)"),
	"D2: no clear(), all agents retained (4)",
);
check(
	out.includes("security-auditor") && out.includes("explorer-agent"),
	"D2: replayed + continuous agents shown",
);
const histLine =
	out.split("\n").find((l) => l.includes("security-auditor")) || "";
check(
	histLine.includes("~~") && histLine.includes("<dim>"),
	"STRK+DIM: replayed done agent struck & dimmed",
);

// STRK+DIM: completed todos render ~~...~~ + <dim> (same style as done agents)
for (const cb of piOnHandlers.get("tool_result") || [])
	cb(
		{
			toolName: "todo",
			details: {
				tasks: [
					{ id: 1, status: "in_progress", subject: "still working" },
					{ id: 2, status: "completed", subject: "done" },
				],
			},
		},
		{},
	);
out = renderOnce();
const todoDoneLine =
	out.split("\n").find((l) => l.includes("done") && l.includes("~~")) || "";
check(
	todoDoneLine.includes("~~") && todoDoneLine.includes("<dim>"),
	`STRK+DIM: completed todo struck & dimmed [${todoDoneLine.trim()}]`,
);

// prune guard: replayed agent survives a >5s wait (5s interval tick)
await new Promise((r) => setTimeout(r, 5300));
out = renderOnce();
check(
	out.includes("security-auditor"),
	"prune guard: replayed agent survives interval prune",
);

// session_start must NOT replay historical records (residual info fix): a
// resumed session's branch carries every past subagents:record, so the
// sidebar must start idle instead of resurrecting them. Place after the
// prune-guard check so the D2 replayed agent assertions above still run
// against the un-cleared map.
//
// NOTE: this must NOT be preceded by sidebarHandler("off") — that command
// flips sidebarEnabled=false, which would make the session_start handler
// below early-return before activeAgents.clear() AND would gate off the
// tool_result→syncTodos path that the TTL todo tests after this depend on.
const residualBranch = [
	{
		type: "custom",
		customType: "subagents:record",
		data: {
			id: "residual-ghost",
			type: "old-researcher",
			status: "completed",
			startedAt: Date.now() - 3_600_000,
			completedAt: Date.now() - 3_000_000,
		},
	},
];
for (const cb of sessionStartHandlers) cb({}, makeCtx(residualBranch));
component = null; // render a fresh component; activeAgents was cleared by session_start
out = renderOnce();
check(
	!out.includes("old-researcher"),
	"session_start: historical subagents:record NOT replayed (no residual info)",
);
check(
	out.includes("(idle)"),
	"session_start: sidebar starts idle (no residual sub-agent entries)",
);

// TTL eviction: drive pruneExpired with a fake clock (no real 60s wait)
const pruneExpired = mod.pruneExpired;
check(typeof pruneExpired === "function", "TTL: pruneExpired exported");
for (const cb of piOnHandlers.get("tool_result") || [])
	cb(
		{
			toolName: "todo",
			details: {
				tasks: [
					{ id: 3, status: "completed", subject: "ttl-done" },
					{ id: 4, status: "in_progress", subject: "ttl-live" },
				],
			},
		},
		{},
	);
out = renderOnce();
const ttlDoneLine = out.split("\n").find((l) => l.includes("ttl-done")) || "";
check(
	ttlDoneLine.includes("~~") && ttlDoneLine.includes("<dim>"),
	`TTL: completed todo shown struck & dimmed [${ttlDoneLine.trim()}]`,
);
pruneExpired(Date.now() + 60_001);
out = renderOnce();
check(!out.includes("ttl-done"), "TTL: completed todo gone after 60s");
check(out.includes("ttl-live"), "TTL: in_progress todo survives prune");

// TTL: done sub-agent survives within TTL, removed once past it
emit("subagents:started", { id: "ttlagent", type: "ttl-agent" });
emit("subagents:completed", { id: "ttlagent" });
out = renderOnce();
const ttlAgentLine = out.split("\n").find((l) => l.includes("ttl-agent")) || "";
check(
	ttlAgentLine.includes("~~") && ttlAgentLine.includes("<dim>"),
	`TTL: done agent shown struck & dimmed [${ttlAgentLine.trim()}]`,
);
pruneExpired(Date.now() + 60_001);
out = renderOnce();
check(!out.includes("ttl-agent"), "TTL: done agent removed after 60s");

// TTL resurrection: a swept completed todo must not re-arm on later snapshots
const seedTodos = (tasks) => {
	for (const cb of piOnHandlers.get("tool_result") || [])
		cb({ toolName: "todo", details: { tasks } }, {});
};
seedTodos([
	{ id: 5, status: "completed", subject: "resz" },
	{ id: 6, status: "in_progress", subject: "rlve" },
]);
out = renderOnce();
check(out.includes("resz"), "TTL: completed todo (resz) shown before sweep");
pruneExpired(Date.now() + 60_001);
out = renderOnce();
check(!out.includes("resz"), "TTL: completed todo (resz) swept after 60s");
seedTodos([
	{ id: 5, status: "completed", subject: "resz" },
	{ id: 6, status: "in_progress", subject: "rlve" },
]);
out = renderOnce();
check(
	!out.includes("resz"),
	"TTL: swept todo (resz) stays gone on later snapshot (no resurrection)",
);
seedTodos([
	{ id: 5, status: "completed", subject: "resz" },
	{ id: 7, status: "completed", subject: "frsh" },
	{ id: 6, status: "in_progress", subject: "rlve" },
]);
out = renderOnce();
check(
	out.includes("frsh") && !out.includes("resz"),
	"TTL: freshly completed todo (frsh) still shown, swept one (resz) stays hidden",
);
pruneExpired(Date.now() + 60_001);
out = renderOnce();
check(!out.includes("frsh"), "TTL: freshly completed todo (frsh) swept");

// SESSION SWITCH (the core regression): pi's EventBus is per-ResourceLoader,
// so every /new, /resume, /continue -c and fork (plus the auto-resume at
// startup) makes a FRESH bus and re-runs the extension factory against it. The
// sub-agent listeners must re-bind to the new bus at the new session's tui
// session_start, or every sub-agent event after the first session switch is
// dropped — exactly the "sidebar freezes until /sidebar toggle" symptom. jiti
// returns the SAME cached module instance across in-process switches, so
// module-level state (incl. the unsubscribe array) persists between factory
// runs; simulate that by re-loading the same module with a brand-new pi/events
// pair.
const events2 = new Map();
const pi2OnHandlers = new Map();
const pi2 = {
	events: {
		on(channel, cb) {
			if (!events2.has(channel)) events2.set(channel, []);
			events2.get(channel).push(cb);
			return () => {};
		},
		emit() {},
	},
	on(name, cb) {
		if (!pi2OnHandlers.has(name)) pi2OnHandlers.set(name, []);
		pi2OnHandlers.get(name).push(cb);
	},
	registerCommand() {},
	async exec() {
		return { stdout: "" };
	},
};
loadDefault(pi2); // second factory invocation — session switch
check(
	(events2.get("subagents:started") || []).length === 0,
	"SESSION SWITCH: factory re-run still does not bind bus listeners",
);
// The new session's tui session_start performs the re-bind:
for (const cb of pi2OnHandlers.get("session_start") || []) cb({}, makeCtx([]));
const emit2 = (ch, p) => {
	for (const cb of events2.get(ch) || []) cb(p);
};
emit2("subagents:started", { id: "postswitch", type: "switch-agent" });
emit2("subagents:completed", { id: "postswitch" });
out = renderOnce();
check(
	out.includes("switch-agent"),
	"SESSION SWITCH: sub-agent event on the NEW bus is tracked after session_start",
);
check(
	(events2.get("subagents:started") || []).length === 1,
	"SESSION SWITCH: listener bound to the new bus exactly once",
);

// SUBAGENT SESSION ISOLATION (the second regression, observed live in
// sidebar-debug.log): extensions ALSO load into every sub-agent's own session
// (ctx.mode "print"). That factory run + print session_start must NOT clear
// activeAgents, must NOT reset the TUI overlay state, and must NOT steal the
// main session's bus listeners.
const events3 = new Map();
const pi3OnHandlers = new Map();
const pi3 = {
	events: {
		on(channel, cb) {
			if (!events3.has(channel)) events3.set(channel, []);
			events3.get(channel).push(cb);
			return () => {};
		},
		emit() {},
	},
	on(name, cb) {
		if (!pi3OnHandlers.has(name)) pi3OnHandlers.set(name, []);
		pi3OnHandlers.get(name).push(cb);
	},
	registerCommand() {},
	async exec() {
		return { stdout: "" };
	},
};
loadDefault(pi3); // the sub-agent session's own factory run
for (const cb of pi3OnHandlers.get("session_start") || [])
	cb({}, { ...makeCtx([]), mode: "print" });
out = renderOnce();
check(
	out.includes("switch-agent"),
	"ISOLATION: print session_start does NOT clear tracked agents",
);
check(
	(events3.get("subagents:started") || []).length === 0,
	"ISOLATION: print session never binds listeners onto the sub-agent bus",
);
// The main bus must still hear lifecycle events after a print session ran:
emit2("subagents:started", { id: "isolive", type: "live-agent" });
emit2("subagents:completed", { id: "isolive" });
out = renderOnce();
check(
	out.includes("live-agent"),
	"ISOLATION: main bus listeners survive sub-agent sessions (completion tracked)",
);

// COMPOSITION (the screenshot bug class): sub-agent rows must NEVER render
// inside the LSP or MCP section, and every section header must appear exactly
// once per frame. render() rebuilds its line list from scratch every call, so
// a single frame can't duplicate headers or leak agent rows. Sections are now
// content-sized (variable height): pi-tui composites overlays into a
// full-height frame every render and rewrites every changed row, so a
// shrinking overlay leaves no ghost — the prior "pad to fixed height" fix is
// gone. These assertions lock both the composition invariant and the
// variable-height behavior.
emit("subagents:started", { id: "p1", type: "placement-agent" });
emit("subagents:started", { id: "p2", type: "placement-agent" });
emit("subagents:started", { id: "p3", type: "placement-agent" });
out = renderOnce();
const compLines = out.split("\n");
const subHdrIdx = compLines.findIndex((l) => /Sub-agents \(/.test(l));
const lspHdrIdx = compLines.findIndex((l) => /\u2502 LSP/.test(l));
const mcpHdrIdx = compLines.findIndex((l) => /\u2502 MCP/.test(l));
const placementIdxs = compLines
	.map((l, i) => (/placement-agent/.test(l) ? i : -1))
	.filter((i) => i >= 0);
check(
	(out.match(/Sub-agents \(/g) || []).length === 1,
	"COMPOSITION: Sub-agents header renders exactly once per frame",
);
check(
	compLines.filter((l) => /\u2502 LSP/.test(l)).length === 1,
	"COMPOSITION: LSP header renders exactly once per frame",
);
check(
	compLines.filter((l) => /\u2502 MCP/.test(l)).length === 1,
	"COMPOSITION: MCP header renders exactly once per frame",
);
check(
	subHdrIdx > -1 && lspHdrIdx > subHdrIdx && mcpHdrIdx > lspHdrIdx,
	"COMPOSITION: section order is Sub-agents < LSP < MCP",
);
check(
	placementIdxs.length === 3 &&
		placementIdxs.every((i) => i > subHdrIdx && i < lspHdrIdx),
	"COMPOSITION: all sub-agent rows sit inside the Sub-agents section, never under LSP/MCP",
);
check(
	placementIdxs.every((i) => i < lspHdrIdx),
	"COMPOSITION: zero sub-agent rows leak below the LSP header",
);
check(
	compLines.filter((l) => /^│\s*│$/.test(l)).length === 0,
	"COMPOSITION: no blank-padding rows — every section is content-sized (variable height)",
);
check(
	compLines.length < 26,
	"COMPOSITION: variable height — frame shorter than the old fixed 26 rows",
);

// static source checks
const src = readFileSync(join(here, "../extensions/index.ts"), "utf8");
check(
	!src.includes("sidebarUnsubscribers") &&
		!src.includes("console.error") &&
		!src.includes("/ext"),
	"static: no sidebarUnsubscribers / console.error / /ext",
);
check(src.includes("Sidebar Panel"), "static: contains 'Sidebar Panel'");
check(
	src.includes("MIN_TERM_WIDTH_FOR_SIDEBAR = 100"),
	"static: contains 'MIN_TERM_WIDTH_FOR_SIDEBAR = 100'",
);

console.log(
	failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
