# Reference

For installation and your first request, start with the [installation guide](../README.md#install).

## Commands

| Command | Behavior |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show a status panel with runtime state, paths, sessions, model reasoning levels, and the last turn. |
| `/agy-acp quota [used\|remaining]` | Show account details, grouped quota bars, and reset countdowns, optionally switching and remembering the display mode. |
| `/agy-acp reset` | Close ACP sessions; the next request rebuilds a session from Pi's history. |

Subcommands support completion with Tab. Unknown arguments display
`Usage: /agy-acp [status|quota [used|remaining]|reset]` as a warning.

### Status panel

The panel marks the runtime as idle, starting, ready, or in error. Before the first
turn, it shows the isolated home and notes that agy has not been probed yet;
viewing status does not start it. Models list their supported reasoning levels,
including a fixed level where applicable.

Once a turn finishes, its summary shows the model, effort, outcome (`completed`,
`aborted`, or `error`), duration, and retry notice count when nonzero. Duration
covers the ACP turn, including time waiting for Pi tools, but excludes startup.
A parked tool call is still part of an active turn, not a completed turn.
Runtime errors use an error notification; a failed last turn with an otherwise
healthy runtime uses a warning.

### Quota panel

In interactive TUI mode, a bordered loader displays `Fetching Antigravity quota...`
while the request is pending. Press Escape to cancel waiting and return to the
editor. The underlying quota query may finish and update the cache, but its result
will not appear after cancellation. Non-TUI modes query directly without a loader.

Quota is read through `agy -p /usage --output-format json`. Each model group has
one row per quota window, with a 12-cell bar, a rounded percentage, and a relative
reset time. By default (`used` mode), bars and percentages count up from `0%`; pass
`remaining` (`/agy-acp quota remaining`) to count down from `100%`. The last
selected mode is saved in `settings.json` inside `PI_AGY_HOME`. For example:

```text
Antigravity Quota
  Account:  user@example.com · Google AI Ultra

  Gemini Models
    Gemini Flash, Gemini Pro
    5h      [░░░░░░░░░░░░]   0% · resets in 4h 59m
    weekly  [█░░░░░░░░░░░]   9% · resets in 6d 7h
```

Missing values display `n/a`; an elapsed reset time displays `resetting soon`.
Severity uses the actual remaining fraction rather than the rounded percentage:

| Condition | Notification |
| --- | --- |
| All known windows above 20% remaining (<80% used) | Info |
| Any window at or below 20% remaining (≥80% used), with none at or below 5% remaining | Warning |
| Any window at or below 5% remaining (≥95% used), or a failed quota query | Error |

Errors include the reason. If cached groups are available after a failed query,
the title marks them as `(stale)` and still displays their bars. An empty
successful response displays `No quota data available.`.

### Account details

Both panels show the email and subscription plan when known, omitting unavailable
fields. If no plan is cached, the first `/agy-acp quota` query also tries to discover
it. This may start ACP but sends no model prompt; failure does not prevent quota
from appearing. Use `/agy-acp reset` to retry discovery. Viewing status never starts it.

The email comes from login logs. With the default home only, the extension also
checks `~/.gemini/antigravity-cli/cli.log` if needed; a custom `PI_AGY_HOME` stays
isolated. Cached plans and login logs can be stale after an account change.

### Quota status and warnings

When a run using `antigravity-acp` fully settles, the extension checks `/usage`
in the background and shows a compact status indicator such as `AGY 20%` (or
`AGY 80%` in `remaining` mode). It uses the lowest known remaining window across
the selected model's matching quota group(s) (or an unambiguous generic family
group), and omits the status indicator and low-quota warning when group ownership is
unknown or ambiguous. Failed background checks stay silent. Successful results
and failures both respect the two-minute quota TTL, and concurrent background
checks share the in-flight query.

At or below 20% and 5% remaining (≥80% and ≥95% used), a warning appears once
per group, quota window, reset time, and threshold. `/agy-acp quota` explicitly
refreshes quota and updates the status indicator; `/agy-acp status` uses fresh
cached quota only. Neither session start nor model selection launches a quota
command. Selecting another provider hides the status indicator; returning to
Antigravity uses only a fresh in-memory snapshot. `/agy-acp reset` clears the
status indicator and warning history; shutdown clears the status indicator.

When the active model belongs to `antigravity-acp`, this extension vetoes Pi's
automatic prompt-cache warming to avoid background warming requests consuming
quota. Other providers' warming decisions are left unchanged.

## Configuration

Set these environment variables before starting Pi:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_AGY_COMMAND` | Absolute path to the `agy` executable. | Automatic discovery. |
| `PI_AGY_HOME` | Dedicated directory for this extension's agy state. | `~/.pi/agent/cache/antigravity-acp` |
| `PI_AGY_QUOTA_DISPLAY` | Startup quota display mode (`used` or `remaining`), overriding `settings.json` for startup. Invalid values are ignored; `/agy-acp quota <mode>` overrides it for the active session. | `settings.json`, then `used` |

For example:

```sh
PI_AGY_COMMAND=/absolute/path/to/agy pi -e ./index.ts
```

### Stored data and authentication

The dedicated directory isolates the bridge agent from your normal agy tools and
plugins. It holds the extension's model cache (`catalog.json`) and
`settings.json` (quota display preference), shared by every Pi instance, and one
agy home per running instance in `processes/<pid>-<random>/` with that
instance's agy session data, log (`acp.log`), and authentication files.

Many Pi instances can share one `PI_AGY_HOME`, including subagents that inherit
it: each instance starts agy with its own home, so starting one never clears
another's sessions. An instance clears its own home's temporary session data and
old logs whenever agy starts. On shutdown it waits for agy to exit (at most a
few seconds) and removes its home; each agy launch also removes the homes of
instances whose process has ended (never one whose process still runs). Cleanup
is best-effort: a home whose files are still locked stays until a later launch.
Sessions rebuild from Pi's history. Liveness is checked by process id, so every
instance sharing a `PI_AGY_HOME` must run on the same host and in the same PID
namespace; do not share one across machines or containers.

Folders an earlier version left directly in `PI_AGY_HOME` (`agy`, `config`,
`workspace`, `acp.log*`) are no longer used by this version. Pi instances still
running the earlier version keep using them, so delete them only after every
such instance has exited or reloaded the new version. Until then, `/agy-acp`
may still read the old `acp.log` for the account email.

With file-backed authentication, the extension copies the existing OAuth token
from your normal agy directory and sets its permissions to `0600`. Do not commit
or share this directory. Authentication and token refresh remain agy's responsibility.

## Models and context

Loading the extension uses the cached catalog, or five fallback model families,
without starting agy. Model refresh or the first request updates available models
and reasoning levels from ACP. A forced refresh queries again; refreshes can be
cancelled. The selector exposes only the reasoning levels offered for each model.
Direct requests map `minimal` to `low` and `xhigh` or `max` to `high`; `off` uses
the runtime default.

The fallback families are:

- `gemini-4-argon`
- `gemini-3.8-flash`
- `claude-opus-5-5`
- `claude-sonnet-5-5`
- `gpt-oss-120b-medium`

These entries are defaults, not a guarantee of account access. Model context windows
start at `0` until learned dynamically from the server-issued `max_context_tokens`
metadata in the session database and cached per model in `catalog.json`. The history
replay budget is 160,000 bytes; older history can be omitted to fit, and
historical images become text placeholders. Pi's compaction summary is kept when
it fits in the budget on its own; the newest messages fill the rest, and a
summary larger than the budget is omitted like any other message.

## Usage and costs

Usage comes from the ACP session rather than per-step API headers. Parked `toolUse`
steps emit zero usage; statistics arrive on the final step when the full ACP turn
finishes (accumulated across any automatic `max_tokens` continuations). `max_context_tokens`
recorded in the session SQLite metadata supplies the model's context window, while
`usage_update` supplies live token occupancy.

The extension separates cumulative token consumption from final-call context
occupancy:

- `input`, `output`, `cacheRead`, and `cacheWrite` preserve unscaled cumulative
  turn totals from `session/prompt`, so Pi's session totals and flat pricing
  overrides reflect full multi-step consumption.
- `totalTokens` (which feeds Pi's context meter and auto-compaction threshold via
  `calculateContextTokens`) uses the final model call's live `usage_update.used`
  count when `agy` provides it. When `usage_update` is absent, it falls back to
  averaging the final `session/prompt` segment's prompt tokens across that
  segment's model calls plus final-segment output tokens; this fallback is an
  estimate rather than an exact per-step measurement.

The cumulative buckets are a contract: Pi's session totals and any usage report
built on them count every model call of a turn. Pi 1.5.x, however, also treats a
completed reply whose `input + cacheRead` exceeds the context window as a silent
overflow and compacts. A long tool loop passes that line while its real context
is a fraction of the window. So for this provider the extension cancels an
automatic `overflow` compaction that will not retry when all of these hold:

- the model's window is known;
- agy measured the reply's context (`usage_update.used`). When it did not,
  `totalTokens` is an estimate averaged over the turn's calls and cannot rule
  out a real overflow, so the compaction goes ahead;
- Pi's measure of the context (`preparation.tokensBefore`) is at most the window
  minus Pi's `reserveTokens`. Inside that reserve band Pi's threshold compaction
  would have fired, and the overflow path skips it, so the compaction goes
  ahead.

Provider overflow errors (Pi retries them), models whose window is unknown,
manual `/compact` and threshold compaction are unaffected. Pi shows a cancel as
a brief compaction that ends with "Auto-compaction cancelled", and records it as
an aborted compaction (`session_compact_failed`); it can recur once at the start
of the next prompt, when Pi checks the same reply again. Another extension that
logs compaction outcomes (for example a cached-compaction extension) may record
these cancels as aborted or fallback attempts; no summary is produced for them.

Default model prices are zero because pricing is unavailable. If you configure
Pi model pricing overrides, flat per-million rates price the cumulative turn
buckets accurately; tiered `inputTokensAbove` rules evaluate against cumulative
turn prompt tokens rather than per-call prompt sizes. These estimates are not
an invoice amount or a promise of free access.

The extension reads only session-scoped `max_context_tokens` metadata inside `PI_AGY_HOME`;
it never inspects your global `agy` databases or invokes or distributes binary patch
scripts.

## Compatibility limits

This version targets the `@earendil-works/*` Pi packages at version 1.5.x.
Host `peerDependencies` use `*` as required by Pi package conventions;
`devDependencies` pin a reproducible CI baseline (`1.5.2`), and CI validates
both that baseline (on Node.js 22.19.0 and 24) and the `1.5.x` host range
(`1.5.0` and latest `1.5`), which requires Node.js >= 22.19.0. Compatibility
with older `@mariozechner/*` interfaces is not claimed.

Pi's system prompt is sent as agy's system prompt (`systemPrompt.append` of
`session/new`). This is tested on agy 1.5.13 only. On agy 1.5.9, upstream
0.1.4–0.2.0 avoided that slot because the backend answered with false
`429 RESOURCE_EXHAUSTED` replies (#24). If that returns, a turn fails with a
429 error, or the first turn of a session hangs: `session/prompt` has no
deadline, so it waits until Pi cancels it. There is no automatic fallback; go
back to a release that sends the prompt in the opening message.

Sampling parameters, output limits, forced `toolChoice`, and provider-scoped
environment overrides are not mapped to ACP. See
[development checks](development.md#verification) for the scope of automated validation.
