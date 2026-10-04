# usage-bar

A Claude Code mod: a live band above the prompt showing your 5h and 7d rate-limit
usage with reset countdowns, the context window, and session cost.

Works in the Claude Code CLI and the Desktop app's Code tab. Requires Claude Code
2.1.287 or later.

```
5h  ▰▰▱▱▱▱▱▱ 20%  2h 40m  │  7d  ▰▰▰▰▰▱▱▱ 58%  1d 7h  │  954.2k / 1.0M ctx  │  $4.32
```

## Install

```
/plugin marketplace add abyigiter/claude-usage-bar
/plugin install usage-bar@abyigiter-mods
/reload-plugins
```

## What it shows

- **5h / 7d** — percent of each rate-limit window used, with a bar and time until
  it resets. Green under 50%, yellow under 80%, red past that. Empty when you're
  on API-key billing (no subscription windows to report).
- **ctx** — tokens used of the context window.
- **$** — session cost so far.

## Building it

Standard mod plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, one hooks
module. Readings come from `$.session.usage()`, refreshed on `session.measure`
(fires when a figure moves), on `turn.complete`, and once a minute on a timer so
the reset countdowns stay fresh. Rendered on `ui.render { component: "AbovePrompt" }`,
state kept in `$.state` so it survives hot reloads.

Tests: `claude plugin test ./usage-bar`.