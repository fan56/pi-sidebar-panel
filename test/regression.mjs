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
  on(channel, cb) { if (!eventListeners.has(channel)) eventListeners.set(channel, []); eventListeners.get(channel).push(cb); return () => {}; },
};
const piOnHandlers = new Map();
const commands = new Map();
const pi = {
  events: piEvents,
  on(name, cb) { if (!piOnHandlers.has(name)) piOnHandlers.set(name, []); piOnHandlers.get(name).push(cb); },
  registerCommand(name, def) { commands.set(name, def); },
  async exec() { return { stdout: "" }; },
};

const theme = {
  bold: (s) => s,
  fg: (c, s) => c === "dim" ? `<dim>${s}</dim>` : s,
  strikethrough: (s) => `~~${s}~~`, // marker so the harness can assert styling
};

let capturedFactory = null;
const uiStub = {
  custom(factory, opts) { capturedFactory = factory; if (opts?.onHandle) opts.onHandle({ hide() {}, unfocus() {}, focus() {} }); },
  notify() {},
  addAutocompleteProvider() {},
};
const makeCtx = (branch) => ({ mode: "tui", cwd: "/tmp", sessionManager: { getBranch: () => branch }, ui: uiStub });

let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── load the extension ──
const mod = jiti(join(here, "../extensions/index.ts"));
const loadDefault = mod.default || mod;
loadDefault(pi);

check(commands.has("sidebar") && !commands.has("ext") && !commands.has("think"), "command 'sidebar' registered (not ext/think)");
const startedL = eventListeners.get("subagents:started") || [];
check(startedL.length === 1, "started listener registered once");
const emit = (ch, p) => { for (const cb of eventListeners.get(ch) || []) cb(p); };
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

// DEFAULT ON: session_start alone must start the sidebar (no command first)
const sessionStartHandlers = piOnHandlers.get("session_start") || [];
check(sessionStartHandlers.length === 1, "session_start handler registered");
for (const cb of sessionStartHandlers) cb({}, makeCtx([]));
check(capturedFactory !== null, "DEFAULT ON: startSidebar ran from session_start without any command");

// D1: events emitted before the sidebar rendered are shown done after render
emit("subagents:started", { id: "early", type: "geo-researcher" });
emit("subagents:completed", { id: "early" });

let component = null;
const renderOnce = () => { if (!component) component = capturedFactory({ requestRender() {} }, theme, {}, () => {}); return component.render(38).join("\n"); };

let out = renderOnce();
check(out.includes(" Sidebar Panel"), "title: rendered output contains ' Sidebar Panel'");
check(out.includes("Sub-agents (1)"), "D1: pre-start agent tracked");
check(out.includes("geo-researcher") && out.includes("\u2713"), "D1: early agent shown done");

// D3: unknown id must not corrupt a running agent
emit("subagents:started", { id: "run1", type: "research-agent" });
emit("subagents:completed", { id: "ghost-unknown" });
out = renderOnce();
const runLine = out.split("\n").find((l) => l.includes("research-agent")) || "";
check(SPINNER.some((c) => runLine.includes(c)), "D3: running agent untouched by unknown-id completion");
emit("subagents:failed", { id: "run1" });
out = renderOnce();
check(out.includes("\u2717") && out.includes("research-agent"), "run1 marked error");

// STRK+DIM: done agents show ~~...~~ + <dim>, running/failed do not
const doneLine = out.split("\n").find((l) => l.includes("geo-researcher")) || "";
check(doneLine.includes("~~") && doneLine.includes("<dim>"), `STRK+DIM: done agent struck & dimmed [${doneLine.trim()}]`);
const errLine = out.split("\n").find((l) => l.includes("research-agent")) || "";
check(!errLine.includes("~~") && !errLine.includes("<dim>"), "STRK+DIM: error agent NOT struck/dimmed");

// toggle off/on with replay branch (continuous collection across /sidebar off→on)
const sidebarHandler = commands.get("sidebar").handler;
sidebarHandler("off", makeCtx([]));
emit("subagents:started", { id: "hidden", type: "explorer-agent" });
emit("subagents:completed", { id: "hidden" });
const histEnd = Date.now() - 60_000;
const branch = [{ type: "custom", customType: "subagents:record", data: { id: "hist", type: "security-auditor", status: "completed", startedAt: Date.now() - 120_000, completedAt: histEnd } }];
sidebarHandler("on", makeCtx(branch));
out = renderOnce();
check(out.includes("Sub-agents (4)"), "D2: no clear(), all agents retained (4)");
check(out.includes("security-auditor") && out.includes("explorer-agent"), "D2: replayed + continuous agents shown");
const histLine = out.split("\n").find((l) => l.includes("security-auditor")) || "";
check(histLine.includes("~~") && histLine.includes("<dim>"), "STRK+DIM: replayed done agent struck & dimmed");

// prune guard: replayed agent survives a >5s wait (5s interval tick)
await new Promise((r) => setTimeout(r, 5300));
out = renderOnce();
check(out.includes("security-auditor"), "prune guard: replayed agent survives interval prune");

// static source checks
const src = readFileSync(join(here, "../extensions/index.ts"), "utf8");
check(!src.includes("sidebarUnsubscribers") && !src.includes("console.error") && !src.includes("/ext"), "static: no sidebarUnsubscribers / console.error / /ext");
check(src.includes("Sidebar Panel"), "static: contains 'Sidebar Panel'");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
