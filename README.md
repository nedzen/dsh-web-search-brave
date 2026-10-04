# dsh-web-search-brave (local fork)

A local fork of the DeepSeek Harness package `@deepseek-ai/dsh-web-search-brave`
— a Brave Search-backed provider for the `ctx.web` capability seam.

Upstream lives in the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
monorepo at `packages/web/web-search-brave`. This fork is **not affiliated with or
endorsed by DeepSeek**, and must not be published to npm under the `@deepseek-ai`
scope.

It exists for one reason: the shipped 0.1.1 could **hang a whole turn**.

## The bug

`BraveSearchProvider.search()` armed no timer of its own and handed `fetch` only the
caller's signal. `@deepseek-ai/dsh-tool-call-timeout-policy` awaits the tool promise
*without racing it*, so a request that never settles records no tool result at all,
the turn hangs indefinitely, and the UI looks frozen. Observed live: a 4-query
`web_search` call sat unresolved for **8m29.7s** until the user interrupted it.

Secondary cause: one multi-query `web_search` fans out as N parallel requests, and
Brave rate-limits per second — so unspaced fan-out spends the budget on HTTP 429.

## The fix (0.1.3)

Three configurable knobs, all bounded by the same hard deadline:

| Knob | Default | Purpose |
| --- | --- | --- |
| `searchTimeoutMs` | 15000 | Hard provider-level deadline. The actual freeze fix. |
| `minRequestIntervalMs` | 1500 | Serializes the fan-out through a per-process queue. |
| `maxRetries` | 2 | Bounded retries on HTTP 429, honouring `Retry-After`. |

## Regression suite

`test/freeze-regression.mjs` reproduces the freeze with a server that accepts the TCP
connection and never responds. Cases A and C go **RED** on 0.1.1 and **GREEN** on 0.1.3.

Run it from a directory where this package's `@deepseek-ai/*` imports resolve — an
installed dsh profile works well:

```sh
cd ~/.dsh/profiles/web
set -a; . ~/.dsh/.env; set +a
node ~/Sites/dsh-web-search-brave/test/freeze-regression.mjs \
  ./node_modules/@deepseek-ai/dsh-web-search-brave/lib/index.js "0.1.3"
```

Node rather than Bun is deliberate: DSH runs this provider under Node's fetch, and the
abort/timeout semantics asserted here are undici's.

## Note on `file:` dependencies

dsh profiles install this package as a `file:` dependency, which pnpm copies. Editing
the source here has **no effect** on an installed profile until the copy is replaced —
`pnpm install` reports "Already up to date" and keeps the stale copy. Remove the
installed package and reinstall:

```sh
rm -rf ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-web-search-brave
dsh plugin --profile web install
```

Plugin **JavaScript** changes also require a dsh restart; only config hot-reloads.

## License

MIT, inherited from upstream.
