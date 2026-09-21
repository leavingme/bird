import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createChat, type SigningKeyEntry } from '@xdevplatform/chat-xdk';
import { getTransaction } from 'x-agent-sdk';
import type { TwitterCookies } from './cookies.js';

// Browser X Chat responses are not a public TypeScript API. Keep the loose
// boundary here and return a small, typed result to the rest of Bird.
// biome-ignore lint/suspicious/noExplicitAny: private GraphQL response shape
type XChatJson = any;

const API_ORIGIN = 'https://api.x.com';
const WEB_ORIGIN = 'https://x.com';
const WEB_BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const KEYCHAIN_SERVICE = 'com.leavingme.bird.xchat';
const KEYCHAIN_ACCOUNT = 'default';
const XCHAT_ID_PATTERN = /^g\d+$/i;
const execFile = promisify(execFileCallback);

export const XCHAT_KEYCHAIN_STORE_ARGS = [
  'add-generic-password',
  '-U',
  '-a',
  KEYCHAIN_ACCOUNT,
  '-s',
  KEYCHAIN_SERVICE,
  '-l',
  'Bird X Chat PIN',
  '-w',
] as const;

type Operation = { id: string; name: string };

export const XCHAT_OPERATIONS = {
  initialPage: { id: 'm1gzpOV8JFOTaFH0Xq7lMQ', name: 'GetInitialXChatPageQuery' },
  recoveryData: { id: '9SJpSem4midUe6YQdkAKDg', name: 'GetConversationRecoveryDataQuery' },
  conversationData: { id: 'NYgaZEq_YBe6pdXkY7xLlw', name: 'GetInboxPageConversationDataQuery' },
  conversationPage: { id: 'GX9ZijkxG8AqRMQVD7hMnQ', name: 'GetConversationPageQuery' },
} satisfies Record<string, Operation>;

export type XChatMessage = {
  type: string;
  id: string | null;
  sequenceId: string | null;
  conversationId: string | null;
  senderId: string | null;
  sender: string;
  createdAt: string | null;
  text: string | null;
  contentType: string | null;
  verified: boolean | null;
  content: XChatJson;
};

export type XChatReadResult = {
  conversationId: string;
  groupName: string | null;
  messages: XChatMessage[];
  fetchedEncryptedEvents: number;
  decryptionErrors: number;
  hasMore: boolean;
  pagination: {
    hasMore: boolean | null;
    minLocalSequenceId: string | null;
    maxLocalSequenceId: string | null;
    eventCount: number;
  } | null;
  source: 'x-chat-cookie-graphql+chat-xdk';
};

function cookieHeader(cookies: TwitterCookies): string {
  return cookies.cookieHeader || `auth_token=${cookies.authToken}; ct0=${cookies.ct0}`;
}

function makeHeaders(
  cookies: TwitterCookies,
  transactionId: string,
  conversationId?: string,
  clientUserId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    authorization: WEB_BEARER_TOKEN,
    'x-csrf-token': cookies.ct0 || '',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'x-client-uuid': randomUUID(),
    'x-twitter-client-deviceid': randomUUID(),
    'x-client-transaction-id': transactionId,
    cookie: cookieHeader(cookies),
    'user-agent': DEFAULT_USER_AGENT,
    origin: WEB_ORIGIN,
    referer: conversationId ? `${WEB_ORIGIN}/i/chat/${encodeURIComponent(conversationId)}` : `${WEB_ORIGIN}/i/chat`,
  };
  if (clientUserId) {
    headers['x-twitter-client-user-id'] = clientUserId;
  }
  return headers;
}

function createGraphqlClient(cookies: TwitterCookies, timeoutMs?: number) {
  const cookie = cookieHeader(cookies);
  return async function query(
    operation: Operation,
    variables: Record<string, unknown>,
    conversationId?: string,
    clientUserId?: string,
  ): Promise<XChatJson> {
    const url = new URL(`${API_ORIGIN}/graphql/${operation.id}/${operation.name}`);
    url.searchParams.set('variables', JSON.stringify(variables));
    const transaction = await getTransaction({ cookie });
    const headers = makeHeaders(
      cookies,
      transaction.generateTransactionId('GET', url.pathname),
      conversationId,
      clientUserId,
    );
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(url, { headers, signal: controller?.signal });
      const raw = await response.text();
      let payload: XChatJson;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`X Chat returned a non-JSON response (HTTP ${response.status})`);
      }
      if (!response.ok) {
        const apiError = Array.isArray(payload?.errors)
          ? payload.errors.map((entry: XChatJson) => entry?.message || 'unknown error').join('; ')
          : null;
        throw new Error(`X Chat request failed (HTTP ${response.status})${apiError ? `: ${apiError}` : ''}`);
      }
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const message = payload.errors.map((entry: XChatJson) => entry?.message || 'unknown error').join('; ');
        throw new Error(`X Chat GraphQL error: ${message}`);
      }
      return payload?.data;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function userResultsFromConversation(conversation: XChatJson): XChatJson[] {
  const detail = conversation?.conversation_detail;
  return [
    ...(detail?.group_members_results || []),
    ...(detail?.participants_results || []),
    detail?.group_created_by_user_results,
  ].filter(Boolean);
}

function publicKeyWrappers(user: XChatJson): XChatJson[] {
  return user?.result?.get_public_keys?.public_keys_with_token_map || [];
}

function identityFromUsers(users: XChatJson[]) {
  for (const user of users) {
    for (const wrapper of publicKeyWrappers(user)) {
      const tokenMap = wrapper?.token_map;
      if (!Array.isArray(tokenMap?.token_map)) {
        continue;
      }
      if (!tokenMap.token_map.some((entry: XChatJson) => entry?.value?.token)) {
        continue;
      }
      return { userId: String(user.rest_id), wrapper, tokenMap };
    }
  }
  return null;
}

function signingKeysFromUsers(users: XChatJson[]): SigningKeyEntry[] {
  const keys: SigningKeyEntry[] = [];
  for (const user of users) {
    const userId = user?.rest_id ? String(user.rest_id) : null;
    if (!userId) {
      continue;
    }
    for (const wrapper of publicKeyWrappers(user)) {
      const metadata = wrapper?.public_key_with_metadata;
      const key = metadata?.public_key;
      if (!metadata?.version || !key?.public_key || !key?.signing_public_key || !key?.identity_public_key_signature) {
        continue;
      }
      keys.push({
        userId,
        publicKeyVersion: String(metadata.version),
        publicKey: key.signing_public_key,
        identityPublicKey: key.public_key,
        identityPublicKeySignature: key.identity_public_key_signature,
      });
    }
  }
  return uniqueBy(keys, (entry) => `${entry.userId}:${entry.publicKeyVersion}`);
}

function usersById(users: XChatJson[]): Map<string, { name: string | null; screenName: string | null }> {
  const result = new Map<string, { name: string | null; screenName: string | null }>();
  for (const user of users) {
    const id = user?.rest_id ? String(user.rest_id) : null;
    if (!id || result.has(id)) {
      continue;
    }
    result.set(id, {
      name: user?.result?.core?.name || null,
      screenName: user?.result?.core?.screen_name || null,
    });
  }
  return result;
}

function normalizeEvent(
  event: XChatJson,
  users: Map<string, { name: string | null; screenName: string | null }>,
): XChatMessage {
  const senderId = event?.senderId ? String(event.senderId) : null;
  const sender = senderId ? users.get(senderId) : null;
  const content = event?.content || {};
  return {
    type: event?.type || 'unknown',
    id: event?.id ? String(event.id) : null,
    sequenceId: event?.sequenceId ? String(event.sequenceId) : null,
    conversationId: event?.conversationId ? String(event.conversationId) : null,
    senderId,
    sender: sender?.screenName ? `@${sender.screenName}` : sender?.name || senderId || 'unknown',
    createdAt: Number.isFinite(event?.createdAtMsec) ? new Date(event.createdAtMsec).toISOString() : null,
    text: typeof content.text === 'string' ? content.text : null,
    contentType: content.contentType || null,
    verified: event?.verified ?? null,
    content,
  };
}

function collectRawEvents(...pages: XChatJson[]): string[] {
  const events = pages.flatMap((page) => [
    ...(page?.latest_conversation_key_change_events || []),
    ...(page?.latest_message_events || []),
  ]);
  return uniqueBy(
    events.filter((event): event is string => typeof event === 'string' && event.length > 0),
    (event) => event,
  );
}

function paginationMeta(page: XChatJson): XChatReadResult['pagination'] {
  if (!page) {
    return null;
  }
  const events = [...(page.latest_conversation_key_change_events || []), ...(page.latest_message_events || [])].filter(
    (event) => typeof event === 'string' && event.length > 0,
  );
  return {
    hasMore: page.has_more ?? null,
    minLocalSequenceId: page.min_local_sequence_id ?? null,
    maxLocalSequenceId: page.max_local_sequence_id ?? null,
    eventCount: events.length,
  };
}

export function resolveXChatHasMore(options: {
  messageCount: number;
  count: number;
  olderHasMore?: boolean | null;
  initialHasMore?: boolean | null;
  fallbackHasMore?: boolean | null;
  recoveryHasMore?: boolean | null;
}): boolean {
  return Boolean(
    options.messageCount > options.count ||
      (options.olderHasMore ?? options.initialHasMore ?? options.fallbackHasMore ?? options.recoveryHasMore ?? false),
  );
}

export function conversationPageVariables(
  conversationId: string,
  beforeSequenceId: string,
  minConversationKeyVersion: string,
): Record<string, unknown> {
  return {
    conversation_id: conversationId,
    min_local_sequence_id: beforeSequenceId,
    min_conversation_key_version: minConversationKeyVersion,
    query_settings: null,
  };
}

async function keychainPin(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const { stdout } = await execFile('/usr/bin/security', [
      'find-generic-password',
      '-a',
      KEYCHAIN_ACCOUNT,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function storeXChatPin(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Secure PIN storage is currently available only through macOS Keychain');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Saving the X Chat PIN needs an interactive terminal');
  }
  await new Promise<void>((resolve, reject) => {
    // `security` explicitly warns that `-w <password>` exposes the secret in
    // the process list. With bare `-w`, Keychain reads it directly from the
    // terminal without echoing it or passing it back through Bird.
    const child = spawn('/usr/bin/security', [...XCHAT_KEYCHAIN_STORE_ARGS], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Could not save the X Chat PIN in Keychain (security exited ${code ?? 'unknown'})`));
      }
    });
  });
}

export async function clearStoredXChatPin(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    await execFile('/usr/bin/security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE]);
    return true;
  } catch {
    return false;
  }
}

async function fetchXChatData(query: ReturnType<typeof createGraphqlClient>, conversationId: string) {
  const initialData = await query(
    XCHAT_OPERATIONS.initialPage,
    {
      max_local_sequence_id: null,
      query_settings: null,
      message_pull_version: null,
      include_user_public_keys: false,
      include_juicebox_tokens: false,
      include_all_group_member_user_objects: false,
      include_participants_results_for_inbox_preview: true,
    },
    conversationId,
  );
  const initialConversation = (initialData?.get_initial_chat_page?.items || []).find(
    (item: XChatJson) => item?.conversation_detail?.conversation_id === conversationId,
  );

  const recoveryData = await query(
    XCHAT_OPERATIONS.recoveryData,
    {
      queries: [{ conversation_id: conversationId, conversation_key_versions: [] }],
      include_user_public_keys: true,
      include_juicebox_tokens: true,
      include_all_group_member_user_objects: true,
      include_participants_results_for_inbox_preview: true,
    },
    conversationId,
  );
  const recoveryConversation = recoveryData?.get_conversation_recovery_data?.recovered_conversations?.[0] || null;

  let fallbackConversation = null;
  if (!initialConversation) {
    const fallbackData = await query(
      XCHAT_OPERATIONS.conversationData,
      {
        conversation_ids: [conversationId],
        include_user_public_keys: false,
        include_juicebox_tokens: false,
        include_all_group_member_user_objects: false,
        include_participants_results_for_inbox_preview: true,
      },
      conversationId,
    );
    fallbackConversation = fallbackData?.get_inbox_page_conversation_data?.items?.[0] || null;
  }

  return { initialConversation, recoveryConversation, fallbackConversation };
}

async function fetchOlderConversation(
  query: ReturnType<typeof createGraphqlClient>,
  conversationId: string,
  beforeSequenceId: string,
  minConversationKeyVersion: string,
) {
  const olderData = await query(
    XCHAT_OPERATIONS.conversationPage,
    conversationPageVariables(conversationId, beforeSequenceId, minConversationKeyVersion),
    conversationId,
  );
  const page = olderData?.get_conversation_page;
  return page
    ? {
        latest_message_events: page.encoded_message_events || [],
        latest_conversation_key_change_events: page.missing_conversation_key_change_events || [],
        has_more: page.has_more ?? false,
        min_local_sequence_id: page.min_local_sequence_id ?? null,
        max_local_sequence_id: page.max_local_sequence_id ?? null,
      }
    : null;
}

export async function readXChatConversation(options: {
  cookies: TwitterCookies;
  conversationId: string;
  pin?: string;
  count?: string | number;
  beforeSequenceId?: string;
  timeoutMs?: number;
}): Promise<XChatReadResult> {
  const { cookies, conversationId, timeoutMs } = options;
  if (!XCHAT_ID_PATTERN.test(conversationId)) {
    throw new Error(`Invalid X Chat group id: ${conversationId}`);
  }
  const unlockPin = String(options.pin || (await keychainPin()) || '').trim();
  if (!unlockPin) {
    const error = new Error('X Chat PIN required. Run `bird chat pin` once, pass --pin, or set XCHAT_PIN.');
    Object.assign(error, { code: 'XCHAT_PIN_REQUIRED' });
    throw error;
  }

  const query = createGraphqlClient(cookies, timeoutMs);
  const { initialConversation, recoveryConversation, fallbackConversation } = await fetchXChatData(
    query,
    conversationId,
  );
  if (!recoveryConversation) {
    throw new Error(`X Chat conversation ${conversationId} was not found`);
  }

  const users = uniqueBy(
    [
      ...userResultsFromConversation(recoveryConversation),
      ...userResultsFromConversation(initialConversation),
      ...userResultsFromConversation(fallbackConversation),
    ],
    (user) => String(user?.rest_id || randomUUID()),
  );
  const identity = identityFromUsers(users);
  if (!identity) {
    throw new Error('Your X Chat identity/token map was not returned by X');
  }
  const realmTokens = new Map<string, string>(
    identity.tokenMap.token_map
      .filter((entry: XChatJson) => entry?.key && entry?.value?.token)
      .map((entry: XChatJson) => [String(entry.key).toLowerCase(), String(entry.value.token)]),
  );
  const chat = await createChat({
    juiceboxConfig: JSON.stringify(identity.tokenMap),
    getAuthToken: async (realmId) => realmTokens.get(String(realmId).toLowerCase()) || '',
  });

  try {
    await chat.unlock(unlockPin);
    const ownMetadata = identity.wrapper?.public_key_with_metadata;
    const ownIdentityKey = ownMetadata?.public_key?.public_key;
    if (!ownMetadata?.version || !ownIdentityKey) {
      throw new Error('Your registered X Chat public key is incomplete');
    }
    if (!chat.matchesRegisteredKey(ownIdentityKey)) {
      throw new Error('Recovered X Chat identity does not match the registered public key');
    }
    chat.setIdentity(identity.userId, String(ownMetadata.version));
    chat.setCacheKeys(true);
    chat.setSigningKeys(signingKeysFromUsers(users));

    let rawEvents = collectRawEvents(recoveryConversation, initialConversation, fallbackConversation);
    let decrypted = chat.decryptEvents(rawEvents);
    let olderConversation = null;
    if (options.beforeSequenceId) {
      const minConversationKeyVersion = decrypted.conversationKeys.latestVersion;
      if (!minConversationKeyVersion) {
        throw new Error('X Chat did not return a conversation key version needed for pagination');
      }
      olderConversation = await fetchOlderConversation(
        query,
        conversationId,
        options.beforeSequenceId,
        minConversationKeyVersion,
      );
      rawEvents = collectRawEvents(recoveryConversation, initialConversation, olderConversation, fallbackConversation);
      decrypted = chat.decryptEvents(rawEvents);
    }
    const userMap = usersById(users);
    let messages = decrypted.messages
      .map((entry) => normalizeEvent(entry.event, userMap))
      .filter(
        (event) =>
          event.conversationId === conversationId &&
          event.type === 'message' &&
          (event.text || event.contentType !== 'text'),
      )
      .sort((left, right) => {
        const a = BigInt(left.sequenceId || '0');
        const b = BigInt(right.sequenceId || '0');
        return a < b ? -1 : a > b ? 1 : 0;
      });
    if (options.beforeSequenceId) {
      const before = BigInt(options.beforeSequenceId);
      messages = messages.filter((message) => BigInt(message.sequenceId || '0') < before);
    }
    const count = Math.max(1, Number.parseInt(String(options.count ?? 100), 10) || 100);
    const selectedMessages = messages.slice(-count);
    const hasMore = resolveXChatHasMore({
      messageCount: messages.length,
      count,
      olderHasMore: olderConversation?.has_more,
      initialHasMore: initialConversation?.has_more,
      fallbackHasMore: fallbackConversation?.has_more,
      recoveryHasMore: recoveryConversation?.has_more,
    });
    const pagination = paginationMeta(olderConversation || initialConversation);
    if (pagination) {
      pagination.hasMore = hasMore;
      pagination.minLocalSequenceId = selectedMessages[0]?.sequenceId ?? null;
      pagination.maxLocalSequenceId = selectedMessages.at(-1)?.sequenceId ?? null;
    }
    return {
      conversationId,
      groupName: recoveryConversation?.conversation_detail?.group_metadata?.group_name || null,
      messages: selectedMessages,
      fetchedEncryptedEvents: rawEvents.length,
      decryptionErrors: Object.keys(decrypted.errors || {}).length,
      hasMore,
      pagination:
        pagination ||
        (selectedMessages.length
          ? {
              hasMore: null,
              minLocalSequenceId: selectedMessages[0]?.sequenceId ?? null,
              maxLocalSequenceId: selectedMessages.at(-1)?.sequenceId ?? null,
              eventCount: rawEvents.length,
            }
          : null),
      source: 'x-chat-cookie-graphql+chat-xdk',
    };
  } finally {
    chat.lock();
  }
}
