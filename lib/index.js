import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

//#region lib/types/provider.js
/**
 * Brave Search provider implementation.
 * Calls Brave's REST API directly and maps results to the WebSearchResult shape.
 * Credentials mirror the DeepSeek provider: a literal `apiKey` wins, otherwise a
 * `resolveApiKey` thunk goes credentials service first, launch environment second.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */

/** Stable id this provider registers under. */
const BRAVE_PROVIDER_ID = "brave-search";

/** Default API endpoint. */
const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";

/** Default maximum results. */
const BRAVE_DEFAULT_MAX_RESULTS = 10;

/** Default search type. */
const BRAVE_DEFAULT_SEARCH_TYPE = "web";

/** Hard per-request deadline used when the config supplies none. */
const BRAVE_DEFAULT_SEARCH_TIMEOUT_MS = 15000;

/**
 * Brave rate-limits per second, but `dsh-tool-web` fans one multi-query
 * `web_search` call out as N parallel requests — which the free tier answers
 * with HTTP 429, or by stalling. Spacing requests turns that storm into a
 * queue. 1100ms measured 3/4 successes against the live API; 1500ms measured
 * 4/4, so the default carries headroom above the nominal 1 req/s. Set 0 to
 * serialize nothing.
 */
const BRAVE_DEFAULT_MIN_REQUEST_INTERVAL_MS = 1500;

/**
 * Bounded retries for HTTP 429. Spacing alone still collides occasionally
 * because Brave's limiter is a sliding window. Every retry re-queues through
 * the same rate-limit slot and sleeps on the caller's deadline signal, so the
 * whole loop stays inside `searchTimeoutMs` and cannot reintroduce a hang.
 */
const BRAVE_DEFAULT_MAX_RETRIES = 2;

/** Ceiling for a retry delay, even when Brave sends a longer Retry-After. */
const BRAVE_MAX_RETRY_DELAY_MS = 3000;

/** True for the DOMException shapes undici raises on abort and on deadline expiry. */
function isAbortError(error) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** True when the abort came from our own deadline rather than the caller. */
function isTimeoutReason(reason) {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

/**
 * Fuse the caller's signal with a hard provider-level deadline.
 *
 * This is the fix for the freeze: without it the provider leans entirely on the
 * caller's cooperative signal. `@deepseek-ai/dsh-tool-call-timeout-policy`
 * awaits the tool promise WITHOUT racing it, so a request that never settles
 * produces no tool result at all and the turn hangs indefinitely.
 */
function withTimeout(signal, timeoutMs) {
  if (timeoutMs === void 0 || timeoutMs <= 0) return signal;
  const sources = [AbortSignal.timeout(timeoutMs)];
  if (signal !== void 0) sources.unshift(signal);
  return AbortSignal.any(sources);
}

/** Abortable sleep: rejects as soon as the signal fires instead of running to term. */
function sleep(ms, signal) {
  if (signal?.aborted === true) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError(signal));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** Map an abort reason onto the matching WebError. */
function abortError(signal) {
  const reason = signal?.reason;
  if (isTimeoutReason(reason)) {
    return new WebError(`Brave Search timed out: ${String(reason?.message ?? reason)}`, "WEB_PROVIDER_ERROR", { cause: reason });
  }
  return new WebError("Brave search aborted", "WEB_ABORTED", { cause: reason });
}

/**
 * Serialize requests through a module-level slot, enforcing a minimum gap
 * between them. The returned promise settles per waiting request; the chain
 * itself is kept alive so one rejection cannot poison the queue.
 */
let requestChain = Promise.resolve();
let lastRequestAt = 0;
function reserveSlot(minIntervalMs, signal) {
  const wait = async () => {
    if (signal?.aborted === true) throw abortError(signal);
    const delay = (minIntervalMs ?? 0) - (Date.now() - lastRequestAt);
    if (delay > 0) await sleep(delay, signal);
    lastRequestAt = Date.now();
  };
  const slot = requestChain.then(wait, wait);
  requestChain = slot.then(() => void 0, () => void 0);
  return slot;
}

/**
 * Map a Brave Search API response to a normalized WebSearchResult.
 * @param response - the parsed Brave API response body.
 * @param maxResults - maximum number of results to return.
 * @returns the normalized search result.
 */
function mapBraveResponse(response, maxResults) {
  const sources = [];

  // Extract web results
  if (response.web && response.web.results) {
    for (const result of response.web.results) {
      sources.push({
        url: result.final_url || result.url,
        title: result.title,
        snippet: result.description || result.meta_description,
        publishedAt: result.page_age || result.date
      });
    }
  }

  // Extract news results if present
  if (response.news && response.news.results) {
    for (const result of response.news.results) {
      sources.push({
        url: result.url,
        title: result.title,
        snippet: result.description || result.body,
        publishedAt: result.age || result.date
      });
    }
  }

  // Extract video results if present
  if (response.videos && response.videos.results) {
    for (const result of response.videos.results) {
      sources.push({
        url: result.url,
        title: result.title,
        snippet: result.description,
        publishedAt: result.date
      });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const uniqueSources = [];
  for (const source of sources) {
    if (!seen.has(source.url)) {
      seen.add(source.url);
      uniqueSources.push(source);
    }
  }

  // Truncate to maxResults
  const truncated = uniqueSources.length > maxResults;
  const truncatedSources = uniqueSources.slice(0, maxResults);

  return {
    sources: truncatedSources,
    truncated
  };
}

/**
 * The Brave-backed search provider. Mirrors the DeepSeek provider's contract:
 * options resolve as a thunk so one search never mixes two settings sections,
 * and the credential resolves per operation without being retained.
 */
class BraveSearchProvider {
  /** Stable id this provider registers under. */
  id = BRAVE_PROVIDER_ID;

  /**
   * @param resolveOptions - options for the NEXT operation, snapshotted once
   * at each operation's entry so one search never mixes two sections.
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }

  /** Check if provider is available (has a credential path and a valid endpoint). */
  available() {
    const options = this.resolveOptions();
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0) && URL.canParse(options.baseURL) && Number.isInteger(options.maxResults) && options.maxResults > 0;
  }

  /**
   * Run a search query.
   * @param request - the search request
   * @param signal - optional abort signal
   * @returns the search result
   */
  async search(request, signal) {
    const options = this.resolveOptions();
    const apiKey = options.apiKey !== void 0 && options.apiKey.length > 0 ? options.apiKey : await options.resolveApiKey?.();
    if (apiKey === void 0 || apiKey.length === 0) {
      throw new WebError(`Brave Search has no API key for "${options.apiKeyEnv ?? "BRAVE_SEARCH_API_KEY"}"; store it through the credentials service (the web Models page writes it), export it in the launching environment, or set a literal "apiKey" in the web-search-brave config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
    }

    const url = new URL(`${options.baseURL}/${options.searchType}/search`);
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(Math.min(request.maxResults ?? options.maxResults, 50)));

    // Fuse the caller's cancellation with a hard provider-level deadline BEFORE
    // queueing, so time spent waiting for a rate-limit slot also counts against
    // the budget. Without this deadline a request that never settles produces no
    // tool result at all and the turn hangs.
    const effectiveSignal = withTimeout(signal, options.searchTimeoutMs);
    const timedOut = () => isTimeoutReason(effectiveSignal?.reason);

    let response;
    for (let attempt = 0; ; attempt++) {
      // One request at a time, spaced: a multi-query web_search fans out N of them.
      await reserveSlot(options.minRequestIntervalMs, effectiveSignal);
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          redirect: "error",
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey
          },
          ...effectiveSignal !== void 0 ? { signal: effectiveSignal } : {}
        });
      } catch (error) {
        // Caller cancellation is reported as such; our own deadline as a timeout.
        if (signal?.aborted === true) throw abortError({ reason: signal.reason });
        if (timedOut() || (error instanceof DOMException && error.name === "TimeoutError")) {
          throw new WebError(`Brave Search timed out after ${options.searchTimeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
        }
        if (isAbortError(error)) throw abortError(effectiveSignal);
        throw new WebError(`Brave Search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
      }
      if (response.status !== 429 || attempt >= (options.maxRetries ?? 0)) break;
      // Rate limited: wait out the window, honouring Retry-After when present,
      // then re-queue. Bounded by maxRetries and by the shared deadline.
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, BRAVE_MAX_RETRY_DELAY_MS)
        : Math.max(1000, Math.min(options.minRequestIntervalMs ?? 0, BRAVE_MAX_RETRY_DELAY_MS));
      await sleep(delay, effectiveSignal);
    }

    if (!response.ok) {
      let message = `Brave Search API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        const detail = parsed.error?.detail ?? parsed.error?.title ?? parsed.message;
        if (detail !== void 0 && detail.length > 0) message += `: ${detail}`;
      } catch {}
      throw new WebError(message, "WEB_PROVIDER_ERROR");
    }

    try {
      return mapBraveResponse(await response.json(), options.maxResults);
    } catch (error) {
      if (signal?.aborted === true) throw abortError({ reason: signal.reason });
      if (timedOut()) throw new WebError(`Brave Search timed out after ${options.searchTimeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
      throw new WebError(`Brave Search returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }
}
//#endregion

//#region lib/index.js
/** Plugin name used by loader diagnostics. */
const name = "web-search-brave";

/** The web seam this provider registers into. */
const inject = ["web"];

/** Settings namespace carrying this provider's config (auto-wired by the loader). */
const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = "web-search-brave";

/** Plugin config schema. */
const Config = z.object({
  /** Literal Brave API key; wins over the credential reference. */
  apiKey: z.string().role("secret").volatile(),
  /** Credential reference for the Brave API key; defaults to BRAVE_SEARCH_API_KEY. */
  apiKeyEnv: z.string().role("credential-ref").default("BRAVE_SEARCH_API_KEY").volatile(),
  /** API endpoint base; defaults to https://api.search.brave.com/res/v1. */
  baseURL: z.string().default(BRAVE_DEFAULT_BASE_URL).volatile(),
  /** Maximum results per search (1-50). Defaults to 10. */
  maxResults: z.number().step(1).min(1).max(50).default(BRAVE_DEFAULT_MAX_RESULTS).volatile(),
  /** Search type: web, news, or videos. Defaults to web. */
  searchType: z.union(["web", "news", "videos"]).default("web").volatile(),
  /**
   * Hard per-request timeout in ms (default 15000). This is the backstop that
   * keeps a stalled or rate-limited Brave response from hanging the tool call:
   * the caller's cooperative tool-call budget cannot cut a request that never
   * settles, because the timeout policy awaits the tool promise without racing.
   */
  searchTimeoutMs: z.number().step(1).min(1).default(BRAVE_DEFAULT_SEARCH_TIMEOUT_MS).volatile(),
  /**
   * Minimum spacing between requests in ms (default 1500). Brave rate-limits per
   * second while one multi-query `web_search` fans out N parallel requests, so
   * without spacing the free tier answers most of them with 429. Set 0 to
   * serialize nothing.
   */
  minRequestIntervalMs: z.number().step(1).min(0).default(BRAVE_DEFAULT_MIN_REQUEST_INTERVAL_MS).volatile(),
  /**
   * Bounded retries when Brave answers HTTP 429 (default 2; 0 disables).
   * Bounded by `searchTimeoutMs`, so retrying cannot hang the call.
   */
  maxRetries: z.number().step(1).min(0).default(BRAVE_DEFAULT_MAX_RETRIES).volatile()
});

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv);
  const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
  return {
    ...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get("credentials");
      if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
      return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? BRAVE_DEFAULT_BASE_URL,
    maxResults: config.maxResults ?? BRAVE_DEFAULT_MAX_RESULTS,
    searchType: config.searchType ?? BRAVE_DEFAULT_SEARCH_TYPE,
    searchTimeoutMs: config.searchTimeoutMs ?? BRAVE_DEFAULT_SEARCH_TIMEOUT_MS,
    minRequestIntervalMs: config.minRequestIntervalMs ?? BRAVE_DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxRetries: config.maxRetries ?? BRAVE_DEFAULT_MAX_RETRIES
  };
}

/**
 * Register the Brave Search provider with ctx.web.
 * @param ctx - cordis context
 * @param config - plugin config
 */
function apply(ctx, config) {
  ctx.web.registerSearchProvider(new BraveSearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    maxResults: config.maxResults.get(),
    searchType: config.searchType.get(),
    searchTimeoutMs: config.searchTimeoutMs.get(),
    minRequestIntervalMs: config.minRequestIntervalMs.get(),
    maxRetries: config.maxRetries.get()
  })));
}
//#endregion

export { BraveSearchProvider, BRAVE_DEFAULT_BASE_URL, BRAVE_DEFAULT_MAX_RESULTS, BRAVE_PROVIDER_ID, BRAVE_DEFAULT_SEARCH_TYPE, Config, WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, apply, inject, name, resolveOptions };
