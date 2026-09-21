import type { Command } from 'commander';
import { getTransaction } from 'x-agent-sdk';
import type { CliContext } from '../cli/shared.js';
import type { TwitterCookies } from '../lib/cookies.js';
import { clearStoredXChatPin, readXChatConversation, storeXChatPin } from '../lib/xchat.js';

// The legacy DM endpoints return several slightly different shapes.
// biome-ignore lint/suspicious/noExplicitAny: private API response boundary
type DmJson = any;

const API_ORIGIN = 'https://x.com';
const BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const XCHAT_ID_PATTERN = /^g\d+$/i;
const XCHAT_URL_PATTERN = /(?:^|\/)(g\d+)(?:[/?#]|$)/i;

type DmMessage = {
  id: string;
  conversationId: string | null;
  senderId: string | null;
  sender: string;
  recipientId: string | null;
  text: string;
  time: string | null;
  raw: DmJson;
};

type DmConversation = {
  id: string;
  type: string;
  participants: Array<{ id: string; name: string }>;
  lastMessage: DmMessage | null;
  sortTimestamp: string | null;
};

function createDmClient(cookies: TwitterCookies, timeoutMs?: number) {
  const cookie = cookies.cookieHeader || `auth_token=${cookies.authToken}; ct0=${cookies.ct0}`;
  return {
    async request(path: string, params: Record<string, string | number | boolean | null | undefined> = {}) {
      const url = new URL(`${API_ORIGIN}${path}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
      const transaction = await getTransaction({ cookie });
      const headers = new Headers({
        accept: '*/*',
        authorization: BEARER_TOKEN,
        'x-csrf-token': cookies.ct0 || '',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'x-client-uuid': crypto.randomUUID(),
        'x-twitter-client-deviceid': crypto.randomUUID(),
        cookie,
        'user-agent': USER_AGENT,
        origin: API_ORIGIN,
        referer: `${API_ORIGIN}/messages`,
      });
      headers.set('x-client-transaction-id', transaction.generateTransactionId('GET', url.pathname));
      const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
      const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const response = await fetch(url, { headers, signal: controller?.signal });
        const raw = await response.text();
        let data: DmJson;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = { raw: raw.slice(0, 1000) };
        }
        if (!response.ok) {
          return {
            success: false as const,
            status: response.status,
            error: data?.errors?.[0]?.message || `HTTP ${response.status}`,
            data,
          };
        }
        return { success: true as const, status: response.status, data };
      } catch (error) {
        return { success: false as const, error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    },
  };
}

export function isXChatId(value: string): boolean {
  return XCHAT_ID_PATTERN.test(value.trim());
}

function looksLikeXChatId(value: string): boolean {
  return value.toLocaleLowerCase().startsWith('g');
}

export function normalizeConversationId(value: string): string {
  const trimmed = value.trim();
  return trimmed.match(XCHAT_URL_PATTERN)?.[1] ?? trimmed;
}

function userName(users: DmJson, id: string | number | null | undefined): string {
  const user = users?.[String(id)];
  if (!user) {
    return id ? String(id) : 'unknown';
  }
  return user.screen_name ? `@${user.screen_name}` : user.name || String(id);
}

export function normalizeDmEntry(entry: DmJson, users: DmJson, conversationId?: string): DmMessage | null {
  const container = entry?.message;
  const message = container?.message_data ?? container;
  if (!message || typeof message !== 'object') {
    return null;
  }
  const text = typeof message.text === 'string' ? message.text : '';
  if (!text && !message.id) {
    return null;
  }
  return {
    id: String(message.id ?? entry?.message?.id ?? ''),
    conversationId: message.conversation_id ?? container?.conversation_id ?? conversationId ?? null,
    senderId: message.sender_id ? String(message.sender_id) : null,
    sender: userName(users, message.sender_id),
    recipientId: message.recipient_id ? String(message.recipient_id) : null,
    text,
    time: message.time ? new Date(Number(message.time)).toISOString() : null,
    raw: entry,
  };
}

export function inboxConversations(data: DmJson): {
  state: DmJson;
  users: DmJson;
  conversations: DmConversation[];
} {
  const state = data?.inbox_initial_state ?? {};
  const users = state.users ?? {};
  const conversations = Object.values<DmJson>(state.conversations ?? {})
    .map((conversation) => {
      const participants = conversation.participants ?? conversation.participant_ids ?? [];
      const participantIds = Array.isArray(participants)
        ? participants
            .map((entry) => (typeof entry === 'object' ? (entry.user_id ?? entry.id) : entry))
            .filter(Boolean)
            .map(String)
        : [];
      const messages = Object.values<DmJson>(state.entries ?? {})
        .map((entry) => normalizeDmEntry(entry, users, conversation.conversation_id))
        .filter((message): message is DmMessage => message?.conversationId === conversation.conversation_id)
        .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
      return {
        id: String(conversation.conversation_id ?? conversation.id ?? ''),
        type: conversation.type ?? (participantIds.length > 2 ? 'group' : 'one_to_one'),
        participants: participantIds.map((id) => ({ id, name: userName(users, id) })),
        lastMessage: messages[0] ?? null,
        sortTimestamp: conversation.sort_timestamp ? new Date(Number(conversation.sort_timestamp)).toISOString() : null,
      };
    })
    .filter((conversation) => conversation.id)
    .sort((a, b) => String(b.sortTimestamp ?? '').localeCompare(String(a.sortTimestamp ?? '')));
  return { state, users, conversations };
}

async function requireCredentials(program: Command, ctx: CliContext) {
  const opts = program.opts();
  const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
  const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);
  for (const warning of warnings) {
    console.error(`${ctx.p('warn')}${warning}`);
  }
  if (!cookies.authToken || !cookies.ct0) {
    throw new Error('Missing required credentials');
  }
  return { cookies, timeoutMs };
}

function printConversation(conversation: DmConversation): void {
  console.log(`${conversation.id} (${conversation.type})`);
  if (conversation.participants.length) {
    console.log(`Participants: ${conversation.participants.map((entry) => entry.name).join(', ')}`);
  }
  if (conversation.lastMessage?.text) {
    console.log(`${conversation.lastMessage.sender}: ${conversation.lastMessage.text}`);
  }
  if (conversation.lastMessage?.time) {
    console.log(conversation.lastMessage.time);
  }
  console.log('─'.repeat(60));
}

function reportError(ctx: CliContext, error: unknown): never {
  console.error(`${ctx.p('err')}${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export function registerChatCommand(program: Command, ctx: CliContext): void {
  const chat = program.command('chat').description('Read legacy X DMs and encrypted X Chat groups');
  chat
    .command('pin')
    .description('Securely save the X Chat PIN in macOS Keychain')
    .option('--clear', 'Delete the saved X Chat PIN')
    .action(async (options) => {
      try {
        if (options.clear) {
          const removed = await clearStoredXChatPin();
          console.log(removed ? 'Saved X Chat PIN removed.' : 'No saved X Chat PIN was found.');
          return;
        }
        console.log('Enter your X Chat PIN in the secure Keychain prompt:');
        await storeXChatPin();
        console.log('X Chat PIN saved securely in macOS Keychain.');
      } catch (error) {
        reportError(ctx, error);
      }
    });

  chat
    .command('list')
    .description('List conversations visible to the legacy DM endpoint')
    .option('-n, --count <number>', 'Number of conversations to show', '50')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const { cookies, timeoutMs } = await requireCredentials(program, ctx);
        const result = await createDmClient(cookies, timeoutMs).request('/i/api/1.1/dm/inbox_initial_state.json', {
          include_groups: true,
        });
        if (!result.success) {
          throw new Error(`Failed to fetch chats: ${result.error}`);
        }
        const count = Math.max(1, Number.parseInt(options.count, 10) || 50);
        const conversations = inboxConversations(result.data).conversations.slice(0, count);
        if (options.json) {
          console.log(JSON.stringify({ conversations, source: 'legacy-dm-cookie-api' }, null, 2));
        } else if (conversations.length) {
          conversations.forEach(printConversation);
        } else {
          console.log('No legacy DM conversations found.');
        }
      } catch (error) {
        reportError(ctx, error);
      }
    });

  chat
    .command('read')
    .description('Read messages from a legacy DM or encrypted X Chat conversation')
    .argument('<conversation-id>', 'Conversation ID, either userId-userId or g…')
    .option('-n, --count <number>', 'Number of messages to show', '50')
    .option('--before <sequence-id>', 'Read the X Chat batch before this local sequence ID')
    .option('--pin <pin>', 'X Chat PIN (prefer XCHAT_PIN or `bird chat pin`)')
    .option('--json', 'Output as JSON')
    .action(async (input, options) => {
      try {
        const conversationId = normalizeConversationId(input);
        if (looksLikeXChatId(conversationId) && !isXChatId(conversationId)) {
          throw new Error(`Invalid X Chat group id: ${conversationId}`);
        }
        const { cookies, timeoutMs } = await requireCredentials(program, ctx);
        if (isXChatId(conversationId)) {
          const result = await readXChatConversation({
            cookies,
            conversationId,
            pin: options.pin || process.env.XCHAT_PIN,
            count: options.count,
            beforeSequenceId: options.before,
            timeoutMs,
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else if (result.messages.length) {
            for (const message of result.messages) {
              console.log(
                `[${message.createdAt ?? '?'}] ${message.sender}: ${message.text ?? `[${message.contentType}]`}`,
              );
            }
          } else {
            console.log(`No decrypted messages returned (${result.decryptionErrors} decryption errors).`);
          }
          return;
        }
        const result = await createDmClient(cookies, timeoutMs).request(
          `/i/api/1.1/dm/conversation/${encodeURIComponent(conversationId)}.json`,
        );
        if (!result.success) {
          throw new Error(`Failed to read chat: ${result.error}`);
        }
        const timeline = result.data?.conversation_timeline ?? {};
        const users = result.data?.users ?? {};
        const count = Math.max(1, Number.parseInt(options.count, 10) || 50);
        const messages = (timeline.entries ?? [])
          .map((entry: DmJson) => normalizeDmEntry(entry, users, conversationId))
          .filter(Boolean)
          .sort((a: DmMessage, b: DmMessage) => String(a.time ?? '').localeCompare(String(b.time ?? '')))
          .slice(-count);
        if (options.json) {
          console.log(JSON.stringify({ conversationId, status: timeline.status ?? null, messages }, null, 2));
        } else if (messages.length) {
          for (const message of messages) {
            console.log(`[${message.time ?? '?'}] ${message.sender}: ${message.text}`);
          }
        } else {
          console.log(`No messages returned (status: ${timeline.status ?? 'unknown'}).`);
        }
      } catch (error) {
        reportError(ctx, error);
      }
    });

  chat
    .command('search')
    .description('Search legacy DMs or one encrypted X Chat conversation')
    .argument('<query>', 'Case-insensitive text to search for')
    .option('-c, --conversation <conversation-id>', 'Search only this conversation; supports g… X Chat IDs')
    .option('-n, --count <number>', 'Number of X Chat messages to decrypt before searching', '100')
    .option('--before <sequence-id>', 'Search the X Chat batch before this local sequence ID')
    .option('--pin <pin>', 'X Chat PIN (prefer XCHAT_PIN or `bird chat pin`)')
    .option('--json', 'Output as JSON')
    .action(async (query, options) => {
      try {
        const requested = options.conversation ? normalizeConversationId(options.conversation) : null;
        if (requested && looksLikeXChatId(requested) && !isXChatId(requested)) {
          throw new Error(`Invalid X Chat group id: ${requested}`);
        }
        const { cookies, timeoutMs } = await requireCredentials(program, ctx);
        if (requested && isXChatId(requested)) {
          const result = await readXChatConversation({
            cookies,
            conversationId: requested,
            pin: options.pin || process.env.XCHAT_PIN,
            count: options.count,
            beforeSequenceId: options.before,
            timeoutMs,
          });
          const needle = query.toLocaleLowerCase();
          const messages = result.messages.filter((message) => message.text?.toLocaleLowerCase().includes(needle));
          if (options.json) {
            console.log(JSON.stringify({ query, conversationId: requested, messages }, null, 2));
          } else if (messages.length) {
            for (const message of messages) {
              console.log(`[${message.createdAt ?? '?'}] ${message.sender}: ${message.text}`);
            }
          } else {
            console.log('No matching messages in the decrypted X Chat page.');
          }
          return;
        }
        const result = await createDmClient(cookies, timeoutMs).request('/i/api/1.1/dm/inbox_initial_state.json', {
          include_groups: true,
        });
        if (!result.success) {
          throw new Error(`Failed to fetch chats: ${result.error}`);
        }
        const { state, users } = inboxConversations(result.data);
        const needle = query.toLocaleLowerCase();
        const messages = Object.values<DmJson>(state.entries ?? {})
          .map((entry) => normalizeDmEntry(entry, users))
          .filter(
            (message): message is DmMessage =>
              Boolean(message?.text.toLocaleLowerCase().includes(needle)) &&
              (!requested || message?.conversationId === requested),
          )
          .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
        if (options.json) {
          console.log(JSON.stringify({ query, messages }, null, 2));
        } else if (messages.length) {
          for (const message of messages) {
            console.log(`[${message.time ?? '?'}] ${message.sender}: ${message.text}`);
            if (message.conversationId) {
              console.log(`  conversation: ${message.conversationId}`);
            }
          }
        } else {
          console.log('No matching messages in the current inbox snapshot.');
        }
      } catch (error) {
        reportError(ctx, error);
      }
    });
}
