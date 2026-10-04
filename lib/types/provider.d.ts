/**
 * Brave Search provider implementation.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { BraveSearchProviderOptions } from './types.ts';

/** Stable id this provider registers under. */
export declare const BRAVE_PROVIDER_ID = "brave-search";

/** Default API endpoint. */
export declare const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";

/** Default maximum results. */
export declare const BRAVE_DEFAULT_MAX_RESULTS = 10;

/**
 * Build a Brave Search provider instance.
 */
export declare class BraveSearchProvider implements WebSearchProvider {
  readonly id: string;
  
  /**
   * @param resolveOptions - options resolver thunk
   */
  constructor(resolveOptions: () => BraveSearchProviderOptions);
  
  /** Check if provider is available (has API key). */
  available(): boolean;
  
  /** Run a search query. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
