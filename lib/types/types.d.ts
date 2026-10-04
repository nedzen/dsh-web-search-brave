/**
 * Brave Search API response types.
 * @module @deepseek-ai/dsh-web-search-brave/types
 */

/** One search result from Brave API. */
export interface BraveSearchResult {
  title: string;
  url: string;
  description?: string;
  date?: string;
  final_url?: string;
  meta_url?: {
    url: string;
    base: string;
    host: string;
    path: string[];
    domain: string;
    tld: string;
    protocol: string;
    port?: string;
  };
  meta_description?: string;
  page_age?: string;
}

/** Brave Search API response. */
export interface BraveSearchResponse {
  type: string;
  query: {
    original: string;
    show_strict_warning: boolean;
    is_navigational: boolean;
    is_news_breaking: boolean;
    spellcheck_off: boolean;
    country?: string;
    bad_results: boolean;
    should_fallback: boolean;
  };
  mixed?: {
    type: string;
    main: Array<{
      type: string;
      index?: number;
      all?: boolean;
    }>;
  };
  web?: {
    type: string;
    results: BraveSearchResult[];
  };
  news?: {
    type: string;
    results: Array<{
      title: string;
      url: string;
      description?: string;
      date?: string;
      body?: string;
      page_age?: string;
      image?: {
        src: string;
        original: string;
      };
      age?: string;
      topic?: string;
      subtype?: string;
      provider?: {
        name: string;
        domain: string;
        icon_url?: string;
      };
      entity?: string;
    }>;
  };
  videos?: {
    type: string;
    results: Array<{
      title: string;
      url: string;
      description?: string;
      date?: string;
      publisher?: string;
      thumbnail?: string;
    }>;
  };
}

/** Resolved provider options. */
export interface BraveSearchProviderOptions {
  /** Brave Search API key. */
  apiKey: string;
  /** API endpoint base. */
  baseURL: string;
  /** Maximum results per search. */
  maxResults: number;
  /** Search type: 'web', 'news', or 'videos'. */
  searchType?: 'web' | 'news' | 'videos';
  /** Credential reference this provider resolves when no literal key is set. */
  apiKeyEnv?: unknown;
  /** Hard per-request deadline in ms; guards against a request that never settles. */
  searchTimeoutMs?: number;
  /** Minimum spacing between requests in ms; 0 disables serialization. */
  minRequestIntervalMs?: number;
}
