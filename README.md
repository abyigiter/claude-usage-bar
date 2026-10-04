# usage-bar

A Claude Code mod: a live band above the prompt showing your 5h and 7d rate-limit
usage with reset countdowns, the context window, and session cost.

Works in the Claude Code CLI and the Desktop app's Code tab. Requires Claude Code
2.1.287 or later.

```
 5h ━━━╋━━ 62% ↻ 1h 40m   ctx ━━━━━━ 14% 138.8k/1M ▂▃▅▇ ▲ +5.1k   $2.32 $10.71/h   ● 0:42   git main +421 −68 ?1 ↑1   PR #144 open ✓ approved ● ci   30 calls ✎ 2   13m   opus-5.5   ▾ more
```

Terminal: tinted chips, each glued into one unit so the row wraps between chips, never through one. Bars are thin `━` rules with the pace marker `╋` at the window's elapsed time; a fill past the marker means you are burning faster than the window allows.

Desktop: each figure is a tinted pill in its category's color (limits by status, context blue, turn purple, git cyan, PR by state, cost amber, today green), turning yellow or red as a budget or limit nears. Pills flow in one row and wrap as units. Detail cards carry matching tints, and cards with nothing to show are left out. Light and dark aware.

Git shows lines added and removed against HEAD (`+421 −68`, staged and unstaged), untracked files (`?1`), and ahead/behind. When the GitHub CLI (`gh`) is installed and signed in, the branch's pull request shows too: number, state, review decision and CI (`✓` pass, `✗` fail, `●` running), colored by what needs attention. It is looked up again on a branch switch or every 5 minutes.

Budgets: `/budget 10` sets a session budget, `/budget day 50` a daily one, `/budget off [day|session]` clears. A toast fires at 80% and at 100% of each, and once when your burn rate will cross the session budget within 15 minutes. The cost figure turns yellow, then red.

Daily ledger: each session keeps its own running total per local day in the plugin store (kept 30 days); today is the sum over sessions. A session that began today counts in full, one carried over from an earlier day from its first reading today. The band shows today's spend, `/usage` today's turns and the last 7 days.

PR links: on desktop the app draws its own clickable PR bar above the band, so the PR pill only shows status; in the terminal `#144 ↗` follows the chip. When checks fail, the detail panel lists each one as a link to its CI page. While CI runs the PR is re-checked every minute, and a toast says when it passes or fails.

`▾ more` opens the detail panel (desktop: four cards in one row; terminal: aligned rows):

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