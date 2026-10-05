// usage-bar for pi: the pure parts (figures, parsing, drawing), with no pi
// imports so they run under `node --test`. The extension in usage-bar.ts
// feeds them pi's session, git and the day ledger, and puts the lines on
// screen as a widget above the editor.

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
export type Turn = { ms: number; usd: number; out: number; input: number; cacheRead: number; cacheWrite: number };
export type Pr = { number: number; state: string; review: "approved" | "changes" | null; checks: "pass" | "fail" | "pending" | null; failing: string[] };
export type Git = { branch?: string; dirty?: number; untracked?: number; added?: number; removed?: number; ahead?: number; behind?: number; pr?: Pr | null };
export type Budget = { session?: number; day?: number };
export type Ledger = { today: number; week: number };
export type View = {
  ctx?: { tokens: number | null; window: number; percent: number | null };
  history: number[]; // context tokens after each turn
  session: Usage;
  startedAt?: number;
  working: number | null; // ms into the running turn
  turns: Turn[];
  tools: Record<string, number>;
  files: string[];
  git: Git;
  model?: string;
  thinking?: string; // pi's thinking level, "off" hides it
  budget: Budget;
  ledger?: Ledger;
  now: number;
};

// ---- figures -----------------------------------------------------------------

export function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function span(ms: number): string | null {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return null;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function secs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function mmss(ms: number): string {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const BARS = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[]): string | null {
  if (values.length < 2) return null;
  const top = Math.max(...values, 1e-9);
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.floor((v / top) * (BARS.length - 1)))]).join("");
}

export function burnRate(v: View): number | null {
  if (!v.startedAt || v.session.cost <= 0) return null;
  const hours = (v.now - v.startedAt) / 3_600_000;
  return hours >= 0.05 ? v.session.cost / hours : null;
}

export function ctxPct(v: View): number {
  if (!v.ctx) return 0;
  if (v.ctx.percent != null) return Math.round(v.ctx.percent);
  return v.ctx.tokens ? Math.round((v.ctx.tokens / v.ctx.window) * 100) : 0;
}

// Turns left before the window fills, at the average growth per turn.
export function turnsLeft(v: View): number | null {
  if (!v.ctx?.tokens) return null;
  const growth = v.history.slice(1).map((t, i) => t - v.history[i]).filter((d) => d > 0);
  if (!growth.length) return null;
  const avg = growth.reduce((s, d) => s + d, 0) / growth.length;
  return Math.max(0, Math.floor((v.ctx.window - v.ctx.tokens) / avg));
}

export function cacheHit(turns: Turn[]): number | null {
  const read = turns.reduce((s, t) => s + t.cacheRead, 0);
  const fed = turns.reduce((s, t) => s + t.input + t.cacheRead + t.cacheWrite, 0);
  return fed ? Math.round((read / fed) * 100) : null;
}

// The tighter of the two budgets, as a fraction used.
export function budgetUse(b: Budget, v: View): { scope: "session" | "day"; limit: number; frac: number } | null {
  const uses = [
    b.session ? { scope: "session" as const, limit: b.session, frac: v.session.cost / b.session } : null,
    b.day ? { scope: "day" as const, limit: b.day, frac: (v.ledger?.today ?? 0) / b.day } : null,
  ].filter((x) => x != null);
  return uses.sort((x, y) => y.frac - x.frac)[0] ?? null;
}

export function toolName(n: string): string {
  return n.startsWith("mcp__") ? n.split("__").pop()! : n;
}

// ---- parsing -----------------------------------------------------------------

// pi stores cost on every assistant message, and on usage and compaction
// entries for model work outside the conversation.
export function entryUsage(e: any): Usage | null {
  const u = e?.type === "message" && e.message?.role === "assistant" ? e.message.usage : e?.type === "usage" || e?.type === "compaction" ? e.usage : null;
  if (!u || typeof u.input !== "number") return null;
  return { input: u.input, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 };
}

export function sumUsage(entries: any[]): Usage {
  const s: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const e of entries) {
    const u = entryUsage(e);
    if (!u) continue;
    s.input += u.input;
    s.output += u.output;
    s.cacheRead += u.cacheRead;
    s.cacheWrite += u.cacheWrite;
    s.cost += u.cost;
  }
  return s;
}

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Cost per local day in one session file (JSONL).
export function costByDay(jsonl: string): Record<string, number> {
  const days: Record<string, number> = {};
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"cost"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = entryUsage(e);
    const t = Date.parse(e.timestamp ?? "");
    if (!u || !u.cost || Number.isNaN(t)) continue;
    const k = dayKey(t);
    days[k] = (days[k] ?? 0) + u.cost;
  }
  return days;
}

export function ledgerFrom(files: Record<string, number>[], now: number): Ledger {
  const week = [...Array(7)].map((_, i) => dayKey(now - i * 86_400_000));
  let today = 0, total = 0;
  for (const days of files) {
    today += days[week[0]] ?? 0;
    for (const d of week) total += days[d] ?? 0;
  }
  return { today, week: total };
}

export function parseStatus(out: string): Git {
  const [head, ...rest] = out.split("\n");
  const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/.exec(head ?? "");
  const track = m?.[2] ?? "";
  const files = rest.filter(Boolean);
  return {
    branch: m?.[1]?.startsWith("HEAD (no branch)") ? "detached" : m?.[1],
    dirty: files.length,
    untracked: files.filter((l) => l.startsWith("??")).length,
    ahead: +(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: +(/behind (\d+)/.exec(track)?.[1] ?? 0),
  };
}

export function parseShortstat(out: string): { added: number; removed: number } {
  return { added: +(/(\d+) insertion/.exec(out)?.[1] ?? 0), removed: +(/(\d+) deletion/.exec(out)?.[1] ?? 0) };
}

const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"];
const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];
export function parsePr(json: string): Pr | null {
  try {
    const p = JSON.parse(json);
    const verdict = (c: any) => String(c.conclusion || c.state || c.status || "").toUpperCase();
    const rollup: any[] = p.statusCheckRollup ?? [];
    const runs = rollup.map(verdict);
    return {
      number: p.number,
      state: p.isDraft ? "draft" : String(p.state ?? "").toLowerCase(),
      review: p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes" : null,
      checks: !runs.length ? null : runs.some((x) => FAILED.includes(x)) ? "fail" : runs.every((x) => PASSED.includes(x)) ? "pass" : "pending",
      failing: rollup.filter((c) => FAILED.includes(verdict(c))).slice(0, 5).map((c) => c.name || c.context || "check"),
    };
  } catch {
    return null;
  }
}

// ---- drawing -----------------------------------------------------------------
// Truecolor chips: a tint per category, the label in its accent, the figure
// bright, the rest muted. Light themes get light tints.

type Tone = "green" | "yellow" | "red" | "blue" | "purple" | "cyan" | "slate";
// [tint, text, accent, muted]
const DARK: Record<Tone, string[]> = {
  green: ["#1c3328", "#d6f2e1", "#5fcf9a", "#7fa892"],
  yellow: ["#372f15", "#f5e8b8", "#e6b830", "#ad9b62"],
  red: ["#432020", "#fadad4", "#f47563", "#b8837b"],
  blue: ["#1f2a46", "#d9e3fa", "#7b9cf2", "#8190b3"],
  purple: ["#2b2645", "#e0daf8", "#a996ff", "#8f88b3"],
  cyan: ["#16323a", "#d0eef2", "#5cc9d6", "#76a3a9"],
  slate: ["#29292f", "#e2e2e8", "#a3a3b0", "#82828e"],
};
const LIGHT: Record<Tone, string[]> = {
  green: ["#dff1e6", "#173a28", "#23875a", "#5d7f6c"],
  yellow: ["#f6edcc", "#3d300a", "#a87708", "#857345"],
  red: ["#f8dcd6", "#4a1912", "#c4402b", "#8f5d55"],
  blue: ["#dfe7f8", "#16264a", "#3563d1", "#5b6b8f"],
  purple: ["#e8e3f8", "#251d4a", "#6a52cc", "#6d6690"],
  cyan: ["#d9f0f3", "#0f3439", "#167f8c", "#557e83"],
  slate: ["#e8e8ec", "#26262c", "#6b6b78", "#7c7c88"],
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
const RESET = "\x1b[0m";
export const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const vis = (s: string) => [...strip(s)].length;

type Part = [string, "label" | "value" | "aside" | "accent" | "off" | "mark" | "add" | "del"];

export function painter(light: boolean) {
  const pal = light ? LIGHT : DARK;
  const chip = (tone: Tone, parts: Part[]): string => {
    const [bg, fg, ac, mu] = pal[tone];
    const color = { label: ac, value: fg, aside: mu, accent: ac, off: mu, mark: fg, add: light ? "#23875a" : "#6fdc9a", del: light ? "#c4402b" : "#f5806f" };
    const bold = new Set(["label", "value", "mark", "add", "del"]);
    const body = parts.map(([s, k]) => `\x1b[${bold.has(k) ? "1" : "22"};38;2;${rgb(color[k])}m${k === "off" ? "\x1b[2m" : ""}${s}\x1b[22m`).join("");
    return `\x1b[48;2;${rgb(bg)}m \x1b[22m${body}\x1b[48;2;${rgb(bg)}m ${RESET}`;
  };
  const fg = (hex: string, s: string, bold = false) => `\x1b[${bold ? "1;" : ""}38;2;${rgb(hex)}m${s}${RESET}`;
  const toneFg = (tone: Tone, s: string, bold = false) => fg(pal[tone][2], s, bold);
  const dim = (s: string) => `\x1b[2m${s}${RESET}`;
  return { chip, toneFg, dim, pal };
}

function bar(p: number, width: number, elapsed?: number): Part[] {
  const filled = Math.round((Math.max(0, Math.min(100, p)) / 100) * width);
  const mark = elapsed == null ? -1 : Math.min(width - 1, Math.floor(elapsed * width));
  const runs: Part[] = [];
  for (let i = 0; i < width; i++) {
    const kind = i === mark ? "mark" : i < filled ? "accent" : "off";
    const g = kind === "mark" ? "╋" : "━";
    if (runs.at(-1)?.[1] === kind) runs.at(-1)![0] += g;
    else runs.push([g, kind]);
  }
  return runs;
}

const ctxTone = (p: number): Tone => (p < 50 ? "blue" : p < 75 ? "yellow" : "red");
const prTone = (pr: Pr): Tone =>
  pr.checks === "fail" || pr.review === "changes" || pr.state === "closed" ? "red"
  : pr.state === "merged" ? "purple" : pr.state === "draft" ? "slate" : pr.checks === "pending" ? "yellow" : "green";
const useTone = (frac: number): Tone => (frac >= 1 ? "red" : frac >= 0.8 ? "yellow" : "green");

// The header: chips packed into as few lines as the width allows, each chip whole.
export function header(v: View, width: number, light = false, expanded = false): string[] {
  const { chip, dim } = painter(light);
  const wide = width >= 100;
  const chips: string[] = [];

  if (v.ctx) {
    const pct = ctxPct(v);
    const parts: Part[] = [["ctx ", "label"], ...bar(pct, 6), [` ${pct}%`, "value"], [` ${short(v.ctx.tokens ?? 0)}/${short(v.ctx.window)}`, "aside"]];
    const growth = v.history.length >= 2 ? v.history.at(-1)! - v.history.at(-2)! : 0;
    if (growth) parts.push([growth > 0 ? ` ▲ +${short(growth)}` : ` ▼ ${short(-growth)}`, "aside"]);
    chips.push(chip(ctxTone(pct), parts));
  }

  const use = budgetUse(v.budget, v);
  {
    const parts: Part[] = [["$ ", "label"], [money(v.session.cost), "value"]];
    if (use?.scope === "session") parts.push([` / $${use.limit.toFixed(0)}`, "aside"]);
    const burn = burnRate(v);
    if (burn && wide) parts.push([` ${money(burn)}/h`, "aside"]);
    chips.push(chip(use ? useTone(use.frac) === "green" ? "yellow" : useTone(use.frac) : "yellow", parts));
  }

  if (v.ledger && v.ledger.today > 0) {
    const parts: Part[] = [["today ", "label"], [money(v.ledger.today), "value"]];
    if (v.budget.day) parts.push([` / $${v.budget.day.toFixed(0)}`, "aside"]);
    const tone = v.budget.day ? useTone(v.ledger.today / v.budget.day) : "green";
    chips.push(chip(tone, parts));
  }

  if (v.working != null) chips.push(chip("purple", [["● ", "accent"], [mmss(v.working), "value"]]));

  if (v.git.branch) {
    const b = v.git.branch.length > 24 ? `${v.git.branch.slice(0, 23)}…` : v.git.branch;
    const parts: Part[] = [["git ", "label"], [b, "value"]];
    if (v.git.added || v.git.removed) parts.push([` +${v.git.added ?? 0}`, "add"], [` −${v.git.removed ?? 0}`, "del"]);
    else if (v.git.dirty) parts.push([` ±${v.git.dirty}`, "accent"]);
    if (v.git.untracked) parts.push([` ?${v.git.untracked}`, "aside"]);
    const sync = [v.git.ahead && `↑${v.git.ahead}`, v.git.behind && `↓${v.git.behind}`].filter(Boolean).join(" ");
    if (sync) parts.push([` ${sync}`, "aside"]);
    chips.push(chip("cyan", parts));
  }

  if (v.git.pr) {
    const pr = v.git.pr;
    const parts: Part[] = [["PR ", "label"], [`#${pr.number}`, "value"], [` ${pr.state}`, "aside"]];
    if (pr.review) parts.push([pr.review === "approved" ? " ✓ approved" : " ✗ changes", pr.review === "approved" ? "add" : "del"]);
    if (pr.checks) parts.push([{ pass: " ✓ ci", fail: " ✗ ci", pending: " ● ci" }[pr.checks], { pass: "add", fail: "del", pending: "accent" }[pr.checks] as Part[1]]);
    chips.push(chip(prTone(pr), parts));
  }

  const calls = Object.values(v.tools).reduce((s, n) => s + n, 0);
  if (calls && wide) chips.push(chip("purple", [[`${calls} calls`, "value"], ...(v.files.length ? [[` ✎ ${v.files.length}`, "accent"] as Part] : [])]));
  const dur = v.startedAt ? span(v.now - v.startedAt) : null;
  if (dur && wide) chips.push(chip("slate", [[dur, "value"]]));
  if (v.model || (v.thinking && v.thinking !== "off")) {
    const parts: Part[] = [];
    if (v.model) parts.push([v.model, "aside"]);
    if (v.thinking && v.thinking !== "off") parts.push([`${v.model ? " " : ""}think:${v.thinking}`, "accent"]);
    chips.push(chip("purple", parts));
  }
  chips.push(dim(expanded ? "▴ /usage" : "▾ /usage"));

  // pack whole chips into lines
  const lines: string[] = [];
  let line = "", w = 0;
  for (const c of chips) {
    const cw = vis(c);
    if (w && w + 1 + cw > width) {
      lines.push(line);
      line = "", w = 0;
    }
    line += (w ? " " : "") + c;
    w += (w ? 1 : 0) + cw;
  }
  if (line) lines.push(line);
  return lines;
}

// The detail panel under the header: one aligned row per area.
export function details(v: View, width: number, light = false): string[] {
  const { toneFg, dim } = painter(light);
  const out: string[] = [dim("─".repeat(Math.max(10, Math.min(width - 1, 96))))];
  const row = (label: string, tone: Tone, body: string) => out.push(`${toneFg(tone, label.padEnd(9), true)}${body}`);

  if (v.ctx) {
    const pct = ctxPct(v);
    const w = Math.max(12, Math.min(30, width - 60));
    const n = Math.round((pct / 100) * w);
    const left = turnsLeft(v);
    const spark = sparkline(v.history);
    row("Context", "blue", `${toneFg(ctxTone(pct), "━".repeat(n))}${dim("━".repeat(w - n))} ${pct}%  ${dim(`${short(v.ctx.tokens ?? 0)} / ${short(v.ctx.window)}`)}${spark ? `  ${toneFg("blue", spark)}` : ""}${left != null ? `  ${left < 5 ? toneFg("red", `≈${left} turns to full`) : dim(`≈${left} turns to full`)}` : ""}`);
  }

  {
    const priced = v.turns.filter((t) => t.usd > 0);
    const bits = [money(v.session.cost)];
    const burn = burnRate(v);
    if (burn) bits.push(dim(`${money(burn)}/h`));
    if (priced.length) bits.push(dim(`last +${money(priced.at(-1)!.usd)}`), dim(`avg ${money(priced.reduce((s, t) => s + t.usd, 0) / priced.length)}/turn`));
    if (v.ledger) bits.push(dim(`today ${money(v.ledger.today)}`), dim(`7d ${money(v.ledger.week)}`));
    const use = budgetUse(v.budget, v);
    if (use) bits.push(toneFg(useTone(use.frac), `${Math.round(use.frac * 100)}% of $${use.limit.toFixed(0)} ${use.scope} budget`));
    const spark = sparkline(priced.map((t) => t.usd));
    if (spark) bits.push(toneFg("yellow", spark));
    row("Spend", "yellow", bits.join("  "));
  }

  if (v.turns.length) {
    const avg = v.turns.reduce((s, t) => s + t.ms, 0) / v.turns.length;
    const hit = cacheHit(v.turns);
    const outTok = v.turns.reduce((s, t) => s + t.out, 0);
    const bits = [String(v.turns.length), dim(`avg ${secs(avg)}  longest ${secs(Math.max(...v.turns.map((t) => t.ms)))}`)];
    if (hit != null) bits.push(`${dim("cache")} ${toneFg(hit >= 70 ? "green" : hit >= 40 ? "yellow" : "red", `${hit}%`)}`);
    if (outTok) bits.push(dim(`out ${short(outTok)}`));
    const spark = sparkline(v.turns.map((t) => t.ms));
    if (spark) bits.push(toneFg("purple", spark));
    row("Turns", "purple", bits.join("  "));
  }

  const top = Object.entries(v.tools).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) {
    const max = top[0][1];
    row("Tools", "cyan", top.map(([n, c]) => `${dim(toolName(n))} ${toneFg("cyan", "━".repeat(Math.max(1, Math.round((c / max) * 8))))} ${c}`).join("   "));
  }
  if (v.files.length) row("Edited", "green", dim(v.files.slice(-4).map((f) => f.split("/").pop()).join(", ")));
  if (v.git.pr?.failing.length) row("Failing", "red", dim(v.git.pr.failing.join(" · ")));
  return out;
}

// /usage as plain text, for a notification or print mode.
export function report(v: View): string {
  const lines: string[] = [];
  if (v.ctx) lines.push(`Context: ${short(v.ctx.tokens ?? 0)} / ${short(v.ctx.window)} (${ctxPct(v)}%)`);
  lines.push(`Session: ${money(v.session.cost)}${burnRate(v) ? `, ${money(burnRate(v)!)}/h` : ""}`);
  if (v.ledger) lines.push(`Today: ${money(v.ledger.today)}, last 7 days ${money(v.ledger.week)}`);
  const use = budgetUse(v.budget, v);
  if (use) lines.push(`Budget: ${Math.round(use.frac * 100)}% of $${use.limit.toFixed(2)} (${use.scope})`);
  if (v.turns.length) lines.push(`Turns: ${v.turns.length}, cache hit ${cacheHit(v.turns) ?? 0}%`);
  return lines.join("\n");
}
