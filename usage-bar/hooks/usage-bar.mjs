// Usage bar: a strip above the prompt with rate limits, context, cost, git,
// a live turn timer, activity, and model. /usage prints the full detail.

const READING = { plugin: "usage-bar", key: "last" };
const ACTIVITY = { plugin: "usage-bar", key: "activity" };
const GIT = { plugin: "usage-bar", key: "git" };
const TURN = { plugin: "usage-bar", key: "turn" };
const UI = { plugin: "usage-bar", key: "ui" };
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_WIDTH = 8;
const BARS = "▁▂▃▄▅▆▇█";
const HISTORY = 12;
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
      await takeReading($);
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
    if (!isDesktop) row.push(Text({ key: "pad", children: "  " }));
    row.push(Button({
      key: "more",
      label: expanded ? "▴" : "▾",
      plain: true,
      dimColor: true,
      onPress: async () => { await $.state.set(UI, { expanded: !expanded }); },
    }));
    const body = [Box({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: isDesktop ? 1 : 0, paddingX: 1, children: row })];
    if (expanded) {
      body.push(Box({ flexDirection: "column", paddingX: 2, paddingTop: isDesktop ? 1 : 0, children: usageLines(u, a, git).map((l) => Text({ dimColor: true, children: l })) }));
    }
    return Box({ flexDirection: "column", children: body });
  });
}

async function answerUsage($, e, next) {
  if (e.command !== commandName) return next(e);
  await takeReading($);
  const { value: u = {} } = await $.state.get(READING);
  const { value: a = { calls: 0, files: [] } } = await $.state.get(ACTIVITY);
  const { value: git } = await $.state.get(GIT);
  return { text: usageLines(u, a, git).join("\n") };
}

function usageLines(u = {}, a = { calls: 0, files: [] }, git) {
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

// ---- terminal: segments split by a dim rule ---------------------------------
// Each segment is one Box of Texts with no gap inside, so its parts stay glued
// together; the row wraps between segments, never inside one.
const STATUS_COLOR = { ok: "green", warn: "yellow", crit: "red" };
const TERM_BAR = 6;

function terminalRow({ Box, Text }, { u, a, git, working, columns }) {
  const wide = columns == null || columns >= 100;
  const T = (children, o = {}) => Text({ children, ...o });
  const segs = [];

  if (columns == null || columns >= 80) {
    for (const rl of u?.rateLimits ?? []) {
      const p = clampPct(rl.percentUsed);
      const color = STATUS_COLOR[limitStatus(rl)];
      const reset = resetsIn(rl.resetsAt);
      const parts = [T(`${limitLabel(rl)} `, { dimColor: true }), ...termBar(Text, p, color, paceOf(rl)?.elapsed), T(` ${p}%`, { color, bold: true })];
      if (reset && (columns == null || columns >= 90)) parts.push(T(` ↻ ${reset}`, { dimColor: true }));
      segs.push(parts);
    }
  }

  if (u?.context?.window && u.context.tokens) {
    const pct = ctxPct(u.context);
    const color = pct < 50 ? "cyan" : pct < 75 ? "yellow" : "red";
    const parts = [T("ctx ", { dimColor: true }), ...termBar(Text, pct, color), T(` ${pct}%`, { color, bold: true }), T(` ${short(u.context.tokens)}/${short(u.context.window)}`, { dimColor: true })];
    const spark = sparkline(u.history);
    if (spark && (columns == null || columns >= 110)) parts.push(T(` ${spark}`, { color, dimColor: true }));
    if (u.delta) parts.push(T(u.delta > 0 ? ` ▲ +${short(u.delta)}` : ` ▼ ${short(-u.delta)}`, { dimColor: true }));
    segs.push(parts);
  }

  if (u?.cost?.usd > 0) {
    const parts = [T(`$${u.cost.usd.toFixed(2)}`, { color: "yellow", bold: true })];
    const burn = burnRate(u);
    if (burn && wide) parts.push(T(` $${burn.toFixed(2)}/h`, { dimColor: true }));
    segs.push(parts);
  }

  if (working != null) segs.push([T("● ", { color: "magenta" }), T(mmss(working), { color: "magenta", bold: true })]);

  if (git?.branch && wide) {
    const parts = [T(`⎇ ${git.branch.length > 24 ? `${git.branch.slice(0, 23)}…` : git.branch}`, { color: "cyan" })];
    if (git.dirty) parts.push(T(` ±${git.dirty}`, { color: "yellow" }));
    const sync = [git.ahead && `↑${git.ahead}`, git.behind && `↓${git.behind}`].filter(Boolean).join(" ");
    if (sync) parts.push(T(` ${sync}`, { dimColor: true }));
    segs.push(parts);
  }

  if (a?.calls && wide) {
    const s = `${a.files.length ? `✎ ${a.files.length} · ` : ""}${a.calls} calls`;
    segs.push([T(s, { dimColor: true })]);
  }

  const dur = duration(u?.startedAt);
  if (dur && wide) segs.push([T(dur, { dimColor: true })]);
  if (u?.model) segs.push([T(shortModel(u.model), { dimColor: true })]);

  return segs.map((children, i) => Box({
    key: `s${i}`,
    flexDirection: "row",
    flexShrink: 0,
    children: i ? [T(" │ ", { dimColor: true }), ...children] : children,
  }));
}

// A thin rule: the used part in the status color, the rest dim, and the pace
// marker where the window's elapsed time sits.
function termBar(Text, p, color, elapsed) {
  const filled = Math.round((p / 100) * TERM_BAR);
  const mark = elapsed == null ? -1 : Math.min(TERM_BAR - 1, Math.floor(elapsed * TERM_BAR));
  const runs = [];
  for (let i = 0; i < TERM_BAR; i++) {
    const kind = i === mark ? "mark" : i < filled ? "on" : "off";
    if (runs.at(-1)?.kind === kind) runs.at(-1).s += kind === "mark" ? "╋" : "━";
    else runs.push({ kind, s: kind === "mark" ? "╋" : "━" });
  }
  const style = { mark: { bold: true }, on: { color }, off: { dimColor: true } };
  return runs.map((r) => Text({ children: r.s, ...style[r.kind] }));
}

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

  if (u?.context?.window && u.context.tokens) {
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

  const out = [];
  for (const [key, segs, label] of [["core", core, alt.join(", ")], ["extra", extra, [u?.cost?.usd > 0 && `cost $${u.cost.usd.toFixed(2)}`, git?.branch && `git ${git.branch}`, dur && `session ${dur}`].filter(Boolean).join(", ")]]) {
    if (!segs.length) continue;
    const { source, width } = svgStrip(segs);
    out.push(Svg({ key, source, alt: label, width, height: H }));
  }
  return out;
}

function prettyModel(id) {
  const m = shortModel(id).replace("-", " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
}
