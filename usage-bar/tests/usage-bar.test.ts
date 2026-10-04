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
  return {
    setTokens: (t) => {
      tokens = t;
    },
  };
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
    expect(await ui.find({ type: "Text", text: /↯/ })).toBeDefined();
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
    expect(await ui.find({ type: "Text", text: /\$0\.00/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /opus-4\.6/ })).toBeDefined();
    await ui.unmount();
  });
});