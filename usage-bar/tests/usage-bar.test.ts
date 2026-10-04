import { describe, expect, test } from "claude-code/testing";

describe("usage-bar", () => {
  test("the band shows rate limits, context, and cost", async ($, on) => {
    on("session.usage", () => ({
      value: {
        startedAt: 0,
        context: { tokens: 954_200, window: 1_000_000, percent: 95 },
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
    on("clock.every", () => ({}));
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
    expect(await ui.find({ type: "Text", text: /954\.2k/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$4\.32/ })).toBeDefined();
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
    on("clock.every", () => ({}));
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
    await ui.unmount();
  });
});