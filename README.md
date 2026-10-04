# usage-bar

A Claude Code mod: a live band above the prompt showing your 5h and 7d rate-limit
usage with reset countdowns, the context window, and session cost.

Works in the Claude Code CLI and the Desktop app's Code tab. Requires Claude Code
2.1.287 or later.

```
 5h  ▰▰▱▱▱▱▱▱  20%  2h 40m   7d  ▰▰▰▰▰▱▱▱  58%  1d 7h   ☂ 115.5k / 1M 12% ▂▃▂ ▲+8.1k   $1.28   1h 23m   ✎ 3 · 14 calls   sonnet-5.5
```

On the desktop app each figure is a stat tile (small-caps label, value, optional bar), light and dark aware. A limit tile reads `20% → 43%`: used now, projected at reset. Also: live turn timer while Claude works, git branch with dirty count and ahead/behind, burn rate (`$/h`) and last-turn cost, and a `more` button that expands the `/usage` detail inline (tool counts, edited files). Each limit bar carries a pace marker (`┃` in the terminal) showing how far into the window you are, so a fill past the marker means you are burning faster than the window allows. A limit turns yellow when your current pace would hit 100% before reset, red past 150% pace or 90% used. `/usage` says when you would hit the limit.

Segments are pill-styled and color-coded; each hides when empty or narrow:

- **5h / 7d** — percent of each rate-limit window used, bar and reset countdown,
  green under 50%, yellow under 80%, red past. Empty on API-key billing.
- **context** — weather icon for health (☀ under 50%, ☁ under 75%, ☂ under 90%,
  ↯ past 90%), tokens of the window, percent, a sparkline of the last 12 turns,
  and the last turn's delta (`▲ +8.1k`).
- **$** — session cost. **duration** — session wall time.
- **activity** — live tool-call count and edited-file count; ticks while Claude
  works.
- **model** — the session's resolved model id, shortened.

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