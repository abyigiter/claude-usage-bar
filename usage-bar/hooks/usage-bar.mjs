// Usage bar: pills above the prompt — rate limits, context forecast, cost,
// session duration, live activity, and model. /usage prints the full detail.

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
    const row = e.surface === "desktop" ? desktopRow(els, view) : terminalRow(els, view);
    if (!row.length) return next(e);
    const { Box, Text, Button } = els;
    const expanded = !!ui?.expanded;
    row.push(Button({
      label: expanded ? "less" : "more",
      plain: true,
      dimColor: true,
      onPress: async () => { await $.state.set(UI, { expanded: !expanded }); },
    }));
    const body = [Box({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 1, paddingX: 1, children: row })];
    if (expanded) {
      body.push(Box({ flexDirection: "column", paddingX: 2, children: usageLines(u, a, git).map((l) => Text({ dimColor: true, children: l })) }));
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

function terminalRow({ Text }, { u, a, git, working, columns }) {
  const pills = [];
  const wide = columns == null || columns >= 100;
  if (columns == null || columns >= 80) {
    for (const rl of u?.rateLimits ?? []) pills.push(...limitPill(Text, rl, columns));
  }
  if (u?.context?.window) pills.push(...contextPill(Text, u, columns));
  if (typeof u?.cost?.usd === "number") {
    const parts = [[`$${u.cost.usd.toFixed(2)}`, { bold: true }]];
    const burn = burnRate(u);
    if (burn && wide) parts.push([`$${burn.toFixed(2)}/h`, { dim: true }]);
    pills.push(...pill(Text, "yellow", parts));
  }
  if (working != null) pills.push(...pill(Text, "blue", [["⏱ turn", {}], [mmss(working), { bold: true }]]));
  if (git?.branch && wide) {
    const parts = [[`⎇ ${git.branch.slice(0, 24)}`, {}]];
    if (git.dirty) parts.push([`±${git.dirty}`, { bold: true }]);
    pills.push(...pill(Text, git.dirty ? "yellow" : "cyan", parts));
  }
  const dur = duration(u?.startedAt);
  if (dur && wide) pills.push(...pill(Text, "magenta", [[dur, { dim: true }]]));
  if (a?.calls && wide) {
    const parts = [[`${a.calls} calls`, { dim: true }]];
    if (a.files.length) parts.unshift([`✎ ${a.files.length}`, { dim: true }]);
    pills.push(...pill(Text, "cyan", parts));
  }
  if (u?.model) pills.push(...pill(Text, "blue", [[shortModel(u.model), { dim: true }]]));
  return pills;
}

// A pill is a row of Texts on a soft tinted background (the desktop palette),
// bright text on a dark tint; adjacent ones join seamlessly.
const TERM_TONE = { green: "green", yellow: "yellow", red: "red", magenta: "purple", cyan: "slate", blue: "blue" };
function pill(Text, color, parts) {
  const [bg, fg] = TONES[TERM_TONE[color] ?? "slate"].d;
  return parts.map(([s, o = {}]) =>
    Text({
      color: fg,
      backgroundColor: bg,
      dimColor: !!o.dim,
      bold: !!o.bold,
      children: ` ${s} `,
    }));
}

function limitPill(Text, rl, columns) {
  const p = clampPct(rl.percentUsed);
  const color = { ok: "green", warn: "yellow", crit: "red" }[limitStatus(rl)];
  const label = rl.kind === "five_hour" ? "5h" : rl.kind === "seven_day" ? "7d" : rl.kind;
  const parts = [[label, {}], [bar(p, paceOf(rl)?.elapsed), {}], [`${p}%`, { bold: true }]];
  const reset = resetsIn(rl.resetsAt);
  if ((columns == null || columns >= 90) && reset) parts.push([reset, { dim: true }]);
  return pill(Text, color, parts);
}

function contextPill(Text, u, columns) {
  const tokens = u.context.tokens ?? 0;
  const pct = ctxPct(u.context);
  const color = pct < 50 ? "green" : pct < 75 ? "yellow" : pct < 90 ? "magenta" : "red";
  const icon = pct < 50 ? "☀" : pct < 75 ? "☁" : pct < 90 ? "☂" : "↯";
  const parts = [[`${icon} ${short(tokens)}`, {}], [`/ ${short(u.context.window)}`, { dim: true }], [`${pct}%`, { bold: true }]];
  const spark = sparkline(u.history);
  if (spark && (columns == null || columns >= 110)) parts.push([spark, {}]);
  if (u.delta) parts.push(u.delta > 0 ? [`▲ +${short(u.delta)}`, {}] : [`▼ ${short(-u.delta)}`, {}]);
  return pill(Text, color, parts);
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

// ---- desktop: stat tiles (SVG) ---------------------------------------------
const LABEL_W = 6.4;
const VALUE_W = 8.3;
const TILE_H = 44;
const TONES = {
  green:  { l: ["#e1efe6", "#1d3b2c", "#3f8f68"], d: ["#1d362a", "#c4e8d3", "#5fcf9a"] },
  yellow: { l: ["#f6ecce", "#4a3a0c", "#b0820a"], d: ["#3a3216", "#f1e2a6", "#e6b830"] },
  red:    { l: ["#f8dcd6", "#5c1f17", "#c4432d"], d: ["#47201e", "#f7cfc8", "#f47563"] },
  purple: { l: ["#e8e2f6", "#2e2557", "#6c56c8"], d: ["#2c2748", "#d6cff5", "#9d8cf0"] },
  blue:   { l: ["#dfe8f7", "#1b2e58", "#3a62c8"], d: ["#202c4a", "#cfdcf7", "#7b9cf2"] },
  amber:  { l: ["#f2e8cf", "#4a3a12", "#a8800f"], d: ["#382f1d", "#efe0b5", "#d9ad3c"] },
  slate:  { l: ["#e9e9ec", "#303036", "#767683"], d: ["#2a2a2f", "#d8d8de", "#9a9aa8"] },
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A tile: small caps label (with an aside on its right), a value row, and an
// optional bar underneath with a pace tick. parts: {text,bold,dim} | {spark}.
function svgTile({ tone, label, aside, parts, bar, alt }) {
  const { l, d } = TONES[tone];
  const padX = 12;
  const GAP = 7; // SVG collapses spaces, so parts are trimmed and spaced here
  parts = parts.map((p) => (p.text == null ? p : { ...p, text: p.text.trim() })).filter((p) => p.spark || p.text);
  const valueW = parts.reduce((w, p) => w + (p.spark ? p.spark.length * 4 - 1 : p.text.length * VALUE_W) + GAP, -GAP);
  const labelW = label.length * LABEL_W + (aside ? 14 + aside.length * LABEL_W : 0);
  const inner = Math.ceil(Math.max(valueW, labelW, bar ? 88 : 0));
  const width = inner + padX * 2;
  let body = `<text class="fg" x="${padX}" y="15" fill="${l[1]}" opacity=".62" font-size="10" font-weight="600" letter-spacing=".6" textLength="${(label.length * LABEL_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>`;
  if (aside) {
    const w = aside.length * LABEL_W;
    body += `<text class="fg" x="${padX + inner - w}" y="15" fill="${l[1]}" opacity=".62" font-size="10" textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs" text-anchor="start">${esc(aside)}</text>`;
  }
  let x = padX;
  const vy = bar ? 30 : 33;
  for (const p of parts) {
    if (p.spark) {
      const lo = Math.min(...p.spark), hi = Math.max(...p.spark);
      p.spark.forEach((v, j) => {
        const h = 3 + (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 11;
        body += `<rect class="ac" x="${x + j * 4}" y="${vy + 1 - h}" width="3" height="${h.toFixed(1)}" rx="1" fill="${l[2]}" opacity="${j === p.spark.length - 1 ? 1 : 0.5}"/>`;
      });
      x += p.spark.length * 4 - 1 + GAP;
    } else {
      const w = p.text.length * VALUE_W;
      body += `<text class="fg" x="${x}" y="${vy}" fill="${l[1]}" opacity="${p.dim ? 0.6 : 1}" font-size="14" font-weight="${p.bold ? 700 : 500}" textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(p.text)}</text>`;
      x += w + GAP;
    }
  }
  if (bar) {
    const by = TILE_H - 9;
    const fill = Math.max(bar.pct > 0 ? 3 : 0, (bar.pct / 100) * inner);
    body += `<rect class="tr" x="${padX}" y="${by}" width="${inner}" height="3" rx="1.5" fill="${l[1]}" opacity=".14"/>`;
    body += `<rect class="ac" x="${padX}" y="${by}" width="${fill}" height="3" rx="1.5" fill="${l[2]}"/>`;
    if (bar.pace != null) {
      const px = padX + Math.min(inner - 1, Math.max(1, bar.pace * inner));
      body += `<rect class="fg" x="${px - 1}" y="${by - 3}" width="2" height="9" rx="1" fill="${l[1]}"/>`;
    }
  }
  const css = `.bg{fill:${d[0]}}.fg{fill:${d[1]}}.ac{fill:${d[2]}}.tr{fill:${d[1]}}`;
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TILE_H}" viewBox="0 0 ${width} ${TILE_H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">` +
    `<style>@media (prefers-color-scheme:dark){${css}}</style>` +
    `<rect class="bg" width="${width}" height="${TILE_H}" rx="10" fill="${l[0]}"/>${body}</svg>`;
  return { source, width, alt };
}

function desktopRow({ Svg }, { u, a, git, working, columns }) {
  const wide = columns == null || columns >= 90;
  const tiles = [];
  const add = (t) => {
    const { source, width, alt } = svgTile(t);
    tiles.push(Svg({ source, alt, width, height: TILE_H }));
  };

  for (const rl of u?.rateLimits ?? []) {
    const p = clampPct(rl.percentUsed);
    const pace = paceOf(rl);
    const reset = resetsIn(rl.resetsAt);
    const parts = [{ text: `${p}%`, bold: true }];
    if (pace?.projected != null) parts.push({ text: ` → ${Math.min(999, Math.round(pace.projected))}%`, dim: true });
    add({
      tone: { ok: "green", warn: "yellow", crit: "red" }[limitStatus(rl)],
      label: limitLabel(rl).toUpperCase(),
      aside: wide && reset ? `resets ${reset}` : null,
      parts,
      bar: { pct: p, pace: pace?.elapsed },
      alt: `${limitLabel(rl)} limit ${p}% used${reset ? `, resets in ${reset}` : ""}`,
    });
  }

  if (u?.context?.window) {
    const pct = ctxPct(u.context);
    const parts = [{ text: short(u.context.tokens ?? 0), bold: true }, { text: ` / ${short(u.context.window)}`, dim: true }];
    if (wide && u.history?.length >= 2) parts.push({ spark: u.history });
    add({
      tone: pct < 50 ? "blue" : pct < 75 ? "yellow" : "red",
      label: "CONTEXT",
      aside: u.delta ? (u.delta > 0 ? `▲ +${short(u.delta)}` : `▼ ${short(-u.delta)}`) : `${pct}%`,
      parts,
      bar: { pct },
      alt: `Context ${pct}% used`,
    });
  }

  if (typeof u?.cost?.usd === "number") {
    const burn = burnRate(u);
    const parts = [{ text: `$${u.cost.usd.toFixed(2)}`, bold: true }];
    if (u.costDelta > 0 && wide) parts.push({ text: ` +$${u.costDelta.toFixed(2)}`, dim: true });
    add({ tone: "amber", label: "COST", aside: burn ? `$${burn.toFixed(2)}/h` : null, parts, alt: `Session cost $${u.cost.usd.toFixed(2)}` });
  }

  if (working != null) add({ tone: "purple", label: "TURN", aside: "live", parts: [{ text: mmss(working), bold: true }], alt: `Turn running ${mmss(working)}` });

  if (git?.branch && wide) {
    const sync = [git.ahead && `↑${git.ahead}`, git.behind && `↓${git.behind}`].filter(Boolean).join(" ");
    const parts = [{ text: git.branch.length > 16 ? `${git.branch.slice(0, 15)}…` : git.branch, bold: true }];
    if (git.dirty) parts.push({ text: ` ±${git.dirty}` });
    add({ tone: git.dirty ? "yellow" : "slate", label: "BRANCH", aside: sync || null, parts, alt: `Git branch ${git.branch}, ${git.dirty} changed` });
  }

  if (a?.calls && wide) {
    const parts = [{ text: `${a.calls}`, bold: true }, { text: ` call${a.calls === 1 ? "" : "s"}`, dim: true }];
    if (a.files.length) parts.push({ text: `  ✎ ${a.files.length}` });
    add({ tone: "purple", label: "ACTIVITY", aside: null, parts, alt: `${a.calls} tool calls, ${a.files.length} files edited` });
  }

  const dur = duration(u?.startedAt);
  if (dur && wide) add({ tone: "slate", label: "SESSION", parts: [{ text: dur, bold: true }], alt: `Session duration ${dur}` });
  if (u?.model) add({ tone: "slate", label: "MODEL", parts: [{ text: prettyModel(u.model), bold: true }], alt: `Model ${shortModel(u.model)}` });
  return tiles;
}

function prettyModel(id) {
  const m = shortModel(id).replace("-", " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
}
