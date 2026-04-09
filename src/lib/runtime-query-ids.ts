import { spawn } from 'node:child_process';
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_CACHE_FILENAME = 'query-ids-cache.json';
const DEFAULT_TTL_MS: number = 24 * 60 * 60 * 1000;

const DISCOVERY_PAGES: string[] = [
  'https://x.com/?lang=en',
  'https://x.com/explore',
  'https://x.com/notifications',
  'https://x.com/settings/profile',
];

/**
 * Operations whose bundles are lazily loaded and never appear in initial HTML
 * <script> tags. Static HTTP scanning cannot find them; a real browser is needed.
 * Maps operationName → page URL that triggers the lazy chunk to load.
 */
export const LAZY_OPERATIONS: Record<string, string> = {
  AiTrendByRestId: 'https://x.com/i/trending/1',
};

const BUNDLE_URL_REGEX = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9.-]+\.js/g;
const QUERY_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

const OPERATION_PATTERNS = [
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

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export type RuntimeQueryIdSnapshot = {
  fetchedAt: string;
  ttlMs: number;
  ids: Record<string, string>;
  discovery: {
    pages: string[];
    bundles: string[];
  };
};

export type RuntimeQueryIdSnapshotInfo = {
  snapshot: RuntimeQueryIdSnapshot;
  cachePath: string;
  ageMs: number;
  isFresh: boolean;
};

export type RuntimeQueryIdsOptions = {
  cachePath?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  /** Path to Chrome/Chromium binary. If undefined, auto-detected from well-known locations. */
  chromePath?: string;
};

export type RuntimeQueryIdStore = {
  cachePath: string;
  ttlMs: number;
  getSnapshotInfo: () => Promise<RuntimeQueryIdSnapshotInfo | null>;
  getQueryId: (operationName: string) => Promise<string | null>;
  refresh: (operationNames: string[], opts?: { force?: boolean }) => Promise<RuntimeQueryIdSnapshotInfo | null>;
  clearMemory: () => void;
};

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url, { headers: HEADERS });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 120)}`);
  }
  return response.text();
}

function resolveDefaultCachePath(): string {
  const override = process.env.BIRD_QUERY_IDS_CACHE;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(homedir(), '.config', 'bird', DEFAULT_CACHE_FILENAME);
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

function parseSnapshot(raw: unknown): RuntimeQueryIdSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const fetchedAt = typeof record.fetchedAt === 'string' ? record.fetchedAt : null;
  const ttlMs = typeof record.ttlMs === 'number' && Number.isFinite(record.ttlMs) ? record.ttlMs : null;
  const ids = record.ids && typeof record.ids === 'object' ? (record.ids as Record<string, unknown>) : null;
  const discovery =
    record.discovery && typeof record.discovery === 'object' ? (record.discovery as Record<string, unknown>) : null;

  if (!fetchedAt || !ttlMs || !ids || !discovery) {
    return null;
  }
  const pages = Array.isArray(discovery.pages) ? discovery.pages : null;
  const bundles = Array.isArray(discovery.bundles) ? discovery.bundles : null;
  if (!pages || !bundles) {
    return null;
  }

  const normalizedIds: Record<string, string> = {};
  for (const [key, value] of Object.entries(ids)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      normalizedIds[key] = value.trim();
    }
  }

  return {
    fetchedAt,
    ttlMs,
    ids: normalizedIds,
    discovery: {
      pages: pages.filter((p) => typeof p === 'string') as string[],
      bundles: bundles.filter((b) => typeof b === 'string') as string[],
    },
  };
}

async function readSnapshotFromDisk(cachePath: string): Promise<RuntimeQueryIdSnapshot | null> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    return parseSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeSnapshotToDisk(cachePath: string, snapshot: RuntimeQueryIdSnapshot): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Static bundle discovery + extraction
// ---------------------------------------------------------------------------

async function discoverBundles(fetchImpl: typeof fetch): Promise<string[]> {
  const bundles = new Set<string>();
  for (const page of DISCOVERY_PAGES) {
    try {
      const html = await fetchText(fetchImpl, page);
      for (const match of html.matchAll(BUNDLE_URL_REGEX)) {
        bundles.add(match[0]);
      }
    } catch {
      // ignore discovery page failures; other pages often work
    }
  }
  const discovered = [...bundles];
  if (discovered.length === 0) {
    throw new Error('No client bundles discovered; x.com layout may have changed.');
  }
  return discovered;
}

function extractOperations(
  bundleContents: string,
  bundleLabel: string,
  targets: Set<string>,
  discovered: Map<string, { queryId: string; bundle: string }>,
): void {
  for (const pattern of OPERATION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    while (true) {
      const match = pattern.regex.exec(bundleContents);
      if (match === null) {
        break;
      }
      const operationName = match[pattern.operationGroup];
      const queryId = match[pattern.queryIdGroup];
      if (!operationName || !queryId) {
        continue;
      }
      if (!targets.has(operationName)) {
        continue;
      }
      if (!QUERY_ID_REGEX.test(queryId)) {
        continue;
      }
      if (discovered.has(operationName)) {
        continue;
      }
      discovered.set(operationName, { queryId, bundle: bundleLabel });
      if (discovered.size === targets.size) {
        return;
      }
    }
  }
}

async function fetchAndExtract(
  fetchImpl: typeof fetch,
  bundleUrls: string[],
  targets: Set<string>,
): Promise<Map<string, { queryId: string; bundle: string }>> {
  const discovered = new Map<string, { queryId: string; bundle: string }>();
  if (targets.size === 0) return discovered;

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
          const js = await fetchText(fetchImpl, url);
          extractOperations(js, label, targets, discovered);
        } catch {
          // ignore failed bundles
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
// Chrome CDP discovery for lazily-loaded bundles
// ---------------------------------------------------------------------------

/**
 * Returns the path to a Chrome/Chromium executable, or null if none found.
 */
export async function findChrome(): Promise<string | null> {
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
      await access(p, constants.X_OK);
      return p;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

async function discoverViaChrome(
  chromePath: string,
  pageUrl: string,
  targets: Set<string>,
): Promise<Map<string, { queryId: string; bundle: string }>> {
  const discovered = new Map<string, { queryId: string; bundle: string }>();

  // Avoid D-Bus connection errors in headless environments
  process.env.DBUS_SESSION_BUS_ADDRESS = '/dev/null';

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

    const listRes = await fetch(`${cdpBase}/json/list`);
    if (!listRes.ok) throw new Error('CDP /json/list failed');
    const tabs = (await listRes.json()) as Array<{ webSocketDebuggerUrl?: string; type?: string; url?: string }>;

    // Try to create a fresh about:blank tab first (avoids chrome://newtab/ navigation block)
    let tab = tabs.find((t) => t.type === 'page' && t.url === 'about:blank' && t.webSocketDebuggerUrl);
    if (!tab?.webSocketDebuggerUrl) {
      try {
        const newTabRes = await fetch(`${cdpBase}/json/new`, {
          method: 'PUT',
          body: JSON.stringify({ url: 'about:blank' }),
        });
        if (newTabRes.ok) {
          const newTab = (await newTabRes.json()) as { webSocketDebuggerUrl?: string; url?: string };
          if (newTab?.webSocketDebuggerUrl) {
            tab = newTab as (typeof tabs)[number];
          }
        }
      } catch {
        // ignore create tab failure
      }
    }

    // Fall back to first available page tab
    if (!tab?.webSocketDebuggerUrl) {
      tab = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }
    if (!tab?.webSocketDebuggerUrl) throw new Error('No CDP page tab found');

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
            clearTimeout(timer);
            resolve(capturedUrls);
          }
        }

        if (msg.method === 'Page.loadEventFired') {
          setTimeout(() => {
            resolve(capturedUrls);
            clearTimeout(timer);
          }, 3000);
        }
      });

      ws.addEventListener('error', (e) => reject(new Error(`CDP WebSocket error: ${String(e)}`)));

      setTimeout(() => {
        send('Page.navigate', { url: pageUrl });
      }, 200);
    });

    for (const url of bundleUrls) {
      const label = url.split('/').at(-1) ?? url;
      try {
        const js = await fetchText(fetch, url);
        extractOperations(js, label, targets, discovered);
      } catch {
        // ignore failed bundles
      }
    }
  } finally {
    cleanup();
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Unified public discovery API
// ---------------------------------------------------------------------------

export type DiscoverQueryIdsOptions = {
  fetchImpl?: typeof fetch;
  /**
   * Path to Chrome/Chromium binary for discovering lazily-loaded bundles.
   * If undefined, auto-detected. Pass null to disable Chrome entirely.
   */
  chromePath?: string | null;
};

/**
 * Discover queryIds for the given operations.
 *
 * - Static operations are found by scanning bundles linked from x.com HTML pages.
 * - Operations in LAZY_OPERATIONS (e.g. AiTrendByRestId) require a real browser
 *   to trigger the lazy webpack chunk. If Chrome is available it is used automatically;
 *   otherwise these operations are silently skipped (caller should fall back to
 *   cached / hardcoded values).
 */
export async function discoverQueryIds(
  operationNames: string[],
  opts: DiscoverQueryIdsOptions = {},
): Promise<Map<string, { queryId: string; bundle: string }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const lazySet = new Set(Object.keys(LAZY_OPERATIONS));
  const staticTargets = new Set(operationNames.filter((op) => !lazySet.has(op)));
  const lazyTargets = operationNames.filter((op) => lazySet.has(op));

  const bundleUrls = await discoverBundles(fetchImpl);
  const discovered = await fetchAndExtract(fetchImpl, bundleUrls, staticTargets);

  if (lazyTargets.length > 0 && opts.chromePath !== null) {
    const chromeBin = opts.chromePath !== undefined ? opts.chromePath : await findChrome();
    if (chromeBin) {
      // Group lazy ops by their discovery page
      const pageToOps = new Map<string, Set<string>>();
      for (const op of lazyTargets) {
        const page = LAZY_OPERATIONS[op];
        if (!page) continue;
        if (!pageToOps.has(page)) pageToOps.set(page, new Set());
        pageToOps.get(page)!.add(op);
      }
      for (const [page, ops] of pageToOps) {
        try {
          const found = await discoverViaChrome(chromeBin, page, ops);
          for (const [op, info] of found) {
            discovered.set(op, info);
          }
        } catch {
          // ignore chrome failures silently at runtime
        }
      }
    }
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// RuntimeQueryIdStore (cache + auto-refresh)
// ---------------------------------------------------------------------------

export function createRuntimeQueryIdStore(options: RuntimeQueryIdsOptions = {}): RuntimeQueryIdStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = options.cachePath ? path.resolve(options.cachePath) : resolveDefaultCachePath();
  // undefined = auto-detect chrome; explicit string = use that path
  const chromePath = options.chromePath;

  let memorySnapshot: RuntimeQueryIdSnapshot | null = null;
  let loadOnce: Promise<RuntimeQueryIdSnapshot | null> | null = null;
  let refreshInFlight: Promise<RuntimeQueryIdSnapshotInfo | null> | null = null;

  const loadSnapshot = async (): Promise<RuntimeQueryIdSnapshot | null> => {
    if (memorySnapshot) {
      return memorySnapshot;
    }
    if (!loadOnce) {
      loadOnce = (async () => {
        const fromDisk = await readSnapshotFromDisk(cachePath);
        memorySnapshot = fromDisk;
        return fromDisk;
      })();
    }
    return loadOnce;
  };

  const getSnapshotInfo = async (): Promise<RuntimeQueryIdSnapshotInfo | null> => {
    const snapshot = await loadSnapshot();
    if (!snapshot) {
      return null;
    }
    const fetchedAtMs = new Date(snapshot.fetchedAt).getTime();
    const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, Date.now() - fetchedAtMs) : Number.POSITIVE_INFINITY;
    const effectiveTtl = Number.isFinite(snapshot.ttlMs) ? snapshot.ttlMs : ttlMs;
    const isFresh = ageMs <= effectiveTtl;
    return { snapshot, cachePath, ageMs, isFresh };
  };

  const getQueryId = async (operationName: string): Promise<string | null> => {
    const info = await getSnapshotInfo();
    if (!info) {
      return null;
    }
    return info.snapshot.ids[operationName] ?? null;
  };

  const refresh = async (
    operationNames: string[],
    opts: { force?: boolean } = {},
  ): Promise<RuntimeQueryIdSnapshotInfo | null> => {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const current = await getSnapshotInfo();
      if (!opts.force && current?.isFresh) {
        return current;
      }

      const discovered = await discoverQueryIds(operationNames, {
        fetchImpl,
        chromePath,
      });

      if (discovered.size === 0) {
        return current ?? null;
      }

      const ids: Record<string, string> = {};
      for (const name of operationNames) {
        const entry = discovered.get(name);
        if (entry?.queryId) {
          ids[name] = entry.queryId;
        }
      }

      const bundleUrls = await discoverBundles(fetchImpl).catch(() => [] as string[]);
      const snapshot: RuntimeQueryIdSnapshot = {
        fetchedAt: new Date().toISOString(),
        ttlMs,
        ids,
        discovery: {
          pages: [...DISCOVERY_PAGES],
          bundles: bundleUrls.map((url) => url.split('/').at(-1) ?? url),
        },
      };

      await writeSnapshotToDisk(cachePath, snapshot);
      memorySnapshot = snapshot;

      return getSnapshotInfo();
    })().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  };

  return {
    cachePath,
    ttlMs,
    getSnapshotInfo,
    getQueryId,
    refresh,
    clearMemory() {
      memorySnapshot = null;
      loadOnce = null;
    },
  };
}

export const runtimeQueryIds = createRuntimeQueryIdStore();

// ---------------------------------------------------------------------------
// CLI entry point: tsx src/lib/runtime-query-ids.ts
// Updates src/lib/query-ids.json with freshly discovered queryIds.
// ---------------------------------------------------------------------------

const UPDATE_TARGET_OPERATIONS = [
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

type UpdateOperationName = (typeof UPDATE_TARGET_OPERATIONS)[number];

const isMain =
  typeof process !== 'undefined' &&
  typeof import.meta !== 'undefined' &&
  // Node: process.argv[1] is the resolved script path
  (() => {
    try {
      return new URL(import.meta.url).pathname === process.argv[1];
    } catch {
      return false;
    }
  })();

if (isMain) {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const queryIdsPath = new URL('./query-ids.json', import.meta.url).pathname;

  async function readExistingIds(): Promise<Partial<Record<UpdateOperationName, string>>> {
    try {
      const contents = await readFile(queryIdsPath, 'utf8');
      const parsed = JSON.parse(contents) as Record<string, string>;
      const result: Partial<Record<UpdateOperationName, string>> = {};
      for (const op of UPDATE_TARGET_OPERATIONS) {
        if (typeof parsed[op] === 'string' && parsed[op].trim().length > 0) {
          result[op] = parsed[op].trim();
        }
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[warn] Failed to read existing query IDs:', error);
      }
      return {};
    }
  }

  async function writeIds(ids: Partial<Record<UpdateOperationName, string>>): Promise<void> {
    const ordered: Partial<Record<UpdateOperationName, string>> = {};
    for (const op of UPDATE_TARGET_OPERATIONS) {
      if (ids[op]) {
        ordered[op] = ids[op];
      }
    }
    const json = `${JSON.stringify(ordered, null, 2)}\n`;
    await mkdir(path.dirname(queryIdsPath), { recursive: true });
    await writeFile(queryIdsPath, json, 'utf8');
  }

  const chromePath = await findChrome();
  if (chromePath) {
    console.log(`[info] Chrome found: ${chromePath}`);
  } else {
    console.warn('[warn] Chrome not found; lazy-loaded operations (e.g. AiTrendByRestId) will be skipped.');
    console.warn('[warn] Set CHROME_PATH env var or install Chrome to enable full discovery.');
  }

  console.log('[info] Discovering Twitter/X query IDs…');
  const discovered = await discoverQueryIds([...UPDATE_TARGET_OPERATIONS], { chromePath });

  if (discovered.size === 0) {
    console.error('[error] No query IDs discovered; extraction patterns may need an update.');
    process.exitCode = 1;
  } else {
    const existing = await readExistingIds();
    const nextIds: Partial<Record<UpdateOperationName, string>> = { ...existing };
    for (const op of UPDATE_TARGET_OPERATIONS) {
      const found = discovered.get(op);
      if (found?.queryId) {
        nextIds[op] = found.queryId;
      }
    }

    await writeIds(nextIds);

    for (const op of UPDATE_TARGET_OPERATIONS) {
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

    console.log(`[info] Updated ${queryIdsPath}`);
  }
}
