[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB)
![dsh](https://img.shields.io/badge/dsh-profile--bundle-1F6FEB)

# dsh-web-search-brave

**Brave Search provider plugin for DeepSeek Harness (dsh) — a hardened fork that stops
`web_search` from hanging your session, and stops multi-query searches from drowning in
HTTP 429 rate limits.**

The upstream package `@deepseek-ai/dsh-web-search-brave` gives DeepSeek Harness a Brave
Search backend for its `ctx.web` capability seam. This fork keeps that drop-in package
name and API, and fixes two reliability problems that can hang or disable `web_search`
inside a real agent session.

> **Not affiliated with or endorsed by DeepSeek or the upstream author.** This is an
> independent fork published under the original MIT license. Do not publish it to npm
> under the `@deepseek-ai` scope — that scope belongs to the upstream project.

- **Keywords:** DeepSeek Harness, dsh, dsh plugin, Brave Search API, web search provider,
  `web_search` tool, HTTP 429 rate limit, request timeout, agent tool call hang

---

## The bug this fixes

If your dsh session ever **froze when the `web_search` tool was called** — spinner
forever, nothing in the transcript, sometimes needing a full restart — this is why.

`BraveSearchProvider.search()` in 0.1.1 armed **no timer of its own** and handed `fetch`
only the caller's `AbortSignal`. DeepSeek Harness enforces tool timeouts through
`@deepseek-ai/dsh-tool-call-timeout-policy`, which is explicitly *cooperative*: it awaits
the tool promise **without racing it**. So when a request never settles, no tool result is
ever recorded, the turn waits indefinitely, and the UI looks frozen.

Observed live, with a 60 s tool budget configured and never applied:

| Call | Result |
| --- | --- |
| `web_search`, 1 query | returned in **1.1 s** |
| `web_search`, 4 queries | **never returned — 8 m 29.7 s**, until the user interrupted it |

The second problem compounds it. One multi-query `web_search` call fans out as **N parallel
requests** (the fan-out lives in `dsh-tool-web`), while Brave rate-limits per second. On the
free tier that spends the whole budget on 429s:

| 4 concurrent queries, unspaced | Outcome |
| --- | --- |
| upstream 0.1.1 | **0 of 4 succeeded** (`WEB_PROVIDER_ERROR`, HTTP 429), in 731 ms |

## What this fork changes

Three configurable knobs, **all bounded by the same hard deadline** so nothing can hang:

| Setting | Default | What it does |
| --- | --- | --- |
| `searchTimeoutMs` | `15000` | Hard provider-level deadline. Fuses your `AbortSignal` with `AbortSignal.timeout()`. **This is the freeze fix.** Created *before* queueing, so queue wait counts against the budget. |
| `minRequestIntervalMs` | `1500` | Serializes the fan-out through a per-process queue, one request at a time, spaced. `1100` measured 3/4 successes; `1500` measured 4/4. |
| `maxRetries` | `2` | Bounded retries on HTTP 429, honouring `Retry-After` (capped at 3 s). Bounded by `searchTimeoutMs`, so retrying cannot reintroduce a hang. |

Deadline expiry is reported as a clear `WEB_PROVIDER_ERROR` timeout; caller cancellation is
still reported as `WEB_ABORTED`. Nothing else about the provider contract changed.

After the fix, on the same live API:

| | before | after |
| --- | --- | --- |
| stalled server, no caller signal | never settles | rejects in **4.0 s** |
| 4 concurrent queries | **0/4** | **4/4** in 5.5 s |
| 1 query | 903 ms | 843 ms |

## Install

```sh
dsh plugin --profile web add github:nedzen/dsh-web-search-brave
```

Or from a local checkout, which is how this fork is developed:

```sh
dsh plugin --profile web add file:$HOME/Sites/dsh-web-search-brave
```

Then pin the seam to it in your profile's `cordis.patch.yml`. A patch replaces the whole
config, so **restate every key the `web` row owns** — omitting `fetchProvider` silently
drops it and breaks `web_fetch`:

```yaml
- id: web
  config:
    searchProvider: brave-search
    fetchProvider: http          # do not omit

- id: web-search-brave
  name: "@deepseek-ai/dsh-web-search-brave"
  config:
    apiKeyEnv: BRAVE_SEARCH_API_KEY
    baseURL: https://api.search.brave.com/res/v1
    maxResults: 10
    searchType: web
    # searchTimeoutMs: 15000      # optional overrides
    # minRequestIntervalMs: 1500
    # maxRetries: 2
```

The API key resolves from the credentials service first, then the launching environment
(`.env` files are layered in automatically). Store it as `BRAVE_SEARCH_API_KEY`, or point
`apiKeyEnv` at whatever name you export.

## Verify it works

`test/freeze-regression.mjs` reproduces the freeze with a server that accepts the TCP
connection and then never responds. Cases **A** (stalled server, no caller signal) and
**C** (fan-out spacing) go **RED** on 0.1.1 and **GREEN** here.

```sh
cd ~/.dsh/profiles/web
set -a; . ~/.dsh/.env; set +a
node ~/Sites/dsh-web-search-brave/test/freeze-regression.mjs \
  ./node_modules/@deepseek-ai/dsh-web-search-brave/lib/index.js "0.1.3"
```

Node rather than Bun is deliberate: dsh runs this provider under Node's `fetch`, and the
abort/timeout semantics being asserted are undici's.

Self-check in a live session — the timing tells you which build is loaded:

| 4-query `web_search` | Build |
| --- | --- |
| returns in under 1 s, usually `HTTP 429` | old 0.1.1 |
| takes 4.5 s or more, normally succeeds | this fork |

## Tuning

- **Many parallel queries time out.** `searchTimeoutMs` also covers queue wait. If the model
  fires several `web_search` calls at once (e.g. `maxParallelToolCalls` above ~3 with 4
  queries each), the tail can exceed 15 s and fail fast rather than hang. Raise
  `searchTimeoutMs` to `30000`.
- **Paid Brave plan.** Set `minRequestIntervalMs: 0` and `maxRetries: 0` to trade robustness
  for speed.
- **Still rate-limited.** Raise `minRequestIntervalMs`, or run a multi-provider fallback
  chain instead of a single backend.

## Troubleshooting

**I edited the source and nothing changed.** A `file:` dependency is *copied* into the
profile by pnpm, and `pnpm install` reports "Already up to date" while keeping the stale
copy. Remove it and reinstall:

```sh
rm -rf ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-web-search-brave
dsh plugin --profile web install
```

**I reinstalled but the running session is unchanged.** Only *config* hot-reloads. Plugin
JavaScript is ESM-cached and `dsh-hmr` ships with no watch roots (`root: []`), so **restart
dsh** to load new provider code.

**`WEB_DUPLICATE_PROVIDER`.** Another provider already registered the `brave-search` id —
check for two rows declaring this bundle.

## Compatibility

This fork targets the **0.1.x** DeepSeek Harness line (`@deepseek-ai/dsh-*@^0.1.1-rc.2`
peers). Upstream's published **0.2.x** already added an equivalent `searchTimeoutMs`, so if
you are on dsh 0.2.x, prefer the official package; the fork exists for people who cannot
move the whole harness to 0.2.x yet.

## Related

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the upstream harness
- [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) — ecosystem index
- GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin) — more dsh plugins

## License

MIT, inherited from upstream. Original work © 2026 KaiChan; fork modifications © 2026
nedzen. See [LICENSE](./LICENSE).
