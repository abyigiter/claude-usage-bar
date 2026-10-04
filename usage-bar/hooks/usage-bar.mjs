// Usage bar: pills above the prompt — rate limits, context forecast, cost,
// session duration, live activity, and model. /usage prints the full detail.

const READING = { plugin: "usage-bar", key: "last" };
const ACTIVITY = { plugin: "usage-bar", key: "activity" };
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_WIDTH = 8;
const BARS = "▁▂▃▄▅▆▇█";
const HISTORY = 12;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
let commandName;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await takeReading($);
    $.clock.every(60_000, () => takeReading($)); // keep reset countdowns fresh
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

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    const { value: a = { calls: 0, files: [] } } = await $.state.get(ACTIVITY);
    const files = [...a.files];
    const p = e.input?.file_path ?? e.input?.notebook_path;
    if (EDIT_TOOLS.has(e.tool) && p && !files.includes(p)) files.push(p);
    await $.state.set(ACTIVITY, { calls: a.calls + 1, files: files.slice(-50) });
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
    if (!e.agentId) await takeReading($); // main-loop turns only
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value: u } = await $.state.get(READING);
    const { value: a } = await $.state.get(ACTIVITY);
    const hasUsage = u && (u.rateLimits?.length || u.context?.window || typeof u.cost?.usd === "number");
    if (!hasUsage && !a?.calls) return next(e);
    if (e.props.hasSurvey) return next(e);
    const els = $.ui.resolve(e);
    if (e.surface === "desktop") return desktopBand(els, u, a, e.props.bodyColumns, next, e);
    return band(els.Box, els.Text, u, a, e.props.bodyColumns, next, e);
  });
}

async function answerUsage($, e, next) {
  if (e.command !== commandName) return next(e);
  await takeReading($);
  const { value: u = {} } = await $.state.get(READING);
  const { value: a = { calls: 0, files: [] } } = await $.state.get(ACTIVITY);
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
  if (cost || dur) lines.push(`Session: ${[cost, dur].filter(Boolean).join("  ·  ")}`);
  lines.push(`Activity: ${a.calls} tool call${a.calls === 1 ? "" : "s"}${a.files.length ? `  ·  ${a.files.length} file${a.files.length === 1 ? "" : "s"} edited` : ""}`);
  if (u.model) lines.push(`Model: ${shortModel(u.model)}`);
  return { text: lines.join("\n") };
}

async function takeReading($) {
  const usage = await $.session.usage();
  const { value: prev } = await $.state.get(READING);
  await $.state.set(READING, mergeReading(prev, { ...usage, model: await $.session.model() }));
}

// Delta is how much the last turn added to context. Both session.measure and
// turn.complete refresh the reading in one turn, so only move the delta and
// sparkline history when the token count actually changed.
function mergeReading(prev, next) {
  const prevTokens = prev?.context?.tokens;
  const tokens = next.context?.tokens;
  const startedAt = next.startedAt ?? prev?.startedAt;
  if (tokens == null || prevTokens == null || tokens === prevTokens) {
    return { ...next, startedAt, prevTokens: prev?.prevTokens, delta: prev?.delta, history: prev?.history };
  }
  return {
    ...next,
    startedAt,
    prevTokens,
    delta: tokens - prevTokens,
    history: [...(prev?.history ?? []), tokens].slice(-HISTORY),
  };
}

function band(Box, Text, u, a, columns, next, e) {
  const pills = [];
  if (columns == null || columns >= 80) {
    for (const rl of u?.rateLimits ?? []) pills.push(limitPill(Text, rl, columns));
  }
  if (u?.context?.window) pills.push(contextPill(Text, u, columns));
  if (typeof u?.cost?.usd === "number") pills.push(pill(Text, "yellow", [[`$${u.cost.usd.toFixed(2)}`, { bold: true }]]));
  const dur = duration(u?.startedAt);
  if (dur && (columns == null || columns >= 100)) pills.push(pill(Text, "magenta", [[dur, { dim: true }]]));
  if (a?.calls && (columns == null || columns >= 100)) {
    const parts = [[`${a.calls} calls`, { dim: true }]];
    if (a.files.length) parts.unshift([`✎ ${a.files.length}`, { dim: true }]);
    pills.push(pill(Text, "cyan", parts));
  }
  if (u?.model) pills.push(pill(Text, "blue", [[shortModel(u.model), { dim: true }]]));
  if (pills.length === 0) return next(e);
  return Box({ flexDirection: "row", gap: 1, paddingX: 1, children: pills });
}

// A pill is a row of Texts on a soft tinted background (the desktop palette),
// bright text on a dark tint; adjacent ones join seamlessly.
const TERM_TONE = { green: "green", yellow: "yellow", red: "red", magenta: "purple", cyan: "purple", blue: "blue" };
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

// ---- desktop: rounded SVG pills ------------------------------------------
const CHAR_W = 7.7;
const PILL_H = 28;
const TONES = {
  green:  { l: ["#dcebe1", "#1d3b2c", "#3f8f68"], d: ["#1f3a2e", "#c4e8d3", "#5fcf9a"] },
  yellow: { l: ["#f2e8c9", "#4a3a0c", "#b0820a"], d: ["#3d3517", "#f1e2a6", "#e6b830"] },
  red:    { l: ["#f5d9d3", "#5c1f17", "#c4432d"], d: ["#4a2220", "#f7cfc8", "#f47563"] },
  purple: { l: ["#e4def4", "#2e2557", "#6c56c8"], d: ["#2f2a4d", "#d6cff5", "#9d8cf0"] },
  blue:   { l: ["#dce6f6", "#1b2e58", "#3a62c8"], d: ["#222f4f", "#cfdcf7", "#7b9cf2"] },
  amber:  { l: ["#efe5cb", "#4a3a12", "#a8800f"], d: ["#3a3220", "#efe0b5", "#d9ad3c"] },
  slate:  { l: ["#e6e6e9", "#303036", "#767683"], d: ["#2b2b30", "#d8d8de", "#9a9aa8"] },
};
const ICONS = {
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5"/>',
  pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  timer: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4M9.5 2.5h5"/>',
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// items: {icon} | {text, bold, dim} | {bar: pct, pace} | {sep}
function svgPill(tone, items, label) {
  const { l, d } = TONES[tone];
  let x = 12;
  const mid = PILL_H / 2;
  let body = "";
  items.forEach((it, i) => {
    if (i > 0) x += it.sep || items[i - 1].sep ? 8 : 6;
    if (it.icon) {
      body += `<g class="ac s" transform="translate(${x},${mid - 7}) scale(0.5833)" fill="none" stroke="${l[2]}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[it.icon]}</g>`;
      x += 14;
    } else if (it.sep) {
      body += `<rect class="fg" x="${x}" y="${mid - 8}" width="1" height="16" fill="${l[1]}" opacity=".18"/>`;
      x += 1;
    } else if (it.spark) {
      const vals = it.spark, lo = Math.min(...vals), hi = Math.max(...vals);
      vals.forEach((v, j) => {
        const h = 3 + (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 11;
        body += `<rect class="ac" x="${x + j * 4}" y="${mid + 7 - h}" width="3" height="${h.toFixed(1)}" rx="1" fill="${l[2]}" opacity="${j === vals.length - 1 ? 1 : 0.55}"/>`;
      });
      x += vals.length * 4 - 1;
    } else if (it.bar != null) {
      const w = 52, h = 6, y = mid - h / 2;
      const fill = Math.max(it.bar > 0 ? h : 0, (it.bar / 100) * w);
      body += `<rect class="tr" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${l[1]}" opacity=".14"/>`;
      body += `<rect class="ac" x="${x}" y="${y}" width="${fill}" height="${h}" rx="3" fill="${l[2]}"/>`;
      if (it.pace != null) {
        const px = x + Math.min(w - 1, Math.max(1, it.pace * w));
        body += `<rect class="fg" x="${px - 1}" y="${mid - 8}" width="2" height="16" rx="1" fill="${l[1]}"/>`;
      }
      x += w;
    } else {
      body += `<text class="fg" x="${x}" y="${mid + 4.2}" fill="${l[1]}" opacity="${it.dim ? 0.7 : 1}" font-weight="${it.bold ? 700 : 500}" textLength="${(it.text.length * CHAR_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(it.text)}</text>`;
      x += it.text.length * CHAR_W;
    }
  });
  const width = Math.ceil(x + 12);
  const css = `.bg{fill:${d[0]}}.fg{fill:${d[1]}}.ac{fill:${d[2]}}.s{fill:none;stroke:${d[2]}}.tr{fill:${d[1]}}`;
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_H}" viewBox="0 0 ${width} ${PILL_H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13">` +
    `<style>@media (prefers-color-scheme:dark){${css}}</style>` +
    `<rect class="bg" width="${width}" height="${PILL_H}" rx="${PILL_H / 2}" fill="${l[0]}"/>${body}</svg>`;
  return { source, width, alt: label };
}

function desktopBand({ Box, Svg }, u, a, columns, next, e) {
  const wide = columns == null || columns >= 90;
  const pills = [];
  const add = (tone, items, label) => pills.push(svgPill(tone, items, label));

  for (const rl of u?.rateLimits ?? []) {
    const p = clampPct(rl.percentUsed);
    const tone = { ok: "green", warn: "yellow", crit: "red" }[limitStatus(rl)];
    const pace = paceOf(rl);
    const reset = resetsIn(rl.resetsAt);
    const items = [
      { icon: rl.kind === "seven_day" ? "calendar" : "gauge" },
      { text: limitLabel(rl) },
      { bar: p, pace: pace?.elapsed },
      { text: `${p}%`, bold: true },
    ];
    if (reset && wide) items.push({ sep: true }, { icon: "clock" }, { text: reset });
    add(tone, items, `${limitLabel(rl)} limit ${p}% used${reset ? `, resets in ${reset}` : ""}`);
  }

  if (u?.context?.window) {
    const pct = ctxPct(u.context);
    const tone = pct < 50 ? "blue" : pct < 75 ? "yellow" : "red";
    const items = [{ icon: "layers" }, { text: short(u.context.tokens ?? 0) }, { text: `/ ${short(u.context.window)}`, dim: true }, { text: `${pct}%`, bold: true }];
    if (wide && u.history?.length >= 2) items.push({ spark: u.history });
    if (u.delta) items.push({ text: u.delta > 0 ? `▲ +${short(u.delta)}` : `▼ ${short(-u.delta)}`, dim: true });
    add(tone, items, `Context ${pct}% used`);
  }

  if (typeof u?.cost?.usd === "number") add("amber", [{ icon: "coin" }, { text: `$${u.cost.usd.toFixed(2)}`, bold: true }], `Session cost $${u.cost.usd.toFixed(2)}`);
  const dur = duration(u?.startedAt);
  if (dur && wide) add("slate", [{ icon: "timer" }, { text: dur }], `Session duration ${dur}`);
  if (a?.calls && wide) {
    const items = [{ icon: "pulse" }, { text: `${a.calls}` }];
    if (a.files.length) items.push({ text: `✎ ${a.files.length}`, dim: true });
    add("purple", items, `${a.calls} tool calls, ${a.files.length} files edited`);
  }
  if (u?.model) add("slate", [{ icon: "chip" }, { text: prettyModel(u.model) }], `Model ${shortModel(u.model)}`);

  if (pills.length === 0) return next(e);
  return Box({
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 1,
    rowGap: 0,
    paddingX: 1,
    children: pills.map((p) => Svg({ source: p.source, alt: p.alt, width: p.width, height: PILL_H })),
  });
}

function prettyModel(id) {
  const m = shortModel(id).replace("-", " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
}
