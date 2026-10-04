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
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_WIDTH = 8;
const BARS = "▁▂▃▄▅▆▇█";
const HISTORY = 12;
const TURN_LOG = 24;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
let commandName;
let turnStart = 0; // ms, 0 when no turn is running

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await takeReading($);
    $.clock.every(60_000, () => takeReading($)); // keep reset countdowns fresh
    $.clock.every(1000, () => { // live turn timer: redraw each second while a turn runs
      if (turnStart && Date.now() - turnStart < 2 * 3_600_000) $.state.set(TURN, { startedAt: turnStart, tick: Date.now() });
    });
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

  on("prompt.submit", async ($, e, next) => {
    turnStart = Date.now();
    await $.state.set(TURN, { startedAt: turnStart, tick: turnStart });
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
      const { value: before } = await $.state.get(READING);
      await takeReading($);
      const { value: after } = await $.state.get(READING);
      await logTurn($, e, before, after);
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
    const view = {
      u, a, git,
      working: e.props.isWorking && turn?.startedAt ? Date.now() - turn.startedAt : null,
      columns: e.props.bodyColumns,
    };
    const els = $.ui.resolve(e);
    const isDesktop = e.surface === "desktop";
    const row = isDesktop ? desktopRow(els, view) : terminalRow(els, view);
    if (!row.length) return next(e);
    const { Box, Text, Button } = els;
    const expanded = !!ui?.expanded;
    row.push(Button({
      key: "more",
      label: expanded ? "▴ less" : "▾ more",
      plain: true,
      dimColor: true,
      onPress: async () => {
        await $.state.set(UI, { expanded: !expanded });
        if (!expanded) await takeBreakdown($);
      },
    }));
    const body = [Box({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 1, rowGap: isDesktop ? 1 : 0, paddingX: 1, children: row })];
    if (expanded) {
      const { value: turns = [] } = await $.state.get(TURNS);
      const { value: map } = await $.state.get(CTXMAP);
      const d = insights(u, a, turns, map);
      body.push(isDesktop ? desktopDetails(els, d, git, u) : terminalDetails(els, d, git, u, view.columns));
    }
    return Box({ flexDirection: "column", children: body });
  });
}

// One record per main-loop turn: how long, what it cost, what it read and wrote.
async function logTurn($, e, before, after) {
  const usd = typeof after?.cost?.usd === "number" && typeof before?.cost?.usd === "number" ? Math.max(0, after.cost.usd - before.cost.usd) : null;
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
  return { text: usageLines(u, a, git, turns).join("\n") };
}

function usageLines(u = {}, a = { calls: 0, files: [] }, git, turns = []) {
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
  if (git?.branch) lines.push(`Git: ${gitText(git)}`);
  if (u.model) lines.push(`Model: ${shortModel(u.model)}`);
  return lines;
}

function gitText(g) {
  return [g.branch, g.dirty && `${g.dirty} changed`, g.ahead && `↑${g.ahead}`, g.behind && `↓${g.behind}`].filter(Boolean).join("  ·  ");
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
      git = {
        branch: m?.[1]?.startsWith("HEAD (no branch)") ? "detached" : m?.[1],
        dirty: rest.filter(Boolean).length,
        ahead: +(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: +(/behind (\d+)/.exec(track)?.[1] ?? 0),
      };
    }
  } catch {
    // not a repo, or no git
  }
  await $.state.set(GIT, git);
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

function terminalRow({ Box, Text }, { u, a, git, working, columns }) {
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
    const parts = [[`$${u.cost.usd.toFixed(2)}`, "value"]];
    const burn = burnRate(u);
    if (burn && wide) parts.push([` $${burn.toFixed(2)}/h`, "aside"]);
    chips.push(chip(Text, "yellow", parts, "cost"));
  }

  if (working != null) chips.push(chip(Text, "purple", [["● ", "accent"], [mmss(working), "value"]], "turn"));

  if (git?.branch && wide) {
    const parts = [["git ", "label"], [git.branch.length > 24 ? `${git.branch.slice(0, 23)}…` : git.branch, "value"]];
    if (git.dirty) parts.push([` ±${git.dirty}`, "accent"]);
    const sync = [git.ahead && `↑${git.ahead}`, git.behind && `↓${git.behind}`].filter(Boolean).join(" ");
    if (sync) parts.push([` ${sync}`, "aside"]);
    chips.push(chip(Text, "cyan", parts, "git"));
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
  if (it.label != null) return text("label", it.label, "lb");
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

function svgStrip(segments) {
  const GAP = 5, SEP = 10, PAD = 2;
  let x = PAD, body = "";
  segments.forEach((items, i) => {
    if (i) {
      x += SEP;
      body += `<rect class="rule" x="${x.toFixed(1)}" y="${MID - 7}" width="1" height="14"/>`;
      x += 1 + SEP;
    }
    items.forEach((it, j) => {
      if (j) x += it.tight ? 3 : GAP;
      body += drawItem(it, x);
      x += itemWidth(it);
    });
  });
  const width = Math.ceil(x + PAD);
  const cls = (i) => Object.entries(PAL).map(([k, v]) => `.${k}{fill:${v[i]}}.${k}-s{stroke:${v[i]}}`).join("");
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" font-family="${FONT}">` +
    `<style>${cls(0)}@media (prefers-color-scheme:dark){${cls(1)}}</style>${body}</svg>`;
  return { source, width };
}

// Two strips: the core figures (limits, context, turn) sized to fit a narrow
// composer, and the extras (git, cost, session time), which wrap under the
// core when the slot is narrow and sit beside it when it is wide.
function desktopRow({ Svg }, { u, a, git, working }) {
  const core = [];
  const extra = [];
  const alt = [];

  for (const rl of u?.rateLimits ?? []) {
    const p = clampPct(rl.percentUsed);
    const pace = paceOf(rl);
    const reset = resetsIn(rl.resetsAt);
    const tone = STATUS_COLOR[limitStatus(rl)];
    const items = [{ label: limitLabel(rl).toUpperCase() }, { bar: { pct: p, pace: pace?.elapsed, tone } }, { value: `${p}%`, tone }];
    if (pace?.projected != null && pace.projected >= 100) items.push({ aside: `→${Math.min(999, Math.round(pace.projected))}%`, tone, tight: true });
    if (reset) items.push({ aside: `↻${compactSpan(reset)}` });
    core.push(items);
    alt.push(`${limitLabel(rl)} ${p}%${reset ? ` resets in ${reset}` : ""}`);
  }

  if (u?.context?.window) {
    const pct = ctxPct(u.context);
    const tone = pct < 50 ? "blue" : pct < 75 ? "yellow" : "red";
    const items = [{ label: "CTX" }, { bar: { pct, tone } }, { value: `${pct}%`, tone }, { aside: `${short(u.context.tokens)}/${short(u.context.window)}` }];
    if (u.delta) items.push({ aside: u.delta > 0 ? `+${short(u.delta)}` : `−${short(-u.delta)}`, tone });
    core.push(items);
    alt.push(`context ${pct}%`);
  }

  if (working != null) {
    core.push([{ dot: true, tone: "purple" }, { value: mmss(working), tone: "purple", tight: true }]);
    alt.push(`turn ${mmss(working)}`);
  }

  if (git?.branch) {
    const items = [{ icon: "branch" }, { value: git.branch.length > 18 ? `${git.branch.slice(0, 17)}…` : git.branch, tight: true }];
    if (git.dirty) items.push({ aside: `±${git.dirty}`, tone: "yellow" });
    const sync = [git.ahead && `↑${git.ahead}`, git.behind && `↓${git.behind}`].filter(Boolean).join(" ");
    if (sync) items.push({ aside: sync });
    extra.push(items);
  }
  const burn = burnRate(u);
  const dur = duration(u?.startedAt);
  if (u?.cost?.usd > 0) extra.push([{ value: `$${u.cost.usd.toFixed(2)}` }, ...(burn ? [{ aside: `$${burn.toFixed(2)}/h` }] : [])]);
  if (dur) extra.push([{ label: "SESSION" }, { value: dur }]);

  const extraAlt = [u?.cost?.usd > 0 && `cost $${u.cost.usd.toFixed(2)}`, git?.branch && `git ${git.branch}`, dur && `session ${dur}`].filter(Boolean);
  // one strip when both fit a typical composer, two that wrap otherwise
  if (core.length && extra.length && svgStrip([...core, ...extra]).width <= 720) {
    const { source, width } = svgStrip([...core, ...extra]);
    return [Svg({ key: "strip", source, alt: [...alt, ...extraAlt].join(", "), width, height: H })];
  }
  const out = [];
  for (const [key, segs, label] of [["core", core, alt.join(", ")], ["extra", extra, extraAlt.join(", ")]]) {
    if (!segs.length) continue;
    const { source, width } = svgStrip(segs);
    out.push(Svg({ key, source, alt: label, width, height: H }));
  }
  return out;
}

// ---- desktop: detail cards ---------------------------------------------------
// Four cards in a 2×2 grid (context, spend, turns, tools) and a footer line,
// drawn as one SVG on the same palette as the strip.
const CARD_W = 300;
const CARD_H = 124;
const GRID_GAP = 10;
const CAT_TONES = ["blue", "purple", "cyan", "green", "yellow", "red", "mu"];

function desktopDetails({ Svg }, d, git, u) {
  const W = CARD_W * 2 + GRID_GAP;
  const t = (x, y, s, { size = 11, weight = 500, cls = "fg", anchor, ls } = {}) =>
    `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}"${anchor ? ` text-anchor="${anchor}"` : ""}${ls ? ` letter-spacing="${ls}"` : ""}>${esc(s)}</text>`;
  const w = (s, size) => [...s].length * size * CW;
  const title = (x, y, s, right) => t(x + 14, y + 22, s, { size: 9, weight: 700, cls: "lb", ls: 0.8 }) + (right ? t(x + CARD_W - 14, y + 22, right.s, { size: 10, cls: right.cls ?? "mu", anchor: "end" }) : "");
  const big = (x, y, s, cls = "fg", side) => t(x + 14, y + 52, s, { size: 22, weight: 700, cls }) + (side ? t(x + 14 + w(s, 22) + 8, y + 52, side, { size: 11, cls: "mu" }) : "");
  const line = (x, y, s, cls = "mu") => t(x + 14, y + 72, s, { size: 10.5, cls });
  const cols = (x, y, values, cls) => {
    if (values.length < 2) return "";
    const top = Math.max(...values, 1e-9), n = values.length, gw = CARD_W - 28, bw = Math.min(10, (gw - (n - 1) * 3) / n);
    return values.map((v, i) => {
      const h = Math.max(2, (v / top) * 30);
      return `<rect class="${cls}" x="${(x + 14 + i * (bw + 3)).toFixed(1)}" y="${(y + CARD_H - 12 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" opacity="${i === n - 1 ? 1 : 0.55}"/>`;
    }).join("");
  };
  const card = (x, y) => `<rect class="card" x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12"/>`;
  let body = "";

  // context
  {
    const x = 0, y = 0;
    body += card(x, y);
    const warn = d.turnsLeft != null && d.turnsLeft < 5;
    body += title(x, y, "CONTEXT", d.free != null ? { s: `compacts in ${short(d.free)}${d.turnsLeft != null ? ` · ≈${d.turnsLeft} turns` : ""}`, cls: warn ? "red" : "mu" } : null);
    if (d.ctx) {
      body += big(x, y, `${d.ctx.pct}%`, CTX_TONE(d.ctx.pct), `${short(d.ctx.tokens)} of ${short(d.ctx.window)}`);
      const bx = x + 14, by = y + 64, bw = CARD_W - 28;
      body += `<rect class="track" x="${bx}" y="${by}" width="${bw}" height="8" rx="4"/>`;
      if (d.used.length) {
        let cx = bx;
        body += `<clipPath id="cb"><rect x="${bx}" y="${by}" width="${bw}" height="8" rx="4"/></clipPath><g clip-path="url(#cb)">`;
        d.used.forEach((c, i) => {
          const cw = (c.tokens / d.ctx.window) * bw;
          if (cw > 0.5) body += `<rect class="${CAT_TONES[i % CAT_TONES.length]}" x="${cx.toFixed(1)}" y="${by}" width="${Math.max(1, cw - 1).toFixed(1)}" height="8"/>`;
          cx += cw;
        });
        body += "</g>";
        d.used.slice(0, 4).forEach((c, i) => {
          const lx = x + 14 + (i % 2) * 140, ly = y + 92 + Math.floor(i / 2) * 16;
          const name = c.name.length > 13 ? `${c.name.slice(0, 12)}…` : c.name;
          body += `<circle class="${CAT_TONES[i % CAT_TONES.length]}" cx="${lx + 3}" cy="${ly - 3.5}" r="3"/>`;
          body += t(lx + 11, ly, name, { size: 10, cls: "mu" }) + t(lx + 132, ly, short(c.tokens), { size: 10, weight: 650, anchor: "end" });
        });
      } else {
        body += `<rect class="${CTX_TONE(d.ctx.pct)}" x="${bx}" y="${by}" width="${Math.max(d.ctx.pct > 0 ? 4 : 0, (d.ctx.pct / 100) * bw).toFixed(1)}" height="8" rx="4"/>`;
        body += t(x + 14, y + 96, "breakdown loads after the next turn", { size: 10, cls: "lb" });
      }
    }
  }

  // spend
  {
    const x = CARD_W + GRID_GAP, y = 0;
    body += card(x, y);
    body += title(x, y, "SPEND", d.burn ? { s: `$${d.burn.toFixed(2)}/h` } : null);
    if (d.cost != null) {
      body += big(x, y, `$${d.cost.toFixed(2)}`, "fg");
      body += line(x, y, [d.lastCost && `last +$${d.lastCost.toFixed(2)}`, d.avgCost != null && `avg $${d.avgCost.toFixed(2)}/turn`].filter(Boolean).join("  ·  ") || "no turns yet");
      body += cols(x, y, d.turnCosts, "yellow");
    }
  }

  // turns
  {
    const x = 0, y = CARD_H + GRID_GAP;
    body += card(x, y);
    body += title(x, y, "TURNS", d.cacheHit != null ? { s: `cache hit ${d.cacheHit}%`, cls: d.cacheHit >= 70 ? "green" : d.cacheHit >= 40 ? "yellow" : "red" } : null);
    body += big(x, y, `${d.turns}`, "purple", d.turns ? `avg ${secs(d.avgMs)} · max ${secs(d.maxMs)}` : "none yet");
    if (d.out) body += line(x, y, `${short(d.out)} tokens written`);
    body += cols(x, y, d.turnMs, "purple");
  }

  // tools
  {
    const x = CARD_W + GRID_GAP, y = CARD_H + GRID_GAP;
    body += card(x, y);
    body += title(x, y, "TOOLS", d.calls ? { s: `${d.calls} calls` } : null);
    const top = d.tools[0]?.[1] ?? 1;
    d.tools.forEach(([n, c], i) => {
      const ry = y + 42 + i * 16;
      const name = n.length > 14 ? `${n.slice(0, 13)}…` : n;
      body += t(x + 14, ry, name, { size: 10, cls: "mu" });
      const bx = x + 118, bw = CARD_W - 118 - 44;
      body += `<rect class="track" x="${bx}" y="${ry - 6}" width="${bw}" height="5" rx="2.5"/>`;
      body += `<rect class="cyan" x="${bx}" y="${ry - 6}" width="${Math.max(3, (c / top) * bw).toFixed(1)}" height="5" rx="2.5"/>`;
      body += t(x + CARD_W - 14, ry, String(c), { size: 10, weight: 650, anchor: "end" });
    });
    if (!d.tools.length) body += t(x + 14, y + 52, "no tool calls yet", { size: 10.5, cls: "lb" });
  }

  // footer
  const fy = CARD_H * 2 + GRID_GAP + 22;
  const foot = [
    d.files.length && ["EDITED", d.files.join(", ")],
    git?.branch && ["GIT", gitText(git).replace(/ {2}· {2}/g, " · ")],
    u?.model && ["MODEL", prettyModel(u.model)],
    d.session && ["SESSION", d.session],
  ].filter(Boolean);
  let fx = 4;
  for (const [k, v] of foot) {
    const room = W - fx - w(k, 9) - 8;
    if (room < 40) break;
    const max = Math.floor(room / (10.5 * CW));
    const val = v.length > max ? `${v.slice(0, max - 1)}…` : v;
    body += t(fx, fy, k, { size: 9, weight: 700, cls: "lb", ls: 0.8 });
    fx += w(k, 9) + k.length * 0.8 + 6;
    body += t(fx, fy, val, { size: 10.5, cls: "mu" });
    fx += w(val, 10.5) + 18;
  }

  const height = fy + 8;
  const cls = (i) => Object.entries(PAL).map(([k, v]) => `.${k}{fill:${v[i]}}`).join("");
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">` +
    `<style>${cls(0)}@media (prefers-color-scheme:dark){${cls(1)}}</style>${body}</svg>`;
  const alt = [d.ctx && `context ${d.ctx.pct}%`, d.cost != null && `cost $${d.cost.toFixed(2)}`, `${d.turns} turns`, d.cacheHit != null && `cache hit ${d.cacheHit}%`, `${d.calls} tool calls`].filter(Boolean).join(", ");
  return Svg({ key: "details", source, alt, width: W, height });
}

function prettyModel(id) {
  const m = shortModel(id).replace("-", " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
}
