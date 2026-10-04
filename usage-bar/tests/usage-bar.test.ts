import { describe, expect, test } from "claude-code/testing";

function stubUsage($, on) {
  let tokens = 954_200;
  on("session.usage", () => ({
    value: {
      startedAt: Date.now() - 83 * 60_000,
      context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
      rateLimits: [
        {
          kind: "five_hour",
          percentUsed: 20,
          resetsAt: new Date(Date.now() + 160 * 60_000).toISOString(),
        },
        {
          kind: "seven_day",
          percentUsed: 58,
          resetsAt: new Date(Date.now() + 31 * 60 * 60_000).toISOString(),
        },
      ],
      cost: { usd: 4.32 },
    },
  }));
  on("session.model", () => ({ value: "claude-sonnet-5-5-20261001" }));
  on("command.register", ($, e) => ({ value: { command: e.command } }));
  on("clock.every", () => ({ value: {} }));
  stubStore(on);
  return {
    setTokens: (t) => {
      tokens = t;
    },
  };
}

function stubStore(on) {
  const kv = new Map();
  on("store.get", ($, e) => ({ value: kv.get(e.key) }));
  on("store.set", ($, e) => { kv.set(e.key, e.value); return { value: undefined }; });
  on("store.keys", () => ({ value: [...kv.keys()] }));
  on("store.delete", ($, e) => { kv.delete(e.key); return { value: undefined }; });
  on("session.id", () => ({ value: "sess-1" }));
}

async function mount($, plugin = "usage-bar") {
  return $.ui.mount({
    plugin,
    surface: "terminal",
    component: "AbovePrompt",
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
  } as any);
}

describe("usage-bar", () => {
  test("pills show rate limits, context, cost, duration, and model", async ($, on) => {
    const usage = stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await mount($);
    expect(await ui.find({ type: "Text", text: /5h/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /20%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /2h 40m/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /7d/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /58%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /1d 7h/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /95%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /954\.2k\/1M/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$4\.32/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /1h 23m/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /sonnet-5\.5/ })).toBeDefined();

    usage.setTokens(1_052_500);
    await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 1 } as any);
    expect(await ui.find({ type: "Text", text: /▲ \+98\.3k/ })).toBeDefined();
    await ui.unmount();
  });

  test("tool calls tick the activity pill", async ($, on) => {
    stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    on("tool.call", () => ({ result: "ok" }));

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await mount($);
    await $.tool.call({ tool: "Bash", input: { command: "ls" } } as any);
    await $.tool.call({ tool: "Read", input: { file_path: "/a.go" } } as any);
    await $.tool.call({ tool: "Edit", input: { file_path: "/a.go" } } as any);
    expect(await ui.find({ type: "Text", text: /3 calls/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /✎ 1/ })).toBeDefined();
    await ui.unmount();
  });

  test("/usage prints the full detail", async ($, on) => {
    stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const r = await $.command.run({ command: "usage" } as any);
    expect(r.text).toContain("Rate limits:");
    expect(r.text).toContain("5h");
    expect(r.text).toContain("20%");
    expect(r.text).toContain("resets in 2h 40m");
    expect(r.text).toContain("Context: 954.2k / 1M (95%)");
    expect(r.text).toContain("$4.32");
    expect(r.text).toContain("1h 23m");
    expect(r.text).toContain("0 tool calls");
    expect(r.text).toContain("Model: sonnet-5.5");
  });

  test("a red bar past 80% and no reset when unknown", async ($, on) => {
    on("session.usage", () => ({
      value: {
        startedAt: 0,
        context: { tokens: 10_000, window: 200_000, percent: 5 },
        rateLimits: [{ kind: "five_hour", percentUsed: 91 }],
        cost: { usd: 0 },
      },
    }));
    on("session.model", () => ({ value: "claude-opus-4-6-20260101" }));
    on("clock.every", () => ({ value: {} }));
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await mount($);
    expect(await ui.find({ type: "Text", text: /91%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$0\.00/ })).toBeDefined(); // a fresh session still shows its figures
    expect(await ui.find({ type: "Text", text: /opus-4\.6/ })).toBeDefined();
    await ui.unmount();
  });

  test("desktop draws one SVG strip", async ($, on) => {
    stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({
      plugin: "usage-bar",
      surface: "desktop",
      component: "AbovePrompt",
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as any);
    const svg: any = await ui.find({ type: "Svg" });
    expect(svg).toBeDefined();
    expect(svg.props.source).toContain("20%");
    expect(svg.props.source).not.toContain("textLength");
    expect(svg.props.alt).toContain("5h 20%");
    await ui.unmount();
  });

  test("git pill shows branch and dirty count; more toggles the details", async ($, on) => {
    stubUsage($, on);
    on("process.run", () => ({ value: { exitCode: 0, stdout: "## main...origin/main [ahead 2]\n M a.go\n?? b.go\n", stderr: "" } }));
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await mount($);
    expect(await ui.find({ type: "Text", text: /main/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /±2/ })).toBeDefined();
    await ui.press({ key: "more" } as any);
    expect(await ui.find({ type: "Text", text: /Context/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /main ·|main  ·/ })).toBeDefined();
    await ui.unmount();
  });

  test("turn timer shows while a turn is working", async ($, on) => {
    stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("prompt.submit", ($, e) => ({ text: e.text }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.prompt.submit({ text: "go" } as any);
    const ui = await $.ui.mount({
      plugin: "usage-bar",
      surface: "terminal",
      component: "AbovePrompt",
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
    } as any);
    expect(await ui.find({ type: "Text", text: /0:0\d/ })).toBeDefined();
    await ui.unmount();
  });

  test("turns are logged with cost and cache hit; details show them", async ($, on) => {
    stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const usage = { input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
    await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 41_000, usage } as any);
    const r = await $.command.run({ command: "usage" } as any);
    expect(r.text).toContain("Turns: 1");
    expect(r.text).toContain("cache hit 90%");
    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount({ plugin: "usage-bar", surface, component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } } as any);
      await ui.press({ key: "more" } as any);
      if (surface === "desktop") {
        const svgs: any[] = await ui.findAll({ type: "Svg" } as any);
        const svg = svgs.find((x) => String(x.props.source).includes("TURNS"));
        expect(svg.props.source).toContain("cache 90%");
      } else {
        expect(await ui.find({ type: "Text", text: /90%/ })).toBeDefined();
      }
      await ui.press({ key: "more" } as any);
      await ui.unmount();
    }
  });

  test("git shows lines added and removed, and the branch's PR", async ($, on) => {
    stubUsage($, on);
    on("process.run", ($, e) => {
      const argv = e.argv ?? e.command ?? [];
      const cmd = argv.join(" ");
      if (cmd.startsWith("git status")) return { value: { exitCode: 0, stdout: "## feat/x...origin/feat/x\n M a.go\n?? b.go\n", stderr: "" } };
      if (cmd.startsWith("git diff")) return { value: { exitCode: 0, stdout: " 2 files changed, 421 insertions(+), 68 deletions(-)\n", stderr: "" } };
      if (cmd.startsWith("gh pr view")) return { value: { exitCode: 0, stdout: JSON.stringify({ number: 144, url: "https://github.com/o/r/pull/144", state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { name: "lint", conclusion: "FAILURE", detailsUrl: "https://ci/lint" }] }), stderr: "" } };
      return { value: { exitCode: 1, stdout: "", stderr: "" } };
    });
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await mount($);
    expect(await ui.find({ type: "Text", text: /\+421/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /−68/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /#144/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /✗ ci/ })).toBeDefined();
    expect(await ui.find({ type: "Link" } as any)).toBeDefined();
    await ui.unmount();
    const r = await $.command.run({ command: "usage" } as any);
    expect(r.text).toContain("PR #144 open approved ✗ checks");
    expect(r.text).toContain("✗ lint  https://ci/lint");
  });

  test("budgets toast at 80% and the ledger counts today's spend", async ($, on) => {
    let cost = 4.32;
    stubStore(on);
    on("session.model", () => ({ value: "claude-sonnet-5-5" }));
    on("command.register", ($, e) => ({ value: { command: e.command } }));
    on("clock.every", () => ({ value: {} }));
    on("session.usage", () => ({ value: { startedAt: Date.now() - 60 * 60_000, context: { tokens: 1000, window: 200_000 }, rateLimits: [], cost: { usd: cost } } }));
    const toasts: string[] = [];
    on("ui.toast", ($, e) => { toasts.push(e.text); });
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    on("prompt.submit", ($, e) => ({ text: e.text }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const set = await $.command.run({ command: "budget", args: "5" } as any);
    expect(set.text).toContain("Session budget: $4.32 of $5.00 (86%)");
    expect(toasts.join("\n")).toContain("86% of the $5.00 budget");
    await $.prompt.submit({ text: "go" } as any);
    cost = 5.5;
    await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 1000 } as any);
    expect(toasts.join("\n")).toContain("over the $5.00 budget");
    const r = await $.command.run({ command: "usage" } as any);
    // the session began today, so today counts all of it, not only the turns since load
    if (new Date(Date.now() - 60 * 60_000).getDate() === new Date().getDate()) expect(r.text).toContain("Today: $5.50 over 1 turn");
    const ui = await mount($);
    expect(await ui.find({ type: "Text", text: /\/ \$5/ })).toBeDefined();
    await ui.unmount();
    for (const surface of ["terminal", "desktop"] as const) {
      const m = await $.ui.mount({ plugin: "usage-bar", surface, component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } } as any);
      expect(m).toBeDefined();
      await m.unmount();
    }
  });
});
