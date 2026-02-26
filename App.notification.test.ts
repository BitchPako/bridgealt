import { describe, expect, it, vi } from 'vitest';

vi.mock('strophe.js', () => ({
  Strophe: { getText: () => '' },
  $iq: vi.fn(),
  $msg: vi.fn(),
  $pres: vi.fn(),
}));

import { ChatType, Message, MessageStatus, type Chat } from './types';
import { buildPrivateChatId, isIncomingMessageFromCurrentUser, materializePrivateChatFromCreateControl, playIncomingMessageToneIfNeeded, resolveBootstrapConnectPlan, resolveChatPolicyContextForTarget, resolveIncomingPrivateRouting, runLocalSessionRecovery, shouldSkipReconnectWhileWorkflowActive } from './App';

const baseMessage: Message = {
  id: 'm-1',
  chatId: 'chat-user@host',
  senderId: 'user@host/resource-a',
  timestamp: Date.now(),
  text: 'hello',
  status: MessageStatus.DELIVERED,
  type: 'text',
  reactions: [],
};

describe('App notification tone logic', () => {
  it('does not play tone for self-sent private message when sender has resource in JID', () => {
    const isFromCurrentUser = isIncomingMessageFromCurrentUser({
      message: baseMessage,
      currentUserId: 'user@host',
      isPrivateChat: true,
    });

    const playTone = vi.fn().mockResolvedValue(undefined);

    const shouldPlayTone = playIncomingMessageToneIfNeeded({
      message: baseMessage,
      currentUserId: 'user@host',
      isFromCurrentUser,
      isMutedChat: false,
      soundSettings: {
        enabled: true,
        messageToneEnabled: true,
        incomingRingtoneEnabled: true,
        messageToneVolume: 0.6,
        incomingRingtoneVolume: 0.75,
        playMessageToneInActiveChat: true,
      },
      activeChatId: null,
    }, playTone);

    expect(isFromCurrentUser).toBe(true);
    expect(shouldPlayTone).toBe(false);
    expect(playTone).not.toHaveBeenCalled();
  });
});

describe('private chat security-mode split', () => {
  it('keeps transport and secure chats independent for same peer and blocks media only in secure chat', () => {
    const peerBareJid = 'alice@example.com';
    const transportChatId = buildPrivateChatId(peerBareJid, 'transport');
    const secureChatId = buildPrivateChatId(peerBareJid, 'e2ee_text_only');

    const chats: Chat[] = [
      {
        id: transportChatId,
        type: ChatType.PRIVATE,
        securityMode: 'transport',
        name: 'alice',
        normalizedName: 'alice',
        isHidden: false,
        participants: ['me@example.com', peerBareJid],
        unreadCount: 0,
        adminIds: [],
      },
      {
        id: secureChatId,
        type: ChatType.PRIVATE,
        securityMode: 'e2ee_text_only',
        name: 'alice',
        normalizedName: 'alice',
        isHidden: false,
        participants: ['me@example.com', peerBareJid],
        unreadCount: 0,
        adminIds: [],
      },
    ];

    expect(transportChatId).not.toBe(secureChatId);
    expect(chats).toHaveLength(2);

    const transportPolicy = resolveChatPolicyContextForTarget(chats, transportChatId, 'chat');
    const securePolicy = resolveChatPolicyContextForTarget(chats, secureChatId, 'chat');

    expect(transportPolicy).toEqual({ securityMode: 'transport', allowMedia: true });
    expect(securePolicy).toEqual({ securityMode: 'e2ee_text_only', allowMedia: false });
  });
});


describe('create-chat control materialization', () => {
  it('creates secure private chat on recipient before first message', () => {
    const chatId = buildPrivateChatId('alice@example.com', 'e2ee_text_only');
    const chats = materializePrivateChatFromCreateControl([], {
      chatId,
      currentUserId: 'bob@example.com',
      peerJid: 'alice@example.com',
      securityMode: 'e2ee_text_only',
      peerDisplayName: 'alice',
    });

    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      id: chatId,
      type: ChatType.PRIVATE,
      securityMode: 'e2ee_text_only',
      participants: ['bob@example.com', 'alice@example.com'],
      isHidden: true,
    });
  });

  it('routes incoming media in private chat to existing chat id after reload', () => {
    const peerBareJid = 'alice@example.com';
    const existingChatId = buildPrivateChatId(peerBareJid, 'e2ee_text_only');
    const legacyIncomingChatId = `chat-${peerBareJid}`;

    const chats: Chat[] = [
      {
        id: existingChatId,
        type: ChatType.PRIVATE,
        securityMode: 'e2ee_text_only',
        name: 'alice',
        normalizedName: 'alice',
        isHidden: false,
        participants: ['bob@example.com', peerBareJid],
        unreadCount: 0,
        adminIds: [],
      },
    ];

    const routing = resolveIncomingPrivateRouting({
      messageChatId: legacyIncomingChatId,
      chats,
      createChatAllowances: new Map(),
    });

    expect(routing.routedChatId).toBe(existingChatId);
  });
});


describe('visibility reconnect guard window', () => {
  it('does not spam reconnectNow while reconnect guard is still active', () => {
    const reconnectNow = vi.fn();
    const guardTimeoutMs = 20_000;
    const staleBufferMs = 2_000;
    const workflowStart = 10_000;
    let reconnectWorkflowSeenAt: { attemptId: number | null; seenAt: number } | null = null;
    const activeReconnectAttemptId = 7;

    const simulateVisibilityReconnect = (now: number) => {
      const workflowGate = shouldSkipReconnectWhileWorkflowActive({
        isWorkflowActive: true,
        activeReconnectAttemptId,
        reconnectWorkflowSeenAt,
        now,
        guardTimeoutMs,
        staleBufferMs,
      });
      reconnectWorkflowSeenAt = workflowGate.nextReconnectWorkflowSeenAt;

      if (!workflowGate.shouldSkip) {
        reconnectNow();
      }
    };

    simulateVisibilityReconnect(workflowStart);
    simulateVisibilityReconnect(workflowStart + guardTimeoutMs - 1);
    simulateVisibilityReconnect(workflowStart + guardTimeoutMs + staleBufferMs - 1);

    expect(reconnectNow).not.toHaveBeenCalled();

    simulateVisibilityReconnect(workflowStart + guardTimeoutMs + staleBufferMs + 1);

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it('resets seenAt when active reconnect attempt id changes', () => {
    const guardTimeoutMs = 20_000;
    const staleBufferMs = 2_000;
    const firstSeenAt = 10_000;

    const firstAttempt = shouldSkipReconnectWhileWorkflowActive({
      isWorkflowActive: true,
      activeReconnectAttemptId: 1,
      reconnectWorkflowSeenAt: null,
      now: firstSeenAt,
      guardTimeoutMs,
      staleBufferMs,
    });

    expect(firstAttempt.nextReconnectWorkflowSeenAt).toEqual({ attemptId: 1, seenAt: firstSeenAt });

    const switchedAttempt = shouldSkipReconnectWhileWorkflowActive({
      isWorkflowActive: true,
      activeReconnectAttemptId: 2,
      reconnectWorkflowSeenAt: firstAttempt.nextReconnectWorkflowSeenAt,
      now: firstSeenAt + 5_000,
      guardTimeoutMs,
      staleBufferMs,
    });

    expect(switchedAttempt.workflowAgeMs).toBe(0);
    expect(switchedAttempt.nextReconnectWorkflowSeenAt).toEqual({ attemptId: 2, seenAt: firstSeenAt + 5_000 });
  });

});


describe('bootstrap connect plan', () => {
  it('skips app-level connect when xmpp reconnect workflow is already active', () => {
    const plan = resolveBootstrapConnectPlan({
      isWorkflowActive: true,
      hasSessionCredentials: true,
    });

    expect(plan).toEqual({
      shouldSkip: true,
      skipReason: 'workflow-active-xmpp-service',
    });
  });

  it('prefers reconnectNow mode when session credentials are already cached', () => {
    const plan = resolveBootstrapConnectPlan({
      isWorkflowActive: false,
      hasSessionCredentials: true,
    });

    expect(plan).toEqual({
      shouldSkip: false,
      connectMode: 'reconnect-now',
    });
  });

  it('falls back to direct connect mode without cached session credentials', () => {
    const plan = resolveBootstrapConnectPlan({
      isWorkflowActive: false,
      hasSessionCredentials: false,
    });

    expect(plan).toEqual({
      shouldSkip: false,
      connectMode: 'direct-connect',
    });
  });
});


describe('local session recovery handler', () => {
  it('disconnects xmpp, logs out auth, and clears local state callbacks', async () => {
    const disconnect = vi.fn();
    const releaseMediaUrls = vi.fn();
    const logout = vi.fn().mockResolvedValue(undefined);
    const clearBadge = vi.fn();
    const resetDirectoryState = vi.fn();
    const resetAppState = vi.fn();
    const clearCreateChatAllowances = vi.fn();
    const clearMediaPreflightCache = vi.fn();
    const clearXmppRecoveryState = vi.fn(() => ['strophe.resume']);
    const closeSettings = vi.fn();

    const clearedKeys = await runLocalSessionRecovery({
      disconnect,
      releaseMediaUrls,
      logout,
      clearBadge,
      resetDirectoryState,
      resetAppState,
      clearCreateChatAllowances,
      clearMediaPreflightCache,
      clearXmppRecoveryState,
      closeSettings,
    });

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(releaseMediaUrls).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(clearBadge).toHaveBeenCalledTimes(1);
    expect(resetDirectoryState).toHaveBeenCalledTimes(1);
    expect(resetAppState).toHaveBeenCalledTimes(1);
    expect(clearCreateChatAllowances).toHaveBeenCalledTimes(1);
    expect(clearMediaPreflightCache).toHaveBeenCalledTimes(1);
    expect(clearXmppRecoveryState).toHaveBeenCalledTimes(1);
    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(clearedKeys).toEqual(['strophe.resume']);
  });
});
