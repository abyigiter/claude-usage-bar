// usage-bar for pi: a live widget above the editor with context, spend,
// today across sessions, the running turn, git and the branch's PR. /usage
// opens the detail panel, /budget sets limits. The drawing lives in core.ts.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  type Budget, type Git, type Ledger, type Turn, type View,
  costByDay, details, header, ledgerFrom, parsePr, parseShortstat, parseStatus, report, sumUsage, budgetUse, money, burnRate,
} from "./core.ts";

const WIDGET = "usage-bar";
const SESSIONS = join(homedir(), ".pi", "agent", "sessions");
const CONFIG = join(homedir(), ".pi", "agent", "usage-bar.json");
const PR_TTL = 5 * 60_000;
const PR_TTL_PENDING = 60_000;
const EDIT_TOOLS = new Set(["edit", "write"]);

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let tui: { requestRender(): void } | undefined;
  let expanded = false;
  let budget: Budget = {};
  let ledger: Ledger | undefined;
  let git: Git = {};
  let prCheckedAt = 0;
  let history: number[] = [];
  let turns: Turn[] = [];
  let tools: Record<string, number> = {};
  let files: string[] = [];
  let turnStart = 0;
  let turnBase = sumUsage([]);
  let alerts: { session?: number; day?: number; pace?: boolean } = {};
  const fileDays = new Map<string, { mtimeMs: number; size: number; days: Record<string, number> }>();
  const timers: ReturnType<typeof setInterval>[] = [];

  const usage = () => sumUsage(ctx?.sessionManager.getEntries() ?? []);
  const view = (): View => {
    const header = ctx?.sessionManager.getHeader() as { timestamp?: string } | null | undefined;
    const c = ctx?.getContextUsage();
    return {
      ctx: c ? { tokens: c.tokens, window: c.contextWindow, percent: c.percent } : undefined,
      history,
      session: usage(),
      startedAt: header?.timestamp ? Date.parse(header.timestamp) : undefined,
      working: turnStart ? Date.now() - turnStart : null,
      turns,
      tools,
      files,
      git,
      model: ctx?.model?.id?.split("/").pop(),
      budget,
      ledger,
      now: Date.now(),
    };
  };
  const redraw = () => tui?.requestRender();

  // ---- data ---------------------------------------------------------------

  async function readGit() {
    if (!ctx) return;
    const cwd = ctx.cwd;
    const run = (cmd: string, args: string[], timeout = 3000) => pi.exec(cmd, args, { cwd, timeout }).catch(() => null);
    const st = await run("git", ["status", "--porcelain=v1", "-b"]);
    if (!st || st.code !== 0) {
      git = {};
      return;
    }
    const next: Git = { ...parseStatus(st.stdout) };
    const diff = await run("git", ["diff", "HEAD", "--shortstat"]);
    if (diff?.code === 0) Object.assign(next, parseShortstat(diff.stdout));
    const was = git.branch === next.branch ? git.pr : undefined;
    const ttl = was?.checks === "pending" ? PR_TTL_PENDING : PR_TTL;
    if (next.branch && next.branch !== "detached" && (git.branch !== next.branch || Date.now() - prCheckedAt > ttl)) {
      prCheckedAt = Date.now();
      const pr = await run("gh", ["pr", "view", "--json", "number,state,isDraft,reviewDecision,statusCheckRollup"], 8000);
      next.pr = pr?.code === 0 ? parsePr(pr.stdout) : null;
      if (was?.checks === "pending" && next.pr?.number === was.number && next.pr.checks && next.pr.checks !== "pending") {
        ctx.ui.notify(next.pr.checks === "pass" ? `PR #${next.pr.number}: CI passed` : `PR #${next.pr.number}: CI failed (${next.pr.failing.join(", ")})`, next.pr.checks === "pass" ? "info" : "error");
      }
    } else {
      next.pr = was;
    }
    git = next;
  }

  // Today and the last 7 days, summed from every pi session file's per-message
  // cost. Files are re-read only when their size or mtime moved.
  async function readLedger() {
    const since = Date.now() - 8 * 86_400_000;
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      let names: import("node:fs").Dirent[] = [];
      try {
        names = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        const p = join(dir, d.name);
        if (d.isDirectory() && depth < 3) await walk(p, depth + 1);
        else if (d.isFile() && d.name.endsWith(".jsonl")) found.push(p);
      }
    };
    await walk(SESSIONS, 0);
    const recent: Record<string, number>[] = [];
    for (const f of found) {
      try {
        const s = await stat(f);
        if (s.mtimeMs < since) continue;
        let hit = fileDays.get(f);
        if (!hit || hit.mtimeMs !== s.mtimeMs || hit.size !== s.size) {
          hit = { mtimeMs: s.mtimeMs, size: s.size, days: costByDay(await readFile(f, "utf8")) };
          fileDays.set(f, hit);
        }
        recent.push(hit.days);
      } catch {
        // file moved or vanished
      }
    }
    ledger = ledgerFrom(recent, Date.now());
  }

  async function loadBudget() {
    try {
      budget = JSON.parse(await readFile(CONFIG, "utf8")).budget ?? {};
    } catch {
      budget = {};
    }
  }

  // Notify once per level (80%, 100%) per budget, and once when the burn rate
  // will cross the session budget within 15 minutes.
  function checkBudget() {
    if (!ctx || (!budget.session && !budget.day)) return;
    const v = view();
    for (const [key, limit, spent, name] of [["session", budget.session, v.session.cost, "Session"], ["day", budget.day, ledger?.today ?? 0, "Today's"]] as const) {
      if (!limit) continue;
      const level = spent >= limit ? 100 : spent >= limit * 0.8 ? 80 : 0;
      if (level > (alerts[key] ?? 0)) {
        ctx.ui.notify(level === 100 ? `${name} spend ${money(spent)} is over the ${money(limit)} budget` : `${name} spend ${money(spent)} is at ${Math.round((spent / limit) * 100)}% of the ${money(limit)} budget`, level === 100 ? "error" : "warning");
        alerts[key] = level;
      }
      const burn = burnRate(v);
      if (key === "session" && !alerts.pace && level < 80 && burn && ((limit - spent) / burn) * 60 <= 15) {
        ctx.ui.notify(`At ${money(burn)}/h the ${money(limit)} session budget is reached in ~${Math.max(1, Math.round(((limit - spent) / burn) * 60))}m`, "warning");
        alerts.pace = true;
      }
    }
  }

  async function refreshAll() {
    await Promise.all([readGit(), readLedger()]);
    redraw();
  }

  // ---- events ----------------------------------------------------------------

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    history = [];
    turns = [];
    tools = {};
    files = [];
    alerts = {};
    await loadBudget();
    if (c.mode === "tui") {
      c.ui.setWidget(WIDGET, (t, theme) => {
        tui = t;
        return {
          render(width: number) {
            const light = (theme as { appearance?: string }).appearance === "light";
            const v = view();
            const lines = header(v, width, light, expanded);
            if (expanded) lines.push(...details(v, width, light));
            return lines.map((l) => truncateToWidth(l, width));
          },
          invalidate() {},
        };
      });
      // the turn timer ticks, and git and the ledger stay fresh between turns
      timers.push(setInterval(() => turnStart && redraw(), 1000));
      timers.push(setInterval(() => void refreshAll(), 60_000));
    }
    void refreshAll();
  });

  pi.on("session_shutdown", () => {
    for (const t of timers.splice(0)) clearInterval(t);
  });

  pi.on("agent_start", (_e, c) => {
    ctx = c;
    turnStart = Date.now();
    turnBase = usage();
    redraw();
  });

  pi.on("tool_execution_end", (e) => {
    tools[e.toolName] = (tools[e.toolName] ?? 0) + 1;
    const p = e.args?.path;
    if (EDIT_TOOLS.has(e.toolName) && typeof p === "string" && !files.includes(p)) files = [...files, p].slice(-50);
    redraw();
  });

  pi.on("agent_end", async (_e, c) => {
    ctx = c;
    const now = usage();
    if (turnStart) {
      turns = [...turns, {
        ms: Date.now() - turnStart,
        usd: now.cost - turnBase.cost,
        out: now.output - turnBase.output,
        input: now.input - turnBase.input,
        cacheRead: now.cacheRead - turnBase.cacheRead,
        cacheWrite: now.cacheWrite - turnBase.cacheWrite,
      }].slice(-24);
    }
    turnStart = 0;
    const tokens = c.getContextUsage()?.tokens;
    if (tokens != null && tokens !== history.at(-1)) history = [...history, tokens].slice(-12);
    await refreshAll();
    checkBudget();
  });

  // ---- commands ----------------------------------------------------------------

  pi.registerCommand("usage", {
    description: "Toggle the usage detail panel; /usage text prints the figures",
    handler: async (args, c) => {
      ctx = c;
      if (args.trim() === "text" || c.mode !== "tui") {
        c.ui.notify(report(view()), "info");
        return;
      }
      expanded = !expanded;
      redraw();
    },
  });

  pi.registerCommand("budget", {
    description: "Spend budget: /budget 10 (session), /budget day 50, /budget off",
    handler: async (args, c) => {
      ctx = c;
      const [a, b] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const amount = (s?: string) => (s && +s.replace("$", "") > 0 ? +s.replace("$", "") : null);
      if (a === "off" || a === "clear") {
        if (b !== "session") delete budget.day;
        if (b !== "day") delete budget.session;
      } else if (a === "day" && amount(b)) budget.day = amount(b)!;
      else if (a === "session" && amount(b)) budget.session = amount(b)!;
      else if (amount(a)) budget.session = amount(a)!;
      else if (a) {
        c.ui.notify("Usage: /budget 10 (session), /budget day 50, /budget off [day|session]", "warning");
        return;
      }
      await writeFile(CONFIG, JSON.stringify({ budget }, null, 2));
      alerts = {};
      const use = budgetUse(budget, view());
      c.ui.notify(use ? `Budget set. ${Math.round(use.frac * 100)}% of $${use.limit.toFixed(2)} (${use.scope}) used.` : "No budget set.", "info");
      checkBudget();
      redraw();
    },
  });
}
