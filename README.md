# Pi Afterword

Save one durable lesson from a Pi conversation on quit or successful Pinote Done.
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
Existing notes stay in the same database; no migration is needed.

## Use

At interactive startup, `Afterwords: N` shows the saved-note count without adding
model context. `/pi-afterword` opens a read-only list, newest first. Arrows select,
Page Up/Down scroll, Enter shows details, and Escape returns or closes. Browsing
makes no model requests and does not inject notes into the conversation.

Generation requires **10 assistant turns on the active branch**, including
tool-call responses and compacted turns. Eligible interactive quit (including
handled SIGTERM/SIGHUP) and successful Pinote Done request one lesson of at most
30 whitespace-separated words from the current model, with minimal reasoning and
no tools. It prefers verified causes/fixes, surprising constraints or failed
approaches; otherwise it records an important decision and its rationale.

The request uses up to the last 64,000 conversation characters, less for small
context windows; images, thinking and system instructions are omitted. There is
one request with a 20-second deadline and no retries. Empty, incomplete or
oversized responses are rejected. Identical conversation text in the same session
is recorded once, including Done followed by quit or reload/resume.

Reload, session switching/forking, delegated/review children, short conversations
and noninteractive runs do not generate notes. Crashes, SIGKILL, power loss or
terminal failure may prevent saving. Provider and database failures do not block
on retries; synchronous filesystem calls cannot be preempted by JavaScript timers.
Requests may incur provider charges outside Pi's main-turn usage totals.

## Storage and privacy

Notes live in `<Pi agent directory>/afterword/afterword.db`, normally
`~/.pi/agent/afterword/afterword.db`, using Node's built-in SQLite. No additional
service or runtime dependency is required. The directory and database use
owner-only permissions. Stop Pi sessions before backing up or moving the database.

The database is **local and unencrypted**. Notes and metadata (session ID,
conversation hash, project directory, model, timestamp, trigger and optional task
ID) can contain sensitive project information despite the no-secrets instruction.
Generation sends conversation excerpts to your configured model provider.

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
