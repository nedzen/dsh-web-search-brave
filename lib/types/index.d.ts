/**
 * Brave Search-backed web search provider for the DeepSeek Harness.
 * @module @deepseek-ai/dsh-web-search-brave
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { BraveSearchProvider, BRAVE_DEFAULT_BASE_URL, BRAVE_DEFAULT_MAX_RESULTS, BRAVE_PROVIDER_ID } from './provider.ts';
export type { BraveSearchProviderOptions } from './types.ts';

/** Plugin name used by loader diagnostics. */
export declare const name = "web-search-brave";

/** The web seam this provider registers into. */
export declare const inject: string[];

/** Plugin config. */
export interface Config {
  /** Literal Brave API key; wins over the credential reference. */
  apiKey?: string;
  /** Credential reference for Brave API key; defaults to BRAVE_SEARCH_API_KEY. */
  apiKeyEnv?: string;
  /** API endpoint base; defaults to https://api.search.brave.com/res/v1. */
  baseURL?: string;
  /** Maximum results per search. Defaults to 10. */
  maxResults?: number;
  /** Search type: web, news, or videos. Defaults to web. */
  searchType?: 'web' | 'news' | 'videos';
  /** Hard per-request timeout in ms. Defaults to 15000. */
  searchTimeoutMs?: number;
  /** Minimum spacing between requests in ms. Defaults to 1500; 0 disables. */
  minRequestIntervalMs?: number;
  /** Bounded retries on HTTP 429. Defaults to 2; 0 disables. */
  maxRetries?: number;
}

export declare const Config: z<Config>;

/** Settings namespace. */
export declare const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;

/** Register the Brave Search provider with ctx.web. */
export declare function apply(ctx: Context, config: Config): void;
