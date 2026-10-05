# usage-bar

A Claude Code mod: a live band above the prompt with your context window,
spend, rate limits, git state and pull request, plus a `▾ more` panel that
shows where the context and the money went.

Works in the Claude Code CLI, the desktop app's Code tab (Claude Code 2.1.287
or later), and [pi](#pi).

![Desktop header](docs/desktop-header.png)

![Desktop detail panel](docs/desktop-panel.png)

![Terminal header](docs/terminal-header.png)

![Terminal detail panel](docs/terminal-panel.webp)

## Install

```
/plugin marketplace add abyigiter/claude-usage-bar
/plugin install usage-bar@abyigiter-mods
/reload-plugins
```

Update later with `/plugin marketplace update abyigiter-mods`, then
`/reload-plugins`.

## pi

The same bar runs in [pi](https://pi.dev) as a widget above the editor:

```
pi install git:github.com/abyigiter/claude-usage-bar
```

Chips for context, cost (against your budget), today's spend, the running
turn, git diff, the branch's PR, tool calls, session time and model. `/usage`
toggles the detail panel (context forecast, spend per turn, turns and cache
hit, top tools, edited files, failing checks); `/usage text` prints the
figures. `/budget` works as below, stored in `~/.pi/agent/usage-bar.json`.

Today and the last 7 days are exact in pi: they are summed from the cost pi
records on every message in every session file under `~/.pi/agent/sessions`.
There is no rate-limit chip, since pi talks to many providers. It sits happily
next to a custom footer such as `pi-powerline-footer`.

Tests: `npm test` (the drawing and parsing in `pi/core.ts`).

## The header

Each figure is a pill colored by what it is, turning yellow or red when it
needs attention. Pills flow in one row and wrap as units.

| Pill | Shows |
| --- | --- |
| `5H` / `7D` | Rate-limit use with a bar, a pace tick at the window's elapsed time, and the reset countdown. Yellow when your pace would hit 100% before reset, red past 150% pace or 90% used. Hidden off a subscription. |
| `CTX` | Context window fill, tokens, and the last turn's growth. |
| `● 0:42` | A live timer while Claude works. |
| git | Branch, lines added and removed against HEAD (`+421 −68`), untracked files (`?1`), ahead and behind. |
| PR | The branch's pull request through `gh`: state, review, CI (`✓` pass, `✗` fail, `●` running). Re-checked every 5 minutes, every minute while CI runs, with a toast when it finishes. Needs the GitHub CLI signed in. |
| `COST` | Session spend and burn rate (`$/h`), against your budget when one is set. |
| `TODAY` | Spend across every session today, and the last 7 days. |

In the terminal the same figures are tinted chips.

## The detail panel

`▾ more` opens four cards on desktop (aligned rows in the terminal). Cards
with nothing to show yet are left out.

- **Context**: a stacked bar by `/context` category (messages, tools, MCP,
  memory, skills) and how many turns are left before auto-compact at your
  average growth.
- **Spend**: total, today, last turn, average per turn, a bar per turn.
- **Turns**: count, average and longest duration, prompt cache hit rate,
  tokens written, a bar per turn.
- **Tools**: the top five tools (MCP names shortened). Failing CI checks are
  listed under the panel.

## Budgets

```
/budget 10          session budget of $10
/budget day 50      daily budget of $50
/budget off         clear both (or /budget off day, /budget off session)
/budget             show where you stand
```

A toast fires at 80% and at 100% of each budget, and once when your burn
rate will cross the session budget within 15 minutes.

## Today's spend

Each session keeps its own running total per local day in the plugin store
(kept 30 days); today is the sum over sessions. A session that began today
counts in full, one carried over from an earlier day counts from its first
reading today.

## `/usage`

Prints everything above as text: limits with pace, context, session cost,
today and the last 7 days, budgets, turns and cache hit rate, tools, edited
files, git and PR with failing checks, model.

## What it reads and runs

No API calls of its own, no keys, no telemetry. Everything is local except
the PR lookup, which goes through your own `gh` login.

| | Claude Code | pi |
| --- | --- | --- |
| Usage and cost | Claude Code's own figures (`$.session.usage()`), the same numbers as `/cost` and the status line | The cost pi records on each message, read from your session files under `~/.pi/agent/sessions` |
| Context breakdown | Claude Code's local `/context` estimate (`breakdown: "summary"`, no token-count requests) | Not available |
| Commands it runs, in the session's directory | `git status --porcelain=v1 -b`, `git diff HEAD --shortstat`, `gh pr view --json number,url,state,isDraft,reviewDecision,statusCheckRollup` | The same three |
| What it writes | Budgets and per-day totals in the plugin's own store | Budgets in `~/.pi/agent/usage-bar.json` |

`git` runs every minute and after each turn. `gh` runs at most every 5
minutes (every minute while CI runs) and only on a branch, and it does nothing
when `gh` is missing or signed out. It never reads `.env` files, credentials or
the contents of your repo; the git commands only return file counts and line
totals.

## Building it

A standard mod plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, one
hooks module. Readings come from `$.session.usage()` on `session.measure`,
`turn.complete` and a one-minute timer; the context breakdown from
`$.session.usage({ breakdown: "summary" })`, a local estimate. The header and
cards on desktop are SVG drawings; the terminal draws Ink text. State lives in
`$.state` so it survives hot reloads; budgets and the day totals in
`$.store`.

Tests: `claude plugin test ./usage-bar`.
