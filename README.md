# Pi Afterword

Save one durable lesson from a Pi conversation on `/new`, quit, or successful Pinote Done.
Browse saved notes across projects with **`/pi-afterword`**. Notes are local, not
automatically injected into future conversations.

[GitHub](https://github.com/kvidzibo/pi-afterword) ·
[Pi package gallery](https://pi.dev/packages)

## Install

Requires **Pi 1.5.0+** and **Node 22.19+**. Pinote is optional; its Done trigger
requires pi-note 0.35.0+.

Before the first npm release, install from GitHub after the package PR is merged:

```sh
pi install git:github.com/kvidzibo/pi-afterword
```

The npm package name is `@kvidzibo/pi-afterword`. Once published:

```sh
pi install npm:@kvidzibo/pi-afterword
```

Run `/reload` in existing sessions. If migrating from the standalone
`pi-afterword.ts`, remove its old `extensions` entry first: do not load both.
Existing notes stay in the same database; schema upgrades are automatic.

## Use

At interactive startup, `Afterwords: N` shows the saved-note count without adding
model context. `/pi-afterword` opens a read-only list, newest first. Arrows select,
Page Up/Down scroll, Enter shows details, and Escape returns or closes. Browsing
makes no model requests and does not inject notes into the conversation. Each note's
header shows its generating model and the session's thinking level; older notes
without a saved thinking level show `unknown`, and notes from before 0.11.0 show
the level of their separate generation request.

Generation requires **10 assistant turns on the active branch**, including
tool-call responses and compacted turns. Eligible interactive quit (including
handled SIGTERM/SIGHUP), `/new` (outgoing session), and successful Pinote Done ask
the session's own model what it learned: Pi's next request for the session (same
system prompt, tools, history, session ID and thinking level) plus one question.
Providers can therefore reuse the session's prompt cache. The question and answer
are never added to the session. The lesson aims for 25 words, never more than 30. It
prefers verified causes/fixes, surprising constraints or failed approaches;
otherwise it records an important decision and its rationale. Done during a running
agent turn is skipped (`agent busy`), and a turn that starts during generation
interrupts it: a request with the session's ID could disturb that turn.

When a request starts, Pi shows `Generating afterword…`. After SQLite commits a new
note, Pi prints `Afterword saved:` followed by the exact note. On `/new`, the
confirmation appears in the new session; on quit it prints to the terminal.
Skipped or already-saved conversations produce neither message.

The request carries the whole session context, including thinking and images
(unless Pi blocks images). Request-time changes Pi makes for other extensions are
not applied: `context` and provider-payload hooks (including any redaction), hidden
tool declarations, or a system prompt replaced for each run. They can also cost a
cache miss. A note over 30 words is never cut: a
separate small request with minimal reasoning shortens it, up to two more times,
sending only the rejected note. All requests share one 20-second deadline. Empty,
incomplete or still-oversized responses are rejected. Identical conversation text
in the same session is recorded once, including Done followed by `/new` or quit.

Reload, resuming or forking a session, delegated/review children, short conversations
and noninteractive runs do not generate notes. Crashes, SIGKILL, power loss or
terminal failure may prevent saving. Provider and database failures are not
retried; synchronous filesystem calls cannot be preempted by JavaScript timers.
Requests may incur provider charges outside Pi's main-turn usage totals.

### Diagnostics

A failed save names its category, such as `note too long`, `timed out`,
`model error` or `database error`. Each generation also appends a `pi-afterword`
custom entry to the session file: outcome, trigger, task ID, model, total duration,
per-request duration, stop reason, word count and token usage with Pi's cost
estimate (including cache reads and writes), plus the failure category and up
to 200 characters of the database error or of a provider error on the first
request. Shortening requests carry the note, so their provider errors are logged by
category only. Entries never contain note text and are not sent to the model.

```sh
jq -c 'select(.customType == "pi-afterword") | .data' <session.jsonl>
```

## Storage and privacy

Notes live in `<Pi agent directory>/afterword/afterword.db`, normally
`~/.pi/agent/afterword/afterword.db`, using Node's built-in SQLite. No additional
service or runtime dependency is required. The directory and database use
owner-only permissions. Stop Pi sessions before backing up or moving the database.

The database is **local and unencrypted**. Notes and metadata (session ID,
conversation hash, project directory, model, thinking level, timestamp, trigger
and optional task ID) can contain sensitive project information despite the no-secrets instruction.
Session-file diagnostics can contain provider or database error text.
Generation sends the session's full context to its model provider again, as a
normal turn would.

## Development

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run --ignore-scripts
pi -e ./index.ts
```

Tests use the pinned Pi dev dependencies, temporary storage and a fake model;
no globally installed Pi, credentials, live services or model calls are required.
CI runs on Node 22.19 and 24. For running UI checks, use Xvfb, a private D-Bus
session and temporary app data; check regular/fullscreen modes, narrow terminals,
scrolling, details/back, resizing and `/reload`.

## Publishing

Merges to `main` run the test matrix, then publish new versions publicly with npm
provenance using trusted publishing (OIDC). Already-published versions are skipped;
registry/auth failures stop publication. Bump `package.json`, `package-lock.json`
and `CHANGELOG.md` together. No tag or npm token secret is required.

One-time setup:

1. After review and merge, authenticate with npm, run `npm ci --ignore-scripts`
   and `npm publish --access public` once to create the package.
2. In the npm package's **Settings → Trusted publishing**, configure GitHub
   Actions: owner `kvidzibo`, repository `pi-afterword`, workflow `publish.yml`,
   no environment, allowing direct `npm publish`.
3. Merge a version bump to exercise the trust relationship within npm's two-day
   validation window. Subsequent new-version merges publish automatically.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
The `pi-package` keyword enables Pi gallery discovery after npm publication;
there is no separate Pi registry upload.
