import { describe, expect, it, vi } from 'vitest';

vi.mock('strophe.js', () => ({
  Strophe: { getText: () => '' },
  $iq: vi.fn(),
  $msg: vi.fn(),
  $pres: vi.fn(),
}));

import { normalizeChatsForState, buildPrivateChatId } from './App';
import { ChatType, MessageStatus, type Chat } from './types';

describe('normalizeChatsForState', () => {
  it('deduplicates chats with identical normalized id and merges deterministic fields', () => {
    const peerJid = 'alice@example.com';
    const normalizedId = buildPrivateChatId(peerJid, 'transport');

    const chats: Chat[] = [
      {
        id: `chat-${peerJid}`,
        type: ChatType.PRIVATE,
        securityMode: 'transport',
        name: 'Alice old',
        normalizedName: 'alice old',
        isHidden: false,
        participants: [peerJid, 'me@example.com'],
        unreadCount: 1,
        adminIds: [],
        lastMessage: {
          id: 'm-1',
          chatId: `chat-${peerJid}`,
          senderId: peerJid,
          text: 'old',
          timestamp: 100,
          status: MessageStatus.DELIVERED,
          type: 'text',
          reactions: [],
        },
      },
      {
        id: peerJid,
        type: ChatType.PRIVATE,
        securityMode: 'transport',
        name: 'Alice new',
        normalizedName: 'alice new',
        isHidden: false,
        participants: [peerJid, 'me@example.com', 'bob@example.com'],
        unreadCount: 4,
        adminIds: [],
        lastMessage: {
          id: 'm-2',
          chatId: peerJid,
          senderId: 'bob@example.com',
          text: 'new',
          timestamp: 200,
          status: MessageStatus.READ,
          type: 'text',
          reactions: [],
        },
      },
    ];

    const normalized = normalizeChatsForState(chats);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].id).toBe(normalizedId);
    expect(normalized[0].participants).toEqual([peerJid, 'me@example.com', 'bob@example.com']);
    expect(normalized[0].unreadCount).toBe(4);
    expect(normalized[0].lastMessage?.id).toBe('m-2');
  });
});
