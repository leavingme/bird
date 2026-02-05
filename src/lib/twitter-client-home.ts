import type { AbstractConstructor, Mixin, TwitterClientBase } from './twitter-client-base.js';
import { TWITTER_API_BASE } from './twitter-client-constants.js';
import { buildExploreFeatures, buildHomeTimelineFeatures } from './twitter-client-features.js';
import type { GraphqlTweetResult, SearchResult, TweetData } from './twitter-client-types.js';
import { extractCursorFromInstructions, parseTweetsFromInstructions } from './twitter-client-utils.js';

const QUERY_UNSPECIFIED_REGEX = /query:\s*unspecified/i;

function isQueryIdMismatch(errors: Array<{ message?: string }>): boolean {
  return errors.some((error) => QUERY_UNSPECIFIED_REGEX.test(error.message ?? ''));
}

// Timeline IDs for GenericTimelineById fallback (same format as Explore tabs)
const HOME_TIMELINE_IDS = {
  forYou: 'VGltZWxpbmU6DAC2CwABAAAAB2Zvcl95b3UAAA==',
  following: 'VGltZWxpbmU6DAC2CwABAAAACGZvbGxvd2luZwAAAA==',
} as const;

/** Options for home timeline fetch methods */
export interface HomeTimelineFetchOptions {
  /** Include raw GraphQL response in `_raw` field */
  includeRaw?: boolean;
}

export interface TwitterClientHomeMethods {
  getHomeTimeline(count?: number, options?: HomeTimelineFetchOptions): Promise<SearchResult>;
  getHomeLatestTimeline(count?: number, options?: HomeTimelineFetchOptions): Promise<SearchResult>;
}

export function withHome<TBase extends AbstractConstructor<TwitterClientBase>>(
  Base: TBase,
): Mixin<TBase, TwitterClientHomeMethods> {
  abstract class TwitterClientHome extends Base {
    // biome-ignore lint/complexity/noUselessConstructor lint/suspicious/noExplicitAny: TS mixin constructor requirement.
    constructor(...args: any[]) {
      super(...args);
    }

    private async getHomeTimelineQueryIds(): Promise<string[]> {
      const primary = await this.getQueryId('HomeTimeline');
      return Array.from(new Set([primary, 'edseUwk9sP5Phz__9TIRnA']));
    }

    private async getHomeLatestTimelineQueryIds(): Promise<string[]> {
      const primary = await this.getQueryId('HomeLatestTimeline');
      return Array.from(new Set([primary, 'iOEZpOdfekFsxSlPQCQtPg']));
    }

    /**
     * Get the authenticated user's "For You" home timeline
     */
    async getHomeTimeline(count = 20, options: HomeTimelineFetchOptions = {}): Promise<SearchResult> {
      return this.fetchHomeTimeline('HomeTimeline', count, options);
    }

    /**
     * Get the authenticated user's "Following" (latest/chronological) home timeline
     */
    async getHomeLatestTimeline(count = 20, options: HomeTimelineFetchOptions = {}): Promise<SearchResult> {
      return this.fetchHomeTimeline('HomeLatestTimeline', count, options);
    }

    /**
     * Fallback method using GenericTimelineById endpoint (same approach as news command)
     */
    private async fetchHomeTimelineViaGeneric(
      operation: 'HomeTimeline' | 'HomeLatestTimeline',
      count: number,
      options: HomeTimelineFetchOptions,
    ): Promise<SearchResult> {
      const { includeRaw = false } = options;
      const debug = process.env.BIRD_DEBUG === '1';
      const timelineId = operation === 'HomeTimeline' ? HOME_TIMELINE_IDS.forYou : HOME_TIMELINE_IDS.following;

      if (debug) {
        console.error(`[fetchHomeTimelineViaGeneric] Using GenericTimelineById fallback for ${operation}`);
      }

      try {
        const queryId = await this.getQueryId('GenericTimelineById');
        const features = buildExploreFeatures();

        const variables = {
          timelineId: timelineId,
          count: count,
          includePromotedContent: false,
        };

        const params = new URLSearchParams({
          variables: JSON.stringify(variables),
          features: JSON.stringify(features),
        });

        const url = `${TWITTER_API_BASE}/${queryId}/GenericTimelineById?${params.toString()}`;

        const response = await this.fetchWithTimeout(url, {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!response.ok) {
          const text = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
        }

        const data = (await response.json()) as {
          data?: {
            timeline?: {
              timeline?: {
                instructions?: Array<{
                  entries?: Array<{
                    content?: {
                      itemContent?: {
                        tweet_results?: {
                          result?: GraphqlTweetResult;
                        };
                      };
                    };
                  }>;
                }>;
              };
            };
          };
          errors?: Array<{ message: string }>;
        };

        if (data.errors && data.errors.length > 0) {
          return { success: false, error: data.errors.map((e) => e.message).join(', ') };
        }

        const instructions = data.data?.timeline?.timeline?.instructions;
        const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: this.quoteDepth, includeRaw });

        if (debug) {
          console.error(`[fetchHomeTimelineViaGeneric] Found ${tweets.length} tweets via GenericTimelineById`);
        }

        return { success: true, tweets: tweets.slice(0, count) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    private async fetchHomeTimeline(
      operation: 'HomeTimeline' | 'HomeLatestTimeline',
      count: number,
      options: HomeTimelineFetchOptions,
    ): Promise<SearchResult> {
      const { includeRaw = false } = options;
      const features = buildHomeTimelineFeatures();
      const pageSize = 20;
      const seen = new Set<string>();
      const tweets: TweetData[] = [];
      let cursor: string | undefined;

      const fetchPage = async (pageCount: number, pageCursor?: string) => {
        let lastError: string | undefined;
        let had404 = false;
        let hadQueryUnspecified = false;
        const queryIds =
          operation === 'HomeTimeline'
            ? await this.getHomeTimelineQueryIds()
            : await this.getHomeLatestTimelineQueryIds();

        for (const queryId of queryIds) {
          const variables = {
            count: pageCount,
            includePromotedContent: true,
            latestControlAvailable: true,
            requestContext: 'launch',
            withCommunity: true,
            ...(pageCursor ? { cursor: pageCursor } : {}),
          };

          const params = new URLSearchParams({
            variables: JSON.stringify(variables),
            features: JSON.stringify(features),
          });

          const url = `${TWITTER_API_BASE}/${queryId}/${operation}?${params.toString()}`;

          try {
            const response = await this.fetchWithTimeout(url, {
              method: 'GET',
              headers: this.getHeaders(),
            });

            if (response.status === 404) {
              had404 = true;
              lastError = `HTTP ${response.status}`;
              continue;
            }

            if (!response.ok) {
              const text = await response.text();
              return { success: false as const, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, had404, hadQueryUnspecified };
            }

            const data = (await response.json()) as {
              data?: {
                home?: {
                  home_timeline_urt?: {
                    instructions?: Array<{
                      entries?: Array<{
                        content?: {
                          itemContent?: {
                            tweet_results?: {
                              result?: GraphqlTweetResult;
                            };
                          };
                        };
                      }>;
                    }>;
                  };
                };
              };
              errors?: Array<{ message: string }>;
            };

            if (data.errors && data.errors.length > 0) {
              const errorMessage = data.errors.map((e) => e.message).join(', ');
              const isQueryMismatch = isQueryIdMismatch(data.errors);
              if (isQueryMismatch) {
                hadQueryUnspecified = true;
              }
              return {
                success: false as const,
                error: errorMessage,
                had404: had404 || isQueryMismatch,
                hadQueryUnspecified,
              };
            }

            const instructions = data.data?.home?.home_timeline_urt?.instructions;
            const pageTweets = parseTweetsFromInstructions(instructions, { quoteDepth: this.quoteDepth, includeRaw });
            const nextCursor = extractCursorFromInstructions(instructions);

            return { success: true as const, tweets: pageTweets, cursor: nextCursor, had404, hadQueryUnspecified };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }

        return { success: false as const, error: lastError ?? 'Unknown error fetching home timeline', had404, hadQueryUnspecified };
      };

      const fetchWithRefresh = async (pageCount: number, pageCursor?: string) => {
        const firstAttempt = await fetchPage(pageCount, pageCursor);
        if (firstAttempt.success) {
          return firstAttempt;
        }
        if (firstAttempt.had404) {
          await this.refreshQueryIds();
          const secondAttempt = await fetchPage(pageCount, pageCursor);
          if (secondAttempt.success) {
            return secondAttempt;
          }
          // If still failing with Query: Unspecified, try GenericTimelineById fallback
          if (secondAttempt.hadQueryUnspecified && !pageCursor) {
            return { success: false as const, error: secondAttempt.error, tryGenericFallback: true };
          }
          return { success: false as const, error: secondAttempt.error };
        }
        // If Query: Unspecified error on first attempt without 404, also try fallback
        if (firstAttempt.hadQueryUnspecified && !pageCursor) {
          return { success: false as const, error: firstAttempt.error, tryGenericFallback: true };
        }
        return { success: false as const, error: firstAttempt.error };
      };

      // Try first page
      const firstPage = await fetchWithRefresh(Math.min(pageSize, count), cursor);
      
      // If Query: Unspecified error, try GenericTimelineById fallback
      if (!firstPage.success && 'tryGenericFallback' in firstPage && firstPage.tryGenericFallback) {
        const debug = process.env.BIRD_DEBUG === '1';
        if (debug) {
          console.error(`[fetchHomeTimeline] Primary endpoint failed with Query: Unspecified, trying GenericTimelineById fallback`);
        }
        return this.fetchHomeTimelineViaGeneric(operation, count, options);
      }

      if (!firstPage.success) {
        return { success: false, error: firstPage.error };
      }

      // Process first page results
      for (const tweet of firstPage.tweets) {
        if (seen.has(tweet.id)) {
          continue;
        }
        seen.add(tweet.id);
        tweets.push(tweet);
        if (tweets.length >= count) {
          break;
        }
      }
      cursor = firstPage.cursor;

      // Continue fetching if needed
      while (tweets.length < count) {
        const pageCount = Math.min(pageSize, count - tweets.length);
        const page = await fetchWithRefresh(pageCount, cursor);
        if (!page.success) {
          // Don't try generic fallback for pagination - just return what we have
          if (tweets.length > 0) {
            break;
          }
          return { success: false, error: page.error };
        }

        let added = 0;
        for (const tweet of page.tweets) {
          if (seen.has(tweet.id)) {
            continue;
          }
          seen.add(tweet.id);
          tweets.push(tweet);
          added += 1;
          if (tweets.length >= count) {
            break;
          }
        }

        if (!page.cursor || page.cursor === cursor || page.tweets.length === 0 || added === 0) {
          break;
        }
        cursor = page.cursor;
      }

      return { success: true, tweets };
    }
  }

  return TwitterClientHome;
}
