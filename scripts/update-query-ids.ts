#!/usr/bin/env tsx
/**
 * Fetches current Twitter/X GraphQL query IDs from public client bundles and
 * updates src/lib/query-ids.json.
 *
 * For operations whose bundles are lazily loaded (e.g. AiTrendByRestId lives in
 * bundle.LiveEvent.*.js which is never linked from initial HTML), a Chrome headless
 * fallback is used when available: the browser navigates to the trending page, the
 * lazy chunk loads automatically, its URL is captured via CDP, and the bundle is
 * fetched + scanned like any other.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_OPERATIONS = [
  'CreateTweet',
  'CreateRetweet',
  'DeleteRetweet',
  'CreateFriendship',
  'DestroyFriendship',
  'FavoriteTweet',
  'UnfavoriteTweet',
  'CreateBookmark',
  'DeleteBookmark',
  'TweetDetail',
  'SearchTimeline',
  'Bookmarks',
  'BookmarkFolderTimeline',
  'Following',
  'Followers',
  'Likes',
  'ExploreSidebar',
  'ExplorePage',
  'GenericTimelineById',
  'TrendHistory',
  'AiTrendByRestId',
  'AboutAccountQuery',
] as const;

type OperationName = (typeof TARGET_OPERATIONS)[number];

/**
 * Operations that live in lazily-loaded chunks not discoverable from static HTML.
 * For these we use the Chrome CDP fallback with a targeted discovery URL.
 */
const LAZY_OPERATIONS: Partial<Record<OperationName, string>> = {
  AiTrendByRestId: 'https://x.com/i/trending/1',
};

const DISCOVERY_PAGES = [
  'https://x.com/?lang=en',
  'https://x.com/explore',
  'https://x.com/notifications',
  'https://x.com/settings/profile',
];

const BUNDLE_URL_REGEX =
  /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9.-]+\.js/g;

const OPERATION_PATTERNS = [
  // Modern bundles export operations like:
  //   e.exports={queryId:"...",operationName:"CreateTweet",operationType:"mutation",...}
  {
    regex: /e\.exports=\{queryId\s*:\s*["']([^"']+)["']\s*,\s*operationName\s*:\s*["']([^"']+)["']/gs,
    operationGroup: 2,
    queryIdGroup: 1,
  },
  {
    regex: /e\.exports=\{operationName\s*:\s*["']([^"']+)["']\s*,\s*queryId\s*:\s*["']([^"']+)["']/gs,
    operationGroup: 1,
    queryIdGroup: 2,
  },
  {
    regex: /operationName\s*[:=]\s*["']([^"']+)["'](.{0,4000}?)queryId\s*[:=]\s*["']([^"']+)["']/gs,
    operationGroup: 1,
    queryIdGroup: 3,
  },
  {
    regex: /queryId\s*[:=]\s*["']([^"']+)["'](.{0,4000}?)operationName\s*[:=]\s*["']([^"']+)["']/gs,
    operationGroup: 3,
    queryIdGroup: 1,
  },
] as const;

const QUERY_IDS_PATH = path.resolve(process.cwd(), 'src/lib/query-ids.json');
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

interface DiscoveredOperation {
  queryId: string;
  bundle: string;
}

async function readExistingIds(): Promise<Record<OperationName, string>> {
  try {
    const contents = await fs.readFile(QUERY_IDS_PATH, 'utf8');
    const parsed = JSON.parse(contents) as Record<string, string>;
    const result: Partial<Record<OperationName, string>> = {};
    for (const op of TARGET_OPERATIONS) {
      if (typeof parsed[op] === 'string' && parsed[op].trim().length > 0) {
        result[op] = parsed[op].trim();
      }
    }
    return result as Record<OperationName, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[warn] Failed to read existing query IDs:', error);
    }
    return {} as Record<OperationName, string>;
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 120)}`);
  }
  return response.text();
}

async function discoverBundles(): Promise<string[]> {
  const bundles = new Set<string>();
  for (const page of DISCOVERY_PAGES) {
    try {
      const html = await fetchText(page);
      for (const match of html.matchAll(BUNDLE_URL_REGEX)) {
        bundles.add(match[0]);
      }
    } catch (error) {
      console.warn(`[warn] Could not fetch ${page}:`, error instanceof Error ? error.message : error);
    }
  }

  const discovered = Array.from(bundles);
  if (discovered.length === 0) {
    throw new Error('No client bundles discovered; x.com layout may have changed.');
  }
  return discovered;
}

function extractOperations(
  bundleContents: string,
  bundleLabel: string,
  targets: Set<OperationName>,
  discovered: Map<OperationName, DiscoveredOperation>,
): void {
  for (const pattern of OPERATION_PATTERNS) {
    pattern.regex.lastIndex = 0; // reset stateful regex
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(bundleContents)) !== null) {
      const operationName = match[pattern.operationGroup];
      const queryId = match[pattern.queryIdGroup];
      if (!operationName || !queryId) continue;

      if (!targets.has(operationName as OperationName)) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(queryId)) continue;
      const op = operationName as OperationName;
      if (discovered.has(op)) continue;
      discovered.set(op, { queryId, bundle: bundleLabel });
      if (discovered.size === targets.size) {
        return;
      }
    }
  }
}

async function fetchAndExtract(
  bundleUrls: string[],
  targets: Set<OperationName>,
): Promise<Map<OperationName, DiscoveredOperation>> {
  const discovered = new Map<OperationName, DiscoveredOperation>();
  const CONCURRENCY = 6;

  for (let i = 0; i < bundleUrls.length; i += CONCURRENCY) {
    const chunk = bundleUrls.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (url) => {
        if (discovered.size === targets.size) {
          return;
        }
        const label = url.split('/').at(-1) ?? url;
        try {
          const js = await fetchText(url);
          extractOperations(js, label, targets, discovered);
        } catch (error) {
          console.warn(`[warn] Failed to scan ${label}:`, error instanceof Error ? error.message : error);
        }
      }),
    );
    if (discovered.size === targets.size) {
      break;
    }
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Chrome CDP fallback for lazily-loaded bundles
// ---------------------------------------------------------------------------

/**
 * Returns the path to a Chrome/Chromium executable, or null if none found.
 */
async function findChrome(): Promise<string | null> {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      await fs.access(p, fs.constants.X_OK);
      return p;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

/**
 * Use Chrome headless + CDP to load `pageUrl`, wait for `bundle.LiveEvent.*.js`
 * to be requested (it loads as a lazy webpack chunk), fetch it, and extract
 * queryIds for the given target operations.
 *
 * Returns a map of operationName → { queryId, bundle }.
 */
async function discoverViaChrome(
  chromePath: string,
  pageUrl: string,
  targets: Set<OperationName>,
): Promise<Map<OperationName, DiscoveredOperation>> {
  const discovered = new Map<OperationName, DiscoveredOperation>();

  // Start Chrome with remote debugging enabled
  const CDP_PORT = 19222;
  const chromeProc = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      `--user-data-dir=/tmp/bird-chrome-${Date.now()}`,
    ],
    { stdio: 'ignore', detached: false },
  );

  const cleanup = () => {
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // already dead
    }
  };

  try {
    // Wait for Chrome to be ready (poll /json/version endpoint)
    const cdpBase = `http://127.0.0.1:${CDP_PORT}`;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await fetch(`${cdpBase}/json/version`);
        if (res.ok) break;
      } catch {
        // not ready yet
      }
    }

    // Get a tab's websocket debugger URL
    const listRes = await fetch(`${cdpBase}/json/list`);
    if (!listRes.ok) throw new Error('CDP /json/list failed');
    const tabs = (await listRes.json()) as Array<{ webSocketDebuggerUrl?: string; type?: string }>;
    const tab = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!tab?.webSocketDebuggerUrl) throw new Error('No CDP page tab found');

    // Connect via WebSocket (Node 22 has built-in WebSocket)
    const bundleUrls = await new Promise<string[]>((resolve, reject) => {
      const ws = new WebSocket(tab.webSocketDebuggerUrl as string);
      const capturedUrls: string[] = [];
      let msgId = 1;
      const send = (method: string, params?: Record<string, unknown>) => {
        ws.send(JSON.stringify({ id: msgId++, method, params: params ?? {} }));
      };

      const TIMEOUT_MS = 20_000;
      const timer = setTimeout(() => {
        resolve(capturedUrls);
      }, TIMEOUT_MS);

      ws.addEventListener('open', () => {
        send('Network.enable');
        send('Page.enable');
      });

      ws.addEventListener('message', (evt: MessageEvent) => {
        let msg: { method?: string; params?: { request?: { url?: string } } };
        try {
          msg = JSON.parse(evt.data as string) as typeof msg;
        } catch {
          return;
        }

        if (msg.method === 'Network.requestWillBeSent') {
          const url = msg.params?.request?.url ?? '';
          if (/\/bundle\.LiveEvent\.[A-Za-z0-9]+\.js/.test(url)) {
            capturedUrls.push(url);
            // Got what we need — stop waiting
            clearTimeout(timer);
            resolve(capturedUrls);
          }
        }

        if (msg.method === 'Page.loadEventFired') {
          // Page fully loaded but no LiveEvent bundle seen — give JS 3s to lazily load
          setTimeout(() => {
            resolve(capturedUrls);
            clearTimeout(timer);
          }, 3000);
        }
      });

      ws.addEventListener('error', (e) => reject(new Error(`CDP WebSocket error: ${String(e)}`)));

      // Navigate to target page after a short delay to ensure handlers are wired
      setTimeout(() => {
        send('Page.navigate', { url: pageUrl });
      }, 200);
    });

    if (bundleUrls.length === 0) {
      console.warn(`[warn] Chrome CDP: no bundle.LiveEvent URL captured from ${pageUrl}`);
      return discovered;
    }

    console.log(`[info] Chrome CDP captured ${bundleUrls.length} lazy bundle(s)`);
    for (const url of bundleUrls) {
      const label = url.split('/').at(-1) ?? url;
      console.log(`[info]   ${label}`);
      try {
        const js = await fetchText(url);
        extractOperations(js, label, targets, discovered);
      } catch (error) {
        console.warn(`[warn] Failed to fetch/scan ${label}:`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    cleanup();
  }

  return discovered;
}

/**
 * Discover operations that live in lazily-loaded bundles using Chrome CDP.
 * If Chrome is not available, logs a warning and returns an empty map
 * (caller will fall through to existing/fallback values).
 */
async function discoverLazyOperations(
  missing: Set<OperationName>,
): Promise<Map<OperationName, DiscoveredOperation>> {
  const result = new Map<OperationName, DiscoveredOperation>();

  // Group missing lazy ops by their discovery page
  const pageToOps = new Map<string, Set<OperationName>>();
  for (const op of missing) {
    const page = LAZY_OPERATIONS[op];
    if (!page) continue;
    if (!pageToOps.has(page)) pageToOps.set(page, new Set());
    pageToOps.get(page)!.add(op);
  }

  if (pageToOps.size === 0) return result;

  const chromePath = await findChrome();
  if (!chromePath) {
    console.warn('[warn] Chrome not found; skipping CDP fallback for lazy bundles:', [...missing].join(', '));
    console.warn('[warn] Set CHROME_PATH env var or install Chrome to enable this.');
    return result;
  }

  console.log(`[info] Using Chrome CDP fallback: ${chromePath}`);

  for (const [page, ops] of pageToOps) {
    try {
      const found = await discoverViaChrome(chromePath, page, ops);
      for (const [op, info] of found) {
        result.set(op, info);
      }
    } catch (error) {
      console.warn(
        `[warn] Chrome CDP failed for ${page}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------

async function writeIds(ids: Record<OperationName, string>): Promise<void> {
  const ordered: Record<OperationName, string> = {} as Record<OperationName, string>;
  for (const op of TARGET_OPERATIONS) {
    if (ids[op]) {
      ordered[op] = ids[op];
    }
  }
  const json = `${JSON.stringify(ordered, null, 2)}\n`;
  await fs.mkdir(path.dirname(QUERY_IDS_PATH), { recursive: true });
  await fs.writeFile(QUERY_IDS_PATH, json, 'utf8');
}

async function main(): Promise<void> {
  console.log('[info] Discovering Twitter/X client bundles…');
  const bundleUrls = await discoverBundles();
  console.log(`[info] Found ${bundleUrls.length} bundles`);

  // Operations in LAZY_OPERATIONS always go through Chrome CDP — skip static scan for them.
  const lazyOps = new Set<OperationName>(Object.keys(LAZY_OPERATIONS) as OperationName[]);
  const staticTargets = new Set<OperationName>(TARGET_OPERATIONS.filter((op) => !lazyOps.has(op)));
  const existing = await readExistingIds();

  const discovered = await fetchAndExtract(bundleUrls, staticTargets);

  if (lazyOps.size > 0) {
    console.log(`[info] Lazy operations (Chrome CDP): ${[...lazyOps].join(', ')}`);
    const lazyFound = await discoverLazyOperations(lazyOps);
    for (const [op, info] of lazyFound) {
      discovered.set(op, info);
    }
  }

  if (discovered.size === 0) {
    throw new Error('No query IDs discovered; extraction patterns may need an update.');
  }

  const nextIds: Record<OperationName, string> = { ...existing };
  for (const op of TARGET_OPERATIONS) {
    const found = discovered.get(op);
    if (found?.queryId) {
      nextIds[op] = found.queryId;
    }
  }

  await writeIds(nextIds);

  for (const op of TARGET_OPERATIONS) {
    const previous = existing[op];
    const current = nextIds[op];
    const source = discovered.get(op)?.bundle ?? 'existing file';
    if (previous && current && previous !== current) {
      console.log(`✅ ${op}: ${previous} → ${current} (${source})`);
    } else if (current) {
      console.log(`✅ ${op}: ${current} (${source})`);
    } else {
      console.warn(`⚠️  ${op}: not found (kept previous value if present)`);
    }
  }

  console.log(`[info] Updated ${QUERY_IDS_PATH}`);
}

main().catch((error) => {
  console.error('[error]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
