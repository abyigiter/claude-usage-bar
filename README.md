# usage-bar

A Claude Code mod: a live band above the prompt showing your 5h and 7d rate-limit
usage with reset countdowns, the context window, and session cost.

Works in the Claude Code CLI and the Desktop app's Code tab. Requires Claude Code
2.1.287 or later.

```
5h ━━━╋━━ 62% ↻ 1h 40m │ 7d ━━╋━━━ 38% ↻ 3d │ ctx ━━━━━━ 22% 219.9k/1M ▂▃▅▇ ▲ +21.2k │ $2.83 $13.06/h │ ● 0:42 │ ⎇ main ±3 ↑1 │ sonnet-5.5  ▾
```

Terminal: one line of segments split by a dim rule. Labels are dim, figures carry the status color, and each bar is a thin `━` rule with the pace marker `╋` at the window's elapsed time. A fill past the marker means you are burning faster than the window allows. Segments drop from right to left as the terminal narrows.

Desktop: two SVG strips on the band's own background. The core strip (limits with bar and pace tick, context, live turn timer) fits a narrow composer. The extras strip (git branch, cost and burn rate, session time) sits beside it when there is room and wraps under it when there is not. Light and dark aware.

A limit turns yellow when your current pace would hit 100% before reset, and red past 150% pace or 90% used. `▾` expands the `/usage` detail inline (tool counts, edited files). Zero cost and empty context are hidden.

Type `/usage` for the same figures as text in the transcript.

## Install

```
/plugin marketplace add abyigiter/claude-usage-bar
/plugin install usage-bar@abyigiter-mods
/reload-plugins
```

## Building it

Standard mod plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, one hooks
module. Readings come from `$.session.usage()`, refreshed on `session.measure`
(fires when a figure moves), on `turn.complete`, and once a minute on a timer so
the reset countdowns stay fresh. Rendered on `ui.render { component: "AbovePrompt" }`,
state kept in `$.state` so it survives hot reloads.

Tests: `claude plugin test ./usage-bar`.