import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli/program.js';
import { createCliContext } from '../src/cli/shared.js';
import { inboxConversations, isXChatId, normalizeConversationId, normalizeDmEntry } from '../src/commands/chat.js';
import {
  conversationPageVariables,
  readXChatConversation,
  resolveXChatHasMore,
  XCHAT_KEYCHAIN_STORE_ARGS,
} from '../src/lib/xchat.js';

describe('chat command', () => {
  it('registers list, read, search, and pin subcommands', () => {
    const program = createProgram(createCliContext([]));
    const chat = program.commands.find((command) => command.name() === 'chat');
    expect(chat).toBeDefined();
    expect(chat?.commands.map((command) => command.name())).toEqual(['pin', 'list', 'read', 'search']);
  });

  it('recognizes X Chat IDs and URLs', () => {
    expect(isXChatId('g1234567890123456789')).toBe(true);
    expect(isXChatId('123-456')).toBe(false);
    expect(normalizeConversationId('https://x.com/i/chat/g1234567890123456789')).toBe('g1234567890123456789');
    expect(normalizeConversationId(' 123-456 ')).toBe('123-456');
  });

  it('exposes chat input validation and filtering options in help', () => {
    const program = createProgram(createCliContext([]));
    const chat = program.commands.find((command) => command.name() === 'chat');
    const search = chat?.commands.find((command) => command.name() === 'search');
    const read = chat?.commands.find((command) => command.name() === 'read');
    expect(search?.options.some((option) => option.long === '--conversation')).toBe(true);
    expect(read?.options.some((option) => option.long === '--before')).toBe(true);
  });

  it('normalizes nested legacy DM entries', () => {
    const entry = {
      message: {
        message_data: {
          id: 'm1',
          conversation_id: '1-2',
          sender_id: '1',
          recipient_id: '2',
          text: 'hello',
          time: '1700000000000',
        },
      },
    };
    expect(normalizeDmEntry(entry, { '1': { screen_name: 'alice' } })).toMatchObject({
      id: 'm1',
      conversationId: '1-2',
      sender: '@alice',
      text: 'hello',
      time: '2023-11-14T22:13:20.000Z',
    });
  });

  it('sorts legacy conversations by timestamp and includes their latest message', () => {
    const result = inboxConversations({
      inbox_initial_state: {
        users: { '1': { screen_name: 'alice' }, '2': { screen_name: 'bob' } },
        conversations: {
          old: { conversation_id: '1-2', participant_ids: ['1', '2'], sort_timestamp: '1000' },
          recent: { conversation_id: '1-3', participant_ids: ['1', '3'], sort_timestamp: '2000' },
        },
        entries: {
          one: { message: { id: 'one', conversation_id: '1-2', sender_id: '1', text: 'old', time: '1000' } },
          two: { message: { id: 'two', conversation_id: '1-3', sender_id: '1', text: 'new', time: '2000' } },
        },
      },
    });
    expect(result.conversations.map((conversation) => conversation.id)).toEqual(['1-3', '1-2']);
    expect(result.conversations[0]?.lastMessage?.text).toBe('new');
  });

  it('rejects malformed encrypted conversation IDs before doing I/O', async () => {
    await expect(
      readXChatConversation({
        cookies: { authToken: 'a', ct0: 'c', cookieHeader: null, source: 'test' },
        conversationId: 'not-a-group',
        pin: 'test-pin',
      }),
    ).rejects.toThrow('Invalid X Chat group id');
  });

  it('requires a real conversation key version for an older-page request', () => {
    expect(conversationPageVariables('g123', '200', '150')).toEqual({
      conversation_id: 'g123',
      min_local_sequence_id: '200',
      min_conversation_key_version: '150',
      query_settings: null,
    });
  });

  it('lets an explicit final older page override the latest snapshot', () => {
    expect(
      resolveXChatHasMore({
        messageCount: 3,
        count: 3,
        olderHasMore: false,
        initialHasMore: true,
      }),
    ).toBe(false);
    expect(resolveXChatHasMore({ messageCount: 4, count: 3, olderHasMore: false })).toBe(true);
  });

  it('prompts Keychain without putting the PIN in subprocess arguments', () => {
    expect(XCHAT_KEYCHAIN_STORE_ARGS.at(-1)).toBe('-w');
    expect(XCHAT_KEYCHAIN_STORE_ARGS).not.toContain('test-pin');
  });
});
