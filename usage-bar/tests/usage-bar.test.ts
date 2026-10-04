import { describe, expect, test } from "claude-code/testing";

function stubUsage($, on) {
  let tokens = 954_200;
  on("session.usage", () => ({
    value: {
      startedAt: 0,
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
  on("clock.every", () => ({ value: {} }));
  return {
    setTokens: (t) => {
      tokens = t;
    },
  };
}

describe("usage-bar", () => {
  test("the band shows rate limits, context, cost, and model", async ($, on) => {
    const usage = stubUsage($, on);
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({
      plugin: "usage-bar",
      surface: "terminal",
      component: "AbovePrompt",
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as any);
    expect(await ui.find({ type: "Text", text: /5h/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /20%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /2h 40m/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /7d/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /58%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /1d 7h/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /95%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /↯/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$4\.32/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /sonnet-5\.5/ })).toBeDefined();

    usage.setTokens(1_052_500);
    await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 1 } as any);
    expect(await ui.find({ type: "Text", text: /▲ \+98\.3k/ })).toBeDefined();
    await ui.unmount();
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
    const ui = await $.ui.mount({
      plugin: "usage-bar",
      surface: "terminal",
      component: "AbovePrompt",
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as any);
    expect(await ui.find({ type: "Text", text: /91%/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$0\.00/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /opus-4\.6/ })).toBeDefined();
    await ui.unmount();
  });
});