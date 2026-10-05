import { test } from "node:test";
import assert from "node:assert/strict";
import { costByDay, dayKey, details, header, ledgerFrom, parsePr, parseShortstat, parseStatus, strip, sumUsage, turnsLeft, vis, type View } from "./core.ts";

const now = Date.parse("2026-10-05T12:00:00Z");
const base = (over: Partial<View> = {}): View => ({
  ctx: { tokens: 138_800, window: 1_000_000, percent: 14 },
  history: [100_000, 120_000, 138_800],
  session: { input: 1000, output: 24_000, cacheRead: 90_000, cacheWrite: 1000, cost: 2.32 },
  startedAt: now - 13 * 60_000,
  working: null,
  turns: [{ ms: 41_000, usd: 0.21, out: 3000, input: 100, cacheRead: 900, cacheWrite: 0 }],
  tools: { bash: 24, read: 5 },
  files: ["/x/a.ts"],
  git: { branch: "main", added: 421, removed: 68, untracked: 1, ahead: 1, pr: { number: 144, state: "open", review: "approved", checks: "fail", failing: ["lint"] } },
  model: "glm-5.3-flash",
  thinking: "high",
  budget: { session: 5 },
  ledger: { today: 14.1, week: 52.3 },
  now,
  ...over,
});

test("session usage sums assistant messages and usage entries", () => {
  const u = sumUsage([
    { type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.5 } } } },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "usage", usage: { input: 0, output: 0, cacheRead: 100, cacheWrite: 0, cost: { total: 0.25 } } },
  ]);
  assert.equal(u.cost, 0.75);
  assert.equal(u.cacheRead, 105);
});

test("cost by day buckets entries by their local day", () => {
  const line = (ts: string, cost: number) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });
  const days = costByDay([line("2026-10-05T10:00:00", 1), line("2026-10-05T11:00:00", 2), line("2026-10-04T10:00:00", 4), "not json"].join("\n"));
  assert.equal(days["2026-10-05"], 3);
  assert.equal(days["2026-10-04"], 4);
  const l = ledgerFrom([days, { [dayKey(now)]: 0.5 }], Date.parse("2026-10-05T12:00:00"));
  assert.equal(l.today, 3.5);
  assert.equal(l.week, 7.5);
});

test("git and PR parsing", () => {
  assert.deepEqual(parseStatus("## feat/x...origin/feat/x [ahead 2]\n M a.go\n?? b.go\n"), { branch: "feat/x", dirty: 2, untracked: 1, ahead: 2, behind: 0 });
  assert.deepEqual(parseShortstat(" 2 files changed, 421 insertions(+), 68 deletions(-)"), { added: 421, removed: 68 });
  const pr = parsePr(JSON.stringify({ number: 144, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { name: "lint", conclusion: "FAILURE" }] }));
  assert.deepEqual(pr, { number: 144, state: "open", review: "approved", checks: "fail", failing: ["lint"] });
  assert.equal(parsePr("nope"), null);
});

test("header shows every chip and keeps each line within the width", () => {
  for (const width of [200, 100, 60]) {
    const lines = header(base({ working: 42_000 }), width);
    const text = lines.map(strip).join("\n");
    for (const s of ["14%", "$2.32", "/ $5", "today $14.10", "0:42", "main", "+421", "−68", "#144", "✗ ci", "glm-5.3-flash", "think:high"]) assert.ok(text.includes(s), `${s} at ${width}`);
    for (const l of lines) assert.ok(vis(l) <= width, `line fits ${width}`);
  }
});

test("details show context forecast, spend, turns, tools and failing checks", () => {
  const text = details(base(), 140).map(strip).join("\n");
  for (const s of ["Context", "turns to full", "last +$0.21", "today $14.10", "46% of $5 session budget", "cache 90%", "bash", "Edited", "a.ts", "Failing", "lint"]) assert.ok(text.includes(s), s);
  assert.equal(turnsLeft(base()), 44); // 861.2k left at 19.4k a turn
});
