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
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, u, a, e.props.bodyColumns, next, e);
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
      lines.push(`  ${rl.kind === "five_hour" ? "5h" : rl.kind === "seven_day" ? "7d" : rl.kind}  ${bar(p)}  ${p}%${reset ? `  ·  resets in ${reset}` : ""}`);
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
  return Box({ flexDirection: "row", gap: 2, paddingX: 1, children: pills });
}

// A pill is a row of inverse-colored Texts; adjacent ones join seamlessly.
function pill(Text, color, parts) {
  return parts.map(([s, o = {}]) =>
    Text({
      color,
      inverse: true,
      dimColor: !!o.dim,
      bold: !!o.bold,
      children: ` ${s} `,
    }));
}

function limitPill(Text, rl, columns) {
  const p = clampPct(rl.percentUsed);
  const color = p < 50 ? "green" : p < 80 ? "yellow" : "red";
  const label = rl.kind === "five_hour" ? "5h" : rl.kind === "seven_day" ? "7d" : rl.kind;
  const parts = [[label, {}], [bar(p), {}], [`${p}%`, { bold: true }]];
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

function bar(p) {
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
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