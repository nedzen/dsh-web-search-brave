// Freeze regression suite for the Brave provider.
//
// Reproduces the reported failure: a server that ACCEPTS the TCP connection and
// then never sends headers. Before the 0.1.3 hardening, `search()` armed no
// timer of its own, so with no external signal the promise never settled — the
// tool call recorded no result and the turn hung (looks like a frozen UI).
//
// Run it from a directory where this package's @deepseek-ai/* imports resolve
// (an installed dsh profile works well), passing the module path explicitly:
//
//   cd ~/.dsh/profiles/web
//   set -a; . ~/.dsh/.env; set +a
//   node ~/Sites/dsh-web-search-brave/test/freeze-regression.mjs \
//     ./node_modules/@deepseek-ai/dsh-web-search-brave/lib/index.js "0.1.3"
//
// Node (not Bun) is deliberate: DSH runs this provider under Node's fetch, and
// the abort/TIMEOUT semantics asserted here are undici's.
//
// Cases A and C are the regression gates and go RED on 0.1.1.
// Cases D/E need BRAVE_SEARCH_API_KEY and are skipped without it.

import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , modulePath, label] = process.argv;
if (!modulePath) throw new Error('usage: freeze-regression.mjs <module-path> <label>');
// Resolve against the CALLER's cwd: a relative specifier would otherwise resolve
// against this file's directory, which is never where the installed copy lives.
const { BraveSearchProvider } = await import(pathToFileURL(path.resolve(modulePath)).href);

const key = process.env.BRAVE_SEARCH_API_KEY;
const results = [];
const record = (name, verdict, detail) => {
  results.push({ name, verdict, detail });
  console.log(`  [${verdict}] ${name}: ${detail}`);
};

const settle = (promise, ms) =>
  Promise.race([
    promise.then((v) => ({ kind: 'ok', v }), (e) => ({ kind: 'err', e })),
    new Promise((r) => setTimeout(() => r({ kind: 'hang' }), ms)),
  ]);

const makeProvider = (opts) =>
  new BraveSearchProvider(() => ({
    apiKeyEnv: 'BRAVE_SEARCH_API_KEY',
    maxResults: 10,
    searchType: 'web',
    apiKey: key,
    // The provider reads options.baseURL directly; the default normally comes
    // from resolveOptions() in the plugin, so the harness supplies it.
    baseURL: 'https://api.search.brave.com/res/v1',
    maxRetries: 2,
    ...opts,
  }));

console.log(`\n=== ${label} :: ${modulePath}`);

// ── Case A: stalled endpoint, NO caller signal ─────────────────────────────
const sockets = new Set();
const stall = net.createServer((s) => {
  sockets.add(s);
  s.on('error', () => {});
  // Accept and deliberately never write a response.
});
await new Promise((r) => stall.listen(0, '127.0.0.1', r));
const stallURL = `http://127.0.0.1:${stall.address().port}/res/v1`;

{
  const t = Date.now();
  const out = await settle(
    makeProvider({ baseURL: stallURL, searchTimeoutMs: 4000, minRequestIntervalMs: 0 }).search(
      { query: 'stall', maxResults: 10 },
      undefined, // <- the live failure mode: no external signal ever fires
    ),
    15000,
  );
  const ms = Date.now() - t;
  if (out.kind === 'hang') {
    record('A. stalled endpoint, no caller signal', 'RED', `still unresolved after ${ms}ms -> this is the UI freeze`);
  } else if (out.kind === 'err') {
    record('A. stalled endpoint, no caller signal', 'GREEN', `rejected in ${ms}ms · code=${out.e.code}`);
  } else {
    record('A. stalled endpoint, no caller signal', 'FAIL', `unexpectedly resolved in ${ms}ms`);
  }
}
for (const s of sockets) s.destroy();
await new Promise((r) => stall.close(r));

// ── Case B: caller cancellation still reports WEB_ABORTED ──────────────────
{
  const slow = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error('user cancel')), 800);
  const t = Date.now();
  const out = await settle(
    makeProvider({ baseURL: `http://127.0.0.1:${slow.address().port}/res/v1`, searchTimeoutMs: 30000, minRequestIntervalMs: 0 }).search(
      { query: 'cancel', maxResults: 10 },
      ctrl.signal,
    ),
    15000,
  );
  const code = out.kind === 'err' ? out.e.code : out.kind;
  record('B. caller cancellation', code === 'WEB_ABORTED' ? 'GREEN' : 'RED', `${code} in ${Date.now() - t}ms`);
  for (const s of sockets) s.destroy();
  await new Promise((r) => slow.close(r));
}

// ── Case C: concurrent fan-out must be spaced ──────────────────────────────
{
  const arrivals = [];
  const fast = http.createServer((req, res) => {
    arrivals.push(Date.now());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ web: { results: [{ title: 't', url: `https://e/${arrivals.length}`, description: 'd' }] } }));
  });
  await new Promise((r) => fast.listen(0, '127.0.0.1', r));
  const p = makeProvider({ baseURL: `http://127.0.0.1:${fast.address().port}/res/v1`, searchTimeoutMs: 15000, minRequestIntervalMs: 300 });
  const outs = await Promise.all(
    [0, 1, 2, 3].map((i) => settle(p.search({ query: `q${i}`, maxResults: 10 }, undefined), 20000)),
  );
  const ok = outs.every((o) => o.kind === 'ok');
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  const minGap = gaps.length > 0 ? Math.min(...gaps) : Infinity;
  record(
    'C. 4 concurrent requests spaced',
    ok && minGap >= 250 ? 'GREEN' : 'RED',
    `minGap=${Number.isFinite(minGap) ? minGap + 'ms' : 'n/a'} arrivals=${arrivals.length} allOk=${ok}`,
  );
  await new Promise((r) => fast.close(r));
}

// ── Case D: real Brave, 1 query ────────────────────────────────────────────
if (key) {
  const t = Date.now();
  const out = await settle(makeProvider({ minRequestIntervalMs: 0 }).search({ query: 'deepseek harness', maxResults: 10 }, undefined), 20000);
  record(
    'D. real Brave, single query',
    out.kind === 'ok' && out.v.sources.length > 0 ? 'GREEN' : 'RED',
    out.kind === 'ok' ? `${out.v.sources.length} sources in ${Date.now() - t}ms` : `${out.kind} ${out.e?.code ?? ''} in ${Date.now() - t}ms`,
  );

  // ── Case E: real Brave, 4 concurrent (the exact live failure) ────────────
  const p = makeProvider({ minRequestIntervalMs: 1500 });
  const t0 = Date.now();
  const outs = await Promise.all(
    ['a', 'b', 'c', 'd'].map((q) => settle(p.search({ query: `deepseek harness ${q}`, maxResults: 10 }, undefined), 30000)),
  );
  const okCount = outs.filter((o) => o.kind === 'ok').length;
  const codes = outs.filter((o) => o.kind === 'err').map((o) => o.e.code);
  record(
    'E. real Brave, 4 concurrent with spacing',
    okCount === 4 ? 'GREEN' : 'RED',
    `${okCount}/4 ok in ${Date.now() - t0}ms codes=${JSON.stringify(codes)}`,
  );
} else {
  record('D/E. real Brave', 'SKIP', 'BRAVE_SEARCH_API_KEY not set');
}

const reds = results.filter((r) => r.verdict === 'RED').length;
console.log(`  ---- ${label}: ${reds === 0 ? 'ALL GREEN' : reds + ' RED'}`);
process.exit(0);
