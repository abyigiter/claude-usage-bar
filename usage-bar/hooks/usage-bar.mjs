// Usage bar: 5h/7d rate limits, context window, and cost above the prompt.

const READING = { plugin: "usage-bar", key: "last" };
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_WIDTH = 8;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await takeReading($);
    $.clock.every(60_000, () => takeReading($)); // keep reset countdowns fresh
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
    if (!u || (!u.rateLimits?.length && !u.context?.window)) return next(e);
    if (e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, u, e.props.bodyColumns, next, e);
  });
}

async function takeReading($) {
  const { startedAt, ...rest } = await $.session.usage();
  const { value: prev } = await $.state.get(READING);
  await $.state.set(READING, mergeReading(prev, { ...rest, model: await $.session.model() }));
}

// Delta is how much the last turn added to context. Both session.measure and
// turn.complete refresh the reading in one turn, so only move the delta when
// the token count actually changed; otherwise keep the previous one.
function mergeReading(prev, next) {
  const prevTokens = prev?.context?.tokens;
  const tokens = next.context?.tokens;
  if (tokens == null || prevTokens == null || tokens === prevTokens) {
    return { ...next, prevTokens: prev?.prevTokens, delta: prev?.delta };
  }
  return { ...next, prevTokens, delta: tokens - prevTokens };
}

function band(Box, Text, u, columns, next, e) {
  const compact = columns != null && columns < 90;
  const parts = [];
  for (const kind of ["five_hour", "seven_day"]) {
    const rl = u.rateLimits?.find((r) => r.kind === kind);
    if (rl) parts.push(limitPart(Text, rl, compact));
  }
  if (u.context?.window) parts.push(contextPart(Text, u.context, u.delta));
  if (typeof u.cost?.usd === "number") {
    parts.push([Text({ color: "yellow", children: `$${u.cost.usd.toFixed(2)}` })]);
  }
  if (u.model) parts.push([Text({ dimColor: true, children: shortModel(u.model) })]);
  if (parts.length === 0) return next(e);
  const children = [];
  parts.forEach((p, i) => {
    if (i > 0) children.push(Text({ dimColor: true, children: "  │  " }));
    children.push(...p);
  });
  return Box({ flexDirection: "row", paddingX: 1, children });
}

function limitPart(Text, rl, compact) {
  const p = Math.max(0, Math.min(100, Math.round(rl.percentUsed ?? 0)));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
  const color = p < 50 ? "green" : p < 80 ? "yellow" : "red";
  const parts = [
    Text({ children: rl.kind === "five_hour" ? "5h " : "7d " }),
    Text({ color, children: bar }),
    Text({ bold: true, children: ` ${p}%` }),
  ];
  const reset = resetsIn(rl.resetsAt);
  if (!compact && reset) parts.push(Text({ dimColor: true, children: `  ${reset}` }));
  return parts;
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

function contextPart(Text, ctx, delta) {
  const tokens = ctx.tokens ?? 0;
  const pct = ctx.percent ?? Math.round((tokens / ctx.window) * 100);
  const color = pct < 75 ? "green" : pct < 90 ? "yellow" : "red";
  const parts = [
    Text({ color, children: short(tokens) }),
    Text({ dimColor: true, children: ` / ${short(ctx.window)} ctx ${pct}%` }),
  ];
  if (pct >= 90) parts.push(Text({ color: "red", bold: true, children: " ↯" }));
  if (delta) {
    parts.push(
      delta > 0
        ? Text({ color: "red", children: ` ▲ +${short(delta)}` })
        : Text({ color: "green", children: ` ▼ ${short(-delta)}` }),
    );
  }
  return parts;
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