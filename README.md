# usage-bar

A Claude Code mod: a live band above the prompt showing your 5h and 7d rate-limit
usage with reset countdowns, the context window, and session cost.

Works in the Claude Code CLI and the Desktop app's Code tab. Requires Claude Code
2.1.287 or later.

```
 5h ━━━╋━━ 62% ↻ 1h 40m   ctx ━━━━━━ 14% 138.8k/1M ▂▃▅▇ ▲ +5.1k   $2.32 $10.71/h   ● 0:42   git main ±3 ↑1   30 calls ✎ 2   13m   opus-5.5   ▾ more
```

Terminal: tinted chips, each glued into one unit so the row wraps between chips, never through one. Bars are thin `━` rules with the pace marker `╋` at the window's elapsed time; a fill past the marker means you are burning faster than the window allows.

Desktop: one SVG strip on the band's own background (two that wrap when the composer is narrow). Light and dark aware.

`▾ more` opens the detail panel (desktop: four cards; terminal: aligned rows):

- **Context**: stacked bar by `/context` category (messages, tools, system prompt, memory, skills), and when auto-compact kicks in, in tokens and in turns at your average growth.
- **Spend**: total, burn rate, last turn, average per turn, a bar per turn.
- **Turns**: count, average and longest duration, prompt cache hit rate, tokens written, a bar per turn.
- **Tools**: top five tools with bars (MCP names shortened), edited files, git, model, session time.

A limit turns yellow when your current pace would hit 100% before reset, and red past 150% pace or 90% used.

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