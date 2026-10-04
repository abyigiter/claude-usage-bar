// Usage bar: a strip above the prompt with rate limits, context, cost, git,
// a live turn timer, activity, and model. ▾ opens a detail panel (context
// breakdown and compaction forecast, spend per turn, turn timing and cache hit
// rate, top tools); /usage prints the same as text.

const READING = { plugin: "usage-bar", key: "last" };
const ACTIVITY = { plugin: "usage-bar", key: "activity" };
const GIT = { plugin: "usage-bar", key: "git" };
const TURN = { plugin: "usage-bar", key: "turn" };
const UI = { plugin: "usage-bar", key: "ui" };
const TURNS = { plugin: "usage-bar", key: "turns" };
const CTXMAP = { plugin: "usage-bar", key: "ctxmap" };
const BUDGET = { plugin: "usage-bar", key: "budget" };
const LEDGER = { plugin: "usage-bar", key: "ledger" };
const ALERTS = { plugin: "usage-bar", key: "alerts" };
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_WIDTH = 8;
const BARS = "▁▂▃▄▅▆▇█";
const HISTORY = 12;
const TURN_LOG = 24;
const PR_TTL = 5 * 60_000;
const PR_TTL_PENDING = 60_000; // while CI runs, so its result toasts soon after
const LEDGER_DAYS = 30;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
let commandName;
let turnStart = 0; // ms, 0 when no turn is running

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await takeReading($);
    await $.state.set(BUDGET, (await storeGet($, "budget")) ?? {});
    await syncLedger($);
    try { await $.store.delete("ledger"); } catch { /* 0.9.0's shared ledger, replaced */ }
    $.clock.every(60_000, () => takeReading($)); // keep reset countdowns fresh
    $.clock.every(1000, () => { // live turn timer: redraw each second while a turn runs
      if (turnStart && Date.now() - turnStart < 2 * 3_600_000) $.state.get(TURN).then(({ value: t }) => $.state.set(TURN, { ...t, startedAt: turnStart, tick: Date.now() }));
    });
    try {
      await $.command.register({ name: "budget", description: "Spend budget: /budget 10 (session), /budget day 50, /budget off" });
    } catch {
      // taken by another plugin
    }
    for (const name of ["usage", "context"]) {
      try {
        await $.command.register({ name, description: "Rate limits, context forecast, cost, and activity" });
        commandName = name;
        break;
      } catch {
        // name taken; try the next one
      }
    }
    return result;
  });

  on("command.run", { command: "usage" }, ($, e, next) => answerUsage($, e, next));
  on("command.run", { command: "context" }, ($, e, next) => answerUsage($, e, next));
  on("command.run", { command: "budget" }, ($, e) => answerBudget($, e));

  on("prompt.submit", async ($, e, next) => {
    turnStart = Date.now();
    const { value: u } = await $.state.get(READING);
    await $.state.set(TURN, { startedAt: turnStart, tick: turnStart, costAt: u?.cost?.usd });
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    const { value: a = { calls: 0, files: [] } } = await $.state.get(ACTIVITY);
    const files = [...a.files];
    const p = e.input?.file_path ?? e.input?.notebook_path;
    if (EDIT_TOOLS.has(e.tool) && p && !files.includes(p)) files.push(p);
    const tools = { ...a.tools, [e.tool]: (a.tools?.[e.tool] ?? 0) + 1 };
    await $.state.set(ACTIVITY, { calls: a.calls + 1, files: files.slice(-50), tools });
    return result;
  });

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    const { value: prev } = await $.state.get(READING);
    await $.state.set(READING, mergeReading(prev, {
      context: e.context,
      rateLimits: e.rateLimits,
      cost: e.cost,
      model: prev?.model,
    }));
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) { // main-loop turns only
      turnStart = 0;
      await takeReading($);
      const { value: after } = await $.state.get(READING);
      const { value: turn } = await $.state.get(TURN);
      await logTurn($, e, turn?.costAt, after);
      await checkBudget($);
      const { value: ui } = await $.state.get(UI);
      if (ui?.expanded) await takeBreakdown($);
    }
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value: u } = await $.state.get(READING);
    const { value: a } = await $.state.get(ACTIVITY);
    const hasUsage = u && (u.rateLimits?.length || u.context?.window || typeof u.cost?.usd === "number");
    if (!hasUsage && !a?.calls) return next(e);
    if (e.props.hasSurvey) return next(e);
    const { value: git } = await $.state.get(GIT);
    const { value: turn } = await $.state.get(TURN);
    const { value: ui } = await $.state.get(UI);
    const { value: budget = {} } = await $.state.get(BUDGET);
    const { value: ledger } = await $.state.get(LEDGER);
    const view = {
      u, a, git, budget, ledger,
      working: e.props.isWorking && turn?.startedAt ? Date.now() - turn.startedAt : null,
      columns: e.props.bodyColumns,
    };
    const els = $.ui.resolve(e);
    const isDesktop = e.surface === "desktop";
    const { Box, Button, Link } = els;
    const expanded = !!ui?.expanded;
    const more = Button({
      key: "more",
      label: expanded ? "▴ less" : "▾ more",
      plain: true,
      dimColor: true,
      onPress: async () => {
        await $.state.set(UI, { expanded: !expanded });
        if (!expanded) await takeBreakdown($);
      },
    });
    let header;
    if (isDesktop) {
      const { left, right } = desktopRow(els, view);
      if (!left.length && !right.length) return next(e);
      // one even flow: pills wrap as units in a fixed order, never as two
      // ragged groups when one pill (a long branch, a PR) grows
      header = Box({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 1, paddingX: 1, children: [...left, ...right, more] });
    } else {
      const row = terminalRow(els, view);
      if (!row.length) return next(e);
      if (git?.pr?.url) row.push(Link({ href: git.pr.url, label: `#${git.pr.number} ↗` }));
      header = Box({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 1, paddingX: 1, children: [...row, more] });
    }
    const body = [header];
    if (expanded) {
      const { value: turns = [] } = await $.state.get(TURNS);
      const { value: map } = await $.state.get(CTXMAP);
      const d = { ...insights(u, a, turns, map), budget, ledger };
      body.push(isDesktop ? desktopDetails(els, d, git, u) : terminalDetails(els, d, git, u, view.columns));
      const links = prLinks(els, git?.pr);
      if (links) body.push(links);
    }
    return Box({ flexDirection: "column", children: body });
  });
}

// Failing checks as links to their CI pages, under the detail panel. Only
// when something failed: the PR itself is already the header's ↗.
function prLinks({ Box, Text, Link }, pr) {
  if (!pr?.failing?.length) return null;
  const kids = [Text({ children: "✗ failing ", color: "red", bold: true })];
  pr.failing.forEach((c, i) => kids.push(...(i ? [Text({ children: " · ", dimColor: true })] : []), Link({ href: c.url, label: c.name })));
  return Box({ key: "pr-links", flexDirection: "row", flexWrap: "wrap", alignItems: "center", paddingX: 2, children: kids });
}

// One record per main-loop turn: how long, what it cost, what it read and wrote.
// The cost is measured from the prompt's submit: session.measure has already
// moved the reading by the time the turn completes.
async function logTurn($, e, costAt, after) {
  const usd = typeof after?.cost?.usd === "number" && typeof costAt === "number" ? Math.max(0, after.cost.usd - costAt) : null;
  const k = e.usage ?? {};
  const rec = {
    ms: e.durationMs ?? 0,
    usd,
    in: k.input_tokens ?? 0,
    out: k.output_tokens ?? 0,
    cr: k.cache_read_input_tokens ?? 0,
    cw: k.cache_creation_input_tokens ?? 0,
  };
  const { value: turns = [] } = await $.state.get(TURNS);
  await $.state.set(TURNS, [...turns, rec].slice(-TURN_LOG));
  await syncLedger($, true);
}

// $.store, failing soft: a host without it keeps budgets and the ledger off.
async function storeGet($, key) {
  try {
    return await $.store.get(key);
  } catch {
    return undefined;
  }
}

async function storeSet($, key, value) {
  try {
    await $.store.set(key, value);
  } catch {
    // no store on this host
  }
}

// ---- budgets and the daily ledger ----------------------------------------------
// Each session keeps its own running total per local day in $.store, under
// `day:<date>:<session>`, so parallel sessions never overwrite each other.
// A session that began today counts in full; one carried over from an earlier
// day counts from its first reading today. Today is the sum over sessions.
let sessionKey;

function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function syncLedger($, isTurn = false) {
  const { value: u } = await $.state.get(READING);
  const cost = u?.cost?.usd;
  if (typeof cost !== "number") return;
  if (!sessionKey) {
    try {
      sessionKey = await $.session.id();
    } catch {
      sessionKey = `s${u.startedAt ?? Date.now()}`;
    }
  }
  const day = dayKey();
  const key = `day:${day}:${sessionKey}`;
  const prev = await storeGet($, key);
  const startedToday = typeof u.startedAt === "number" && dayKey(u.startedAt) === day;
  const entry = prev ?? { spent: startedToday ? cost : 0, last: cost, turns: 0 };
  if (prev) {
    const delta = cost - prev.last;
    entry.spent = prev.spent + (delta < 0 ? cost : delta); // a reset cost counts from zero
    entry.last = cost;
  }
  if (isTurn) entry.turns += 1;
  if (!prev || prev.spent !== entry.spent || prev.last !== entry.last || isTurn) await storeSet($, key, entry);
  await refreshLedger($);
}

async function refreshLedger($) {
  let keys = [];
  try {
    keys = (await $.store.keys()).filter((k) => k.startsWith("day:"));
  } catch {
    return;
  }
  const days = [...Array(7)].map((_, i) => dayKey(Date.now() - i * 86_400_000)).reverse();
  const totals = Object.fromEntries(days.map((d) => [d, { usd: 0, turns: 0 }]));
  const oldest = dayKey(Date.now() - LEDGER_DAYS * 86_400_000);
  for (const k of keys) {
    const d = k.split(":")[1];
    if (d < oldest) {
      try { await $.store.delete(k); } catch { /* keep */ }
      continue;
    }
    if (!totals[d]) continue;
    const v = await storeGet($, k);
    totals[d].usd += v?.spent ?? 0;
    totals[d].turns += v?.turns ?? 0;
  }
  const today = totals[days.at(-1)];
  await $.state.set(LEDGER, {
    date: days.at(-1),
    today: today.usd,
    todayTurns: today.turns,
    week: days.reduce((s, d) => s + totals[d].usd, 0),
    days: days.map((d) => totals[d].usd),
  });
}

async function answerBudget($, e) {
  const [a, b] = String(e.args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const budget = (await storeGet($, "budget")) ?? {};
  const amount = (v) => (v != null && Number.isFinite(+v.replace("$", "")) && +v.replace("$", "") > 0 ? +v.replace("$", "") : null);
  if (a === "off" || a === "clear") {
    if (b === "day") delete budget.day;
    else if (b === "session") delete budget.session;
    else { delete budget.day; delete budget.session; }
  } else if (a === "day" && amount(b)) budget.day = amount(b);
  else if (a === "session" && amount(b)) budget.session = amount(b);
  else if (amount(a)) budget.session = amount(a);
  else if (a) return { text: "Usage: /budget 10 (session), /budget day 50, /budget off [day|session]" };
  await storeSet($, "budget", budget);
  await $.state.set(BUDGET, budget);
  await $.state.set(ALERTS, {});
  await checkBudget($);
  const { value: u } = await $.state.get(READING);
  const { value: l } = await $.state.get(LEDGER);
  return { text: budgetLines(budget, u, l).join("\n") || "No budget set. /budget 10 sets a session budget, /budget day 50 a daily one." };
}

function budgetLines(budget = {}, u, l) {
  const lines = [];
  const cost = u?.cost?.usd ?? 0;
  if (budget.session) lines.push(`Session budget: $${cost.toFixed(2)} of $${budget.session.toFixed(2)} (${Math.round((cost / budget.session) * 100)}%)`);
  if (budget.day) lines.push(`Daily budget: $${(l?.today ?? 0).toFixed(2)} of $${budget.day.toFixed(2)} (${Math.round(((l?.today ?? 0) / budget.day) * 100)}%)`);
  return lines;
}

// Toast once per level (80%, 100%) per scope, and once when the burn rate will
// cross the session budget within 15 minutes.
async function checkBudget($) {
  const { value: budget = {} } = await $.state.get(BUDGET);
  if (!budget.session && !budget.day) return;
  const { value: u } = await $.state.get(READING);
  const { value: l } = await $.state.get(LEDGER);
  const { value: seen = {} } = await $.state.get(ALERTS);
  const next = { ...seen };
  const burn = burnRate(u);
  const scopes = [
    ["session", budget.session, u?.cost?.usd ?? 0, "Session"],
    ["day", budget.day, l?.today ?? 0, "Today's"],
  ];
  for (const [key, limit, spent, name] of scopes) {
    if (!limit) continue;
    const level = spent >= limit ? 100 : spent >= limit * 0.8 ? 80 : 0;
    if (level > (seen[key] ?? 0)) {
      $.ui.toast(level === 100
        ? `${name} spend $${spent.toFixed(2)} is over the $${limit.toFixed(2)} budget`
        : `${name} spend $${spent.toFixed(2)} is at ${Math.round((spent / limit) * 100)}% of the $${limit.toFixed(2)} budget`, { timeoutMs: 8000 });
      next[key] = level;
    }
    if (key === "session" && !seen.pace && level < 80 && burn) {
      const mins = ((limit - spent) / burn) * 60;
      if (mins <= 15) {
        $.ui.toast(`At $${burn.toFixed(2)}/h the $${limit.toFixed(2)} session budget is reached in ~${fmtMinutes(mins)}`, { timeoutMs: 8000 });
        next.pace = true;
      }
    }
  }
  await $.state.set(ALERTS, next);
}

// 0..1+ of the tighter budget, and which one, for the cost figure's color.
function budgetUse(budget = {}, u, l) {
  const uses = [
    budget.session && { scope: "session", limit: budget.session, frac: (u?.cost?.usd ?? 0) / budget.session },
    budget.day && { scope: "day", limit: budget.day, frac: (l?.today ?? 0) / budget.day },
  ].filter(Boolean);
  return uses.sort((x, y) => y.frac - x.frac)[0] ?? null;
}

function budgetTone(use) {
  return !use ? null : use.frac >= 1 ? "red" : use.frac >= 0.8 ? "yellow" : "green";
}

// /context's category rows, estimated locally (no token-count requests).
async function takeBreakdown($) {
  try {
    const usage = await $.session.usage({ breakdown: "summary" });
    const b = usage?.context?.breakdown;
    if (!b?.categories) return;
    await $.state.set(CTXMAP, {
      at: Date.now(),
      cats: b.categories.filter((c) => !c.isDeferred).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    });
  } catch {
    // no breakdown on this host
  }
}

// Figures the detail views share, derived once per draw.
function insights(u = {}, a = { calls: 0, files: [] }, turns = [], map) {
  const ctx = u.context?.window ? { tokens: u.context.tokens ?? 0, window: u.context.window, pct: ctxPct(u.context) } : null;
  const used = (map?.cats ?? []).filter((c) => c.kind === "used" && c.tokens > 0).sort((x, y) => y.tokens - x.tokens);
  const free = (map?.cats ?? []).find((c) => c.kind === "free")?.tokens;
  const growth = (u.history ?? []).slice(1).map((v, i) => v - u.history[i]).filter((d) => d > 0);
  const perTurn = growth.length ? growth.reduce((s, d) => s + d, 0) / growth.length : null;
  const turnsLeft = free != null && perTurn ? Math.floor(free / perTurn) : null;
  const priced = turns.filter((t) => t.usd != null);
  const spent = priced.reduce((s, t) => s + t.usd, 0);
  const read = turns.reduce((s, t) => s + t.cr, 0);
  const fed = turns.reduce((s, t) => s + t.in + t.cr + t.cw, 0);
  const tools = Object.entries(a.tools ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([n, c]) => [toolName(n), c]);
  return {
    ctx, used, free, perTurn, turnsLeft,
    cost: typeof u.cost?.usd === "number" ? u.cost.usd : null,
    burn: burnRate(u),
    lastCost: u.costDelta > 0 ? u.costDelta : null,
    avgCost: priced.length ? spent / priced.length : null,
    turnCosts: priced.map((t) => t.usd),
    turns: turns.length,
    avgMs: turns.length ? turns.reduce((s, t) => s + t.ms, 0) / turns.length : null,
    maxMs: turns.length ? Math.max(...turns.map((t) => t.ms)) : null,
    turnMs: turns.map((t) => t.ms),
    out: turns.reduce((s, t) => s + t.out, 0),
    cacheHit: fed ? Math.round((read / fed) * 100) : null,
    calls: a.calls,
    tools,
    files: a.files.slice(-4).map((f) => f.split("/").pop()),
    session: duration(u.startedAt),
  };
}

// mcp__Claude_Browser__browser_batch -> browser_batch
function toolName(n) {
  return n.startsWith("mcp__") ? n.split("__").pop() : n;
}

function secs(ms) {
  if (ms == null) return "–";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

async function answerUsage($, e, next) {
  if (e.command !== commandName) return next(e);
  await takeReading($);
  const { value: u = {} } = await $.state.get(READING);
  const { value: a = { calls: 0, files: [] } } = await $.state.get(ACTIVITY);
  const { value: git } = await $.state.get(GIT);
  const { value: turns = [] } = await $.state.get(TURNS);
  const { value: budget } = await $.state.get(BUDGET);
  const { value: ledger } = await $.state.get(LEDGER);
  return { text: usageLines(u, a, git, turns, budget, ledger).join("\n") };
}

function usageLines(u = {}, a = { calls: 0, files: [] }, git, turns = [], budget, ledger) {
  const lines = [];
  if (u.rateLimits?.length) {
    lines.push("Rate limits:");
    for (const rl of u.rateLimits) {
      const p = clampPct(rl.percentUsed);
      const reset = resetsIn(rl.resetsAt);
      const pace = paceOf(rl);
      const note = pace?.projected != null && pace.projected >= 100
        ? `  ·  on pace for ${Math.round(pace.projected)}%, hits limit in ~${fmtMinutes(pace.minutesToLimit)}`
        : pace ? "  ·  pace ok" : "";
      lines.push(`  ${limitLabel(rl)}  ${bar(p, pace?.elapsed)}  ${p}%${reset ? `  ·  resets in ${reset}` : ""}${note}`);
    }
  }
  if (u.context?.window) {
    const pct = ctxPct(u.context);
    const spark = sparkline(u.history);
    lines.push(`Context: ${short(u.context.tokens ?? 0)} / ${short(u.context.window)} (${pct}%)${spark ? `  ${spark}` : ""}`);
    if (u.delta) lines.push(`  last turn: ${u.delta > 0 ? `▲ +${short(u.delta)}` : `▼ ${short(-u.delta)}`}`);
  }
  const cost = typeof u.cost?.usd === "number" ? `$${u.cost.usd.toFixed(2)}` : null;
  const dur = duration(u.startedAt);
  const burn = burnRate(u);
  const extras = [cost, burn && `$${burn.toFixed(2)}/h`, u.costDelta > 0 && `last turn +$${u.costDelta.toFixed(2)}`, dur].filter(Boolean);
  if (extras.length) lines.push(`Session: ${extras.join("  ·  ")}`);
  if (turns.length) {
    const d = insights(u, a, turns);
    lines.push(`Turns: ${d.turns}  ·  avg ${secs(d.avgMs)}  ·  longest ${secs(d.maxMs)}${d.cacheHit != null ? `  ·  cache hit ${d.cacheHit}%` : ""}${d.avgCost != null ? `  ·  avg $${d.avgCost.toFixed(2)}/turn` : ""}`);
  }
  lines.push(`Activity: ${a.calls} tool call${a.calls === 1 ? "" : "s"}${a.files.length ? `  ·  ${a.files.length} file${a.files.length === 1 ? "" : "s"} edited` : ""}`);
  const top = Object.entries(a.tools ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 5);
  if (top.length) lines.push(`  tools: ${top.map(([n, c]) => `${n}×${c}`).join("  ")}`);
  if (a.files.length) lines.push(`  edited: ${a.files.slice(-5).map((f) => f.split("/").pop()).join(", ")}`);
  if (ledger) lines.push(`Today: $${ledger.today.toFixed(2)} over ${ledger.todayTurns} turn${ledger.todayTurns === 1 ? "" : "s"}  ·  last 7 days $${ledger.week.toFixed(2)}`);
  lines.push(...budgetLines(budget, u, ledger));
  if (git?.branch) lines.push(`Git: ${gitText(git)}`);
  for (const c of git?.pr?.failing ?? []) lines.push(`  ✗ ${c.name}  ${c.url}`);
  if (git?.pr?.url) lines.push(`  ${git.pr.url}`);
  if (u.model) lines.push(`Model: ${shortModel(u.model)}`);
  return lines;
}

function gitText(g) {
  return [
    g.branch,
    (g.added || g.removed) && `+${g.added ?? 0} −${g.removed ?? 0}`,
    g.untracked && `${g.untracked} new`,
    g.ahead && `↑${g.ahead}`,
    g.behind && `↓${g.behind}`,
    g.pr && prText(g.pr),
  ].filter(Boolean).join("  ·  ");
}

function prText(pr) {
  const checks = { pass: "✓ checks", fail: "✗ checks", pending: "● checks" }[pr.checks];
  const review = { approved: "approved", changes: "changes requested" }[pr.review];
  return [`PR #${pr.number} ${pr.state}`, review, checks].filter(Boolean).join(" ");
}

// PR tone: what needs attention first (failing checks, requested changes).
function prTone(pr) {
  if (pr.checks === "fail" || pr.review === "changes" || pr.state === "closed") return "red";
  if (pr.state === "merged") return "purple";
  if (pr.state === "draft") return "slate";
  if (pr.checks === "pending") return "yellow";
  return "green";
}

// dollars per hour since the session began; needs a few minutes to mean anything
function burnRate(u) {
  if (typeof u?.cost?.usd !== "number" || typeof u.startedAt !== "number") return null;
  const hours = (Date.now() - u.startedAt) / 3_600_000;
  return hours >= 0.05 && u.cost.usd > 0 ? u.cost.usd / hours : null;
}

function mmss(ms) {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

async function takeReading($) {
  const usage = await $.session.usage();
  const { value: prev } = await $.state.get(READING);
  await $.state.set(READING, mergeReading(prev, { ...usage, model: await $.session.model() }));
  await syncLedger($);
  await takeGit($);
}

async function takeGit($) {
  let git = {};
  try {
    const r = await $.process.run(["git", "status", "--porcelain=v1", "-b"], { timeoutMs: 3000 });
    if (r.exitCode === 0) {
      const [head, ...rest] = r.stdout.split("\n");
      const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/.exec(head);
      const track = m?.[2] ?? "";
      const files = rest.filter(Boolean);
      git = {
        branch: m?.[1]?.startsWith("HEAD (no branch)") ? "detached" : m?.[1],
        dirty: files.length,
        untracked: files.filter((l) => l.startsWith("??")).length,
        ahead: +(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: +(/behind (\d+)/.exec(track)?.[1] ?? 0),
        ...(await diffStat($)),
      };
    }
  } catch {
    // not a repo, or no git
  }
  const { value: prev } = await $.state.get(GIT);
  // the PR changes rarely: look again on a branch switch or every few minutes
  const ttl = prev?.pr?.checks === "pending" ? PR_TTL_PENDING : PR_TTL;
  const stale = !prev?.prCheckedAt || prev.branch !== git.branch || Date.now() - prev.prCheckedAt > ttl;
  if (git.branch && git.branch !== "detached" && stale) {
    Object.assign(git, await lookupPr($));
    const was = prev?.branch === git.branch ? prev?.pr : null;
    if (was?.checks === "pending" && git.pr?.number === was.number && git.pr.checks && git.pr.checks !== "pending") {
      $.ui.toast(git.pr.checks === "pass"
        ? `PR #${git.pr.number}: CI passed`
        : `PR #${git.pr.number}: CI failed (${git.pr.failing.map((c) => c.name).join(", ")})`, { timeoutMs: 10_000 });
    }
  }
  else if (git.branch && prev?.branch === git.branch) Object.assign(git, { pr: prev.pr, prCheckedAt: prev.prCheckedAt });
  await $.state.set(GIT, git);
}

// Lines added and removed against HEAD, staged and unstaged together.
async function diffStat($) {
  try {
    const r = await $.process.run(["git", "diff", "HEAD", "--shortstat"], { timeoutMs: 3000 });
    if (r.exitCode !== 0) return {};
    return {
      added: +(/(\d+) insertion/.exec(r.stdout)?.[1] ?? 0),
      removed: +(/(\d+) deletion/.exec(r.stdout)?.[1] ?? 0),
    };
  } catch {
    return {};
  }
}

// The branch's pull request through the GitHub CLI; nothing when gh is missing,
// signed out, or the branch has none.
async function lookupPr($) {
  const checkedAt = Date.now();
  try {
    const r = await $.process.run(["gh", "pr", "view", "--json", "number,url,state,isDraft,reviewDecision,statusCheckRollup"], { timeoutMs: 8000 });
    if (r.exitCode !== 0) return { pr: null, prCheckedAt: checkedAt };
    const p = JSON.parse(r.stdout);
    const rollup = p.statusCheckRollup ?? [];
    const verdict = (c) => (c.conclusion || c.state || c.status || "").toUpperCase();
    const runs = rollup.map(verdict);
    const failing = rollup
      .filter((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(verdict(c)))
      .slice(0, 5)
      .map((c) => ({ name: c.name || c.context || "check", url: c.detailsUrl || c.targetUrl || p.url }));
    const checks = !runs.length ? null
      : runs.some((x) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(x)) ? "fail"
      : runs.every((x) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(x)) ? "pass" : "pending";
    return {
      pr: {
        number: p.number,
        url: p.url,
        failing,
        pending: runs.filter((x) => !["SUCCESS", "NEUTRAL", "SKIPPED", "FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(x)).length,
        state: p.isDraft ? "draft" : String(p.state ?? "").toLowerCase(),
        review: p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes" : null,
        checks,
      },
      prCheckedAt: checkedAt,
    };
  } catch {
    return { pr: null, prCheckedAt: checkedAt };
  }
}

// Deltas are how much the last turn added to context and to cost. Both
// session.measure and turn.complete refresh the reading in one turn, so only move
// a delta (and the sparkline history) when its figure actually changed.
function mergeReading(prev, next) {
  const startedAt = next.startedAt ?? prev?.startedAt;
  const usd = next.cost?.usd;
  const costMoved = usd != null && prev?.cost?.usd != null && usd !== prev.cost.usd;
  const costDelta = costMoved ? usd - prev.cost.usd : prev?.costDelta;
  const prevTokens = prev?.context?.tokens;
  const tokens = next.context?.tokens;
  if (tokens == null || prevTokens == null || tokens === prevTokens) {
    return { ...next, startedAt, costDelta, prevTokens: prev?.prevTokens, delta: prev?.delta, history: prev?.history };
  }
  return {
    ...next,
    startedAt,
    costDelta,
    prevTokens,
    delta: tokens - prevTokens,
    history: [...(prev?.history ?? []), tokens].slice(-HISTORY),
  };
}

// ---- terminal: tinted chips ---------------------------------------------------
// Each chip is one Box of Texts on a shared tint, glued with no gap inside, so
// the row wraps between chips and never through one.
const STATUS_COLOR = { ok: "green", warn: "yellow", crit: "red" };
const TERM_BAR = 6;
// [tint, text, accent, muted]
const CHIP = {
  green:  ["#1c3328", "#d6f2e1", "#5fcf9a", "#7fa892"],
  yellow: ["#372f15", "#f5e8b8", "#e6b830", "#ad9b62"],
  red:    ["#432020", "#fadad4", "#f47563", "#b8837b"],
  blue:   ["#1f2a46", "#d9e3fa", "#7b9cf2", "#8190b3"],
  purple: ["#2b2645", "#e0daf8", "#a996ff", "#8f88b3"],
  cyan:   ["#16323a", "#d0eef2", "#5cc9d6", "#76a3a9"],
  slate:  ["#29292f", "#e2e2e8", "#a3a3b0", "#82828e"],
};
const CTX_TONE = (pct) => (pct < 50 ? "blue" : pct < 75 ? "yellow" : "red");

// parts: [text, "label" | "value" | "aside" | "accent" | "off" | "mark"]
function chip(Text, tone, parts, key) {
  const [bg, fg, ac, mu] = CHIP[tone];
  const style = {
    label: { color: ac, bold: true },
    value: { color: fg, bold: true },
    aside: { color: mu },
    accent: { color: ac },
    off: { color: mu, dimColor: true },
    mark: { color: fg, bold: true },
    add: { color: "#6fdc9a", bold: true },
    del: { color: "#f5806f", bold: true },
  };
  const last = parts.length - 1;
  return {
    key,
    children: parts.map(([s, kind], i) => Text({
      backgroundColor: bg,
      ...style[kind],
      children: `${i === 0 ? " " : ""}${s}${i === last ? " " : ""}`,
    })),
  };
}

function chipBar(p, elapsed, width = TERM_BAR) {
  const filled = Math.round((p / 100) * width);
  const mark = elapsed == null ? -1 : Math.min(width - 1, Math.floor(elapsed * width));
  const runs = [];
  for (let i = 0; i < width; i++) {
    const kind = i === mark ? "mark" : i < filled ? "accent" : "off";
    const g = kind === "mark" ? "╋" : "━";
    if (runs.at(-1)?.[1] === kind) runs.at(-1)[0] += g;
    else runs.push([g, kind]);
  }
  return runs;
}

function terminalRow({ Box, Text }, { u, a, git, working, columns, budget, ledger }) {
  const wide = columns == null || columns >= 100;
  const chips = [];

  for (const rl of u?.rateLimits ?? []) {
    const p = clampPct(rl.percentUsed);
    const reset = resetsIn(rl.resetsAt);
    const parts = [[`${limitLabel(rl)} `, "label"], ...chipBar(p, paceOf(rl)?.elapsed), [` ${p}%`, "value"]];
    if (reset && wide) parts.push([` ↻ ${reset}`, "aside"]);
    chips.push(chip(Text, STATUS_COLOR[limitStatus(rl)], parts, `rl-${rl.kind}`));
  }

  if (u?.context?.window) {
    const pct = ctxPct(u.context);
    const parts = [["ctx ", "label"], ...chipBar(pct), [` ${pct}%`, "value"], [` ${short(u.context.tokens ?? 0)}/${short(u.context.window)}`, "aside"]];
    const spark = sparkline(u.history);
    if (spark && (columns == null || columns >= 110)) parts.push([` ${spark}`, "accent"]);
    if (u.delta) parts.push([u.delta > 0 ? ` ▲ +${short(u.delta)}` : ` ▼ ${short(-u.delta)}`, "aside"]);
    chips.push(chip(Text, CTX_TONE(pct), parts, "ctx"));
  }

  if (typeof u?.cost?.usd === "number") {
    const use = budgetUse(budget, u, ledger);
    const parts = [[`$${u.cost.usd.toFixed(2)}`, "value"]];
    if (use?.scope === "session") parts.push([` / $${use.limit.toFixed(0)}`, "aside"]);
    const burn = burnRate(u);
    if (burn && wide) parts.push([` $${burn.toFixed(2)}/h`, "aside"]);
    if (ledger?.today > 0 && wide) parts.push([` today $${ledger.today.toFixed(2)}${budget?.day ? ` / $${budget.day.toFixed(0)}` : ""}`, "aside"]);
    chips.push(chip(Text, budgetTone(use) ?? "yellow", parts, "cost"));
  }

  if (working != null) chips.push(chip(Text, "purple", [["● ", "accent"], [mmss(working), "value"]], "turn"));

  if (git?.branch && wide) {
    const parts = [["git ", "label"], [git.branch.length > 24 ? `${git.branch.slice(0, 23)}…` : git.branch, "value"]];
    if (git.added || git.removed) parts.push([` +${git.added ?? 0}`, "add"], [` −${git.removed ?? 0}`, "del"]);
    else if (git.dirty) parts.push([` ±${git.dirty}`, "accent"]);
    if (git.untracked) parts.push([` ?${git.untracked}`, "aside"]);
    const sync = [git.ahead && `↑${git.ahead}`, git.behind && `↓${git.behind}`].filter(Boolean).join(" ");
    if (sync) parts.push([` ${sync}`, "aside"]);
    chips.push(chip(Text, "cyan", parts, "git"));
  }

  if (git?.pr && wide) {
    const pr = git.pr;
    const parts = [["PR ", "label"], [`#${pr.number}`, "value"], [` ${pr.state}`, "aside"]];
    if (pr.review) parts.push([pr.review === "approved" ? " ✓ approved" : " ✗ changes", pr.review === "approved" ? "add" : "del"]);
    if (pr.checks) parts.push([{ pass: " ✓ ci", fail: " ✗ ci", pending: " ● ci" }[pr.checks], { pass: "add", fail: "del", pending: "accent" }[pr.checks]]);
    chips.push(chip(Text, prTone(pr), parts, "pr"));
  }

  if (a?.calls && wide) {
    const parts = [[`${a.calls} calls`, "value"]];
    if (a.files.length) parts.push([` ✎ ${a.files.length}`, "accent"]);
    chips.push(chip(Text, "purple", parts, "tools"));
  }

  const dur = duration(u?.startedAt);
  if (dur && wide) chips.push(chip(Text, "slate", [[dur, "value"]], "time"));
  if (u?.model) chips.push(chip(Text, "slate", [[shortModel(u.model), "aside"]], "model"));

  return chips.map((c) => Box({ key: c.key, flexDirection: "row", flexShrink: 0, children: c.children }));
}

// ---- terminal: detail panel ------------------------------------------------
// Aligned rows under a rule: a colored label column, then figures and charts.
const CAT_COLORS = ["blue", "magenta", "cyan", "green", "yellow", "red", "white"];

function terminalDetails({ Box, Text }, d, git, u, columns = 100) {
  const T = (children, o = {}) => Text({ children, ...o });
  const rows = [];
  const row = (label, color, kids) => rows.push(Box({ key: `d-${label}`, flexDirection: "row", children: [T(label.padEnd(9), { color, bold: true }), ...kids] }));
  const barW = Math.max(12, Math.min(30, columns - 60));

  rows.push(T("─".repeat(Math.max(10, Math.min(columns - 4, 96))), { dimColor: true }));

  if (d.ctx) {
    const kids = [];
    if (d.used.length) {
      // stacked: one colored run per category, then the free part dim
      let drawn = 0;
      d.used.forEach((c, i) => {
        const n = Math.round((c.tokens / d.ctx.window) * barW);
        if (n > 0) kids.push(T("━".repeat(n), { color: CAT_COLORS[i % CAT_COLORS.length] }));
        drawn += n;
      });
      kids.push(T("━".repeat(Math.max(0, barW - drawn)), { dimColor: true }));
    } else {
      const n = Math.round((d.ctx.pct / 100) * barW);
      kids.push(T("━".repeat(n), { color: STATUS_TERM[CTX_TONE(d.ctx.pct)] }), T("━".repeat(barW - n), { dimColor: true }));
    }
    kids.push(T(` ${d.ctx.pct}%`, { bold: true }), T(`  ${short(d.ctx.tokens)} / ${short(d.ctx.window)}`, { dimColor: true }));
    if (d.free != null) kids.push(T(`  compacts in ${short(d.free)}${d.turnsLeft != null ? ` · ≈${d.turnsLeft} turns` : ""}`, { color: d.turnsLeft != null && d.turnsLeft < 5 ? "red" : undefined, dimColor: !(d.turnsLeft != null && d.turnsLeft < 5) }));
    row("Context", "blue", kids);
    if (d.used.length) {
      const legend = [];
      d.used.slice(0, 6).forEach((c, i) => legend.push(T("● ", { color: CAT_COLORS[i % CAT_COLORS.length] }), T(`${c.name} ${short(c.tokens)}   `, { dimColor: true })));
      rows.push(Box({ key: "d-legend", flexDirection: "row", flexWrap: "wrap", paddingLeft: 9, children: legend }));
    }
  }

  if (d.cost != null) {
    const kids = [T(`$${d.cost.toFixed(2)}`, { bold: true })];
    if (d.burn) kids.push(T(`  $${d.burn.toFixed(2)}/h`, { dimColor: true }));
    if (d.lastCost) kids.push(T(`  last +$${d.lastCost.toFixed(2)}`, { dimColor: true }));
    if (d.avgCost != null) kids.push(T(`  avg $${d.avgCost.toFixed(2)}/turn`, { dimColor: true }));
    if (d.ledger) kids.push(T(`  today $${d.ledger.today.toFixed(2)}  7d $${d.ledger.week.toFixed(2)}`, { dimColor: true }));
    const use = budgetUse(d.budget, u, d.ledger);
    if (use) kids.push(T(`  ${Math.round(use.frac * 100)}% of $${use.limit.toFixed(0)} ${use.scope} budget`, { color: { green: "green", yellow: "yellow", red: "red" }[budgetTone(use)] }));
    const spark = sparkline(d.turnCosts);
    if (spark) kids.push(T(`  ${spark}`, { color: "yellow" }));
    row("Spend", "yellow", kids);
  }

  if (d.turns) {
    const kids = [T(`${d.turns}`, { bold: true }), T(`  avg ${secs(d.avgMs)}  longest ${secs(d.maxMs)}`, { dimColor: true })];
    if (d.cacheHit != null) kids.push(T("  cache ", { dimColor: true }), T(`${d.cacheHit}%`, { color: d.cacheHit >= 70 ? "green" : d.cacheHit >= 40 ? "yellow" : "red" }));
    if (d.out) kids.push(T(`  out ${short(d.out)}`, { dimColor: true }));
    const spark = sparkline(d.turnMs);
    if (spark) kids.push(T(`  ${spark}`, { color: "magenta" }));
    row("Turns", "magenta", kids);
  }

  if (d.tools.length) {
    const top = d.tools[0][1];
    const kids = [];
    d.tools.forEach(([n, c], i) => {
      kids.push(T(`${i ? "   " : ""}${n} `, { dimColor: true }), T("━".repeat(Math.max(1, Math.round((c / top) * 8))), { color: "cyan" }), T(` ${c}`, { bold: true }));
    });
    row("Tools", "cyan", kids);
  }

  if (d.files.length) row("Edited", "green", [T(d.files.join(", "), { dimColor: true })]);
  const meta = [git?.branch && gitText(git), u?.model && shortModel(u.model), d.session && `session ${d.session}`].filter(Boolean);
  if (meta.length) row("Session", "white", [T(meta.join("  ·  "), { dimColor: true })]);

  return Box({ key: "details", flexDirection: "column", paddingX: 1, children: rows });
}
const STATUS_TERM = { blue: "blue", yellow: "yellow", red: "red" };

function bar(p, elapsed) {
  const filled = Math.round((p / 100) * BAR_WIDTH);
  const cells = [...(BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled))];
  if (elapsed != null) cells[Math.min(BAR_WIDTH - 1, Math.floor(elapsed * BAR_WIDTH))] = "┃"; // pace marker
  return cells.join("");
}

function sparkline(history) {
  if (!history || history.length < 2) return null;
  const top = Math.max(...history, 1);
  return history.map((v) => BARS[Math.min(BARS.length - 1, Math.floor((v / top) * (BARS.length - 1)))]).join("");
}

function clampPct(p) {
  return Math.max(0, Math.min(100, Math.round(p ?? 0)));
}

function ctxPct(ctx) {
  return ctx.percent ?? Math.round(((ctx.tokens ?? 0) / ctx.window) * 100);
}

function resetsIn(resetsAt) {
  if (typeof resetsAt !== "string") return null;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return null;
  const m = Math.round((t - Date.now()) / 60_000);
  if (m <= 0) return null;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function duration(startedAt) {
  if (typeof startedAt !== "number") return null;
  const m = Math.floor((Date.now() - startedAt) / 60_000);
  if (m < 1) return null;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function shortModel(id) {
  return String(id)
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

function short(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---- pace logic -----------------------------------------------------------
const WINDOW_MS = { five_hour: 5 * 3_600_000, seven_day: 7 * 24 * 3_600_000 };

function limitLabel(rl) {
  return rl.kind === "five_hour" ? "5h" : rl.kind === "seven_day" ? "7d" : rl.kind;
}

// How far into the window we are, and where the current burn rate lands at reset.
function paceOf(rl) {
  const win = WINDOW_MS[rl.kind];
  const t = Date.parse(rl.resetsAt ?? "");
  if (!win || Number.isNaN(t)) return null;
  const left = Math.max(0, t - Date.now());
  const elapsed = Math.min(1, Math.max(0, 1 - left / win));
  if (elapsed < 0.1) return { elapsed };
  const p = clampPct(rl.percentUsed);
  const projected = p / elapsed;
  const minutesToLimit = p > 0 && projected > 100 ? ((100 - p) / p) * elapsed * (win / 60_000) : null;
  return { elapsed, projected, minutesToLimit };
}

// ok / warn / crit: absolute level, or burning faster than the window allows.
function limitStatus(rl) {
  const p = clampPct(rl.percentUsed);
  if (p >= 90) return "crit";
  const pace = paceOf(rl);
  if (pace?.projected != null && pace.projected >= 150 && p >= 30) return "crit";
  if (p >= 70 || (pace?.projected != null && pace.projected >= 100 && p >= 20)) return "warn";
  return "ok";
}

function fmtMinutes(m) {
  m = Math.max(1, Math.round(m));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---- desktop: one SVG strip ------------------------------------------------
// The whole band is a single drawing, so it never wraps into ragged rows. It
// sits on the host's own band background: no tile fills, color only on the
// figures that carry status. Monospace, so widths are exact without stretching.
const H = 30;
const MID = H / 2;
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const CW = 0.6; // monospace advance, em
const SIZE = { label: 9, value: 12, aside: 10.5 };
const TRACK = { label: 0.8, value: 0, aside: 0 };
const BAR_W = 34;
const PAL = {
  card: ["#0000000a", "#ffffff0a"],
  // [light, dark]
  fg: ["#1f1f24", "#ececf1"],
  mu: ["#74747f", "#9b9ba8"],
  lb: ["#8b8b96", "#7d7d8a"],
  rule: ["#00000018", "#ffffff1c"],
  track: ["#0000001a", "#ffffff1f"],
  green: ["#23875a", "#5fd19c"],
  yellow: ["#a87708", "#e8bd3f"],
  red: ["#c4402b", "#ff7b67"],
  blue: ["#3563d1", "#86a6ff"],
  purple: ["#6a52cc", "#a996ff"],
  cyan: ["#167f8c", "#5cc9d6"],
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textW = (kind, s) => [...s].length * (SIZE[kind] * CW + TRACK[kind]);

// item: {label} | {value, tone} | {aside, tone?} | {bar:{pct,pace,tone}} | {spark, tone} | {dot, tone}
function itemWidth(it) {
  if (it.label != null) return textW("label", it.label);
  if (it.value != null) return textW("value", it.value);
  if (it.aside != null) return textW("aside", it.aside);
  if (it.bar) return BAR_W;
  if (it.spark) return it.spark.length * 3.5 - 1.5;
  if (it.dot) return 7;
  if (it.icon) return 10;
  return 0;
}

function drawItem(it, x) {
  const text = (kind, s, cls) => {
    const fs = SIZE[kind];
    const weight = kind === "value" ? 650 : kind === "label" ? 700 : 500;
    const ls = TRACK[kind] ? ` letter-spacing="${TRACK[kind]}"` : "";
    return `<text class="${cls}" x="${x.toFixed(1)}" y="${(MID + fs * 0.36).toFixed(1)}" font-size="${fs}" font-weight="${weight}"${ls}>${esc(s)}</text>`;
  };
  if (it.label != null) return text("label", it.label, it.cls ?? "lb");
  if (it.value != null) return text("value", it.value, it.tone ?? "fg");
  if (it.aside != null) return text("aside", it.aside, it.tone ?? "mu");
  if (it.icon) {
    const t = MID - 5.5, b = MID + 5.5;
    return `<g class="mu-s" fill="none" stroke-width="1.4" stroke-linecap="round"><circle cx="${x + 2.5}" cy="${b - 1.5}" r="1.5"/><circle cx="${x + 2.5}" cy="${t + 1.5}" r="1.5"/><circle cx="${x + 8}" cy="${t + 3}" r="1.5"/><path d="M${x + 2.5} ${t + 3}V${b - 3}M${x + 8} ${t + 4.5}c0 3-5.5 2.5-5.5 5"/></g>`;
  }
  if (it.dot) return `<circle class="${it.tone}" cx="${x + 3.5}" cy="${MID}" r="3.5"/>`;
  if (it.bar) {
    const w = BAR_W, y = MID - 2;
    const fill = it.bar.pct > 0 ? Math.max(4, (it.bar.pct / 100) * w) : 0;
    let s = `<rect class="track" x="${x}" y="${y}" width="${w}" height="4" rx="2"/>`;
    if (fill) s += `<rect class="${it.bar.tone}" x="${x}" y="${y}" width="${fill.toFixed(1)}" height="4" rx="2"/>`;
    if (it.bar.pace != null) {
      const px = x + Math.min(w - 1, Math.max(1, it.bar.pace * w));
      s += `<rect class="fg" x="${(px - 0.75).toFixed(1)}" y="${y - 3}" width="1.5" height="10" rx=".75"/>`;
    }
    return s;
  }
  if (it.spark) {
    const lo = Math.min(...it.spark), hi = Math.max(...it.spark);
    return it.spark.map((v, j) => {
      const h = 3 + (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 9;
      const op = j === it.spark.length - 1 ? 1 : 0.45;
      return `<rect class="${it.tone}" x="${x + j * 3.5}" y="${(MID + 6 - h).toFixed(1)}" width="2" height="${h.toFixed(1)}" rx="1" opacity="${op}"/>`;
    }).join("");
  }
  return "";
}

// "1h 40m" -> "1h40m", "3d 0h" -> "3d"
function compactSpan(s) {
  return s.replace(/ 0[hm]$/, "").replace(" ", "");
}

// A pill: one figure on a soft tint of its tone with a hairline edge. Each pill
// is its own drawing, so the band's flex layout wraps them as units.
const PILL_TONES = ["green", "yellow", "red", "blue", "purple", "cyan"];
function pillCss(i) {
  const fg = PAL.fg[i];
  return PILL_TONES.map((k) => `.pb-${k}{fill:${PAL[k][i]};fill-opacity:${i ? 0.17 : 0.12};stroke:${PAL[k][i]};stroke-opacity:${i ? 0.42 : 0.35}}`).join("") +
    `.pb-n{fill:${fg};fill-opacity:${i ? 0.06 : 0.045};stroke:${fg};stroke-opacity:${i ? 0.14 : 0.12}}`;
}

// Card tints: fainter than a pill, so four of them side by side stay calm.
function cardCss(i) {
  return PILL_TONES.map((k) => `.cb-${k}{fill:${PAL[k][i]};fill-opacity:${i ? 0.07 : 0.05};stroke:${PAL[k][i]};stroke-opacity:${i ? 0.2 : 0.18}}`).join("");
}

function svgPill(tone, items) {
  const GAP = 5, PADX = 10;
  let x = PADX, body = "";
  items = items.map((it) => (it.label != null && tone && !it.cls ? { ...it, cls: tone } : it));
  items.forEach((it, j) => {
    if (j) x += it.tight ? 3 : GAP;
    body += drawItem(it, x);
    x += itemWidth(it);
  });
  const width = Math.ceil(x + PADX);
  const cls = (i) => Object.entries(PAL).map(([k, v]) => `.${k}{fill:${v[i]}}.${k}-s{stroke:${v[i]}}`).join("") + pillCss(i);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" font-family="${FONT}">` +
    `<style>${cls(0)}@media (prefers-color-scheme:dark){${cls(1)}}</style>` +
    `<rect class="pb-${tone ?? "n"}" x=".5" y="3.5" width="${width - 1}" height="${H - 7}" rx="${(H - 7) / 2}" stroke-width="1"/>${body}</svg>`;
  return { source, width };
}

// Session figures on the left (limits, context, live turn); work and money on
// the right (git, PR, cost, today). Each side wraps on its own.
function desktopRow({ Svg, Link }, { u, git, working, budget, ledger }) {
  const left = [];
  const right = [];
  const add = (side, key, tone, items, alt) => {
    const { source, width } = svgPill(tone, items);
    side.push(Svg({ key, source, alt, width, height: H }));
  };

  for (const rl of u?.rateLimits ?? []) {
    const p = clampPct(rl.percentUsed);
    const pace = paceOf(rl);
    const reset = resetsIn(rl.resetsAt);
    const tone = STATUS_COLOR[limitStatus(rl)];
    const items = [{ label: limitLabel(rl).toUpperCase() }, { bar: { pct: p, pace: pace?.elapsed, tone } }, { value: `${p}%`, tone }];
    if (pace?.projected != null && pace.projected >= 100) items.push({ aside: `→${Math.min(999, Math.round(pace.projected))}%`, tone, tight: true });
    if (reset) items.push({ aside: `↻${compactSpan(reset)}` });
    add(left, `rl-${rl.kind}`, tone, items, `${limitLabel(rl)} ${p}%${reset ? ` resets in ${reset}` : ""}`);
  }

  if (u?.context?.window) {
    const pct = ctxPct(u.context);
    const tone = CTX_TONE(pct);
    const items = [{ label: "CTX" }, { bar: { pct, tone } }, { value: `${pct}%`, tone }, { aside: `${short(u.context.tokens ?? 0)}/${short(u.context.window)}` }];
    if (u.delta) items.push({ aside: u.delta > 0 ? `+${short(u.delta)}` : `−${short(-u.delta)}`, tone });
    add(left, "ctx", tone, items, `context ${pct}%`);
  }

  if (working != null) add(left, "turn", "purple", [{ dot: true, tone: "purple" }, { value: mmss(working), tone: "purple", tight: true }], `turn ${mmss(working)}`);

  if (git?.branch) {
    const items = [{ icon: "branch" }, { value: git.branch.length > 22 ? `${git.branch.slice(0, 21)}…` : git.branch, tight: true }];
    if (git.added || git.removed) items.push({ aside: `+${git.added ?? 0}`, tone: "green" }, { aside: `−${git.removed ?? 0}`, tone: "red", tight: true });
    else if (git.dirty) items.push({ aside: `±${git.dirty}`, tone: "yellow" });
    if (git.untracked) items.push({ aside: `?${git.untracked}` });
    const sync = [git.ahead && `↑${git.ahead}`, git.behind && `↓${git.behind}`].filter(Boolean).join(" ");
    if (sync) items.push({ aside: sync });
    add(right, "git", "cyan", items, `git ${gitText(git)}`);
  }

  if (git?.pr) {
    const pr = git.pr, tone = prTone(pr);
    const items = [{ dot: true, tone }, { value: `#${pr.number}`, tone, tight: true }, { aside: pr.state }];
    if (pr.review) items.push({ aside: pr.review === "approved" ? "✓ approved" : "✗ changes", tone: pr.review === "approved" ? "green" : "red" });
    if (pr.checks) items.push({ aside: { pass: "✓ ci", fail: `✗ ${pr.failing?.length || ""} ci`.replace("  ", " "), pending: "● ci" }[pr.checks], tone: { pass: "green", fail: "red", pending: "yellow" }[pr.checks] });
    add(right, "pr", tone, items, prText(pr));
    if (pr.url) right.push(Link({ href: pr.url, label: "↗" }));
  }

  if (typeof u?.cost?.usd === "number") {
    const use = budgetUse(budget, u, ledger);
    const tone = budgetTone(use);
    const items = [{ label: "COST" }, { value: `$${u.cost.usd.toFixed(2)}`, tone: tone && tone !== "green" ? tone : undefined }];
    if (use?.scope === "session") items.push({ aside: `/ $${use.limit.toFixed(0)}`, tight: true });
    const burn = burnRate(u);
    if (burn) items.push({ aside: `$${burn.toFixed(2)}/h` });
    add(right, "cost", tone && tone !== "green" ? tone : "yellow", items, `cost $${u.cost.usd.toFixed(2)}`);
  }

  if (ledger?.today > 0) {
    const use = budget?.day ? ledger.today / budget.day : null;
    const tone = use == null ? null : use >= 1 ? "red" : use >= 0.8 ? "yellow" : null;
    const items = [{ label: "TODAY" }, { value: `$${ledger.today.toFixed(2)}`, tone: tone ?? undefined }];
    if (budget?.day) items.push({ aside: `/ $${budget.day.toFixed(0)}`, tight: true });
    if (ledger.week > ledger.today) items.push({ aside: `7d $${ledger.week.toFixed(0)}` });
    add(right, "today", tone ?? "green", items, `today $${ledger.today.toFixed(2)}`);
  }

  return { left, right };
}

// ---- desktop: detail cards ---------------------------------------------------
// Four compact cards in one row (context, spend, turns, tools) over a footer
// line, as one SVG about 130px tall so the band shows it whole.
const CARD_W = 184;
const CARD_H = 108;
const GRID_GAP = 8;
const CAT_TONES = ["blue", "purple", "cyan", "green", "yellow", "red", "mu"];

function desktopDetails({ Svg }, d, git, u) {
  const cardsShown = [d.ctx, d.cost != null, d.turns > 0, d.tools.length > 0].filter(Boolean).length || 1;
  const W = Math.max(CARD_W * 2 + GRID_GAP, CARD_W * cardsShown + GRID_GAP * (cardsShown - 1));
  const t = (x, y, s, { size = 10, weight = 500, cls = "fg", anchor, ls } = {}) =>
    `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}"${anchor ? ` text-anchor="${anchor}"` : ""}${ls ? ` letter-spacing="${ls}"` : ""}>${esc(s)}</text>`;
  const w = (s, size) => [...s].length * size * CW;
  const fit = (s, size, room) => {
    const max = Math.floor(room / (size * CW));
    return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
  };
  const P = 12; // card padding
  const title = (x, s, right, tone = "lb") => t(x + P, 19, s, { size: 8.5, weight: 700, cls: tone, ls: 0.8 }) +
    (right ? t(x + CARD_W - P, 19, fit(right.s, 9.5, CARD_W - 2 * P - w(s, 8.5) - 10), { size: 9.5, cls: right.cls ?? "mu", anchor: "end" }) : "");
  const big = (x, s, cls = "fg", side) => t(x + P, 45, s, { size: 19, weight: 700, cls }) +
    (side ? t(x + P + w(s, 19) + 6, 45, fit(side, 9.5, CARD_W - 2 * P - w(s, 19) - 6), { size: 9.5, cls: "mu" }) : "");
  const line = (x, s, cls = "mu") => t(x + P, 62, fit(s, 9.5, CARD_W - 2 * P), { size: 9.5, cls });
  const cols = (x, values, cls) => {
    if (values.length < 2) return "";
    const top = Math.max(...values, 1e-9), n = values.length, gw = CARD_W - 2 * P, bw = Math.min(8, (gw - (n - 1) * 2.5) / n);
    return values.map((v, i) => {
      const h = Math.max(2, (v / top) * 26);
      return `<rect class="${cls}" x="${(x + P + i * (bw + 2.5)).toFixed(1)}" y="${(CARD_H - 10 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" opacity="${i === n - 1 ? 1 : 0.55}"/>`;
    }).join("");
  };
  const card = (x, tone) => `<rect class="cb-${tone}" x="${x + 0.5}" y=".5" width="${CARD_W - 1}" height="${CARD_H - 1}" rx="11"/>`;
  const at = (i) => i * (CARD_W + GRID_GAP);
  let body = "";
  // only the cards with something to say, packed left
  const show = [d.ctx && "context", d.cost != null && "spend", d.turns > 0 && "turns", d.tools.length > 0 && "tools"].filter(Boolean);
  const slot = (name) => show.indexOf(name);

  // context
  if (slot("context") >= 0) {
    const x = at(slot("context"));
    body += card(x, "blue") + title(x, "CONTEXT", d.ctx ? { s: `${short(d.ctx.tokens)}/${short(d.ctx.window)}` } : null, "blue");
    if (d.ctx) {
      const warn = d.turnsLeft != null && d.turnsLeft < 5;
      body += big(x, `${d.ctx.pct}%`, CTX_TONE(d.ctx.pct), d.turnsLeft != null ? `≈${d.turnsLeft} turns left` : d.free != null ? `${short(d.free)} free` : null);
      if (warn) body += t(x + CARD_W - P, 45, "compact soon", { size: 9, cls: "red", anchor: "end" });
      const bx = x + P, by = 54, bw = CARD_W - 2 * P;
      body += `<rect class="track" x="${bx}" y="${by}" width="${bw}" height="6" rx="3"/>`;
      if (d.used.length) {
        let cx = bx;
        body += `<clipPath id="cb"><rect x="${bx}" y="${by}" width="${bw}" height="6" rx="3"/></clipPath><g clip-path="url(#cb)">`;
        d.used.forEach((c, i) => {
          const cw = (c.tokens / d.ctx.window) * bw;
          if (cw > 0.5) body += `<rect class="${CAT_TONES[i % CAT_TONES.length]}" x="${cx.toFixed(1)}" y="${by}" width="${Math.max(1, cw - 1).toFixed(1)}" height="6"/>`;
          cx += cw;
        });
        body += "</g>";
        d.used.slice(0, 3).forEach((c, i) => {
          const ly = 76 + i * 12.5;
          body += `<circle class="${CAT_TONES[i % CAT_TONES.length]}" cx="${bx + 3}" cy="${ly - 3.2}" r="2.6"/>`;
          body += t(bx + 10, ly, fit(c.name, 9, bw - 50), { size: 9, cls: "mu" }) + t(bx + bw, ly, short(c.tokens), { size: 9, weight: 650, anchor: "end" });
        });
      } else {
        body += `<rect class="${CTX_TONE(d.ctx.pct)}" x="${bx}" y="${by}" width="${Math.max(d.ctx.pct > 0 ? 3 : 0, (d.ctx.pct / 100) * bw).toFixed(1)}" height="6" rx="3"/>`;
        body += t(bx, 80, "breakdown after next turn", { size: 9, cls: "lb" });
      }
    }
  }

  // spend
  if (slot("spend") >= 0) {
    const x = at(slot("spend"));
    const use = budgetUse(d.budget, u, d.ledger);
    body += card(x, "yellow") + title(x, "SPEND", use ? { s: `${Math.round(use.frac * 100)}% of $${use.limit.toFixed(0)}`, cls: budgetTone(use) } : d.burn ? { s: `$${d.burn.toFixed(2)}/h` } : null, "yellow");
    if (d.cost != null) {
      body += big(x, `$${d.cost.toFixed(2)}`, "fg", d.ledger?.today > 0 ? `today $${d.ledger.today.toFixed(2)}` : d.burn && use ? `$${d.burn.toFixed(2)}/h` : null);
      body += line(x, [d.lastCost && `last +$${d.lastCost.toFixed(2)}`, d.avgCost != null && `avg $${d.avgCost.toFixed(2)}`].filter(Boolean).join(" · ") || (d.turns ? "per turn from next turn" : d.session ? `over ${d.session}` : ""));
      body += cols(x, d.turnCosts, "yellow");
    }
  }

  // turns
  if (slot("turns") >= 0) {
    const x = at(slot("turns"));
    const hit = d.cacheHit;
    body += card(x, "purple") + title(x, "TURNS", hit != null ? { s: `cache ${hit}%`, cls: hit >= 70 ? "green" : hit >= 40 ? "yellow" : "red" } : null, "purple");
    body += big(x, `${d.turns}`, "purple", d.turns ? `avg ${secs(d.avgMs)}` : "none yet");
    if (d.turns) body += line(x, [`max ${secs(d.maxMs)}`, d.out && `${short(d.out)} out`].filter(Boolean).join(" · "));
    body += cols(x, d.turnMs, "purple");
  }

  // tools
  if (slot("tools") >= 0) {
    const x = at(slot("tools"));
    body += card(x, "cyan") + title(x, "TOOLS", d.calls ? { s: `${d.calls} calls` } : null, "cyan");
    const top = d.tools[0]?.[1] ?? 1;
    d.tools.forEach(([n, c], i) => {
      const ry = 36 + i * 15;
      body += t(x + P, ry, fit(n, 9, 66), { size: 9, cls: "mu" });
      const bx = x + P + 70, bw = CARD_W - 2 * P - 70 - 22;
      body += `<rect class="track" x="${bx}" y="${ry - 5}" width="${bw}" height="4" rx="2"/>`;
      body += `<rect class="cyan" x="${bx}" y="${ry - 5}" width="${Math.max(3, (c / top) * bw).toFixed(1)}" height="4" rx="2"/>`;
      body += t(x + CARD_W - P, ry, String(c), { size: 9, weight: 650, anchor: "end" });
    });
    if (!d.tools.length) body += t(x + P, 45, "no tool calls yet", { size: 9.5, cls: "lb" });
  }

  // footer
  const fy = CARD_H + 19;
  const foot = [
    d.files.length && ["EDITED", d.files.join(", ")],
    u?.model && ["MODEL", prettyModel(u.model)],
    d.session && ["SESSION", d.session],
  ].filter(Boolean);
  let fx = 4;
  for (const [k, v] of foot) {
    const kw = w(k, 8.5) + k.length * 0.8;
    const room = W - fx - kw - 8;
    if (room < 40) break;
    const val = fit(v, 9.5, Math.min(room, 260));
    body += t(fx, fy, k, { size: 8.5, weight: 700, cls: "lb", ls: 0.8 });
    fx += kw + 6;
    body += t(fx, fy, val, { size: 9.5, cls: "mu" });
    fx += w(val, 9.5) + 16;
  }

  const height = fy + 6;
  const cls = (i) => Object.entries(PAL).map(([k, v]) => `.${k}{fill:${v[i]}}`).join("") + cardCss(i);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">` +
    `<style>${cls(0)}@media (prefers-color-scheme:dark){${cls(1)}}</style>${body}</svg>`;
  const alt = [d.ctx && `context ${d.ctx.pct}%`, d.cost != null && `cost $${d.cost.toFixed(2)}`, `${d.turns} turns`, d.cacheHit != null && `cache hit ${d.cacheHit}%`, `${d.calls} tool calls`].filter(Boolean).join(", ");
  return Svg({ key: "details", source, alt, width: W, height });
}

function prettyModel(id) {
  const m = shortModel(id).replace("-", " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
}
