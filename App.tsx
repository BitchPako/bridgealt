
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { INITIAL_CHATS, SEED_USERS } from './constants';
import { AppState, BotIntentPayload, CallMediaType, CallState, Chat, Message, MessageStatus, User, ChatType, ChatSecurityMode, LockConfig, GroupMemberManageAction, AddGroupMembersHandler, ChannelDirectoryEntry, ModerationReasonCode, OutboxTask, PendingMediaPayload, SoundSettings, resolveChatSecurityMode, sanitizePrivacySettings, sanitizeSecuritySettings } from './types';
import Sidebar from './components/Sidebar.tsx';
import ChatWindow from './components/ChatWindow';
import SettingsView from './components/SettingsView';
import ProfilePanel from './components/ProfilePanel';
import NewChatModal from './components/NewChatModal';
import NewGroupModal from './components/NewGroupModal';
import NewChannelModal from './components/NewChannelModal';
import ForwardModal from './components/ForwardModal';
import ContactsModal from './components/ContactsModal'; 
import LockScreen from './components/LockScreen'; 
import AuthScreen from './components/AuthScreen';
import MediaGallery from './components/MediaGallery'; 
import CallOverlay from './components/CallOverlay';
import PermissionBlockedModal from './components/PermissionBlockedModal';
import { authService, initDB } from './services/authService';
import { dbService } from './services/dbService';
import { notificationService } from './services/notificationService';
import { soundNotificationService } from './services/soundNotificationService';
import { assertMediaUrlIsExternallyReachable, clearXmppRecoveryStorage, getReconnectGuardTimeoutMs, resolveOutgoingMediaType, xmppService } from './services/xmppService'; 
import { callService } from './services/callService';
import { handleXmppCallSignal } from './services/callSignalHandler';
import { buildPrivateChatId as buildPrivateChatIdFromGuard, canExchangePrivateMessages, clearPrivateGuardStateForPeer, evaluateInboundPrivateMessage, getPeerJidFromPrivateChatId, manuallySilencePrivatePeer, normalizeBareJid, parsePrivateChatId as parsePrivateChatIdFromGuard, resolveContactStatus } from './services/privateMessagingGuard';
import { outboxService } from './services/outboxService';
import { isChannelJid, normalizeSearchQuery } from './services/jidUtils';
import { RefreshCcw, Terminal } from 'lucide-react';
import { moderationService } from './services/moderationService';
import { validateIncomingGroupMessage, validateOutgoingGroupMessage } from './services/groupModerationService';
import { TRANSLATIONS, Language } from './translations';
import { SyncOperation, SyncSnapshot, SyncStateEnvelope, applySyncOperation, createInitialSyncEnvelope, mergeSnapshotWithPending } from './services/syncSchema';
import { buildEncryptedBridgeMediaPayload, encryptMediaBlob } from './services/mediaCrypto';
import { e2eeService, type DeviceBundle } from './services/e2eeService';
import { MediaPreflightOptions, MediaPreflightResult, normalizeMediaError, openMediaPermissionSettings, preflightMediaPermissions } from './services/mediaPermissionService';
import { type RestoredMediaPatch, restorePersistedMediaAfterHydration } from './services/mediaRestore';
import { callConfigService } from './services/callConfigService';
import { runRuntimeCapabilityPreflight, type RuntimeCapabilityIssueCode, type RuntimeCapabilityResult } from './services/runtimeCapabilityService';

export const buildPrivateChatId = buildPrivateChatIdFromGuard;
export const parsePrivateChatId = parsePrivateChatIdFromGuard;

type IncomingPrivateRoutingContext = {
  messageChatId: string;
  chats: Chat[];
  createChatAllowances: Map<string, { securityMode: ChatSecurityMode; expiresAt: number }>;
  now?: number;
};

export const resolveIncomingPrivateRouting = ({
  messageChatId,
  chats,
  createChatAllowances,
  now = Date.now(),
}: IncomingPrivateRoutingContext): { peerJid: string | null; securityMode: ChatSecurityMode; routedChatId: string | null } => {
  const incomingPrivateMeta = parsePrivateChatId(messageChatId);
  const incomingPrivatePeerJid = incomingPrivateMeta?.peerJid || getPeerJidFromPrivateChatId(messageChatId);

  if (!incomingPrivatePeerJid) {
    return { peerJid: null, securityMode: 'transport', routedChatId: null };
  }

  const existingPrivateChat = chats.find(chat => (
    chat.type === ChatType.PRIVATE
    && parsePrivateChatId(chat.id)?.peerJid === incomingPrivatePeerJid
  ));

  const allowance = createChatAllowances.get(normalizeBareJid(incomingPrivatePeerJid));
  const allowanceMode = allowance && allowance.expiresAt > now ? allowance.securityMode : null;
  const deterministicMode = (!incomingPrivateMeta?.isLegacy ? incomingPrivateMeta?.securityMode : null)
    || existingPrivateChat?.securityMode
    || allowanceMode
    || null;

  const securityMode = deterministicMode || 'transport';
  if (!deterministicMode) {
    return { peerJid: incomingPrivatePeerJid, securityMode, routedChatId: null };
  }

  const routedPrivateChatId = buildPrivateChatId(incomingPrivatePeerJid, deterministicMode);
  if (!routedPrivateChatId || routedPrivateChatId === messageChatId) {
    return { peerJid: incomingPrivatePeerJid, securityMode, routedChatId: null };
  }

  return { peerJid: incomingPrivatePeerJid, securityMode, routedChatId: routedPrivateChatId };
};

const mergeMessageReactions = (
  reactions: Message['reactions'],
  emoji: string,
  userId: string,
  action: 'add' | 'remove'
): Message['reactions'] => {
  const normalizedEmoji = emoji.trim();
  const normalizedUserId = userId.trim().toLowerCase();
  if (!normalizedEmoji || !normalizedUserId) return reactions;

  const next = reactions.map(reaction => ({ ...reaction, userIds: [...reaction.userIds] }));
  const targetIndex = next.findIndex(reaction => reaction.emoji === normalizedEmoji);

  if (action === 'add') {
    if (targetIndex === -1) {
      return [...next, { emoji: normalizedEmoji, count: 1, userIds: [normalizedUserId] }];
    }

    const userSet = new Set(next[targetIndex].userIds.map(id => id.toLowerCase()));
    if (userSet.has(normalizedUserId)) return reactions;
    userSet.add(normalizedUserId);
    next[targetIndex].userIds = Array.from(userSet);
    next[targetIndex].count = next[targetIndex].userIds.length;
    return next;
  }

  if (targetIndex === -1) return reactions;
  const filteredUsers = next[targetIndex].userIds.filter(id => id.toLowerCase() !== normalizedUserId);
  if (filteredUsers.length === next[targetIndex].userIds.length) return reactions;

  if (filteredUsers.length === 0) {
    next.splice(targetIndex, 1);
  } else {
    next[targetIndex].userIds = filteredUsers;
    next[targetIndex].count = filteredUsers.length;
  }

  return next;
};

const generateInviteCode = () => Math.random().toString(36).slice(2, 10);

const upsertChatById = (chats: Chat[], incomingChat: Chat): Chat[] => {
  const chatIndex = new Map<string, number>();
  const nextChats: Chat[] = [];

  chats.forEach((chat) => {
    const existingIndex = chatIndex.get(chat.id);
    if (existingIndex === undefined) {
      chatIndex.set(chat.id, nextChats.length);
      nextChats.push(chat);
      return;
    }

    nextChats[existingIndex] = chat;
  });

  const incomingIndex = chatIndex.get(incomingChat.id);
  if (incomingIndex === undefined) {
    return [incomingChat, ...nextChats];
  }

  nextChats[incomingIndex] = incomingChat;
  return nextChats;
};

const dedupeChatsById = (chats: Chat[]): Chat[] => {
  const deduped = new Map<string, Chat>();
  chats.forEach((chat) => deduped.set(chat.id, chat));
  return Array.from(deduped.values());
};

const mergeChatsUniqueById = (chats: Chat[], incomingChats: Chat[]): Chat[] => {
  const merged = incomingChats.reduce((acc, chat) => upsertChatById(acc, chat), chats);
  return dedupeChatsById(merged);
};


const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  messageToneEnabled: true,
  incomingRingtoneEnabled: true,
  messageToneVolume: 0.6,
  incomingRingtoneVolume: 0.75,
  playMessageToneInActiveChat: false,
};

const mergeSoundSettings = (candidate?: Partial<SoundSettings> | null): SoundSettings => ({
  ...DEFAULT_SOUND_SETTINGS,
  ...(candidate || {}),
  messageToneVolume: Math.min(1, Math.max(0, Number(candidate?.messageToneVolume ?? DEFAULT_SOUND_SETTINGS.messageToneVolume))),
  incomingRingtoneVolume: Math.min(1, Math.max(0, Number(candidate?.incomingRingtoneVolume ?? DEFAULT_SOUND_SETTINGS.incomingRingtoneVolume))),
});

const sanitizeMessagesForPersistence = (messagesByChat: Record<string, Message[]>): Record<string, Message[]> => {
  const sanitizedEntries = Object.entries(messagesByChat).map(([chatId, chatMessages]) => {
    let changed = false;
    const sanitizedMessages = chatMessages.map((message) => {
      if (!message.mediaUrl?.startsWith('blob:')) return message;
      changed = true;
      return {
        ...message,
        mediaUrl: undefined,
      };
    });

    return [chatId, changed ? sanitizedMessages : chatMessages] as const;
  });

  return Object.fromEntries(sanitizedEntries);
};

type ToneDecisionContext = {
  message: Message;
  currentUserId?: string | null;
  isMutedChat: boolean;
  soundSettings: SoundSettings;
  activeChatId: string | null;
};

export const resolveChatPolicyContextForTarget = (
  chats: Chat[],
  chatId: string,
  stanzaType: 'chat' | 'groupchat',
): ChatPolicyContext => {
  const targetChat = chats.find(c => c.id === chatId);
  if (!targetChat) {
    const securityMode = stanzaType === 'chat' ? 'e2ee_text_only' : 'transport';
    return { securityMode, allowMedia: securityMode !== 'e2ee_text_only' };
  }

  if (targetChat.type === ChatType.GROUP || targetChat.type === ChatType.CHANNEL || targetChat.type === ChatType.SAVED) {
    return { securityMode: 'transport', allowMedia: true };
  }

  const securityMode = resolveChatSecurityMode(targetChat.securityMode);
  return { securityMode, allowMedia: securityMode !== 'e2ee_text_only' };
};

export const isIncomingMessageFromCurrentUser = ({
  message,
  currentUserId,
  isPrivateChat,
}: {
  message: Message;
  currentUserId?: string | null;
  isPrivateChat: boolean;
}): boolean => {
  if (!currentUserId) return false;
  if (message.senderId === currentUserId) return true;
  if (!isPrivateChat) return false;

  return normalizeBareJid(message.senderId) === normalizeBareJid(currentUserId);
};

export const playIncomingMessageToneIfNeeded = (
  context: ToneDecisionContext & { isFromCurrentUser: boolean },
  playTone: (settings: SoundSettings) => Promise<void>
): boolean => {
  const shouldPlayTone =
    !context.isFromCurrentUser
    && !context.isMutedChat
    && context.soundSettings.enabled
    && context.soundSettings.messageToneEnabled
    && (context.soundSettings.playMessageToneInActiveChat || context.activeChatId !== context.message.chatId);

  if (shouldPlayTone) {
    void playTone(context.soundSettings);
  }

  return shouldPlayTone;
};


type LocalSessionRecoveryActions = {
  disconnect: () => void | Promise<void>;
  releaseMediaUrls?: () => void;
  logout: () => Promise<void>;
  clearBadge?: () => void;
  resetDirectoryState: () => void;
  resetAppState: () => void;
  clearCreateChatAllowances?: () => void;
  clearMediaPreflightCache?: () => void;
  clearXmppRecoveryState?: () => string[];
  closeSettings?: () => void;
};

export const runLocalSessionRecovery = async (actions: LocalSessionRecoveryActions): Promise<string[]> => {
  try {
    await Promise.resolve(actions.disconnect());
  } catch (error) {
    console.warn('[SessionRecovery] disconnect is already settled', error);
  }
  actions.releaseMediaUrls?.();
  await actions.logout();
  actions.clearBadge?.();
  actions.resetDirectoryState();
  actions.resetAppState();
  actions.clearCreateChatAllowances?.();
  actions.clearMediaPreflightCache?.();
  const clearedKeys = actions.clearXmppRecoveryState?.() || [];
  actions.closeSettings?.();
  return clearedKeys;
};

const INITIAL_CALL_STATE: CallState = {
  callId: null,
  chatId: null,
  peerJid: null,
  direction: null,
  media: 'audio',
  status: 'idle',
  isMuted: false,
  isSpeakerOn: false,
  isCameraOn: true,
  isScreenSharing: false,
  videoSource: 'camera',
  participants: [],
  conferenceId: null,
  canUseSpeakerToggle: false,
  diagnosticsEvents: [],
};

const INITIAL_STATE: AppState = {
  currentUser: null,
  chats: INITIAL_CHATS,
  messages: {},
  scheduledMessages: {},
  activeChatId: null,
  isDarkMode: true,
  theme: 'terminal',
  notifications: true,
  soundSettings: DEFAULT_SOUND_SETTINGS,
  language: 'en',
  xmppConnected: false,
  xmppSessionReady: false,
  e2eeInitializing: false,
  e2eeInitFailed: false,
  e2eePolicyBlocked: false,
  omemoPublishDiagnostic: null,
  pendingRequests: [],
  isLocked: false, // Initial lock state
  callState: INITIAL_CALL_STATE,
  outboxTasks: []
};

const resolveOmemoPublishDiagnostic = (health: any): string | null => {
  const reasonCode = health?.lastEvent?.reasonCode || health?.lastResult?.reasonCode;
  const errorCondition = health?.lastEvent?.errorCondition || health?.lastResult?.errorCondition;

  if (reasonCode === 'OMEMO_PUBLISH_PRECHECK_FORBIDDEN' || errorCondition === 'forbidden') {
    return 'Публикация OMEMO запрещена сервером (forbidden).';
  }
  if (reasonCode === 'OMEMO_PUBLISH_PRECHECK_NOT_AUTHORIZED' || errorCondition === 'not-authorized') {
    return 'Недостаточно прав для публикации OMEMO (not-authorized).';
  }
  if (reasonCode === 'OMEMO_PUBLISH_PRECHECK_SERVICE_UNAVAILABLE' || reasonCode === 'OMEMO_PUBLISH_NODE_CREATE_UNSUPPORTED' || errorCondition === 'service-unavailable' || errorCondition === 'feature-not-implemented') {
    return 'Сервер не поддерживает PEP/OMEMO или создание OMEMO-узлов.';
  }
  if (reasonCode === 'OMEMO_INIT_FAILED') {
    return 'Инициализация E2EE завершилась ошибкой. Повтор выполняется в фоне.';
  }

  if (reasonCode || errorCondition) {
    return `Публикация OMEMO временно недоступна (${reasonCode || errorCondition}).`;
  }

  return null;
};


const normalizeChannelName = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();


export const materializePrivateChatFromCreateControl = (
  chats: Chat[],
  params: {
    chatId: string;
    currentUserId: string;
    peerJid: string;
    securityMode: ChatSecurityMode;
    peerDisplayName?: string;
  }
): Chat[] => {
  const resolvedName = params.peerDisplayName || params.peerJid.split('@')[0] || params.peerJid;
  const participants = [params.currentUserId, params.peerJid];
  const existing = chats.find((chat) => chat.id === params.chatId);

  if (existing) {
    return chats.map((chat) => chat.id === params.chatId
      ? {
          ...chat,
          securityMode: params.securityMode,
          participants,
          name: chat.name || resolvedName,
          normalizedName: normalizeChannelName(chat.name || resolvedName),
          isHidden: true,
        }
      : chat);
  }

  return [{
    id: params.chatId,
    type: ChatType.PRIVATE,
    securityMode: params.securityMode,
    name: resolvedName,
    normalizedName: normalizeChannelName(resolvedName),
    isHidden: true,
    participants,
    unreadCount: 0,
    adminIds: [],
  }, ...chats];
};
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const INCOMING_PRESENCE_REQUEST_TTL_MS = 5 * 60_000;
const ANDROID_BACK_DEBOUNCE_MS = 400;
const RUNTIME_PREFLIGHT_LOG_KEY = 'runtime_preflight_log';

const appendRuntimePreflightPersistentLog = (payload: unknown) => {
  if (typeof window === 'undefined') return;

  try {
    const raw = window.localStorage.getItem(RUNTIME_PREFLIGHT_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const entries = Array.isArray(parsed) ? parsed : [];
    entries.push(payload);
    while (entries.length > 30) entries.shift();
    window.localStorage.setItem(RUNTIME_PREFLIGHT_LOG_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn('[RuntimePreflight] failed to persist diagnostics', error);
  }
};


const OUTBOX_STAGE_WEIGHTS: Record<'preparing' | 'encrypting' | 'uploading' | 'sent', number> = {
  preparing: 10,
  encrypting: 35,
  uploading: 50,
  sent: 5,
};

type SendMessageDeliveryStatus = 'sent-to-server' | 'delivered' | 'read';

const resolveMessageStatusFromDeliveryStatus = (deliveryStatus?: SendMessageDeliveryStatus): MessageStatus => {
  if (deliveryStatus === 'read') return MessageStatus.READ;
  if (deliveryStatus === 'delivered') return MessageStatus.DELIVERED;
  return MessageStatus.SENT;
};

const createInitialOutboxStageProgress = () => ({
  preparing: { progress: 0, weight: OUTBOX_STAGE_WEIGHTS.preparing },
  encrypting: { progress: 0, weight: OUTBOX_STAGE_WEIGHTS.encrypting },
  uploading: { progress: 0, weight: OUTBOX_STAGE_WEIGHTS.uploading },
  sent: { progress: 0, weight: OUTBOX_STAGE_WEIGHTS.sent },
});

const computeCompositeOutboxProgress = (stageProgress?: OutboxTask['stageProgress']) => {
  if (!stageProgress) return 0;
  let weightedProgress = 0;
  let totalWeight = 0;
  (Object.keys(OUTBOX_STAGE_WEIGHTS) as Array<keyof typeof OUTBOX_STAGE_WEIGHTS>).forEach((stage) => {
    const configuredWeight = stageProgress[stage]?.weight ?? OUTBOX_STAGE_WEIGHTS[stage];
    const stageValue = Math.min(100, Math.max(0, stageProgress[stage]?.progress ?? 0));
    weightedProgress += stageValue * configuredWeight;
    totalWeight += configuredWeight;
  });
  if (totalWeight <= 0) return 0;
  return Math.round(weightedProgress / totalWeight);
};

const SAFARI_SAFE_AUDIO_BASES = ['audio/mp4', 'audio/aac', 'audio/x-m4a'];

const buildAudioMediaVariants = (mediaUrl?: string, mediaMime?: string): PendingMediaPayload['mediaVariants'] | undefined => {
  if (!mediaUrl || !mediaMime) return undefined;
  const normalizedMime = mediaMime.toLowerCase();
  if (!normalizedMime.startsWith('audio/')) return undefined;
  return {
    audio: [{ mime: mediaMime, url: mediaUrl }],
  };
};

const hasSafariSafeAudioVariant = (mediaMime?: string, mediaVariants?: PendingMediaPayload['mediaVariants']): boolean => {
  const normalize = (value?: string) => (value || '').toLowerCase().split(';')[0].trim();
  if (SAFARI_SAFE_AUDIO_BASES.includes(normalize(mediaMime))) return true;
  return Boolean(mediaVariants?.audio?.some((variant) => SAFARI_SAFE_AUDIO_BASES.includes(normalize(variant.mime))));
};


type ChatPolicyContext = {
  securityMode: ChatSecurityMode;
  allowMedia: boolean;
};

type XmppRecipientResolver = {
  getEncryptionRecipientsForTarget?: (targetJid: string, stanzaType: 'chat' | 'groupchat') => Promise<DeviceBundle[]>;
  getGroupRecipientDeviceBundles: (jid: string) => Promise<DeviceBundle[]>;
  getRecipientDeviceBundles: (jid: string) => Promise<DeviceBundle[]>;
};

const resolveEncryptionRecipients = async (
  service: XmppRecipientResolver,
  targetJid: string,
  stanzaType: 'chat' | 'groupchat'
): Promise<DeviceBundle[]> => {
  if (typeof service.getEncryptionRecipientsForTarget === 'function') {
    return service.getEncryptionRecipientsForTarget(targetJid, stanzaType);
  }

  return stanzaType === 'groupchat'
    ? service.getGroupRecipientDeviceBundles(targetJid)
    : service.getRecipientDeviceBundles(targetJid);
};

// Global Tap Effect Component
const GlobalTapEffects = () => {
  const [taps, setTaps] = useState<{id: number, x: number, y: number}[]>([]);
  const tapsRef = useRef(taps);

  useEffect(() => {
      tapsRef.current = taps;
  }, [taps]);

  const handleClick = useCallback((e: MouseEvent) => {
      // Limit taps to avoid performance issues on rapid fire
      if (tapsRef.current.length > 10) return;

      const id = Date.now() + Math.random();
      setTaps(prev => [...prev, { id, x: e.clientX, y: e.clientY }]);

      // Cleanup after animation
      setTimeout(() => {
          setTaps(prev => prev.filter(t => t.id !== id));
      }, 600);
  }, []);

  useEffect(() => {
      window.addEventListener('mousedown', handleClick);
      return () => window.removeEventListener('mousedown', handleClick);
  }, [handleClick]);

  return (
    <>
      {taps.map(tap => (
          <div 
              key={tap.id} 
              className="tap-effect"
              style={{ left: tap.x, top: tap.y }}
          />
      ))}
    </>
  );
};


const applySnapshotToAppState = (baseState: AppState, snapshot: SyncSnapshot): AppState => {
  const chatMeta = snapshot.chats || {};
  const nextChats = baseState.chats.map((chat) => {
    const synced = chatMeta[chat.id];
    if (!synced) return chat;
    return {
      ...chat,
      isMuted: synced.isMuted ?? chat.isMuted,
      isPinned: synced.isPinned ?? chat.isPinned,
    };
  });

  const nextScheduled = Object.fromEntries(
    Object.entries(snapshot.scheduled || {}).map(([chatId, list]) => [
      chatId,
      list.map((msg) => ({
        id: msg.id,
        chatId,
        senderId: baseState.currentUser?.id || 'unknown',
        text: msg.text,
        timestamp: msg.timestamp,
        status: MessageStatus.SCHEDULED,
        type: msg.type,
        mediaUrl: msg.mediaUrl,
        replyToId: msg.replyToId,
        scheduledFor: msg.scheduledFor,
        reactions: [],
      })),
    ])
  );

  return {
    ...baseState,
    chats: nextChats,
    scheduledMessages: nextScheduled,
    theme: snapshot.prefs.theme,
    notifications: snapshot.prefs.notifications,
    soundSettings: mergeSoundSettings(snapshot.prefs.soundSettings),
    language: snapshot.prefs.language,
  };
};


const normalizeChatForState = (chat: Chat): Chat => {
  const resolvedSecurityMode = resolveChatSecurityMode(chat.securityMode);
  if (chat.type !== ChatType.PRIVATE) {
    return {
      ...chat,
      securityMode: resolvedSecurityMode,
    };
  }

  const parsed = parsePrivateChatId(chat.id);
  const fallbackPeer = normalizeBareJid(chat.participants.find((participantId) => participantId.includes('@') || participantId.includes('/')) || '');
  const peerJid = parsed?.peerJid || fallbackPeer;
  const normalizedId = peerJid ? buildPrivateChatId(peerJid, parsed?.securityMode || resolvedSecurityMode) : chat.id;

  return {
    ...chat,
    id: normalizedId,
    securityMode: parsed?.securityMode || resolvedSecurityMode,
  };
};

const getChatLastMessageTimestamp = (chat: Chat): number => {
  return typeof chat.lastMessage?.timestamp === 'number' ? chat.lastMessage.timestamp : Number.NEGATIVE_INFINITY;
};

const mergeChatsById = (existing: Chat, incoming: Chat): Chat => {
  const existingTimestamp = getChatLastMessageTimestamp(existing);
  const incomingTimestamp = getChatLastMessageTimestamp(incoming);
  const latestChat = incomingTimestamp >= existingTimestamp ? incoming : existing;
  const latestLastMessage = incomingTimestamp >= existingTimestamp ? incoming.lastMessage : existing.lastMessage;

  return {
    ...latestChat,
    participants: Array.from(new Set([...existing.participants, ...incoming.participants])),
    unreadCount: Math.max(existing.unreadCount, incoming.unreadCount),
    lastMessage: latestLastMessage,
  };
};

export const normalizeChatsForState = (value: unknown): Chat[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((entry): entry is Chat => Boolean(entry && typeof entry === 'object' && typeof (entry as Chat).id === 'string'))
    .map((entry) => normalizeChatForState(entry));

  const chatsById = new Map<string, Chat>();
  normalized.forEach((chat) => {
    const existing = chatsById.get(chat.id);
    if (!existing) {
      chatsById.set(chat.id, chat);
      return;
    }

    chatsById.set(chat.id, mergeChatsById(existing, chat));
  });

  return Array.from(chatsById.values());
};

const restoreCachedDirectory = (value: unknown): User[] => {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is User => Boolean(entry && typeof entry === 'object' && typeof (entry as User).id === 'string'))
    .map((entry) => {
      const normalizedId = normalizeBareJid(entry.id);
      return {
        ...entry,
        id: normalizedId,
        jid: entry.jid ? normalizeBareJid(entry.jid) : normalizedId,
        username: entry.username || normalizedId.split('@')[0],
        isOnline: Boolean(entry.isOnline),
      };
    });
};

const sanitizeOutboxTaskForPersistence = (task: OutboxTask): OutboxTask => ({
  ...task,
  payload: {
    ...task.payload,
    media: task.payload.media
      ? {
          attachmentId: task.payload.media.attachmentId,
          fileName: task.payload.media.fileName,
          mime: task.payload.media.mime,
          size: task.payload.media.size,
          type: task.payload.media.type,
          encryptedAttachmentId: task.payload.media.encryptedAttachmentId,
        }
      : undefined,
  },
});

const isBlobLikeObject = (value: unknown): value is Blob => {
  return typeof Blob !== 'undefined' && value instanceof Blob;
};

const restoreOutboxTasks = (value: unknown): { tasks: OutboxTask[]; attachmentIds: Set<string> } => {
  if (!Array.isArray(value)) return { tasks: [], attachmentIds: new Set() };

  const invalidTaskIds = new Set<string>();
  const attachmentIds = new Set<string>();

  const normalized = value
    .filter((entry): entry is OutboxTask => Boolean(entry && typeof entry === 'object' && typeof (entry as OutboxTask).id === 'string'))
    .map((task) => {
      const media = task.payload?.media;
      if (!media) return { ...task, payload: { ...task.payload, media: undefined } };

      const hasLegacyBlob = Object.prototype.hasOwnProperty.call(media, 'blob');
      const blobValue = (media as PendingMediaPayload).blob;
      const hasValidAttachment = typeof media.attachmentId === 'string' && media.attachmentId.length > 0;

      if (hasLegacyBlob && !isBlobLikeObject(blobValue) && !hasValidAttachment) {
        invalidTaskIds.add(task.id);
      }

      if (!hasValidAttachment) {
        invalidTaskIds.add(task.id);
      } else {
        attachmentIds.add(media.attachmentId!);
      }

      return {
        ...task,
        payload: {
          ...task.payload,
          media: {
            attachmentId: media.attachmentId,
            fileName: media.fileName,
            mime: media.mime,
            size: media.size,
            type: media.type,
            encryptedAttachmentId: media.encryptedAttachmentId,
          },
        },
      };
    });

  normalized.forEach((task) => {
    if (task.type === 'media-message' && task.payload.uploadTaskId && invalidTaskIds.has(task.payload.uploadTaskId)) {
      invalidTaskIds.add(task.id);
    }
  });

  return {
    tasks: normalized.filter(task => !invalidTaskIds.has(task.id)),
    attachmentIds,
  };
};

const makeSyncOp = <T extends SyncOperation['type']>(type: T, payload: Omit<Extract<SyncOperation, { type: T }>, 'type' | 'id' | 'timestamp'>): Extract<SyncOperation, { type: T }> => {
  return {
    id: `op-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: Date.now(),
    type,
    ...(payload as any),
  };
};

const areSyncOpListsEqual = (left: SyncOperation[], right: SyncOperation[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((op, index) => op.id === right[index]?.id);
};

const HYDRATION_RETRY_BACKOFF_MS = [1000, 3000, 10000] as const;
const RECONNECT_COALESCE_WINDOW_MS = 4000;
const RECONNECT_WORKFLOW_STALE_BUFFER_MS = 2000;

export const shouldSkipReconnectWhileWorkflowActive = ({
  isWorkflowActive,
  activeReconnectAttemptId,
  reconnectWorkflowSeenAt,
  now,
  guardTimeoutMs,
  staleBufferMs = RECONNECT_WORKFLOW_STALE_BUFFER_MS,
}: {
  isWorkflowActive: boolean;
  activeReconnectAttemptId: number | null;
  reconnectWorkflowSeenAt: { attemptId: number | null; seenAt: number } | null;
  now: number;
  guardTimeoutMs: number;
  staleBufferMs?: number;
}): {
  shouldSkip: boolean;
  workflowAgeMs: number;
  nextReconnectWorkflowSeenAt: { attemptId: number | null; seenAt: number } | null;
  reconnectWorkflowStaleMs: number;
} => {
  if (!isWorkflowActive) {
    return {
      shouldSkip: false,
      workflowAgeMs: 0,
      nextReconnectWorkflowSeenAt: null,
      reconnectWorkflowStaleMs: guardTimeoutMs + staleBufferMs,
    };
  }

  const isSameAttempt = reconnectWorkflowSeenAt?.attemptId === activeReconnectAttemptId;
  const nextReconnectWorkflowSeenAt = isSameAttempt
    ? reconnectWorkflowSeenAt
    : { attemptId: activeReconnectAttemptId, seenAt: now };
  const workflowAgeMs = now - nextReconnectWorkflowSeenAt.seenAt;
  const reconnectWorkflowStaleMs = guardTimeoutMs + staleBufferMs;

  return {
    shouldSkip: workflowAgeMs < reconnectWorkflowStaleMs,
    workflowAgeMs,
    nextReconnectWorkflowSeenAt,
    reconnectWorkflowStaleMs,
  };
};

type BootstrapConnectPlan = {
  shouldSkip: boolean;
  skipReason?: 'workflow-active-xmpp-service';
  connectMode?: 'direct-connect' | 'reconnect-now';
};

export const resolveBootstrapConnectPlan = ({
  isWorkflowActive,
  hasSessionCredentials,
}: {
  isWorkflowActive: boolean;
  hasSessionCredentials: boolean;
}): BootstrapConnectPlan => {
  if (isWorkflowActive) {
    return {
      shouldSkip: true,
      skipReason: 'workflow-active-xmpp-service',
    };
  }

  return {
    shouldSkip: false,
    connectMode: hasSessionCredentials ? 'reconnect-now' : 'direct-connect',
  };
};

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  const [lockConfig, setLockConfig] = useState<LockConfig | null>(null);
  const [localCallStream, setLocalCallStream] = useState<MediaStream | null>(null);
  const [remoteCallStream, setRemoteCallStream] = useState<MediaStream | null>(null);
  const pendingIncomingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);

  const stateRef = useRef(state);
  const userDirectoryRef = useRef<User[]>([]);
  const connectionAttemptedRef = useRef(false);
  const onlineReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReconnectAttemptAtRef = useRef(0);
  const reconnectWorkflowSeenAtRef = useRef<{ attemptId: number | null; seenAt: number } | null>(null);
  const processedGroupInvitesRef = useRef<Set<string>>(new Set());
  const seenGroupMessageKeysRef = useRef<Map<string, number>>(new Map());
  const xmppListenersInitializedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const attemptCoalescedReconnect = useCallback((source: 'app:visibilitychange' | 'app:online') => {
    const now = Date.now();
    const status = xmppService.getStatus();
    const activeReconnectAttemptId = xmppService.activeReconnectAttemptId;

    if (status === 'CONNECTING') {
      console.log('[App][Reconnect] skipped', {
        reason: 'already-connecting',
        source,
        status,
        attemptId: activeReconnectAttemptId,
      });
      return;
    }

    const guardTimeoutMs = getReconnectGuardTimeoutMs();
    const workflowGate = shouldSkipReconnectWhileWorkflowActive({
      isWorkflowActive: xmppService.isReconnectWorkflowActive,
      activeReconnectAttemptId,
      reconnectWorkflowSeenAt: reconnectWorkflowSeenAtRef.current,
      now,
      guardTimeoutMs,
    });
    reconnectWorkflowSeenAtRef.current = workflowGate.nextReconnectWorkflowSeenAt;

    if (workflowGate.shouldSkip) {
      console.log('[App][Reconnect] skipped', {
        reason: 'workflow-active',
        source,
        attemptId: activeReconnectAttemptId,
        workflowAgeMs: workflowGate.workflowAgeMs,
        guardTimeoutMs,
        staleAfterMs: workflowGate.reconnectWorkflowStaleMs,
      });
      return;
    }

    const elapsedSinceLastAttempt = now - lastReconnectAttemptAtRef.current;
    if (elapsedSinceLastAttempt < RECONNECT_COALESCE_WINDOW_MS) {
      console.log('[App][Reconnect] skipped', {
        reason: 'throttled',
        source,
        attemptId: activeReconnectAttemptId,
        elapsedSinceLastAttempt,
        throttleMs: RECONNECT_COALESCE_WINDOW_MS,
      });
      return;
    }

    reconnectWorkflowSeenAtRef.current = null;
    lastReconnectAttemptAtRef.current = now;
    console.log('[App] App foreground/online event, ensuring connection...', {
      source,
      workflowAgeMs: workflowGate.workflowAgeMs,
      guardTimeoutMs,
    });
    xmppService.reconnectNow(source);
  }, []);


  useEffect(() => {
    soundNotificationService.preload();
  }, []);

  useEffect(() => {
    const isIncomingRinging = state.callState.direction === 'incoming' && state.callState.status === 'ringing';
    if (isIncomingRinging) {
      void soundNotificationService.startIncomingRingtone(state.soundSettings);
      return;
    }

    soundNotificationService.stopIncomingRingtone();
  }, [state.callState.direction, state.callState.status, state.soundSettings]);
  useEffect(() => {
    void outboxService.init();

    outboxService.on('onMessageStatus', ({ clientId, chatId, status, attempt, nextRetryAt }) => {
      if (status === MessageStatus.FAILED) {
        logMessageTelemetry('sent_not_delivered', {
          chatId,
          clientId,
          attempt: attempt || 0
        });
      }
      setState(prev => {
        const chatMessages = prev.messages[chatId] || [];
        const targetIndex = chatMessages.findIndex(msg => msg.clientId === clientId);
        if (targetIndex < 0) return prev;

        const nextForChat = [...chatMessages];
        nextForChat[targetIndex] = {
          ...nextForChat[targetIndex],
          status,
          outboxAttempt: attempt,
          outboxNextRetryAt: nextRetryAt,
          outboxState: status === MessageStatus.SENT
            ? 'sent'
            : status === MessageStatus.FAILED
              ? 'failed'
              : status === MessageStatus.QUEUED
                ? 'queued'
                : 'sending'
        };

        return {
          ...prev,
          messages: {
            ...prev.messages,
            [chatId]: nextForChat
          }
        };
      });
    });
  }, []);


  useEffect(() => {
    const capabilities = callService.getPlatformCapabilities();
    setState(prev => ({
      ...prev,
      callState: {
        ...prev.callState,
        platformHint: capabilities.platform,
        canUseSpeakerToggle: capabilities.canSelectAudioOutput,
      }
    }));

    callService.on('state', (partial) => {
      setState(prev => ({
        ...prev,
        callState: {
          ...prev.callState,
          ...partial,
          chatId: partial.peerJid ? buildPrivateChatId(partial.peerJid, 'transport') : prev.callState.chatId,
        }
      }));
    });

    callService.on('localStream', setLocalCallStream);
    callService.on('remoteStream', setRemoteCallStream);
    callService.on('signal', ({ to, payload }) => xmppService.sendCallSignal(to, payload));
    callService.on('ended', () => {
      pendingIncomingOfferRef.current = null;
      setState(prev => ({
        ...prev,
        callState: {
          ...INITIAL_CALL_STATE,
          platformHint: prev.callState.platformHint,
          canUseSpeakerToggle: prev.callState.canUseSpeakerToggle,
        }
      }));
    });

    return () => {
      // singleton handlers intentionally persist for app lifetime
    };
  }, []);

  useEffect(() => {
    callService.configureE2EE({
      getOwnJid: () => normalizeBareJid(stateRef.current.currentUser?.id || xmppService.currentUserJid || ''),
      getPeerDeviceBundles: (peerJid: string) => xmppService.getEncryptionRecipientsForTarget(peerJid, 'chat'),
    });
  }, [state.currentUser?.id]);

  const [userDirectory, setUserDirectory] = useState<User[]>([]);
  const [incomingPresenceRequests, setIncomingPresenceRequests] = useState<User[]>([]);
  const incomingPresenceRequestTsRef = useRef<Map<string, number>>(new Map());
  const createChatAllowanceRef = useRef<Map<string, { securityMode: ChatSecurityMode; expiresAt: number }>>(new Map());

  useEffect(() => {
    userDirectoryRef.current = userDirectory;
  }, [userDirectory]);
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showContacts, setShowContacts] = useState(false); // NEW
  const [searchQuery, setSearchQuery] = useState('');
  const [globalChannelResults, setGlobalChannelResults] = useState<ChannelDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [runtimeCapability, setRuntimeCapability] = useState<RuntimeCapabilityResult | null>(null);
  const [isRuntimeDegraded, setIsRuntimeDegraded] = useState(false);
  const [showRuntimeDiagnostics, setShowRuntimeDiagnostics] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [syncEnvelope, setSyncEnvelope] = useState<SyncStateEnvelope>(createInitialSyncEnvelope());
  const [pendingSyncOps, setPendingSyncOps] = useState<SyncOperation[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'conflict' | 'offline' | 'error'>('idle');
  const [syncConflicts, setSyncConflicts] = useState<string[]>([]);
  const isSyncInFlightRef = useRef(false);
  const syncEnvelopeRef = useRef(syncEnvelope);
  const currentRevision = useMemo(() => syncEnvelope.snapshot.revision, [syncEnvelope.snapshot.revision]);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [galleryInitialId, setGalleryInitialId] = useState<string | null>(null);
  const [swRegistration, setSwRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [isReloadingForUpdate, setIsReloadingForUpdate] = useState(false);
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  
  const [messageToForward, setMessageToForward] = useState<Message | null>(null);
  const [unencryptedMediaDialog, setUnencryptedMediaDialog] = useState<{ taskId: string; open: boolean }>({ taskId: '', open: false });
  const [contactApprovalModal, setContactApprovalModal] = useState<{ open: boolean; peerJid: string; routeSource: 'composer_guard_block' | 'outgoing_guard_block' }>({
    open: false,
    peerJid: '',
    routeSource: 'composer_guard_block',
  });
  const unencryptedMediaDecisionResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const [peerCapabilitiesVersion, setPeerCapabilitiesVersion] = useState(0);
  const navigationDepthRef = useRef(0);
  const isNavigatingBackRef = useRef(false);
  const hasInternalOverlayRef = useRef(false);
  const androidBackLastTsRef = useRef(0);
  const androidBackLockRef = useRef(false);
  const t = TRANSLATIONS[state.language];

  const getNavigationLayerDepth = useCallback(() => {
    let depth = 0;
    if (state.activeChatId) depth += 1;
    if (showProfile) depth += 1;
    if (galleryInitialId) depth += 1;
    if (showSettings) depth += 1;
    if (showContacts) depth += 1;
    if (showNewChat) depth += 1;
    if (showNewGroup) depth += 1;
    if (showNewChannel) depth += 1;
    if (messageToForward) depth += 1;
    if (unencryptedMediaDialog.open) depth += 1;
    if (contactApprovalModal.open) depth += 1;
    return depth;
  }, [
    contactApprovalModal.open,
    galleryInitialId,
    messageToForward,
    showContacts,
    showNewChannel,
    showNewChat,
    showNewGroup,
    showProfile,
    showSettings,
    state.activeChatId,
    unencryptedMediaDialog.open,
  ]);
  const promptUnencryptedMediaFallback = useCallback((taskId: string) => {
    setUnencryptedMediaDialog({ taskId, open: true });
    return new Promise<boolean>((resolve) => {
      unencryptedMediaDecisionResolverRef.current = resolve;
    });
  }, []);

  const resolveUnencryptedMediaFallback = useCallback((allowed: boolean) => {
    setUnencryptedMediaDialog({ taskId: '', open: false });
    const resolver = unencryptedMediaDecisionResolverRef.current;
    unencryptedMediaDecisionResolverRef.current = null;
    if (resolver) resolver(allowed);
  }, []);


  const closeTopNavigationLayer = useCallback((): boolean => {
    if (contactApprovalModal.open) {
      setContactApprovalModal(prev => ({ ...prev, open: false, peerJid: '' }));
      notificationService.showNotification('Guard', 'Сообщение не отправлено: нет взаимного контакта');
      return true;
    }
    if (unencryptedMediaDialog.open) {
      resolveUnencryptedMediaFallback(false);
      return true;
    }
    if (messageToForward) {
      setMessageToForward(null);
      return true;
    }
    if (showNewChannel) {
      setShowNewChannel(false);
      return true;
    }
    if (showNewGroup) {
      setShowNewGroup(false);
      return true;
    }
    if (showNewChat) {
      setShowNewChat(false);
      return true;
    }
    if (showContacts) {
      setShowContacts(false);
      return true;
    }
    if (galleryInitialId) {
      setGalleryInitialId(null);
      return true;
    }
    if (showSettings) {
      setShowSettings(false);
      return true;
    }
    if (showProfile) {
      setShowProfile(false);
      return true;
    }
    if (state.activeChatId) {
      setState(prev => ({ ...prev, activeChatId: null }));
      return true;
    }
    return false;
  }, [
    contactApprovalModal.open,
    galleryInitialId,
    messageToForward,
    resolveUnencryptedMediaFallback,
    showContacts,
    showNewChannel,
    showNewChat,
    showNewGroup,
    showProfile,
    showSettings,
    state.activeChatId,
    unencryptedMediaDialog.open,
  ]);


  useEffect(() => {
    syncEnvelopeRef.current = syncEnvelope;
  }, [syncEnvelope]);

  useEffect(() => {
    hasInternalOverlayRef.current = getNavigationLayerDepth() > 0;
  }, [getNavigationLayerDepth]);

  useEffect(() => {
    const currentDepth = getNavigationLayerDepth();
    const previousDepth = navigationDepthRef.current;

    if (isNavigatingBackRef.current) {
      navigationDepthRef.current = currentDepth;
      isNavigatingBackRef.current = false;
      return;
    }

    if (currentDepth > previousDepth) {
      const nextToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.history.pushState({ bridgeNavigationDepth: currentDepth, bridgeToken: nextToken }, '', window.location.href);
    }

    navigationDepthRef.current = currentDepth;
  }, [getNavigationLayerDepth]);

  useEffect(() => {
    const handlePopState = () => {
      if (!hasInternalOverlayRef.current) return;
      isNavigatingBackRef.current = true;
      closeTopNavigationLayer();
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [closeTopNavigationLayer]);

  useEffect(() => {
    const capacitorApp = (window as any)?.Capacitor?.Plugins?.App;
    if (!capacitorApp?.addListener) return;

    let removeListener: (() => void) | null = null;
    let releaseBackLockTimer: number | null = null;

    void capacitorApp.addListener('backButton', () => {
      const now = Date.now();
      if (androidBackLockRef.current || now - androidBackLastTsRef.current < ANDROID_BACK_DEBOUNCE_MS) {
        return;
      }

      androidBackLastTsRef.current = now;
      androidBackLockRef.current = true;
      releaseBackLockTimer = window.setTimeout(() => {
        androidBackLockRef.current = false;
      }, ANDROID_BACK_DEBOUNCE_MS);

      const hasInternalStack = getNavigationLayerDepth() > 0;

      if (hasInternalStack) {
        if (navigationDepthRef.current > 0) {
          window.history.back();
          return;
        }

        isNavigatingBackRef.current = true;
        closeTopNavigationLayer();
        return;
      }

      if (window.history.length > 1) {
        isNavigatingBackRef.current = true;
        window.history.back();
        return;
      }

      const confirmedExit = window.confirm(state.language === 'ru' ? 'Выйти из приложения?' : 'Exit app?');
      if (!confirmedExit) return;

      if (typeof capacitorApp.exitApp === 'function') {
        capacitorApp.exitApp();
      }
    }).then((listener: { remove?: () => void }) => {
      removeListener = typeof listener?.remove === 'function' ? listener.remove.bind(listener) : null;
    }).catch((error: unknown) => {
      console.warn('Failed to register hardware back button handler', error);
    });

    return () => {
      if (releaseBackLockTimer !== null) {
        window.clearTimeout(releaseBackLockTimer);
      }
      if (removeListener) removeListener();
    };
  }, [closeTopNavigationLayer, getNavigationLayerDepth, state.language]);

  useEffect(() => {
    const now = Date.now();
    incomingPresenceRequestTsRef.current = new Map(
      incomingPresenceRequests
        .map(user => [normalizeBareJid(user.id), (user as any)._receivedAt || now] as const)
        .filter(([jid]) => Boolean(jid))
    );
  }, [incomingPresenceRequests]);

  const upsertIncomingPresenceRequest = useCallback((peerJid: string) => {
    const bareJid = normalizeBareJid(peerJid);
    if (!bareJid) return;
    const now = Date.now();
    const lastSeen = incomingPresenceRequestTsRef.current.get(bareJid);
    if (lastSeen && now - lastSeen < INCOMING_PRESENCE_REQUEST_TTL_MS) return;

    incomingPresenceRequestTsRef.current.set(bareJid, now);
    setIncomingPresenceRequests(prev => {
      const withoutPeer = prev.filter(user => normalizeBareJid(user.id) !== bareJid);
      const existing = userDirectoryRef.current.find(user => normalizeBareJid(user.id || user.jid || '') === bareJid);
      const user: User = {
        ...(existing || {} as Partial<User>),
        id: bareJid,
        jid: bareJid,
        username: existing?.username || bareJid.split('@')[0],
        isOnline: existing?.isOnline ?? false,
        status: 'Incoming subscription request',
      } as User;
      return [...withoutPeer, { ...user, _receivedAt: now } as User];
    });
  }, []);

  const clearIncomingPresenceRequest = useCallback((peerJid: string) => {
    const bareJid = normalizeBareJid(peerJid);
    if (!bareJid) return;
    incomingPresenceRequestTsRef.current.delete(bareJid);
    setIncomingPresenceRequests(prev => prev.filter(user => normalizeBareJid(user.id) !== bareJid));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      setIncomingPresenceRequests(prev => prev.filter(user => {
        const bareJid = normalizeBareJid(user.id);
        const seenAt = incomingPresenceRequestTsRef.current.get(bareJid);
        if (!seenAt || now - seenAt > INCOMING_PRESENCE_REQUEST_TTL_MS) {
          incomingPresenceRequestTsRef.current.delete(bareJid);
          return false;
        }
        return true;
      }));
    }, 30_000);

    return () => window.clearInterval(interval);
  }, []);

  const applyReactionUpdate = useCallback((chatId: string, messageId: string, emoji: string, userId: string, action: 'add' | 'remove') => {
    let changed = false;

    setState(prev => {
      const chatMessages = prev.messages[chatId] || [];
      const nextMessages = chatMessages.map(message => {
        if (message.id !== messageId && message.clientId !== messageId) return message;
        const mergedReactions = mergeMessageReactions(message.reactions || [], emoji, userId, action);
        if (mergedReactions === message.reactions) return message;
        changed = true;
        return { ...message, reactions: mergedReactions };
      });

      if (!changed) return prev;

      return {
        ...prev,
        messages: {
          ...prev.messages,
          [chatId]: nextMessages
        }
      };
    });

    return changed;
  }, []);




  const resolveDisplayNameById = useCallback((id?: string, chatType: ChatType = ChatType.PRIVATE, fallback = 'Unknown') => {
    const currentLanguage = stateRef.current.language;
    if (chatType === ChatType.SAVED) return TRANSLATIONS[currentLanguage].personalSpace;
    if (!id) return fallback;

    const normalize = (value: string) => {
      const parsedPrivateId = parsePrivateChatId(value);
      if (parsedPrivateId) return parsedPrivateId.peerJid;
      return value.startsWith('chat-') ? value.slice(5) : value;
    };
    const normalizedId = normalize(id);

    const directMatch = userDirectoryRef.current.find(u => [u.id, u.jid].includes(id) || [u.id, u.jid].includes(normalizedId));
    if (directMatch?.username) return directMatch.username;

    const currentUser = stateRef.current.currentUser;
    if (currentUser && ([currentUser.id, currentUser.jid].includes(id) || [currentUser.id, currentUser.jid].includes(normalizedId))) {
      return currentUser.username;
    }

    const localPart = normalizedId.includes('@') ? normalizedId.split('@')[0] : normalizedId;
    return localPart || fallback;
  }, []);

  // --- Ensure Saved Messages Chat Exists ---
  useEffect(() => {
    if (state.currentUser) {
       const savedChatId = `saved-${state.currentUser.id}`;
       setState(prev => {
          if (prev.chats.find(c => c.id === savedChatId)) return prev;
          
          const savedChat: Chat = {
             id: savedChatId,
             type: ChatType.SAVED,
             name: 'Saved Messages', 
             normalizedName: normalizeChannelName('Saved Messages'),
             isHidden: true,
             participants: [state.currentUser!.id],
             unreadCount: 0,
             adminIds: [state.currentUser!.id],
             isPinned: true,
             securityMode: 'transport',
          };
          return { ...prev, chats: mergeChatsUniqueById(prev.chats, [savedChat]) };
       });
    }
  }, [state.currentUser ? state.currentUser.id : null]);

  // Update App Badge
  useEffect(() => {
    const totalUnread = state.chats.reduce((acc, chat) => acc + chat.unreadCount, 0);
    notificationService.setAppBadge(totalUnread);
  }, [state.chats]);

  // --- XMPP Integration ---
  
  useEffect(() => {
    if (xmppListenersInitializedRef.current) return;
    xmppListenersInitializedRef.current = true;

    // XMPP Event Listeners
    xmppService.on('onMessage', (message: Message) => {
        let cacheMigrationCandidate: {
          sourceMessageId: string;
          targetMessageId: string;
          mediaIv?: string;
          mediaKeyEnvelope?: string;
          transportScheme?: string;
        } | null = null;

        const incomingPrivateRouting = resolveIncomingPrivateRouting({
          messageChatId: message.chatId,
          chats: stateRef.current.chats,
          createChatAllowances: createChatAllowanceRef.current,
        });

        if (incomingPrivateRouting.routedChatId) {
          message = { ...message, chatId: incomingPrivateRouting.routedChatId };
        }

        const chatMeta = stateRef.current.chats.find(c => c.id === message.chatId);
        const isSavedChat = chatMeta?.type === ChatType.SAVED || message.chatId.startsWith('saved-');
        const incomingIsPrivate = !isSavedChat && (chatMeta?.type === ChatType.PRIVATE || message.chatId.startsWith('chat-'));
        const isTextOnlyChat = chatMeta?.securityMode === 'e2ee_text_only';
        const hasIncomingMediaPayload = message.type !== 'text' || Boolean(message.mediaUrl) || Boolean(message.mediaCiphertextUrl) || Boolean(message.mediaKeyEnvelope) || Boolean(message.mediaKey);
        if (isTextOnlyChat && hasIncomingMediaPayload) {
          console.warn('[App] Dropping non-text payload in e2ee_text_only chat', { chatId: message.chatId, messageId: message.id, type: message.type });
          return;
        }
        const currentUserId = stateRef.current.currentUser?.id;
        const isFromCurrentUser = isIncomingMessageFromCurrentUser({
          message,
          currentUserId,
          isPrivateChat: incomingIsPrivate,
        });

        const privatePeerJid = getPeerJidFromPrivateChatId(message.chatId) || message.senderId;
        let inboundGuardReason: string | undefined;
        if (incomingIsPrivate && !isFromCurrentUser) {
            const guard = isChannelJid(privatePeerJid)
              ? { allowed: true as const }
              : evaluateInboundPrivateMessage(privatePeerJid, userDirectoryRef.current, message.text || '');
            inboundGuardReason = guard.reason;

            const allowance = createChatAllowanceRef.current.get(normalizeBareJid(privatePeerJid));
            const hasCreateChatAllowance = Boolean(allowance && allowance.expiresAt > Date.now());

            if ((guard.reason === 'pending_request' || guard.shouldRouteToRequests) && !hasCreateChatAllowance) {
                const isNewRequest = routePeerToPendingRequests(privatePeerJid, guard.reason || 'pending_request');
                if (isNewRequest) {
                  notificationService.showNotification('Message Requests', `Message moved to Requests from ${privatePeerJid} (${guard.reason || 'pending_request'})`);
                }
            }

            if (hasCreateChatAllowance) {
              createChatAllowanceRef.current.delete(normalizeBareJid(privatePeerJid));
            }

            if (!guard.allowed && !hasCreateChatAllowance) {
                void moderationService.saveLocalEvent(
                  stateRef.current.currentUser?.id || 'system',
                  privatePeerJid,
                  guard.reason === 'auto_silenced' ? 'silence' : 'reject_message',
                  guard.reasonCode || 'other',
                  { reason: guard.reason || 'unknown' }
                );
                logMessageTelemetry('delivered_rejected_peer_guard', {
                  stage: 'inbound',
                  peerJid: privatePeerJid,
                  reason: guard.reason || 'unknown'
                });
                console.warn('[App] Ignoring private message due to guard', guard.reason, privatePeerJid);
                return;
            }
        }

        if (message.chatId && !message.chatId.startsWith('chat-') && !message.chatId.startsWith('saved-')) {
            const targetChat = stateRef.current.chats.find(c => c.id === message.chatId);
            if (targetChat && (targetChat.type === ChatType.GROUP || targetChat.type === ChatType.CHANNEL)) {
              const incomingModeration = validateIncomingGroupMessage(targetChat, message.text || '');
              if (!incomingModeration.allowed) {
                void moderationService.saveLocalEvent(
                  stateRef.current.currentUser?.id || 'system',
                  message.senderId,
                  'reject_message',
                  'spam',
                  { chatId: message.chatId, reason: incomingModeration.reason || 'unknown' }
                );
                return;
              }
            }
            const now = Date.now();
            const signatureBase = `${message.chatId}|${message.senderId}|${message.type}|${message.text}|${message.mediaUrl || ''}`;
            const roundedBucket = Math.floor(message.timestamp / 2000);
            const signature = `${signatureBase}|${roundedBucket}`;
            const keys = [message.id, message.clientId || '', signature].filter(Boolean);

            for (const key of keys) {
                const previous = seenGroupMessageKeysRef.current.get(key);
                if (previous && now - previous < 2 * 60 * 1000) {
                    return;
                }
            }

            keys.forEach(key => seenGroupMessageKeysRef.current.set(key, now));
            if (seenGroupMessageKeysRef.current.size > 1500) {
                const entries = Array.from(seenGroupMessageKeysRef.current.entries()).sort((a, b) => a[1] - b[1]);
                for (let i = 0; i < 500; i++) {
                    const candidate = entries[i];
                    if (!candidate) break;
                    seenGroupMessageKeysRef.current.delete(candidate[0]);
                }
            }
        }

        setState(prev => {
            const existingChat = prev.chats.find(c => c.id === message.chatId);
            let chat = existingChat;

            if (!chat) {
                const isSaved = message.chatId.startsWith('saved-');
                const isPrivate = message.chatId.startsWith('chat-');
                const isGroup = !isSaved && !isPrivate;
                const inferredChatType = isSaved
                  ? ChatType.SAVED
                  : (isGroup ? ChatType.GROUP : ChatType.PRIVATE);

                const chatName = resolveDisplayNameById(
                  message.chatId,
                  inferredChatType,
                  resolveDisplayNameById(message.senderId)
                );

                chat = {
                    id: message.chatId,
                    type: inferredChatType,
                    name: chatName,
                    normalizedName: normalizeChannelName(chatName),
                    isHidden: inferredChatType === ChatType.PRIVATE || inferredChatType === ChatType.SAVED,
                    participants: [message.senderId, prev.currentUser ? prev.currentUser.id : ''],
                    unreadCount: 0,
                    adminIds: [],
                    lastMessage: message,
                    securityMode: inferredChatType === ChatType.PRIVATE
                      ? (parsePrivateChatId(message.chatId)?.securityMode || 'transport')
                      : resolveChatSecurityMode(undefined),
                };
            } else {
                chat = {
                    ...chat,
                    lastMessage: message,
                    unreadCount: (prev.activeChatId === message.chatId) ? chat.unreadCount : chat.unreadCount + 1
                };
            }

            const newChats = mergeChatsUniqueById(prev.chats, [chat]);

            // Append / reconcile message
            const currentMessages = prev.messages[message.chatId] || [];
            const messageForState = inboundGuardReason === 'pending_request'
              ? { ...message, text: `[Request inbox: ${inboundGuardReason}] ${message.text || ''}`.trim() }
              : message;

            if (currentMessages.some(m => m.id === messageForState.id)) return prev;

            let newMsgList = currentMessages;
            let reconciled = false;

            if (message.clientId) {
                const optimisticIdx = currentMessages.findIndex(m => m.clientId === messageForState.clientId && (m.status === MessageStatus.SENDING || m.status === MessageStatus.QUEUED || m.status === MessageStatus.FAILED));
                if (optimisticIdx >= 0) {
                    const optimisticMessage = currentMessages[optimisticIdx];
                    if (
                      optimisticMessage
                      && optimisticMessage.id
                      && optimisticMessage.id !== messageForState.id
                      && (messageForState.type === 'image' || messageForState.type === 'video' || messageForState.type === 'audio' || messageForState.type === 'file')
                    ) {
                      cacheMigrationCandidate = {
                        sourceMessageId: optimisticMessage.id,
                        targetMessageId: messageForState.id,
                        mediaIv: messageForState.mediaIv,
                        mediaKeyEnvelope: messageForState.mediaKeyEnvelope,
                        transportScheme: messageForState.mediaTransportScheme || messageForState.encryptionScheme,
                      };
                    }
                    newMsgList = [...currentMessages];
                    newMsgList[optimisticIdx] = { ...messageForState, status: MessageStatus.SENT };
                    reconciled = true;
                }
            }

            if (!reconciled) {
                const isStrictDuplicate = currentMessages.some(m => {
                    if (m.id === messageForState.id) return true;
                    if (messageForState.clientId && m.clientId && m.clientId === messageForState.clientId) return true;
                    if (m.senderId !== messageForState.senderId || m.type !== messageForState.type || m.text !== messageForState.text) return false;
                    if ((m.mediaUrl || '') !== (messageForState.mediaUrl || '')) return false;
                    return Math.abs(m.timestamp - messageForState.timestamp) < 1000;
                });
                if (isStrictDuplicate) return prev;

                const shouldAppend = currentMessages.length === 0
                    || currentMessages[currentMessages.length - 1].timestamp <= message.timestamp;
                newMsgList = shouldAppend
                    ? [...currentMessages, messageForState]
                    : [...currentMessages, messageForState].sort((a,b) => a.timestamp - b.timestamp);
            }

            return {
                ...prev,
                chats: newChats,
                messages: {
                    ...prev.messages,
                    [message.chatId]: newMsgList
                }
            };
        });

        if (cacheMigrationCandidate) {
          const migration = cacheMigrationCandidate;
          void (async () => {
            try {
              const cachedMedia = await dbService.getMediaCacheEntry<{
                mediaBlob?: Blob;
                ciphertextBlob?: Blob;
                mime?: string;
                size?: number;
              }>(migration.sourceMessageId);
              const blobToPersist = (cachedMedia?.mediaBlob instanceof Blob
                ? cachedMedia.mediaBlob
                : (cachedMedia?.ciphertextBlob instanceof Blob ? cachedMedia.ciphertextBlob : null));
              if (!blobToPersist) return;

              await dbService.saveMediaCacheEntry(migration.targetMessageId, blobToPersist, {
                messageId: migration.targetMessageId,
                mime: cachedMedia?.mime || blobToPersist.type,
                size: typeof cachedMedia?.size === 'number' ? cachedMedia.size : blobToPersist.size,
                mediaIv: migration.mediaIv,
                mediaKeyEnvelope: migration.mediaKeyEnvelope,
                transportScheme: migration.transportScheme,
                isEncrypted: false,
              });
            } catch (cacheMigrationError) {
              console.warn('[Outbox] Failed to migrate local media cache to server message id', {
                sourceMessageId: migration.sourceMessageId,
                targetMessageId: migration.targetMessageId,
                cacheMigrationError,
              });
            }
          })();
        }
        
        // Notify
        const latestChatMeta = stateRef.current.chats.find(c => c.id === message.chatId);
        const isMutedChat = !!latestChatMeta?.isMuted;
        playIncomingMessageToneIfNeeded({
          message,
          currentUserId,
          isFromCurrentUser,
          isMutedChat,
          soundSettings: stateRef.current.soundSettings,
          activeChatId: stateRef.current.activeChatId,
        }, soundNotificationService.playMessageTone.bind(soundNotificationService));

        if (stateRef.current.notifications && !isMutedChat && stateRef.current.activeChatId !== message.chatId) {
            notificationService.showNotification(resolveDisplayNameById(message.senderId), message.text);
        }
    });

    xmppService.on('onRoster', (users: User[]) => {
        setUserDirectory(prev => {
            const prevMap = new Map<string, User>(prev.map(u => [normalizeBareJid(u.id), u]));
            return users.map(u => {
              const normalized = normalizeBareJid(u.id);
              const existing = prevMap.get(normalized);
              return {
                ...(existing || {} as Partial<User>),
                ...u,
                isOnline: existing ? existing.isOnline : u.isOnline,
                status: existing ? existing.status : u.status,
                contactStatus: resolveContactStatus(u)
              } as User;
            });
        });
    });

    xmppService.on('onPresence', (presence: { id: string, isOnline: boolean, status: string }) => {
        const presenceBareJid = normalizeBareJid(presence.id);
        setUserDirectory(prev => prev.map(u => {
            if (normalizeBareJid(u.id) === presenceBareJid || normalizeBareJid(u.jid || '') === presenceBareJid) {
                return { ...u, isOnline: presence.isOnline, status: presence.status };
            }
            return u;
        }));
    });

    xmppService.on('onPeerCapabilities', () => {
        setPeerCapabilitiesVersion(prev => prev + 1);
    });

    xmppService.on('onAccessControlChanged', () => {
        setUserDirectory(prev => [...prev]);
    });

    xmppService.on('onReaction', (payload: { chatId: string; messageId: string; emoji: string; userId: string; action: 'add' | 'remove' }) => {
        applyReactionUpdate(payload.chatId, payload.messageId, payload.emoji, payload.userId, payload.action);
    });

    xmppService.on('onSubscriptionApproved', (data: { from: string }) => {
        const fromJid = normalizeBareJid(data.from);
        if (!fromJid) return;
        clearIncomingPresenceRequest(fromJid);
        setUserDirectory(prev => {
          const exists = prev.some(user => normalizeBareJid(user.id) === fromJid);
          if (!exists) {
            return [...prev, { id: fromJid, jid: fromJid, username: fromJid.split('@')[0], isOnline: false, status: 'Offline', subscription: 'both', ask: null, contactStatus: 'mutual' } as User];
          }
          return prev.map(user =>
            normalizeBareJid(user.id) === fromJid
              ? { ...user, subscription: 'both', ask: null, contactStatus: 'mutual' }
              : user
          );
        });
    });

    xmppService.on('onSubscriptionRequest', (data: { from: string }) => {
         const fromJid = normalizeBareJid(data.from);
         const currentUserBareJid = normalizeBareJid(stateRef.current.currentUser?.id || xmppService.currentUserJid || '');
         if (!fromJid || (currentUserBareJid && fromJid === currentUserBareJid)) return;
         upsertIncomingPresenceRequest(fromJid);
         notificationService.showNotification("System", `Incoming contact request from ${data.from}`);
    });


    xmppService.on('onCallSignal', async (data: { from: string, signal: any }) => {
        try {
            await handleXmppCallSignal({
                data,
                getCurrentUserBareJid: () => normalizeBareJid(stateRef.current.currentUser?.id || xmppService.currentUserJid || ''),
                pendingIncomingOfferRef,
                handleSignal: (from, signal) => callService.handleSignal(from, signal),
                showNotification: (title, body) => notificationService.showNotification(title, body),
                resolveSecurityModeForPeerJid: (peerBareJid) => {
                    const secureChatId = buildPrivateChatId(peerBareJid, 'e2ee_text_only');
                    const hasSecureChat = stateRef.current.chats.some(chat => chat.id === secureChatId);
                    return hasSecureChat ? 'e2ee_text_only' : 'transport';
                },
            });
        } catch (error) {
            console.warn('[Call] Failed to process call signal', data.signal?.action, error);
        }
    });


    xmppService.on('onChatControl', (data: { from: string, control: { action?: string; chatId?: string; peerJid?: string; securityMode?: ChatSecurityMode } }) => {
      if (data.control?.action !== 'create-chat') return;
      const fromBareJid = normalizeBareJid(data.from);
      const securityMode = resolveChatSecurityMode(data.control.securityMode);
      const chatId = data.control.chatId || buildPrivateChatId(fromBareJid, securityMode);
      if (!fromBareJid || !chatId) return;

      createChatAllowanceRef.current.set(fromBareJid, {
        securityMode,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      setState(prev => {
        if (!prev.currentUser) return prev;
        return {
          ...prev,
          chats: dedupeChatsById(materializePrivateChatFromCreateControl(prev.chats, {
            chatId,
            currentUserId: prev.currentUser.id,
            peerJid: fromBareJid,
            securityMode,
            peerDisplayName: resolveDisplayNameById(fromBareJid, ChatType.PRIVATE, fromBareJid.split('@')[0] || fromBareJid),
          })),
        };
      });
    });

    xmppService.on('onChatDeleted', (data: { from: string, chatId?: string }) => {
        const fallbackPeerJid = normalizeBareJid(data.from);
        const targetPeerJid = parsePrivateChatId(data.chatId || '')?.peerJid || fallbackPeerJid;
        setState(prev => {
            const privateChatIdsToDelete = prev.chats
              .filter(chat => chat.type === ChatType.PRIVATE && getPeerJidFromPrivateChatId(chat.id) === targetPeerJid)
              .map(chat => chat.id);

            if (privateChatIdsToDelete.length === 0) {
              const fallbackChatId = data.chatId || buildPrivateChatId(data.from, 'transport');
              if (fallbackChatId) privateChatIdsToDelete.push(fallbackChatId);
            }

            if (privateChatIdsToDelete.length === 0) return prev;

            const nextMessages = { ...prev.messages };
            const nextScheduled = { ...prev.scheduledMessages };

            privateChatIdsToDelete.forEach((chatId) => {
              xmppService.releaseMediaBlobUrlsForChat(chatId);
              const cacheKeys = (prev.messages[chatId] || []).map((message) => message.id);
              void dbService.deleteMediaCacheEntries(cacheKeys).catch((error) => console.warn('Failed to cleanup media cache for deleted chat', error));
              delete nextMessages[chatId];
              delete nextScheduled[chatId];
            });

            return {
                ...prev,
                chats: prev.chats.filter(c => !privateChatIdsToDelete.includes(c.id)),
                messages: nextMessages,
                scheduledMessages: nextScheduled,
                activeChatId: prev.activeChatId && privateChatIdsToDelete.includes(prev.activeChatId) ? null : prev.activeChatId
            };
        });
    });

    xmppService.on('onMessageRetracted', (data: { chatId: string, messageId: string, actor: string }) => {
        xmppService.releaseMediaBlobUrlForMessage(data.messageId);
        void dbService.deleteMediaCacheEntry(data.messageId).catch((error) => console.warn('Failed to cleanup media cache for retracted message', error));
        setState(prev => {
            const currentMessages = prev.messages[data.chatId] || [];
            const nextMessagesForChat = currentMessages.filter(msg => msg.id !== data.messageId);

            if (nextMessagesForChat.length === currentMessages.length) {
                return prev;
            }

            const nextLastMessage = nextMessagesForChat[nextMessagesForChat.length - 1];

            return {
                ...prev,
                messages: {
                    ...prev.messages,
                    [data.chatId]: nextMessagesForChat
                },
                chats: prev.chats.map(chat =>
                    chat.id === data.chatId
                      ? { ...chat, lastMessage: nextLastMessage }
                      : chat
                )
            };
        });
    });

    xmppService.on('onMessageDeliveryUpdate', (data: { chatId: string; messageId: string; clientId?: string; status: MessageStatus }) => {
        const rankByStatus: Record<MessageStatus, number> = {
          [MessageStatus.QUEUED]: 0,
          [MessageStatus.SENDING]: 1,
          [MessageStatus.RETRY]: 1,
          [MessageStatus.FAILED]: 1,
          [MessageStatus.SENT]: 2,
          [MessageStatus.DELIVERED]: 3,
          [MessageStatus.READ]: 4,
          [MessageStatus.SCHEDULED]: 0,
        };

        setState(prev => {
            const chatMessages = prev.messages[data.chatId] || [];
            const nextMessages = chatMessages.map(message => {
              const matches = message.id === data.messageId || (!!data.clientId && message.clientId === data.clientId);
              if (!matches) return message;
              const currentRank = rankByStatus[message.status] ?? 0;
              const nextRank = rankByStatus[data.status] ?? 0;
              if (nextRank < currentRank) return message;
              return { ...message, status: data.status };
            });

            if (nextMessages.every((msg, index) => msg === chatMessages[index])) {
              return prev;
            }

            const nextLastMessage = nextMessages[nextMessages.length - 1];
            return {
              ...prev,
              messages: {
                ...prev.messages,
                [data.chatId]: nextMessages
              },
              chats: prev.chats.map(chat =>
                chat.id === data.chatId && chat.lastMessage
                  ? {
                      ...chat,
                      lastMessage: (chat.lastMessage.id === data.messageId || (!!data.clientId && chat.lastMessage.clientId === data.clientId))
                        ? { ...chat.lastMessage, status: data.status }
                        : (nextLastMessage || chat.lastMessage)
                    }
                  : chat
              )
            };
        });
    });

    xmppService.on('onSendMessageResult', (payload: {
      clientId?: string;
      success: boolean;
      deliveryStatus?: SendMessageDeliveryStatus;
      reasonCode?: 'OMEMO_KEYS_MISSING_FALLBACK_USED' | 'OMEMO_KEYS_MISSING_BLOCKED' | 'ROUTING_NO_OFFLINE_SUPPORT' | 'OMEMO_REQUIRED_TARGET' | 'E2EE_INIT_TIMEOUT';
    }) => {
      if (payload.reasonCode === 'E2EE_INIT_TIMEOUT') {
        notificationService.showNotification('E2EE не инициализирован', 'Закройте лишние вкладки с приложением или очистите IndexedDB, затем перезайдите.');
      }

      if (!payload.clientId) return;

      if (!payload.success && payload.reasonCode === 'OMEMO_KEYS_MISSING_BLOCKED') {
        updateMessageStatusByClientId(payload.clientId, MessageStatus.FAILED, {
          outboxErrorCode: 'OMEMO_KEYS_MISSING',
          outboxErrorHint: 'У контакта нет опубликованных OMEMO-устройств. Сообщение не отправлено.',
        });
        notificationService.showNotification('Отправка заблокирована', 'У получателя нет ключей шифрования, отправка заблокирована');
        return;
      }

      if (payload.reasonCode === 'OMEMO_KEYS_MISSING_FALLBACK_USED') {
        notificationService.showNotification('Сообщение отправлено с предупреждением', 'У получателя нет ключей шифрования. Использован fallback без шифрования.');
      }


      if (payload.success) {
        updateMessageStatusByClientId(payload.clientId, resolveMessageStatusFromDeliveryStatus(payload.deliveryStatus), {
          outboxErrorCode: undefined,
          outboxErrorHint: undefined,
        });
      }
    });

    xmppService.on('onStatus', (status) => {
        if (status === 'CONNECTED') {
            setState(prev => ({ 
                ...prev, 
                xmppConnected: true,
                xmppSessionReady: true,
                e2eeInitializing: false,
                e2eeInitFailed: false,
                e2eePolicyBlocked: false,
                omemoPublishDiagnostic: null,
                currentUser: prev.currentUser ? { ...prev.currentUser, isOnline: true } : null
            }));
            setBootLog(prev => [...prev, "XMPP UPLINK SECURED."]);
            
            if (stateRef.current.currentUser) {
                const currentUsername = stateRef.current.currentUser.username;
                const knownRoomIds = new Set(
                  stateRef.current.chats
                    .filter(chat => chat.type === ChatType.GROUP || chat.type === ChatType.CHANNEL)
                    .map(chat => chat.id)
                );

                knownRoomIds.forEach(roomJid => {
                    xmppService.joinRoom(roomJid, currentUsername);
                });

                void xmppService.fetchBookmarkedRooms().then(bookmarkedRooms => {
                    if (!bookmarkedRooms || bookmarkedRooms.length === 0) return;

                    setState(prev => {
                        const existing = new Set(prev.chats.map(chat => chat.id));
                        const missingChats: Chat[] = bookmarkedRooms
                          .filter(roomJid => !existing.has(roomJid))
                          .map(roomJid => {
                              const roomNode = roomJid.split('@')[0] || roomJid;
                              const name = roomNode.replace(/[-_]+/g, ' ').trim();
                              return {
                                  id: roomJid,
                                  type: ChatType.GROUP,
                                  name: name || roomJid,
                                  normalizedName: normalizeChannelName(name || roomJid),
                                  isHidden: false,
                                  participants: [stateRef.current.currentUser!.id],
                                  unreadCount: 0,
                                  adminIds: [],
                                  description: 'Recovered from server bookmarks',
                                  securityMode: 'transport' as const,
                              } as Chat;
                          });

                        if (missingChats.length === 0) return prev;

                        return {
                            ...prev,
                            chats: mergeChatsUniqueById(prev.chats, missingChats)
                        };
                    });

                    bookmarkedRooms.forEach(roomJid => {
                        xmppService.joinRoom(roomJid, currentUsername);
                    });
                });
            }

        } else if (status === 'DISCONNECTED' || status === 'AUTHFAIL' || status === 'CONNFAIL') {
            setState(prev => ({ 
                ...prev, 
                xmppConnected: false,
                xmppSessionReady: false,
                e2eeInitializing: false,
                e2eeInitFailed: false,
                e2eePolicyBlocked: false,
                omemoPublishDiagnostic: null,
                currentUser: prev.currentUser ? { ...prev.currentUser, isOnline: false } : null
            }));
        }
    });

    xmppService.on('onSessionReady', () => {
      setState(prev => ({ ...prev, xmppSessionReady: true }));
    });

    xmppService.on('onOmemoPublishHealth', (health) => {
      const diagnostic = resolveOmemoPublishDiagnostic(health);
      const isInitFailed = health?.lastResult?.reasonCode === 'OMEMO_INIT_FAILED';
      const isFatal = health?.lastEvent?.severity === 'fatal';
      const isPolicyBlocked = isFatal;
      setState(prev => ({
        ...prev,
        e2eeInitializing: prev.xmppConnected && !health?.isHealthy && !isInitFailed && !isFatal,
        e2eeInitFailed: prev.xmppConnected && Boolean(isInitFailed),
        e2eePolicyBlocked: prev.xmppConnected && isPolicyBlocked,
        omemoPublishDiagnostic: prev.xmppConnected ? diagnostic : null,
      }));
    });

  }, []);

  // Connection Manager
  useEffect(() => {
    const connectXmpp = async () => {
        if (!state.currentUser || state.xmppConnected) {
            return;
        }

        if (xmppService.isConnecting || xmppService.connection?.connected) {
            return;
        }

        const status = xmppService.getStatus();
        if (status === 'CONNECTING' || status === 'CONNECTED') {
            return;
        }

        const bootstrapPlan = resolveBootstrapConnectPlan({
          isWorkflowActive: xmppService.isReconnectWorkflowActive,
          hasSessionCredentials: Boolean(xmppService.currentUserJid && xmppService.currentPassword && xmppService.currentWsUrl),
        });

        if (bootstrapPlan.shouldSkip) {
            console.log('[App][Reconnect] skipped', {
              reason: bootstrapPlan.skipReason,
              source: 'app:bootstrap',
            });
            return;
        }

        // Prevent double connection attempts in strict mode or rapid re-renders
        if (connectionAttemptedRef.current) return;

        const config = await authService.getXmppConfig();

        if (config) {
            const urlToUse = config.wsUrl || 'wss://bridgemsg.ru:5443/ws';
            console.log("[App] Triggering XMPP Connection...", urlToUse);
            connectionAttemptedRef.current = true;
            if (bootstrapPlan.connectMode === 'reconnect-now') {
              xmppService.currentUserJid = config.jid;
              xmppService.currentPassword = config.pass || '';
              xmppService.currentWsUrl = urlToUse;
              xmppService.reconnectNow('app:bootstrap');
            } else {
              xmppService.connect(config.jid, config.pass || '', urlToUse, { source: 'app:bootstrap' });
            }

            // Allow retry after 10s if it fails
            setTimeout(() => { connectionAttemptedRef.current = false; }, 10000);
        } else {
            setBootLog(prev => [...prev, "RUNNING IN LOCAL MODE (NO XMPP CONFIG)."]);
        }
    };

    connectXmpp();

    // Reconnect on tab focus / visibility change
    const handleVisibilityChange = () => {
        const isVisible = document.visibilityState === 'visible';

        // 1. Manage CSI (Client State Indication) - XEP-0352
        xmppService.setClientState(isVisible);
        callService.handleAppVisibilityChange(isVisible);

        // 2. Reconnect only when service is idle and not connected.
        if (isVisible) {
          if (connectionAttemptedRef.current) {
            return;
          }

          const status = xmppService.getStatus();
          if (status === 'CONNECTED' || status === 'CONNECTING') {
            return;
          }

          console.log('[App] Tab visible, initiating health check...');
          attemptCoalescedReconnect('app:visibilitychange');
        }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [attemptCoalescedReconnect, state.currentUser]);
  
  // --- End XMPP Integration ---

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      if (import.meta.env.DEV) {
        setUpdateReady(false);
        setSwRegistration(null);

        void navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
          .catch(console.warn);

        if ('caches' in window) {
          void caches
            .keys()
            .then((cacheNames) => Promise.all(
              cacheNames
                .filter((cacheName) => cacheName.startsWith('bridge-'))
                .map((cacheName) => caches.delete(cacheName))
            ))
            .catch(console.warn);
        }

        return undefined;
      }

      let registrationRef: ServiceWorkerRegistration | null = null;

      const markUpdateIfWaiting = (registration: ServiceWorkerRegistration) => {
        if (registration.waiting) {
          setUpdateReady(true);
        }
      };

      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(APP_VERSION)}`)
        .then((registration) => {
          registrationRef = registration;
          setSwRegistration(registration);
          markUpdateIfWaiting(registration);

          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) {
              return;
            }

            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                setUpdateReady(true);
              }
            });
          });
        })
        .catch(console.warn);

      const onControllerChange = () => {
        if (!isReloadingForUpdate) {
          setIsReloadingForUpdate(true);
          window.location.reload();
        }
      };

      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

      return () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        if (registrationRef) {
          setSwRegistration(registrationRef);
        }
      };
    }

    return undefined;
  }, [isReloadingForUpdate]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);

      if (onlineReconnectTimerRef.current) {
        clearTimeout(onlineReconnectTimerRef.current);
      }

      onlineReconnectTimerRef.current = setTimeout(() => {
        onlineReconnectTimerRef.current = null;
        if (connectionAttemptedRef.current) {
          return;
        }
        const alreadyConnected = Boolean(xmppService.connection?.connected);
        if (alreadyConnected) {
          return;
        }
        attemptCoalescedReconnect('app:online');
      }, 500);
    };
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      if (onlineReconnectTimerRef.current) {
        clearTimeout(onlineReconnectTimerRef.current);
        onlineReconnectTimerRef.current = null;
      }
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [attemptCoalescedReconnect]);

  const runServiceWorkerUpdate = useCallback(() => {
    if (!swRegistration?.waiting) {
      return;
    }

    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }, [swRegistration]);

  const retryBootSequence = useCallback(() => {
    setBootError(null);
    setBootLog([]);
    setRuntimeCapability(null);
    setIsRuntimeDegraded(false);
    setShowRuntimeDiagnostics(false);
    setLoading(true);
    setBootAttempt(prev => prev + 1);
  }, []);

  useEffect(() => {
    const runBootSequence = async () => {
      const logs = [
        "LOADING KERNEL...",
        "MOUNTING SECURE DATABASE...",
      ];

      for (const log of logs) {
        setBootLog(prev => [...prev, log]);
        await new Promise(r => setTimeout(r, 150));
      }

      const capability = runRuntimeCapabilityPreflight({ requireSecureContext: true });
      setRuntimeCapability(capability);

      const issueCodes = new Set<RuntimeCapabilityIssueCode>(capability.issues.map((issue) => issue.code));
      const hasCriticalRuntimeFailure = issueCodes.has('INDEXEDDB_UNAVAILABLE') || issueCodes.has('CRYPTO_SUBTLE_UNAVAILABLE');
      const hasNativeInsecureContextOnly = issueCodes.size === 1 && issueCodes.has('INSECURE_CONTEXT') && capability.platform.isNative;

      setIsRuntimeDegraded(hasNativeInsecureContextOnly);
      setShowRuntimeDiagnostics(false);

      const preflightLogPayload = {
        ts: new Date().toISOString(),
        passed: capability.passed,
        issueCodes: capability.issues.map((issue) => issue.code),
        platform: capability.platform,
        userAgent: capability.platform.userAgent,
      };
      console.info('[RuntimePreflight] result', preflightLogPayload);
      appendRuntimePreflightPersistentLog(preflightLogPayload);

      if (hasCriticalRuntimeFailure || (!capability.passed && !hasNativeInsecureContextOnly)) {
        setBootLog(prev => [...prev, "RUNTIME PREFLIGHT FAILED."]);
        setBootLog(prev => [...prev, "CRITICAL DB/CRYPTO OPERATIONS DISABLED."]);
        setLoading(false);
        return;
      }

      if (hasNativeInsecureContextOnly) {
        setBootLog(prev => [...prev, "RUNTIME PREFLIGHT WARNING: INSECURE CONTEXT ON NATIVE WEBVIEW."]);
        setBootLog(prev => [...prev, "DEGRADED MODE ENABLED."]);
      }

      // Initialize IndexedDB
      try {
        setBootError(null);

        for (const log of logs) {
          setBootLog(prev => [...prev, log]);
          await new Promise(r => setTimeout(r, 150));
        }

        try {
          await initDB();
          setBootLog(prev => [...prev, "DATABASE MOUNTED."]);

          const storedCallConfig = await callConfigService.loadFromStorage().catch((error) => {
            console.error('[Boot] step=call_config_load failed', error);
            setBootLog(prev => [...prev, 'CALL CONFIG FALLBACK APPLIED.']);
            return { iceServers: [] };
          });
          callService.configureNetwork(storedCallConfig);

          const lockSettings = await dbService.getConfig('lock_config');
          if (dbService.consumeConfigResetFlag('lock_config')) {
            setBootLog(prev => [...prev, "LOCK CONFIG RESET: CORRUPTED ENCRYPTED PAYLOAD DETECTED."]);
            console.info('[Boot] lock_config was reset due to corrupted encrypted payload. This is non-fatal and unrelated to E2EE media health.');
          }

          if (lockSettings && lockSettings.enabled) {
            setLockConfig(lockSettings);
            setState(prev => ({ ...prev, isLocked: true }));
            setBootLog(prev => [...prev, "SECURITY LOCK ACTIVE."]);
          }
        } catch (error) {
          console.error('[Boot] step=db_init failed', error);
          setBootLog(prev => [...prev, "DB MOUNT FAILED."]);
        }

        await new Promise(r => setTimeout(r, 100));

        const session = await authService.getSession().catch((error) => {
          console.error('[Boot] step=session_restore failed', error);
          setBootLog(prev => [...prev, 'SESSION RESTORE FAILED.']);
          return null;
        });
        setBootLog(prev => [...prev, session ? "SESSION RESTORED." : "NO ACTIVE SESSION."]);

        if (session) {
          try {
            const userState = await dbService.getUserState(session.id).catch((error) => {
              console.error('[Boot] step=user_state_load failed', error);
              setBootLog(prev => [...prev, 'USER STATE FALLBACK APPLIED.']);
              return null;
            });

            if (userState) {
              const cachedDirectory = restoreCachedDirectory(userState.userDirectory);
              const { tasks: restoredOutboxTasks, attachmentIds } = restoreOutboxTasks((userState as any).outboxTasks);
              const restUserState = { ...userState } as Record<string, unknown>;
              delete restUserState.userDirectory;
              delete restUserState.incomingPresenceRequests;
              restUserState.outboxTasks = restoredOutboxTasks;
              restUserState.soundSettings = mergeSoundSettings((restUserState as { soundSettings?: Partial<SoundSettings> }).soundSettings);
              restUserState.chats = normalizeChatsForState((restUserState as { chats?: unknown }).chats);
              setUserDirectory(cachedDirectory);
              setIncomingPresenceRequests(Array.isArray((userState as any).incomingPresenceRequests) ? (userState as any).incomingPresenceRequests : []);
              setState(prev => ({
                ...prev,
                ...restUserState,
                currentUser: withUserDefaults({ ...session }),
                pendingRequests: userState.pendingRequests || [],
                isLocked: prev.isLocked
              }));
              void dbService.getAllOutboxMediaAttachments<{ attachmentId: string }>()
                .then((attachments) => Promise.all(
                  attachments
                    .filter((item) => !attachmentIds.has(item.attachmentId))
                    .map((item) => dbService.deleteOutboxMediaAttachment(item.attachmentId))
                ))
                .catch((cleanupError) => console.warn('Failed to cleanup stale outbox media attachments', cleanupError));
              setBootLog(prev => [...prev, "USER STATE DECRYPTED."]);
            } else {
              setUserDirectory([]);
              setIncomingPresenceRequests([]);
              setState(prev => ({ ...prev, currentUser: withUserDefaults({ ...session }), isLocked: prev.isLocked }));
              setBootLog(prev => [...prev, "NEW SESSION INITIALIZED."]);
            }
          } catch (error) {
            console.error("Failed to load user state", error);
            setUserDirectory([]);
            setIncomingPresenceRequests([]);
            setState(prev => ({ ...prev, currentUser: withUserDefaults({ ...session }), isLocked: prev.isLocked }));
          }

          if (stateRef.current.notifications) {
            notificationService.requestPermission();
          }
        }
      } catch (error) {
        console.error('[Boot] step=boot_sequence failed', error);
        setBootLog(prev => [...prev, 'BOOT FAILED.']);
        setBootError(error instanceof Error ? error.message : 'Unexpected boot failure.');
      } finally {
        setLoading(false);
      }
    };

    void runBootSequence();
  }, [bootAttempt]);

  useEffect(() => {
    const body = document.body;
    body.className = '';
    if (state.theme !== 'terminal') {
      body.classList.add(`theme-${state.theme}`);
    }

    const isLightSystemTheme = state.theme === 'white' || state.theme === 'sand';
    const themeColor = '#000000';

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', themeColor);
    }

    const appleStatusMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (appleStatusMeta) {
      appleStatusMeta.setAttribute('content', 'black-translucent');
    }

    document.documentElement.style.colorScheme = isLightSystemTheme ? 'light' : 'dark';
  }, [state.theme]);

  // Persist State Securely per User
  useEffect(() => {
    if (state.currentUser) {
        const stateToSave = { 
            chats: state.chats,
            messages: sanitizeMessagesForPersistence(state.messages), 
            scheduledMessages: state.scheduledMessages,
            isDarkMode: state.isDarkMode,
            theme: state.theme,
            notifications: state.notifications,
            soundSettings: state.soundSettings,
            language: state.language,
            pendingRequests: state.pendingRequests,
            incomingPresenceRequests,
            outboxTasks: state.outboxTasks.map(sanitizeOutboxTaskForPersistence),
            userDirectory
        };
        dbService.saveUserState(state.currentUser.id, stateToSave).catch(e => console.error("Auto-save failed", e));
        dbService.saveSyncState(state.currentUser.id, { ...syncEnvelope, pendingOps: pendingSyncOps }).catch(e => console.error('Sync auto-save failed', e));
    }
  }, [
    state.currentUser?.id,
    state.chats,
    state.messages,
    state.scheduledMessages,
    state.theme,
    state.notifications,
    state.soundSettings,
    state.language,
    state.pendingRequests,
    incomingPresenceRequests,
    state.outboxTasks,
    userDirectory,
    syncEnvelope,
    pendingSyncOps,
  ]);


  useEffect(() => {
    const normalized = normalizeSearchQuery(searchQuery);
    if (!normalized || normalized.length < 2) {
      setGlobalChannelResults([]);
      return;
    }

    let cancelled = false;
    void xmppService.searchGlobalChannels(normalized).then(results => {
      if (!cancelled) setGlobalChannelResults(results);
    }).catch(() => {
      if (!cancelled) setGlobalChannelResults([]);
    });

    return () => {
      cancelled = true;
    };
  }, [searchQuery]);

  const withUserDefaults = useCallback((user: User): User => ({
    ...user,
    privacySettings: sanitizePrivacySettings(user.privacySettings),
    securitySettings: sanitizeSecuritySettings(user.securitySettings),
  }), []);

  const applyRestoredMediaPatches = useCallback((userId: string, patches: RestoredMediaPatch[]) => {
    if (patches.length === 0) return;

    patches.forEach((patch) => {
      xmppService.registerRestoredMediaBlobUrl(patch.messageId, patch.chatId, patch.mediaUrl, patch.blobSize);
    });

    setState(prev => {
      if (prev.currentUser?.id !== userId) return prev;
      let changed = false;
      const nextMessages: Record<string, Message[]> = { ...prev.messages };

      for (const patch of patches) {
        const chatMessages = nextMessages[patch.chatId] || [];
        const index = chatMessages.findIndex((msg) => msg.id === patch.messageId);
        if (index === -1) continue;
        if (chatMessages[index].mediaUrl === patch.mediaUrl) continue;

        const updatedChatMessages = [...chatMessages];
        updatedChatMessages[index] = {
          ...updatedChatMessages[index],
          mediaUrl: patch.mediaUrl,
          mediaDecryptFailed: false,
          mediaDecryptPending: false,
          isLegacyUnencryptedMedia: false,
        };
        nextMessages[patch.chatId] = updatedChatMessages;
        changed = true;
      }

      return changed ? { ...prev, messages: nextMessages } : prev;
    });
  }, []);

  const restoreMediaAfterHydration = useCallback(async (userId: string, ownJid: string, messagesByChat: Record<string, Message[]>) => {
    const hydratedResult = await restorePersistedMediaAfterHydration(messagesByChat, ownJid);
    applyRestoredMediaPatches(userId, hydratedResult.patches);

    let pending = hydratedResult.pending;

    for (const delayMs of HYDRATION_RETRY_BACKOFF_MS) {
      if (pending.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, delayMs));

      if (stateRef.current.currentUser?.id !== userId) break;

      const pendingTargets: Record<string, Message[]> = {};
      for (const item of pending) {
        const chatMessages = stateRef.current.messages[item.chatId] || [];
        const message = chatMessages.find(msg => msg.id === item.messageId);
        if (!message) continue;

        if (!pendingTargets[item.chatId]) {
          pendingTargets[item.chatId] = [];
        }
        pendingTargets[item.chatId].push(message);
      }

      if (Object.keys(pendingTargets).length === 0) break;

      const retryResult = await restorePersistedMediaAfterHydration(pendingTargets, ownJid);
      applyRestoredMediaPatches(userId, retryResult.patches);

      const unresolvedSet = new Set(retryResult.pending.map(item => `${item.chatId}:${item.messageId}`));
      pending = pending.filter(item => unresolvedSet.has(`${item.chatId}:${item.messageId}`));
    }
  }, [applyRestoredMediaPatches]);

  const isBlobUrlReachable = useCallback(async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, []);

  const restoreMediaForActiveChatIfNeeded = useCallback(async (chatId: string) => {
    const ownJid = state.currentUser?.jid || state.currentUser?.id;
    if (!ownJid) return;

    const chatMessages = state.messages[chatId] || [];
    const hydrationTargets: Message[] = [];

    for (const message of chatMessages) {
      const hasDecryptMetadata = Boolean(message.mediaCiphertextUrl && message.mediaIv && message.mediaKeyEnvelope);
      if (!hasDecryptMetadata) continue;

      const hasMissingMediaUrl = !message.mediaUrl;
      if (hasMissingMediaUrl) {
        hydrationTargets.push(message);
        continue;
      }

      if (message.mediaDecryptPending) {
        hydrationTargets.push(message);
        continue;
      }

      if (!message.mediaUrl.startsWith('blob:')) continue;

      const reachable = await isBlobUrlReachable(message.mediaUrl);
      if (!reachable) {
        hydrationTargets.push(message);
      } else {
        xmppService.touchMediaBlobUrl(message.id);
      }
    }

    if (hydrationTargets.length === 0) {
      xmppService.touchMediaBlobUrlsForChat(chatId);
      return;
    }

    const hydratedResult = await restorePersistedMediaAfterHydration({ [chatId]: hydrationTargets }, ownJid);
    if (hydratedResult.patches.length === 0) return;

    hydratedResult.patches.forEach((patch) => {
      xmppService.registerRestoredMediaBlobUrl(patch.messageId, patch.chatId, patch.mediaUrl, patch.blobSize);
    });

    setState(prev => {
      if (prev.activeChatId !== chatId) return prev;
      let changed = false;
      const nextChatMessages = [...(prev.messages[chatId] || [])];

      hydratedResult.patches.forEach((patch) => {
        const index = nextChatMessages.findIndex((msg) => msg.id === patch.messageId);
        if (index === -1) return;
        if (nextChatMessages[index].mediaUrl === patch.mediaUrl) return;
        nextChatMessages[index] = {
          ...nextChatMessages[index],
          mediaUrl: patch.mediaUrl,
          mediaDecryptFailed: false,
          mediaDecryptPending: false,
          isLegacyUnencryptedMedia: false,
        };
        changed = true;
      });

      if (!changed) return prev;

      return {
        ...prev,
        messages: {
          ...prev.messages,
          [chatId]: nextChatMessages,
        },
      };
    });
  }, [isBlobUrlReachable, state.currentUser?.id, state.currentUser?.jid, state.messages]);

  const normalizedChats = useMemo(() => dedupeChatsById(state.chats), [state.chats]);

  const activeChat = useMemo(() => 
    normalizedChats.find(c => c.id === state.activeChatId) || null
  , [normalizedChats, state.activeChatId]);

  const canSendXmppRequests = state.xmppConnected
    && state.xmppSessionReady
    && xmppService.getStatus() === 'CONNECTED';
  const xmppRequestDisabledReason = !navigator.onLine
    ? 'No network connection'
    : (!state.xmppConnected ? 'XMPP is offline' : (!state.xmppSessionReady ? 'Session is not ready yet' : null));

  const activePeerJid = useMemo(() => {
    if (!activeChat || activeChat.type !== ChatType.PRIVATE) return null;
    return getPeerJidFromPrivateChatId(activeChat.id) || null;
  }, [activeChat]);

  useEffect(() => {
    const openedPrivateChatId = activeChat && activeChat.type === ChatType.PRIVATE ? activeChat.id : null;
    xmppService.setOpenedChat(openedPrivateChatId);
  }, [activeChat]);

  useEffect(() => {
    if (!state.activeChatId) return;
    void restoreMediaForActiveChatIfNeeded(state.activeChatId);
  }, [restoreMediaForActiveChatIfNeeded, state.activeChatId]);

  const activePeerCompatibility = useMemo(() => {
    if (!activePeerJid) {
      return {
        canCall: true,
        canRetract: true,
        callHint: null as string | null,
        retractHint: null as string | null,
      };
    }

    const canCall = xmppService.peerSupportsCallAction(activePeerJid, 'offer');
    const canRetract = xmppService.peerSupportsFeature(activePeerJid, 'chat-control-v1');

    return {
      canCall,
      canRetract,
      callHint: canCall ? null : t.callUnavailableLegacy,
      retractHint: canRetract ? null : t.retractUnavailableLegacy,
    };
  }, [activePeerJid, peerCapabilitiesVersion, t.callUnavailableLegacy, t.retractUnavailableLegacy]);

  const handleAuthenticated = async (user: User) => {
    try {
      await e2eeService.initializeForUser(user.jid || user.id);
    } catch (error) {
      console.error('[E2EE] Failed to initialize secure state during app startup', error);
    }

    try {
      const callConfig = await callConfigService.fetchAndPersist(user.jid || user.id);
      callService.configureNetwork(callConfig);
    } catch (error) {
      console.warn('[CallConfig] Failed to initialize call config on auth', error);
    }
    // Load isolated state for this user
    try {
        const userState = await dbService.getUserState(user.id);
        const localSync = await dbService.getSyncState(user.id);
        const lockSettings = await dbService.getConfig('lock_config');
        if (dbService.consumeConfigResetFlag('lock_config')) {
            console.info('[Auth] lock_config was reset due to corrupted encrypted payload. This is non-fatal and unrelated to E2EE media health.');
        }

        let shouldLock = false;
        if (lockSettings && lockSettings.enabled) {
            setLockConfig(lockSettings);
            shouldLock = true;
        }

        if (userState) {
            const { tasks: restoredOutboxTasks, attachmentIds } = restoreOutboxTasks((userState as any).outboxTasks);
            const restUserState = { ...userState } as Record<string, unknown>;
            delete restUserState.userDirectory;
            delete restUserState.incomingPresenceRequests;
            restUserState.outboxTasks = restoredOutboxTasks;
            restUserState.soundSettings = mergeSoundSettings((restUserState as { soundSettings?: Partial<SoundSettings> }).soundSettings);
            restUserState.chats = normalizeChatsForState((restUserState as { chats?: unknown }).chats);
            setUserDirectory(restoreCachedDirectory(userState.userDirectory));
            const restoredMessages = (restUserState.messages || {}) as Record<string, Message[]>;
            setState(prev => ({ ...prev, ...restUserState, currentUser: withUserDefaults({ ...user }), pendingRequests: userState.pendingRequests || [], isLocked: shouldLock }));
            void restoreMediaAfterHydration(user.id, user.jid || user.id, restoredMessages);
            void dbService.getAllOutboxMediaAttachments<{ attachmentId: string }>()
              .then((attachments) => Promise.all(
                attachments
                  .filter((item) => !attachmentIds.has(item.attachmentId))
                  .map((item) => dbService.deleteOutboxMediaAttachment(item.attachmentId))
              ))
              .catch((cleanupError) => console.warn('Failed to cleanup stale outbox media attachments', cleanupError));
        } else {
            setUserDirectory([]);
            setState(prev => ({ ...prev, currentUser: withUserDefaults({ ...user }), chats: INITIAL_CHATS, messages: {}, isLocked: shouldLock }));
        }
    } catch (e) {
        setUserDirectory([]);
        setState(prev => ({ ...prev, currentUser: { ...user } }));
    }

    if (state.notifications) {
      notificationService.requestPermission();
    }
  };

  const [blockedPermissionMessage, setBlockedPermissionMessage] = useState<string | null>(null);
  const mediaPreflightCacheRef = useRef(new Map<string, MediaPreflightResult>());

  const getMediaPreflightKey = useCallback((options: MediaPreflightOptions) => JSON.stringify({
    audio: options.audio ?? false,
    video: options.video ?? false,
    photos: options.photos ?? false,
  }), []);

  const runMediaPermissionFlow = useCallback(async (options: MediaPreflightOptions & { forcePrompt?: boolean }): Promise<MediaPreflightResult | null> => {
    const key = getMediaPreflightKey(options);
    if (!options.forcePrompt) {
      const cached = mediaPreflightCacheRef.current.get(key);
      if (cached && !cached.blockedKind) {
        return cached;
      }
    }

    const result = await preflightMediaPermissions({ ...options, requestPermissions: true });
    mediaPreflightCacheRef.current.set(key, result);
    if (result.blockedKind) {
      setBlockedPermissionMessage(result.reason || 'Доступ к микрофону/камере/фото заблокирован.');
      return null;
    }
    return result;
  }, [getMediaPreflightKey]);

  const handleLogout = async () => {
    callService.sendHangup();
    await runLocalSessionRecovery({
      disconnect: () => xmppService.disconnect(true),
      releaseMediaUrls: () => xmppService.releaseAllMediaBlobUrls(),
      logout: () => authService.logout(),
      clearBadge: () => notificationService.clearAppBadge(),
      resetDirectoryState: () => setUserDirectory([]),
      resetAppState: () => setState(INITIAL_STATE),
      clearCreateChatAllowances: () => createChatAllowanceRef.current.clear(),
      clearMediaPreflightCache: () => mediaPreflightCacheRef.current.clear(),
      closeSettings: () => setShowSettings(false),
    });
  };

  const handleLocalSessionReset = async () => {
    callService.sendHangup();
    await runLocalSessionRecovery({
      disconnect: () => xmppService.disconnect(true),
      releaseMediaUrls: () => xmppService.releaseAllMediaBlobUrls(),
      logout: () => authService.logout(),
      clearBadge: () => notificationService.clearAppBadge(),
      resetDirectoryState: () => setUserDirectory([]),
      resetAppState: () => setState(INITIAL_STATE),
      clearCreateChatAllowances: () => createChatAllowanceRef.current.clear(),
      clearMediaPreflightCache: () => mediaPreflightCacheRef.current.clear(),
      clearXmppRecoveryState: () => clearXmppRecoveryStorage(),
      closeSettings: () => setShowSettings(false),
    });
  };

  const handleStartCall = useCallback(async (media: CallMediaType) => {
    if (!state.currentUser || !activeChat) return;

    if (activeChat.securityMode === 'e2ee_text_only') {
      notificationService.showNotification('Guard', 'Calls are disabled in secure text-only chats.');
      return;
    }

    const permissionPreflight = await runMediaPermissionFlow({
      audio: true,
      video: media === 'video',
    });
    if (!permissionPreflight) return;

    try {
      if (activeChat.type === ChatType.GROUP) {
        const peers = activeChat.participants.filter((participantId) => participantId !== state.currentUser!.id);
        await callService.startGroupConference(peers, media, permissionPreflight);
        return;
      }

      if (activeChat.type !== ChatType.PRIVATE) return;

      const peerJid = parsePrivateChatId(activeChat.id)?.peerJid
        || activeChat.participants.find((participantId) => participantId !== state.currentUser!.id);

      if (!peerJid) return;
      if (!xmppService.peerSupportsCallAction(peerJid, 'offer')) {
        alert(t.callUnavailableLegacy);
        return;
      }

      await callService.startOutgoingCall(peerJid, media, permissionPreflight);

      const preCheck = await callService.runPreCallDeviceCheck();
      if (!preCheck.hasMicrophone || (media === 'video' && !preCheck.hasCamera)) {
        notificationService.showNotification('Call', media === 'video' ? 'Camera or microphone is not available' : 'Microphone is not available');
      }

      void callService.playAudioTestTone();
      const token = callService.createInviteToken();
      if (token) {
        notificationService.showNotification('Call link', `Invite token: ${token.slice(0, 16)}...`);
      }
    } catch (error) {
      const normalized = normalizeMediaError(error);
      if (normalized.isPermissionBlocked) {
        setBlockedPermissionMessage(normalized.userMessage);
        return;
      }
      notificationService.showNotification('Call', normalized.userMessage);
    }
  }, [activeChat, state.currentUser, t.callUnavailableLegacy]);

  const handleAcceptCall = useCallback(async () => {
    const { peerJid, callId, media } = stateRef.current.callState;
    if (!peerJid || !callId) return;

    const permissionPreflight = await runMediaPermissionFlow({
      audio: true,
      video: media === 'video',
    });
    if (!permissionPreflight) return;

    await callService.acceptIncomingCall(peerJid, callId, media, pendingIncomingOfferRef.current || undefined, permissionPreflight);
    pendingIncomingOfferRef.current = null;
  }, [runMediaPermissionFlow]);

  const handleRejectCall = useCallback(() => {
    pendingIncomingOfferRef.current = null;
    callService.sendReject();
  }, []);

  const handleEndCall = useCallback(() => {
    pendingIncomingOfferRef.current = null;
    callService.sendHangup();
  }, []);

  const handleRegisterCallPlaybackElement = useCallback((element: HTMLMediaElement | null) => {
    void callService.setPlaybackElement(element);
  }, []);

  const createClientMessageId = useCallback(() => `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, []);
  const createOutboxTaskId = useCallback(() => `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, []);
  const outboxProcessorRef = useRef(false);

  const buildTargetMeta = useCallback((targetChatId: string) => {
    const targetChat = state.chats.find(c => c.id === targetChatId);
    let targetJid = targetChatId;
    const parsedPrivate = parsePrivateChatId(targetChatId);
    if (parsedPrivate) targetJid = parsedPrivate.peerJid;
    if (targetChatId.startsWith('saved-') && state.currentUser) targetJid = state.currentUser.id;

    const stanzaType: 'chat' | 'groupchat' = targetChat?.type === ChatType.GROUP ? 'groupchat' : 'chat';
    return { targetJid, stanzaType };
  }, [state.chats, state.currentUser]);

  const resolveChatPolicyContext = useCallback((chatId: string, stanzaType: 'chat' | 'groupchat'): ChatPolicyContext => {
    return resolveChatPolicyContextForTarget(stateRef.current.chats, chatId, stanzaType);
  }, []);

  const updateMessageStatusByTask = useCallback((
    chatId: string,
    tempMessageId: string,
    status: MessageStatus,
    meta?: { outboxErrorCode?: string; outboxErrorHint?: string }
  ) => {
    setState(prev => {
      const chatMessages = prev.messages[chatId] || [];
      const changed = chatMessages.some(msg => {
        if (msg.id !== tempMessageId) return false;
        return msg.status !== status
          || msg.outboxErrorCode !== meta?.outboxErrorCode
          || msg.outboxErrorHint !== meta?.outboxErrorHint;
      });
      if (!changed) return prev;
      return {
        ...prev,
        messages: {
          ...prev.messages,
          [chatId]: chatMessages.map(msg => msg.id === tempMessageId
            ? { ...msg, status, outboxErrorCode: meta?.outboxErrorCode, outboxErrorHint: meta?.outboxErrorHint }
            : msg)
        }
      };
    });
  }, []);

  const updateMessageStatusByClientId = useCallback((
    clientId: string,
    status: MessageStatus,
    meta?: { outboxErrorCode?: string; outboxErrorHint?: string }
  ) => {
    setState(prev => {
      let hasChanges = false;
      const nextMessages: Record<string, Message[]> = {};

      Object.entries(prev.messages).forEach(([chatId, chatMessages]) => {
        let chatChanged = false;
        const nextForChat = chatMessages.map(msg => {
          if (msg.clientId !== clientId) return msg;
          if (
            msg.status === status
            && msg.outboxErrorCode === meta?.outboxErrorCode
            && msg.outboxErrorHint === meta?.outboxErrorHint
          ) {
            return msg;
          }

          chatChanged = true;
          return {
            ...msg,
            status,
            outboxErrorCode: meta?.outboxErrorCode,
            outboxErrorHint: meta?.outboxErrorHint,
          };
        });

        nextMessages[chatId] = chatChanged ? nextForChat : chatMessages;
        hasChanges = hasChanges || chatChanged;
      });

      if (!hasChanges) return prev;

      return {
        ...prev,
        messages: nextMessages,
      };
    });
  }, []);

  const updateOutboxTask = useCallback((taskId: string, patch: Partial<OutboxTask>) => {
    setState(prev => {
      const taskIndex = prev.outboxTasks.findIndex(task => task.id === taskId);
      if (taskIndex < 0) return prev;

      const currentTask = prev.outboxTasks[taskIndex];
      const patchEntries = Object.entries(patch) as [keyof OutboxTask, OutboxTask[keyof OutboxTask]][];
      const hasRealChanges = patchEntries.some(([key, value]) => currentTask[key] !== value);
      if (!hasRealChanges) return prev;

      const nextTasks = [...prev.outboxTasks];
      nextTasks[taskIndex] = { ...currentTask, ...patch, updatedAt: Date.now() };

      return {
        ...prev,
        outboxTasks: nextTasks
      };
    });
  }, []);


  const setOutboxTaskStageProgress = useCallback((taskId: string, stage: 'preparing' | 'encrypting' | 'uploading' | 'sent', stageValue: number, patch?: Partial<OutboxTask>) => {
    setState(prev => {
      const taskIndex = prev.outboxTasks.findIndex(task => task.id === taskId);
      if (taskIndex < 0) return prev;
      const currentTask = prev.outboxTasks[taskIndex];
      const currentStages = currentTask.stageProgress || createInitialOutboxStageProgress();
      const normalizedStageValue = Math.max(0, Math.min(100, Math.round(stageValue)));
      const nextStages: NonNullable<OutboxTask['stageProgress']> = {
        ...currentStages,
        [stage]: {
          progress: normalizedStageValue,
          weight: currentStages[stage]?.weight ?? OUTBOX_STAGE_WEIGHTS[stage],
        },
      };
      const nextTask: OutboxTask = {
        ...currentTask,
        ...patch,
        currentStage: stage,
        stageProgress: nextStages,
        progress: computeCompositeOutboxProgress(nextStages),
        updatedAt: Date.now(),
      };
      const nextTasks = [...prev.outboxTasks];
      nextTasks[taskIndex] = nextTask;
      return {
        ...prev,
        outboxTasks: nextTasks,
      };
    });
  }, []);

  const removeOutboxTask = useCallback((taskId: string) => {
    const existingTask = stateRef.current.outboxTasks.find(task => task.id === taskId);
    if (existingTask?.type === 'media-upload' && existingTask.payload.media?.attachmentId) {
      void dbService.deleteOutboxMediaAttachment(existingTask.payload.media.attachmentId)
        .catch((error) => console.warn('Failed to delete outbox media attachment', error));
    }
    if (existingTask?.type === 'media-upload' && existingTask.payload.media?.encryptedAttachmentId) {
      void dbService.deleteOutboxMediaAttachment(existingTask.payload.media.encryptedAttachmentId)
        .catch((error) => console.warn('Failed to delete encrypted outbox media attachment', error));
    }
    setState(prev => ({ ...prev, outboxTasks: prev.outboxTasks.filter(task => task.id !== taskId) }));
  }, []);

  const extractError = (error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
      const codedError = error as { code: string; message?: string };
      return `${codedError.code}${codedError.message ? `: ${codedError.message}` : ''}`;
    }
    if (error instanceof Error) return error.message;
    return String(error || 'Unknown error');
  };

  const isNetworkLikeError = (error: unknown) => {
    const message = extractError(error).toLowerCase();
    return message.includes('network') || message.includes('net_reset') || message.includes('ns_error_net_reset') || message.includes('failed to fetch');
  };

  const isDeferredUploadDiscoveryError = (error: unknown) => {
    const message = extractError(error).toLowerCase();
    return message.includes('upload_discovery_timeout') || message.includes('upload service discovery timed out');
  };

  const isOmemoBundleFetchUnavailableError = (error: unknown) => {
    const message = extractError(error).toLowerCase();
    return message.includes('e2ee_required_no_recipient_keys') && message.includes('bundle fetch failed');
  };

  const resolveOutboxSendErrorMeta = (error: unknown): { outboxErrorCode?: string; outboxErrorHint?: string } => {
    const normalizedError = extractError(error);
    const lowered = normalizedError.toLowerCase();
    const hasMissingOmemoKeys = lowered.includes('omemo_keys_missing_blocked') || lowered.includes('e2ee_required_no_recipient_keys');

    if (hasMissingOmemoKeys) {
      return {
        outboxErrorCode: 'OMEMO_KEYS_MISSING',
        outboxErrorHint: 'У контакта нет опубликованных OMEMO-устройств. Сообщение не отправлено.',
      };
    }

    return {};
  };

  const resolveSendFailurePresentation = (
    sendResult?: { reasonCode?: string; error?: string }
  ): { status: MessageStatus.RETRY | MessageStatus.FAILED; outboxErrorCode?: string; outboxErrorHint?: string } => {
    const reasonCode = sendResult?.reasonCode;
    const error = sendResult?.error;

    if (reasonCode === 'OMEMO_KEYS_MISSING_BLOCKED' || reasonCode === 'OMEMO_REQUIRED_TARGET') {
      const meta = resolveOutboxSendErrorMeta(reasonCode);
      return {
        status: MessageStatus.FAILED,
        outboxErrorCode: meta.outboxErrorCode || reasonCode,
        outboxErrorHint: meta.outboxErrorHint || error || reasonCode,
      };
    }

    return {
      status: MessageStatus.RETRY,
      outboxErrorCode: reasonCode || error || 'SEND_FAILED',
      outboxErrorHint: error || reasonCode || 'SEND_FAILED',
    };
  };

  const isValidBlobLike = (value: unknown): value is Blob => {
    if (value instanceof Blob) return true;
    if (!value || typeof value !== 'object') return false;

    const blobLike = value as { arrayBuffer?: unknown; size?: unknown; type?: unknown };
    return typeof blobLike.arrayBuffer === 'function'
      && typeof blobLike.size === 'number'
      && typeof blobLike.type === 'string';
  };

  const LARGE_MEDIA_THRESHOLD_BYTES = 8 * 1024 * 1024;
  const LARGE_MEDIA_UPLOAD_ATTEMPTS = 3;

  const getOutboxBackoffDelay = (attempts: number) => {
    const normalizedAttempts = Math.max(1, attempts);
    return Math.min(30000, 1000 * Math.pow(2, normalizedAttempts - 1));
  };

  useEffect(() => {
    if (!state.currentUser || outboxProcessorRef.current) return;

    const now = Date.now();
    const online = navigator.onLine && state.xmppConnected;
    const queuedTasks = state.outboxTasks.filter(task => task.userId === state.currentUser?.id);

    const retryReady = queuedTasks.filter(task => task.state === 'retry' && (!task.nextRetryAt || task.nextRetryAt <= now));
    const pendingReady = queuedTasks.filter(task => task.state === 'pending');
    const waitingNetwork = queuedTasks.filter(task => task.state === 'waiting_network');

    if (online && waitingNetwork.length > 0) {
      waitingNetwork.forEach(task => updateOutboxTask(task.id, { state: 'pending', error: undefined }));
      return;
    }

    const candidates = [...pendingReady, ...retryReady]
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'media-upload' ? -1 : 1;
        return a.createdAt - b.createdAt;
      });

    const task = candidates.find((candidate) => {
      if (candidate.type === 'media-message' && candidate.payload.uploadTaskId) {
        const uploadTaskStillExists = queuedTasks.some(entry => entry.id === candidate.payload.uploadTaskId);
        if (uploadTaskStillExists) return false;
      }
      return true;
    });

    if (!task) return;

    if (!online) {
      updateOutboxTask(task.id, { state: 'waiting_network' });
      return;
    }

    outboxProcessorRef.current = true;
    if (task.type === 'media-upload') {
      setOutboxTaskStageProgress(task.id, 'preparing', 5, { state: 'in_progress', error: undefined });
    } else {
      updateOutboxTask(task.id, { state: 'in_progress', error: undefined });
    }

    const processTask = async () => {
      if (task.type === 'media-upload') {
        const media = task.payload.media;
        let mediaBlob = media?.blob;

        if ((!mediaBlob || !isValidBlobLike(mediaBlob)) && media?.attachmentId) {
          const persistedBlob = await dbService.getOutboxMediaAttachmentBlob(media.attachmentId);
          if (persistedBlob && isValidBlobLike(persistedBlob)) {
            mediaBlob = persistedBlob;
            updateOutboxTask(task.id, {
              payload: {
                ...task.payload,
                media: {
                  ...media,
                  blob: persistedBlob,
                },
              },
            });
          }
        }

        if (!mediaBlob || !isValidBlobLike(mediaBlob)) {
          const invalidBlobError = Object.assign(new Error('Media blob is missing or invalid for upload'), { code: 'MEDIA_BLOB_INVALID' });
          console.warn('[Outbox] MEDIA_BLOB_INVALID', {
            clientId: task.payload.clientId,
            chatId: task.chatId,
            targetJid: task.payload.targetJid,
            taskId: task.id,
            mediaShape: media?.blob ? {
              hasArrayBuffer: typeof (media.blob as { arrayBuffer?: unknown }).arrayBuffer === 'function',
              sizeType: typeof (media.blob as { size?: unknown }).size,
              typeType: typeof (media.blob as { type?: unknown }).type,
            } : null,
          });
          throw invalidBlobError;
        }

        const uploadName = media.fileName || media.name || `${task.payload.clientId}.bin`;
        const isGroupMessage = task.payload.stanzaType === 'groupchat';
        const chatPolicy = {
          securityMode: task.payload.securityMode || (isGroupMessage ? 'transport' : 'e2ee_text_only'),
          allowMedia: task.payload.allowMedia !== false,
        } as ChatPolicyContext;

        let bridgePayload: ReturnType<typeof buildEncryptedBridgeMediaPayload> | {
          mediaUrl: string;
          mediaMime?: string;
          mediaVariants?: PendingMediaPayload['mediaVariants'];
          mediaSize?: number;
          encrypted: false;
          scheme: 'none';
        };

        try {
          setOutboxTaskStageProgress(task.id, 'preparing', 100);
          setOutboxTaskStageProgress(task.id, 'encrypting', chatPolicy.securityMode === 'transport' ? 100 : 5);

          if (chatPolicy.securityMode === 'transport') {
            setOutboxTaskStageProgress(task.id, 'uploading', 0);
            const uploadFile = new File([mediaBlob], uploadName, { type: mediaBlob.type || media.mime || 'application/octet-stream' });
            const mediaUrl = await xmppService.uploadFile(uploadFile, (progress) => {
              setOutboxTaskStageProgress(task.id, 'uploading', progress);
            });
            bridgePayload = {
              mediaUrl,
              mediaMime: mediaBlob.type || media.mime || undefined,
              mediaVariants: buildAudioMediaVariants(mediaUrl, mediaBlob.type || media.mime || undefined),
              mediaSize: mediaBlob.size,
              encrypted: false,
              scheme: 'none',
            };
          } else {
            const stanzaType = isGroupMessage ? 'groupchat' : 'chat';
            const recipientBundles = await resolveEncryptionRecipients(
              xmppService as unknown as XmppRecipientResolver,
              task.payload.targetJid,
              stanzaType
            );
          const trustScopeJid = isGroupMessage ? task.payload.targetJid : normalizeBareJid(task.payload.targetJid);
          const trustedTargets = recipientBundles.filter((bundle) => e2eeService.getTrustState(trustScopeJid, Number(bundle.deviceId), bundle.fingerprint) !== 'blocked');
          if (trustedTargets.length === 0) {
            throw new Error('No trusted OMEMO recipients available');
          }

          const encrypted = await encryptMediaBlob(mediaBlob);
          setOutboxTaskStageProgress(task.id, 'encrypting', 100);
          setOutboxTaskStageProgress(task.id, 'uploading', 0);
          const uploadFile = new File([encrypted.ciphertext], uploadName, { type: 'application/octet-stream' });
          const mediaUrl = await xmppService.uploadFile(uploadFile, (progress) => {
            setOutboxTaskStageProgress(task.id, 'uploading', progress);
          });

          const mediaKeyEnvelope = await e2eeService.encryptForDevices(
            state.currentUser.id,
            task.payload.targetJid,
            JSON.stringify({
              url: mediaUrl,
              key: encrypted.mediaKey,
              iv: encrypted.mediaIv,
              scheme: encrypted.scheme,
              mime: encrypted.mediaMime,
              size: encrypted.mediaSize,
              chunkSize: encrypted.chunkSize,
              chunkCount: encrypted.chunkCount,
              v: 1,
            }),
            trustedTargets
          );

            bridgePayload = buildEncryptedBridgeMediaPayload({
              mediaUrl,
              mediaMime: encrypted.mediaMime,
              mediaSize: encrypted.mediaSize,
              mediaIv: encrypted.mediaIv,
              mediaKeyId: encrypted.mediaKeyId,
              mediaKeyEnvelope,
              chunkSize: encrypted.chunkSize,
              chunkCount: encrypted.chunkCount,
              scheme: encrypted.scheme,
            });
          }
        } catch (encryptionError) {
          const requireEncryptedMedia = sanitizeSecuritySettings(stateRef.current.currentUser?.securitySettings).requireEncryptedMedia;
          const normalizedEncryptionError = extractError(encryptionError);

          console.warn('[Outbox] Media E2EE unavailable', {
            error: normalizedEncryptionError,
            clientId: task.payload.clientId,
            targetJid: task.payload.targetJid,
            requireEncryptedMedia,
          });

          updateOutboxTask(task.id, {
            state: 'failed',
            attempts: task.attempts + 1,
            nextRetryAt: undefined,
            error: 'E2EE_MEDIA_REQUIRED',
          });
          updateMessageStatusByTask(task.chatId, task.payload.tempMessageId, MessageStatus.FAILED, {
            outboxErrorCode: 'E2EE_MEDIA_REQUIRED',
            outboxErrorHint: 'Не удалось зашифровать медиа. Отправить без шифрования?',
          });

          if (requireEncryptedMedia) {
            return;
          }

          const allowUnencrypted = await promptUnencryptedMediaFallback(task.id);
          if (!allowUnencrypted) {
            return;
          }

          setOutboxTaskStageProgress(task.id, 'encrypting', 100, {
            state: 'in_progress',
            attempts: task.attempts + 1,
            nextRetryAt: undefined,
            error: undefined,
            payload: {
              ...task.payload,
              allowUnencryptedMedia: true,
            },
          });
          setOutboxTaskStageProgress(task.id, 'uploading', 0);

          const uploadFile = new File([mediaBlob], uploadName, { type: mediaBlob.type || media.mime || 'application/octet-stream' });
          const mediaUrl = await xmppService.uploadFile(uploadFile, (progress) => {
            setOutboxTaskStageProgress(task.id, 'uploading', progress);
          });
          bridgePayload = {
            mediaUrl,
            mediaMime: mediaBlob.type || media.mime || undefined,
            mediaVariants: buildAudioMediaVariants(mediaUrl, mediaBlob.type || media.mime || undefined),
            mediaSize: mediaBlob.size,
            encrypted: false,
            scheme: 'none',
          };
        }

        const relatedMediaMessage = stateRef.current.outboxTasks.find(entry => entry.id === task.payload.uploadTaskId || entry.payload.uploadTaskId === task.id);
        const payloadTransportScheme = 'mediaScheme' in bridgePayload ? bridgePayload.mediaScheme : bridgePayload.scheme;
        const payloadMediaIv = 'mediaIv' in bridgePayload ? bridgePayload.mediaIv : undefined;
        const payloadMediaKeyEnvelope = 'mediaKeyEnvelope' in bridgePayload ? bridgePayload.mediaKeyEnvelope : undefined;

        void dbService.saveMediaCacheEntry(task.payload.tempMessageId, mediaBlob, {
          messageId: task.payload.tempMessageId,
          mime: mediaBlob.type || media.mime || undefined,
          size: mediaBlob.size,
          mediaIv: payloadMediaIv,
          mediaKeyEnvelope: payloadMediaKeyEnvelope,
          transportScheme: payloadTransportScheme,
          isEncrypted: false,
        }).catch((cacheError) => {
          console.warn('[Outbox] Failed to persist outgoing media cache entry', {
            messageId: task.payload.tempMessageId,
            taskId: task.id,
            cacheError,
          });
        });

        if (relatedMediaMessage) {
          const bridgeScheme = payloadTransportScheme;
          updateOutboxTask(relatedMediaMessage.id, {
            payload: {
              ...relatedMediaMessage.payload,
              ...bridgePayload,
              encrypted: bridgePayload.encrypted,
              scheme: bridgeScheme,
            }
          });
        }

        setOutboxTaskStageProgress(task.id, 'sent', 100);
        updateMessageStatusByTask(task.chatId, task.payload.tempMessageId, MessageStatus.SENDING, { outboxErrorCode: undefined, outboxErrorHint: undefined });
        removeOutboxTask(task.id);
        return;
      }

      const isGroupMessage = task.payload.stanzaType === 'groupchat';
      const outgoingType = resolveOutgoingMediaType(
        isGroupMessage,
        xmppService.peerSupportsMediaType(task.payload.targetJid, task.payload.messageType),
        task.payload.messageType
      );

      const extraData = {
        type: outgoingType,
        mediaUrl: task.payload.mediaUrl,
        mediaMime: task.payload.mediaMime,
        mediaVariants: task.payload.mediaVariants,
        mediaSize: task.payload.mediaSize,
        replyToId: task.payload.replyToId,
        mediaIv: task.payload.mediaIv,
        mediaKeyId: task.payload.mediaKeyId,
        mediaKeyEnvelope: task.payload.mediaKeyEnvelope,
        encrypted: task.payload.encrypted,
        scheme: task.payload.scheme,
        chunkSize: task.payload.chunkSize,
        chunkCount: task.payload.chunkCount,
      };

      if (task.payload.messageType === 'audio') {
        const hasPlayableVariant = hasSafariSafeAudioVariant(task.payload.mediaMime, task.payload.mediaVariants);
        console.info('[VoiceVariantMetric] outgoing_voice_without_playable_variant', {
          clientId: task.payload.clientId,
          targetJid: task.payload.targetJid,
          hasPlayableVariant,
          mediaMime: task.payload.mediaMime,
          audioVariantCount: task.payload.mediaVariants?.audio?.length || 0,
        });
      }

      const sent = await xmppService.sendMessage(
        task.payload.targetJid,
        task.payload.text,
        task.payload.stanzaType,
        extraData,
        task.payload.clientId,
        undefined,
        undefined,
        {
          securityMode: task.payload.securityMode || (isGroupMessage ? 'transport' : 'e2ee_text_only'),
          allowMedia: task.payload.allowMedia !== false,
        }
      );

      if (!sent) {
        const sendResult = xmppService.consumeSendMessageResult(task.payload.clientId);
        const sendError = sendResult?.reasonCode || sendResult?.error || xmppService.consumeSendMessageError(task.payload.clientId);
        throw new Error(sendError || 'SEND_FAILED');
      }

      const sendResult = xmppService.consumeSendMessageResult(task.payload.clientId);
      const nextStatus = resolveMessageStatusFromDeliveryStatus(sendResult?.deliveryStatus);

      updateMessageStatusByTask(task.chatId, task.payload.tempMessageId, nextStatus, { outboxErrorCode: undefined, outboxErrorHint: undefined });
      removeOutboxTask(task.id);
    };

    processTask().catch((error) => {
      const normalizedError = extractError(error);
      const isMediaBlobInvalid = normalizedError.toLowerCase().includes('media_blob_invalid');
      const attempts = task.attempts + 1;
      const delay = getOutboxBackoffDelay(attempts);
      const retryState = isMediaBlobInvalid
        ? 'failed'
        : (isNetworkLikeError(error) || isDeferredUploadDiscoveryError(error) || isOmemoBundleFetchUnavailableError(error)) ? 'waiting_network' : 'retry';
      const nextRetryAt = retryState === 'failed' ? undefined : Date.now() + delay;

      updateOutboxTask(task.id, {
        state: retryState,
        attempts,
        nextRetryAt,
        error: normalizedError,
      });

      if (isMediaBlobInvalid) {
        console.warn('[Outbox] Task failed permanently due to MEDIA_BLOB_INVALID', {
          clientId: task.payload.clientId,
          taskId: task.id,
          chatId: task.chatId,
          targetJid: task.payload.targetJid,
          attempts,
          error: normalizedError,
        });
        updateMessageStatusByTask(task.chatId, task.payload.tempMessageId, MessageStatus.FAILED, {
          outboxErrorCode: 'MEDIA_BLOB_INVALID',
          outboxErrorHint: 'Пере-прикрепите файл',
        });
        return;
      }

      const sendErrorMeta = resolveOutboxSendErrorMeta(error);
      updateMessageStatusByTask(task.chatId, task.payload.tempMessageId, MessageStatus.RETRY, {
        outboxErrorCode: sendErrorMeta.outboxErrorCode,
        outboxErrorHint: sendErrorMeta.outboxErrorHint,
      });
    }).finally(() => {
      outboxProcessorRef.current = false;
    });
  }, [
    state.currentUser,
    state.outboxTasks,
    state.xmppConnected,
    getOutboxBackoffDelay,
    removeOutboxTask,
    updateMessageStatusByTask,
    updateOutboxTask,
    setOutboxTaskStageProgress,
    promptUnencryptedMediaFallback,
  ]);

  const canCurrentUserManageChat = useCallback((chat?: Chat | null) => {
    if (!state.currentUser || !chat) return false;
    if (chat.type !== ChatType.GROUP && chat.type !== ChatType.CHANNEL) return true;
    return chat.ownerId === state.currentUser.id;
  }, [state.currentUser]);

  const logMessageTelemetry = useCallback((event: 'guard_blocked' | 'sent_not_delivered' | 'delivered_rejected_peer_guard', payload: Record<string, string | number | boolean>) => {
    console.info('[Telemetry][MessageFlow]', event, payload);
  }, []);

  const routePeerToPendingRequests = useCallback((peerJid: string, reason: string): boolean => {
    const normalized = normalizeBareJid(peerJid);
    if (!normalized) return false;

    let added = false;
    setState(prev => {
      if (prev.pendingRequests.some(u => normalizeBareJid(u.id) === normalized)) return prev;
      const newUser: User = {
        id: normalized,
        jid: normalized,
        username: normalized.split('@')[0] || normalized,
        isOnline: false,
        status: `Message request (${reason})`,
        contactStatus: 'requested'
      };
      added = true;
      return { ...prev, pendingRequests: [...prev.pendingRequests, newUser] };
    });
    return added;
  }, []);


  const openContactApprovalModal = useCallback((peerJid: string, routeSource: 'composer_guard_block' | 'outgoing_guard_block') => {
    setContactApprovalModal({ open: true, peerJid, routeSource });
  }, []);

  const handleApproveContactAndSendRequest = useCallback(() => {
    if (!contactApprovalModal.peerJid) return;
    const peerBareJid = normalizeBareJid(contactApprovalModal.peerJid);
    if (peerBareJid) {
      void xmppService.addContact(peerBareJid);
    }
    routePeerToPendingRequests(contactApprovalModal.peerJid, contactApprovalModal.routeSource);
    setContactApprovalModal({ open: false, peerJid: '', routeSource: 'composer_guard_block' });
  }, [contactApprovalModal.peerJid, contactApprovalModal.routeSource, routePeerToPendingRequests]);

  const handleCancelContactApproval = useCallback(() => {
    setContactApprovalModal({ open: false, peerJid: '', routeSource: 'composer_guard_block' });
    notificationService.showNotification('Guard', 'Сообщение не отправлено: нет взаимного контакта');
  }, []);

  const processMessage = async (
    targetChatId: string,
    text: string,
    type: Message['type'],
    mediaUrl?: string,
    replyToId?: string,
    forwardedFrom?: { userId: string; username: string },
    bypassAccessGuard = false,
    botPayload?: BotIntentPayload,
    pendingMedia?: PendingMediaPayload
  ) => {
    if (!state.currentUser) return;

    let resolvedPendingMedia = pendingMedia;
    let resolvedMediaUrl = mediaUrl;

    if (!resolvedPendingMedia && resolvedMediaUrl?.startsWith('blob:')) {
      try {
        const blobResponse = await fetch(resolvedMediaUrl);
        if (!blobResponse.ok) throw new Error(`Failed to read local blob (${blobResponse.status})`);
        const blob = await blobResponse.blob();
        const fallbackMime = blob.type || 'application/octet-stream';
        const extension = fallbackMime.split('/')[1]?.split(';')[0] || 'bin';
        const fallbackFileName = `retry-media-${Date.now()}.${extension}`;

        resolvedPendingMedia = {
          blob,
          mime: fallbackMime,
          name: fallbackFileName,
          fileName: fallbackFileName,
          size: blob.size,
          type,
        };
        resolvedMediaUrl = undefined;
      } catch (blobReadError) {
        console.error('Unable to retry media message from local blob URL', blobReadError);
        alert('Cannot resend media from a temporary local preview. Please reattach the file.');
        return;
      }
    }

    const targetChat = state.chats.find(c => c.id === targetChatId);
    const targetChatPolicy = resolveChatPolicyContext(targetChatId, targetChat?.type === ChatType.GROUP ? 'groupchat' : 'chat');
    const hasMediaPayload = type !== 'text' || Boolean(resolvedMediaUrl) || Boolean(resolvedPendingMedia?.blob);

    if (targetChatPolicy.securityMode === 'e2ee_text_only' && hasMediaPayload) {
      notificationService.showNotification('Guard', 'This secure chat allows text messages only.');
      return;
    }

    if (!bypassAccessGuard && targetChat?.type === ChatType.PRIVATE && !targetChatId.startsWith('saved-')) {
      const peerJid = getPeerJidFromPrivateChatId(targetChatId);
      if (peerJid && !isChannelJid(peerJid) && !canExchangePrivateMessages(peerJid, userDirectoryRef.current)) {
        logMessageTelemetry('guard_blocked', {
          stage: 'composer',
          chatId: state.activeChatId,
          peerJid,
          reason: 'pending_request'
        });
        openContactApprovalModal(peerJid, 'composer_guard_block');
        return;
      }
    }

    if (!bypassAccessGuard && targetChat && (targetChat.type === ChatType.GROUP || targetChat.type === ChatType.CHANNEL)) {
      const modCheck = validateOutgoingGroupMessage(targetChat, state.currentUser.id, text, state.messages[targetChatId] || []);
      if (!modCheck.allowed) {
        const reasonMap = {
          anti_link_spam: 'spam',
          flood_protection: 'flood',
          slow_mode: 'other'
        } as const;
        void moderationService.saveLocalEvent(
          state.currentUser.id,
          targetChatId,
          'reject_message',
          reasonMap[modCheck.reason || 'slow_mode'],
          {
            chatId: targetChatId,
            reason: modCheck.reason || 'unknown',
            retryAfterMs: modCheck.retryAfterMs || 0
          }
        );
        const retrySuffix = modCheck.retryAfterMs ? ` Retry in ${Math.ceil(modCheck.retryAfterMs / 1000)}s.` : '';
        logMessageTelemetry('guard_blocked', {
          stage: 'moderation',
          chatId: targetChatId,
          reason: modCheck.reason || 'unknown',
          retryAfterMs: modCheck.retryAfterMs || 0
        });
        notificationService.showNotification('Guard', `Message blocked by moderation (${modCheck.reason || 'unknown'}).${retrySuffix}`);
        return;
      }
    }

    // Local ID for UI Optimism
    const tempId = `temp-${Date.now()}`;
    const clientId = createClientMessageId();
    const hasPendingMedia = Boolean(resolvedPendingMedia?.blob);
    const uploadTaskId = hasPendingMedia ? createOutboxTaskId() : undefined;
    const messageTaskId = hasPendingMedia ? createOutboxTaskId() : undefined;
    const attachmentId = hasPendingMedia ? `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : undefined;
    const localMediaPreviewUrl = (resolvedPendingMedia?.blob) ? URL.createObjectURL(resolvedPendingMedia.blob) : resolvedMediaUrl;
    const localMediaMime = hasPendingMedia
      ? (resolvedPendingMedia?.mime || resolvedPendingMedia?.blob?.type || undefined)
      : undefined;
    const initialStatus = hasPendingMedia
      ? ((state.xmppConnected && navigator.onLine) ? MessageStatus.SENDING : MessageStatus.QUEUED)
      : MessageStatus.SENDING;

    const chatMessages = state.messages[targetChatId] || [];
    const replyTarget = replyToId
      ? chatMessages.find(msg => msg.id === replyToId || msg.clientId === replyToId)
      : undefined;
    const stableReplyToId = replyTarget
      ? (replyTarget.id.startsWith('temp-') ? (replyTarget.clientId || replyTarget.id) : replyTarget.id)
      : replyToId;

    const newMessage: Message = {
      id: tempId,
      clientId,
      chatId: targetChatId,
      senderId: state.currentUser.id,
      text,
      timestamp: Date.now(),
      status: initialStatus,
      type,
      mediaUrl: localMediaPreviewUrl,
      mediaMime: localMediaMime,
      replyToId: stableReplyToId,
      forwardedFrom,
      reactions: [],
      ...(botPayload ? { bot: { structuredPayload: botPayload, slashCommand: botPayload.command } } : {})
    };

    setState(prev => {
      const newChats = [...prev.chats];
      const chatIndex = newChats.findIndex(c => c.id === targetChatId);
      if (chatIndex > -1) {
        const updatedChat = { ...newChats[chatIndex], lastMessage: newMessage };
        newChats.splice(chatIndex, 1);
        newChats.unshift(updatedChat);
      }
      return {
        ...prev,
        messages: {
          ...prev.messages,
          [targetChatId]: [...(prev.messages[targetChatId] || []), newMessage]
        },
        chats: newChats
      };
    });

    const { targetJid, stanzaType } = buildTargetMeta(targetChatId);
    const chatPolicy = resolveChatPolicyContext(targetChatId, stanzaType);
    const resolvedChatPolicy = chatPolicy;

    if (hasPendingMedia && resolvedPendingMedia?.blob && attachmentId) {
      await dbService.saveOutboxMediaAttachment(attachmentId, resolvedPendingMedia.blob, {
        fileName: resolvedPendingMedia.fileName || resolvedPendingMedia.name,
        mime: resolvedPendingMedia.mime || resolvedPendingMedia.blob.type || undefined,
        size: resolvedPendingMedia.size || resolvedPendingMedia.blob.size,
        type: resolvedPendingMedia.type,
      });

      const uploadTask: OutboxTask = {
        id: uploadTaskId!,
        userId: state.currentUser.id,
        chatId: targetChatId,
        type: 'media-upload',
        state: (state.xmppConnected && navigator.onLine) ? 'pending' : 'waiting_network',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        progress: 0,
        currentStage: 'preparing',
        stageProgress: createInitialOutboxStageProgress(),
        payload: {
          text,
          messageType: type,
          replyToId: stableReplyToId,
          clientId,
          tempMessageId: tempId,
          targetJid,
          stanzaType,
          securityMode: resolvedChatPolicy.securityMode,
          allowMedia: resolvedChatPolicy.allowMedia,
          media: {
            attachmentId,
            fileName: resolvedPendingMedia.fileName || resolvedPendingMedia.name,
            mime: resolvedPendingMedia.mime || resolvedPendingMedia.blob.type || undefined,
            size: resolvedPendingMedia.size || resolvedPendingMedia.blob.size,
            type: resolvedPendingMedia.type,
          },
        }
      };

      const mediaMessageTask: OutboxTask = {
        id: messageTaskId!,
        userId: state.currentUser.id,
        chatId: targetChatId,
        type: 'media-message',
        state: (state.xmppConnected && navigator.onLine) ? 'pending' : 'waiting_network',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        payload: {
          text,
          messageType: type,
          replyToId: stableReplyToId,
          clientId,
          tempMessageId: tempId,
          targetJid,
          stanzaType,
          securityMode: resolvedChatPolicy.securityMode,
          allowMedia: resolvedChatPolicy.allowMedia,
          uploadTaskId: uploadTaskId!,
          mediaVariants: resolvedPendingMedia?.mediaVariants,
        }
      };

      setState(prev => ({ ...prev, outboxTasks: [...prev.outboxTasks, uploadTask, mediaMessageTask] }));
      return;
    }

    if (state.xmppConnected) {
      const targetChat = state.chats.find(c => c.id === targetChatId);
      const isGroup = targetChat ? targetChat.type === ChatType.GROUP : false;
      const stanzaType: 'chat' | 'groupchat' = isGroup ? 'groupchat' : 'chat';
      const outgoingType = resolveOutgoingMediaType(isGroup, xmppService.peerSupportsMediaType(targetJid, type), type);
      const sent = await xmppService.sendMessage(
        targetJid,
        text,
        stanzaType,
        (resolvedMediaUrl || botPayload || stableReplyToId)
          ? {
              type: outgoingType,
              mediaUrl: resolvedMediaUrl,
              replyToId: stableReplyToId,
              ...(botPayload ? { bot: { structuredPayload: botPayload, slashCommand: botPayload.command } } : {}),
            }
          : undefined,
        clientId,
        undefined,
        undefined,
        resolvedChatPolicy
      );

      const sendResult = xmppService.consumeSendMessageResult(clientId);

      if (!sent) {
        const failurePresentation = resolveSendFailurePresentation(sendResult);
        updateMessageStatusByClientId(clientId, failurePresentation.status, {
          outboxErrorCode: failurePresentation.outboxErrorCode,
          outboxErrorHint: failurePresentation.outboxErrorHint,
        });
        return;
      }

      updateMessageStatusByClientId(clientId, resolveMessageStatusFromDeliveryStatus(sendResult?.deliveryStatus), {
        outboxErrorCode: undefined,
        outboxErrorHint: undefined,
      });
    }
  };

  const sendMessage = useCallback((text: string, type: Message['type'] = 'text', mediaUrl?: string, replyToId?: string, botPayload?: BotIntentPayload | PendingMediaPayload, pendingMedia?: PendingMediaPayload) => {
    if (!state.activeChatId) return;

    const activeChatMeta = state.chats.find(c => c.id === state.activeChatId);
    if (activeChatMeta?.type === ChatType.PRIVATE && !state.activeChatId.startsWith('saved-')) {
      const peerJid = getPeerJidFromPrivateChatId(state.activeChatId);
      if (peerJid && !isChannelJid(peerJid) && !canExchangePrivateMessages(peerJid, userDirectoryRef.current)) {
        logMessageTelemetry('guard_blocked', {
          stage: 'composer',
          chatId: state.activeChatId,
          peerJid,
          reason: 'pending_request'
        });
        openContactApprovalModal(peerJid, 'outgoing_guard_block');
      }
    }

    processMessage(state.activeChatId, text, type, mediaUrl, replyToId, undefined, false, (botPayload && 'intent' in botPayload) ? botPayload as BotIntentPayload : undefined, pendingMedia || ((botPayload && !('intent' in botPayload)) ? botPayload as PendingMediaPayload : undefined));
  }, [state.activeChatId, state.currentUser, state.chats, state.xmppConnected, logMessageTelemetry, openContactApprovalModal, resolveChatPolicyContext, routePeerToPendingRequests]);

  const scheduleMessage = useCallback((text: string, date: number, type: Message['type'] = 'text', mediaUrl?: string, replyToId?: string) => {
    if (!state.activeChatId || !state.currentUser) return;
    const targetChatId = state.activeChatId;
    
    const msg: Message = {
      id: `sched-${Date.now()}`,
      chatId: targetChatId,
      senderId: state.currentUser.id,
      text,
      timestamp: Date.now(),
      status: MessageStatus.SCHEDULED,
      type,
      mediaUrl,
      replyToId,
      scheduledFor: date,
      reactions: []
    };

    setState(prev => ({
      ...prev,
      scheduledMessages: {
        ...prev.scheduledMessages,
        [targetChatId]: [...(prev.scheduledMessages[targetChatId] || []), msg].sort((a, b) => (a.scheduledFor || 0) - (b.scheduledFor || 0))
      }
    }));

    enqueueSyncOperation(makeSyncOp('upsert_scheduled', {
      chatId: targetChatId,
      message: {
        id: msg.id,
        text: msg.text,
        type: msg.type,
        mediaUrl: msg.mediaUrl,
        replyToId: msg.replyToId,
        scheduledFor: msg.scheduledFor || date,
        timestamp: msg.timestamp,
      }
    }));
  }, [state.activeChatId, state.currentUser]);

  const cancelScheduledMessage = useCallback((msgId: string) => {
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    setState(prev => ({
      ...prev,
      scheduledMessages: {
        ...prev.scheduledMessages,
        [chatId]: (prev.scheduledMessages[chatId] || []).filter(m => m.id !== msgId)
      }
    }));
    enqueueSyncOperation(makeSyncOp('remove_scheduled', { chatId, messageId: msgId }));
  }, [state.activeChatId]);

  const retractMessageFromState = useCallback((chatId: string, messageId: string) => {
    xmppService.releaseMediaBlobUrlForMessage(messageId);
    void dbService.deleteMediaCacheEntry(messageId).catch((error) => console.warn('Failed to cleanup media cache for retracted message', error));
    setState(prev => {
      const currentMessages = prev.messages[chatId] || [];
      const nextMessagesForChat = currentMessages.filter(msg => msg.id !== messageId);

      if (nextMessagesForChat.length === currentMessages.length) {
        return prev;
      }

      const nextLastMessage = nextMessagesForChat[nextMessagesForChat.length - 1];

      return {
        ...prev,
        messages: {
          ...prev.messages,
          [chatId]: nextMessagesForChat
        },
        chats: prev.chats.map(chat =>
          chat.id === chatId
            ? { ...chat, lastMessage: nextLastMessage }
            : chat
        )
      };
    });
  }, []);

  const canRetractForEveryone = useCallback((chat: Chat | undefined, message: Message) => {
    if (!state.currentUser || !chat) return false;

    const isMine = message.senderId === state.currentUser.id;
    const isOwner = chat.ownerId === state.currentUser.id;
    const isAdmin = chat.adminIds.includes(state.currentUser.id);

    if (chat.type === ChatType.GROUP) return isMine || isOwner || isAdmin;
    if (chat.type === ChatType.CHANNEL) return isOwner || isAdmin;
    return isMine;
  }, [state.currentUser]);

  const handleDeleteMessage = useCallback((message: Message, scope: 'me' | 'everyone') => {
    const chatId = message.chatId;
    const messageId = message.id;

    retractMessageFromState(chatId, messageId);

    if (scope !== 'everyone' || !state.xmppConnected) return;

    const targetChat = state.chats.find(chat => chat.id === chatId);
    if (!targetChat || !canRetractForEveryone(targetChat, message)) return;

    if (targetChat.type === ChatType.PRIVATE) {
      const peerJid = getPeerJidFromPrivateChatId(chatId);
      if (peerJid && !xmppService.peerSupportsFeature(peerJid, 'chat-control-v1')) {
        alert(t.retractUnavailableLegacy);
        return;
      }
    }

    let targetJid = chatId;
    const parsedPrivate = parsePrivateChatId(chatId);
    if (parsedPrivate) targetJid = parsedPrivate.peerJid;
    if (chatId.startsWith('saved-') && state.currentUser) targetJid = state.currentUser.id;

    xmppService.sendDeleteMessage(
      targetJid,
      messageId,
      targetChat.type === ChatType.GROUP ? 'groupchat' : 'chat'
    );
  }, [state.xmppConnected, state.chats, state.currentUser, canRetractForEveryone, retractMessageFromState]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const updates: { chatId: string, msg: Message }[] = [];

      Object.entries(state.scheduledMessages).forEach(([chatId, msgs]) => {
        (msgs as Message[]).forEach(msg => {
          if (msg.scheduledFor && msg.scheduledFor <= now) {
            updates.push({ chatId, msg });
          }
        });
      });

      if (updates.length > 0) {
        setState(prev => {
          const nextScheduled = { ...prev.scheduledMessages };
          updates.forEach(({ chatId, msg }) => {
            if (nextScheduled[chatId]) {
              nextScheduled[chatId] = nextScheduled[chatId].filter(m => m.id !== msg.id);
            }
          });
          return { ...prev, scheduledMessages: nextScheduled };
        });

        updates.forEach(({ chatId, msg }) => {
          processMessage(chatId, msg.text, msg.type, msg.mediaUrl, msg.replyToId);
        });
      }
    }, 3000); 

    return () => clearInterval(interval);
  }, [state.scheduledMessages, state.currentUser, state.chats]); 

  const handleUpdateSettings = async (updates: any) => {
    if (updates.currentUser) {
      const shouldAllowDisable2FA = updates.currentUser.twoFactorDisableVerified === true;
      const { twoFactorDisableVerified, ...sanitizedUserRaw } = updates.currentUser;
      const sanitizedUser = withUserDefaults(sanitizedUserRaw);

      await authService.updateUser(sanitizedUser, {
        allowDisable2FA: shouldAllowDisable2FA,
      });

      updates = {
        ...updates,
        currentUser: sanitizedUser,
      };
    }

    if (updates.soundSettings) {
      updates = {
        ...updates,
        soundSettings: mergeSoundSettings(updates.soundSettings),
      };
    }

    if (updates.notifications === true && state.notifications === false) {
      notificationService.requestPermission();
    }

    setState(prev => ({ ...prev, ...updates }));

    const syncPrefs: any = {};
    if (typeof updates.theme === 'string') syncPrefs.theme = updates.theme;
    if (typeof updates.notifications === 'boolean') syncPrefs.notifications = updates.notifications;
    if (updates.language === 'en' || updates.language === 'ru') syncPrefs.language = updates.language;
    if (updates.soundSettings) syncPrefs.soundSettings = mergeSoundSettings(updates.soundSettings);
    if (Object.keys(syncPrefs).length > 0) {
      enqueueSyncOperation(makeSyncOp('update_prefs', { value: syncPrefs }));
    }

    if (updates.lockPolicy) {
      enqueueSyncOperation(makeSyncOp('set_lock_policy', { value: {
        enabled: !!updates.lockPolicy.enabled,
        biometricsEnabled: !!updates.lockPolicy.biometricsEnabled,
        updatedAt: Date.now(),
      } }));
    }
  };

  const handleRequestContactApproval = useCallback(async (peerJid: string) => {
    const canSendXmppRequests = stateRef.current.xmppConnected
      && xmppService.getStatus() === 'CONNECTED'
      && stateRef.current.xmppSessionReady;

    if (!canSendXmppRequests) {
      alert(
        navigator.onLine
          ? 'Transport is not ready yet. Please wait a moment and try again.'
          : 'No network connection. Reconnect to the internet and try again.'
      );
      return;
    }

    const normalized = normalizeBareJid(peerJid);
    const result = await xmppService.addContact(normalized);
    if (!result.success) {
      console.warn('[App] Failed to send contact request', result.error);
    }
  }, []);

  const startPrivateChat = useCallback((user: User, securityMode: ChatSecurityMode = 'transport') => {
    if (!state.currentUser) return undefined;
    const currentUserBareJid = normalizeBareJid(state.currentUser.id || xmppService.currentUserJid || '');
    const targetBareJid = normalizeBareJid(user.jid || user.id);
    if (targetBareJid && currentUserBareJid && targetBareJid === currentUserBareJid) {
      const savedChatId = `saved-${state.currentUser.id}`;
      setState(prev => ({ ...prev, activeChatId: savedChatId }));
      return savedChatId;
    }

    const peerBareJid = targetBareJid || normalizeBareJid(user.id);
    const chatId = buildPrivateChatId(peerBareJid, securityMode);

    if (state.xmppConnected && targetBareJid) {
      xmppService.addContact(targetBareJid, user.username);
    }

    setState(prev => {
      const existingChat = prev.chats.find(chat => chat.id === chatId);
      const baseChat: Chat = existingChat || {
        id: chatId,
        type: ChatType.PRIVATE,
        securityMode,
        name: user.username,
        normalizedName: normalizeChannelName(user.username),
        isHidden: true,
        participants: [prev.currentUser?.id || state.currentUser.id, user.id],
        unreadCount: 0,
        adminIds: [],
        description: user.bio,
      };
      const nextChat: Chat = {
        ...baseChat,
        securityMode,
      };

      return {
        ...prev,
        chats: mergeChatsUniqueById(prev.chats, [nextChat]),
        activeChatId: chatId,
      };
    });

    if (state.xmppConnected && targetBareJid) {
      xmppService.sendCreateChatControl(targetBareJid, {
        chatId,
        peerJid: currentUserBareJid,
        securityMode,
      });
    }

    return chatId;
  }, [state.currentUser, state.xmppConnected]);

  const handleStartChat = (user: User) => startPrivateChat(user, 'transport');

  const handleStartSecureChat = (user: User) => startPrivateChat(user, 'e2ee_text_only');


  const applyLocalContactCleanup = useCallback((userId: string) => {
    const normalizedUserId = normalizeBareJid(userId);
    if (!normalizedUserId) return;

    xmppService.clearPeerLocalState(normalizedUserId);
    clearPrivateGuardStateForPeer(normalizedUserId);
    e2eeService.clearTrustStateForJid(normalizedUserId);

    setUserDirectory(prev => prev.filter(u => normalizeBareJid(u.id) !== normalizedUserId));

    setState(prev => {
      const privateChatIdsToDelete = prev.chats
        .filter(c => c.type === ChatType.PRIVATE && ((parsePrivateChatId(c.id)?.peerJid === normalizedUserId) || c.participants.some(p => normalizeBareJid(p) === normalizedUserId)))
        .map(c => c.id);

      const nextMessages = { ...prev.messages };
      const nextScheduled = { ...prev.scheduledMessages };
      privateChatIdsToDelete.forEach(chatId => {
        delete nextMessages[chatId];
        delete nextScheduled[chatId];
      });

      const nextActiveChatId = prev.activeChatId && privateChatIdsToDelete.includes(prev.activeChatId)
        ? null
        : prev.activeChatId;

      return {
        ...prev,
        chats: prev.chats.filter(c => !privateChatIdsToDelete.includes(c.id)),
        pendingRequests: prev.pendingRequests.filter(u => normalizeBareJid(u.id) !== normalizedUserId),
        messages: nextMessages,
        scheduledMessages: nextScheduled,
        activeChatId: nextActiveChatId
      };
    });
  }, []);

  const handleReportPeer = useCallback(async (targetId: string, reasonCode: ModerationReasonCode) => {
    if (!state.currentUser) return;
    const localEvent = await moderationService.saveLocalEvent(state.currentUser.id, targetId, 'report', reasonCode, {
      chatId: state.activeChatId || 'none'
    });

    const sent = xmppService.sendModerationEvent(targetId, 'report', reasonCode, { localEventId: localEvent.id });
    if (sent) {
      await moderationService.appendServerAck(localEvent);
    }
  }, [state.currentUser, state.activeChatId]);

  const handleBlockPeer = useCallback(async (targetId: string, reasonCode: ModerationReasonCode) => {
    if (!state.currentUser) return;
    const normalizedTarget = normalizeBareJid(targetId);
    manuallySilencePrivatePeer(normalizedTarget, 24 * 60 * 60 * 1000);

    const localEvent = await moderationService.saveLocalEvent(state.currentUser.id, normalizedTarget, 'block', reasonCode, {
      chatId: state.activeChatId || 'none'
    });

    setState(prev => {
      if (!prev.currentUser) return prev;
      const existing = new Set(prev.currentUser.blockedUserIds || []);
      existing.add(normalizedTarget);
      return {
        ...prev,
        currentUser: {
          ...prev.currentUser,
          blockedUserIds: Array.from(existing)
        }
      };
    });

    const sent = xmppService.sendModerationEvent(normalizedTarget, 'block', reasonCode, { localEventId: localEvent.id });
    if (sent) {
      await moderationService.appendServerAck(localEvent);
    }
  }, [state.currentUser, state.activeChatId]);

  const handleRemoveContact = useCallback(async (user: User) => {
    const confirmed = window.confirm(`${t.removeContact}?\n${user.id}`);
    if (!confirmed) return;

    if (state.xmppConnected) {
      const result = await xmppService.removeContact(user.id);
      if (!result.success) {
        console.warn('[App] removeContact failed:', result.error);
        return;
      }
      applyLocalContactCleanup(user.id);
    } else {
      applyLocalContactCleanup(user.id);
    }

    const currentUserId = state.currentUser?.id;
    if (currentUserId) {
      const savedChatId = `saved-${currentUserId}`;
      const warningMessage: Message = {
        id: `sys-${Date.now()}`,
        chatId: savedChatId,
        senderId: 'system',
        text: `Contact ${user.id} removed: private messaging is blocked until a new mutual subscription is approved.`,
        timestamp: Date.now(),
        status: MessageStatus.READ,
        type: 'text',
        reactions: []
      };

      setState(prev => {
        const existingSavedChat = prev.chats.find(c => c.id === savedChatId);
        const savedChatName = t.personalSpace;
        const nextChats = existingSavedChat
          ? prev.chats.map(chat => chat.id === savedChatId ? { ...chat, lastMessage: warningMessage } : chat)
          : [{
              id: savedChatId,
              type: ChatType.SAVED,
              name: savedChatName,
              normalizedName: normalizeChannelName(savedChatName),
              isHidden: true,
              participants: [currentUserId],
              unreadCount: prev.activeChatId === savedChatId ? 0 : 1,
              adminIds: [currentUserId],
              isPinned: true,
              lastMessage: warningMessage,
              securityMode: 'transport' as const
            }, ...prev.chats];

        return {
          ...prev,
          chats: nextChats,
          messages: {
            ...prev.messages,
            [savedChatId]: [...(prev.messages[savedChatId] || []), warningMessage]
          }
        };
      });
    }

  }, [applyLocalContactCleanup, state.xmppConnected, state.currentUser, t.removeContact, t.personalSpace]);


  const handleForwardToUser = (user: User) => {
     const chatId = buildPrivateChatId(user.jid || user.id, 'transport');
     if (!chatId) return;
     setState(prev => {
      const existingChat = prev.chats.find(c => c.id === chatId);
      if (existingChat) return prev;

      const newChat: Chat = {
       id: chatId,
       type: ChatType.PRIVATE,
       securityMode: 'transport',
       name: user.username,
       normalizedName: normalizeChannelName(user.username),
       isHidden: true,
       participants: [prev.currentUser?.id || state.currentUser!.id, user.id],
       unreadCount: 0,
       adminIds: [],
       description: user.bio,
     };

     return { ...prev, chats: upsertChatById(prev.chats, newChat) };
    });
     performForward(chatId);
  };

  const handleRetryMediaMessage = useCallback((message: Message) => {
    if (message.outboxErrorCode === 'MEDIA_BLOB_INVALID') {
      alert('Файл поврежден после перезапуска. Пере-прикрепите медиа и отправьте заново.');
      return;
    }

    if (message.outboxErrorCode === 'E2EE_MEDIA_REQUIRED') {
      const failedTask = stateRef.current.outboxTasks.find(task => task.payload.tempMessageId === message.id && task.type === 'media-upload');
      if (failedTask) {
        updateOutboxTask(failedTask.id, {
          state: 'pending',
          error: undefined,
          nextRetryAt: undefined,
          payload: {
            ...failedTask.payload,
            allowUnencryptedMedia: false,
          },
        });
      }
      updateMessageStatusByTask(message.chatId, message.id, MessageStatus.RETRY, {
        outboxErrorCode: undefined,
        outboxErrorHint: undefined,
      });
      return;
    }

    if (!state.activeChatId) return;
    processMessage(
      state.activeChatId,
      message.text,
      message.type,
      message.mediaUrl,
      message.replyToId,
      message.forwardedFrom,
      true,
      message.bot?.structuredPayload
    );
  }, [state.activeChatId, processMessage, updateMessageStatusByTask, updateOutboxTask]);

  const performForward = (chatId: string) => {
    if (!messageToForward || !state.currentUser) return;

    const sourceUser = messageToForward.forwardedFrom 
      ? messageToForward.forwardedFrom 
      : {
          userId: messageToForward.senderId,
          username: resolveDisplayNameById(messageToForward.senderId)
        };

    processMessage(
      chatId,
      messageToForward.text,
      messageToForward.type,
      messageToForward.mediaUrl,
      undefined,
      sourceUser
    );

    setMessageToForward(null);
    setState(prev => ({ ...prev, activeChatId: chatId }));
  };

  const handleStartGroup = async (name: string, participantIds: string[]) => {
    if (!state.currentUser) return;

    const creatorJid = xmppService.getBareJidFromJid(state.currentUser.id);
    const uniqueParticipantIds = Array.from(
      new Set(
        participantIds
          .map(id => xmppService.getBareJidFromJid(id))
          .filter((jid): jid is string => Boolean(jid) && jid !== creatorJid)
      )
    );

    const domain = state.currentUser.jid ? state.currentUser.jid.split('@')[1] : 'localhost';
    const mucDomain = `conference.${domain}`;
    const cleanName = name.replace(/\s+/g, '-').toLowerCase();
    const roomNode = `${cleanName}-${Math.floor(Math.random()*1000)}`;
    const roomJid = `${roomNode}@${mucDomain}`;

    const newChat: Chat = {
        id: roomJid,
        type: ChatType.GROUP,
        name: name,
        normalizedName: normalizeChannelName(name),
        isHidden: false,
        participants: [state.currentUser.id, ...uniqueParticipantIds],
        unreadCount: 0,
        adminIds: [state.currentUser.id],
        ownerId: state.currentUser.id,
        description: 'Secure Group Cluster',
        moderation: {
          antiLinkSpam: true,
          floodProtection: true,
          slowModeSeconds: 5
        },
        inviteCode: generateInviteCode(),
        securityMode: 'transport'
    };

    setState(prev => ({ ...prev, chats: mergeChatsUniqueById(prev.chats, [newChat]), activeChatId: roomJid }));

    if (state.xmppConnected) {
        xmppService.joinRoom(roomJid, state.currentUser.username);

        const inviteFailures: string[] = [];
        const maxRetries = 3;

        for (const participantJid of uniqueParticipantIds) {
          let assigned = false;

          for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
            try {
              await xmppService.setGroupAffiliation(roomJid, participantJid, 'member');
              assigned = true;
              break;
            } catch (error) {
              const isLastAttempt = attempt === maxRetries;
              console.error(`[GROUP] Failed to grant member affiliation for ${participantJid} (attempt ${attempt}/${maxRetries})`, error);

              if (isLastAttempt) {
                inviteFailures.push(participantJid);
              } else {
                await new Promise(resolve => setTimeout(resolve, 700 * attempt));
              }
            }
          }

          if (!assigned) {
            notificationService.showNotification('System', `Failed to invite ${participantJid} to ${name}. Please retry manually.`);
          }
        }

        if (inviteFailures.length > 0) {
          console.warn(`[GROUP] Partial invite completion for ${roomJid}. Failed members:`, inviteFailures);
        }
    }

  };


  const handleStartChannel = (name: string, description: string, isHidden: boolean) => {
     if (!state.currentUser) return;

     const normalizedName = normalizeChannelName(name);
     const localCollision = state.chats.some(chat => chat.type === ChatType.CHANNEL && normalizeChannelName(chat.normalizedName || chat.name) === normalizedName);
     const directoryCollision = xmppService.isGlobalChannelNameTaken(normalizedName);
     if (localCollision || directoryCollision) {
      notificationService.showNotification('System', `Channel @${name.trim()} already exists.`);
      return;
     }

     const domain = state.currentUser.jid ? state.currentUser.jid.split('@')[1] : 'localhost';
     const mucDomain = `conference.${domain}`;
     const roomJid = `channel-${Date.now()}@${mucDomain}`;

     const searchIndexedAt = !isHidden ? Date.now() : undefined;
     const newChat: Chat = {
         id: roomJid,
         type: ChatType.CHANNEL,
         name: name,
         normalizedName,
         isHidden,
         searchIndexedAt,
         description: description,
         participants: [state.currentUser.id],
         unreadCount: 0,
         adminIds: [state.currentUser.id],
         ownerId: state.currentUser.id,
         subscriberCount: 1,
         moderation: {
           antiLinkSpam: true,
           floodProtection: true,
           slowModeSeconds: 8
         },
         inviteCode: generateInviteCode(),
         securityMode: 'transport'
     };

     setState(prev => ({ ...prev, chats: mergeChatsUniqueById(prev.chats, [newChat]), activeChatId: roomJid }));

     if (!isHidden) {
      xmppService.publishChannelToGlobalDirectory(newChat);
     }

     if (state.xmppConnected) {
         xmppService.joinRoom(roomJid, state.currentUser.username);
     }
  };

  const handleManageGroupMember = (chatId: string, memberId: string, action: GroupMemberManageAction) => {
      const targetChat = state.chats.find(c => c.id === chatId);
      if (!canCurrentUserManageChat(targetChat)) return;

      if (state.xmppConnected) {
        let affiliation: 'admin' | 'member' | 'outcast' | 'none' | 'owner' = 'member';
        if (action === 'promote') affiliation = 'admin';
        if (action === 'demote') affiliation = 'member';
        if (action === 'kick') affiliation = 'none';
        void xmppService.setGroupAffiliation(chatId, memberId, affiliation).catch(error => {
          console.error(`[GROUP] Failed to update member ${memberId} in ${chatId} with affiliation ${affiliation}`, error);
          notificationService.showNotification('System', `Could not update permissions for ${memberId}. Please retry.`);
        });
      }

      setState(prev => {
          const chats = prev.chats.map(c => {
              if (c.id !== chatId) return c;

              let newAdminIds = [...c.adminIds];
              let newParticipants = [...c.participants];

              if (action === 'promote') {
                  if (!newAdminIds.includes(memberId)) newAdminIds.push(memberId);
              } else if (action === 'demote') {
                  newAdminIds = newAdminIds.filter(id => id !== memberId);
              } else if (action === 'kick') {
                  newAdminIds = newAdminIds.filter(id => id !== memberId);
                  newParticipants = newParticipants.filter(id => id !== memberId);
              }

              return { ...c, adminIds: newAdminIds, participants: newParticipants };
          });
          return { ...prev, chats };
      });
  };



  const handleAddGroupMembers: AddGroupMembersHandler = (chatId, memberIds) => {
    const targetChat = state.chats.find(c => c.id === chatId);
    if (!canCurrentUserManageChat(targetChat) || !state.currentUser) return;

    const currentUserJid = xmppService.getBareJidFromJid(state.currentUser.id);
    const uniqueMemberIds = Array.from(
      new Set(
        memberIds
          .map(id => xmppService.getBareJidFromJid(id))
          .filter((jid): jid is string => Boolean(jid) && jid !== currentUserJid)
      )
    );
    if (uniqueMemberIds.length === 0) return;

    if (state.xmppConnected) {
      uniqueMemberIds.forEach(memberId => {
        xmppService.setGroupAffiliation(chatId, memberId, 'member');
      });
    }

    setState(prev => {
      const chats = prev.chats.map(chat => {
        if (chat.id !== chatId) return chat;
        const nextParticipants = Array.from(new Set([...chat.participants, ...uniqueMemberIds]));
        return {
          ...chat,
          participants: nextParticipants,
          subscriberCount: chat.type === ChatType.CHANNEL ? nextParticipants.length : chat.subscriberCount,
        };
      });
      return { ...prev, chats };
    });
  };



  const enqueueSyncOperation = useCallback((op: SyncOperation) => {
    setPendingSyncOps(prev => [...prev, op]);
    setSyncEnvelope(prev => ({ ...prev, snapshot: applySyncOperation(prev.snapshot, op) }));
    setSyncStatus('idle');
  }, []);


  const handleCopyInviteLink = async (chatId: string) => {
    const chat = state.chats.find(c => c.id === chatId);
    if (!chat || (chat.type !== ChatType.GROUP && chat.type !== ChatType.CHANNEL)) return;
    const code = chat.inviteCode || generateInviteCode();
    if (!chat.inviteCode) {
      setState(prev => ({ ...prev, chats: prev.chats.map(c => c.id === chatId ? { ...c, inviteCode: code } : c) }));
    }
    const inviteUrl = `${window.location.origin}/#join=${encodeURIComponent(chat.id)}:${code}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      notificationService.showNotification('System', 'Invite link copied');
    } catch {
      notificationService.showNotification('System', inviteUrl);
    }
  };

  const handleJoinViaInviteLink = () => {
    const raw = window.prompt('Paste invite link');
    if (!raw || !state.currentUser) return;
    const decoded = decodeURIComponent(raw.trim());
    const match = decoded.match(/#join=([^:]+):([a-z0-9]+)/i);
    if (!match) {
      notificationService.showNotification('System', 'Invalid invite link');
      return;
    }
    const roomJid = match[1];
    const code = match[2];
    const existing = state.chats.find(c => c.id === roomJid);
    if (existing && existing.inviteCode && existing.inviteCode !== code) {
      notificationService.showNotification('System', 'Invite code is invalid');
      return;
    }

    const chatType = roomJid.startsWith('channel-') ? ChatType.CHANNEL : ChatType.GROUP;
    setState(prev => {
      const existingChat = prev.chats.find(c => c.id === roomJid);
      if (!existingChat) {
        const discovered: Chat = {
          id: roomJid,
          type: chatType,
          name: roomJid.split('@')[0],
          normalizedName: roomJid.split('@')[0],
          isHidden: false,
          participants: [prev.currentUser?.id || state.currentUser.id],
          unreadCount: 0,
          adminIds: [],
          inviteCode: code,
          subscriberCount: chatType === ChatType.CHANNEL ? 1 : undefined,
          securityMode: 'transport'
        };
        return { ...prev, chats: mergeChatsUniqueById(prev.chats, [discovered]), activeChatId: roomJid };
      }

      return { ...prev, activeChatId: roomJid };
    });

    if (state.xmppConnected) {
      xmppService.joinRoom(roomJid, state.currentUser.username);
    }
  };

  const handleOpenSettings = () => {
    setShowSettings(true);
  };

  const toggleChatMute = (chatId: string) => {
    setState(prev => {
      const newChats = prev.chats.map(c => 
        c.id === chatId ? { ...c, isMuted: !c.isMuted } : c
      );
      return { ...prev, chats: newChats };
    });
    const target = state.chats.find(c => c.id === chatId);
    enqueueSyncOperation(makeSyncOp('set_chat_mute', { chatId, value: !(target?.isMuted ?? false) }));
  };

  const handleMentionClick = (username: string) => {
      // Logic would need to resolve username to JID
  };

  const handleSelectChat = (id: string) => {
      setState(prev => {
          const newChats = prev.chats.map(c => 
              c.id === id ? { ...c, unreadCount: 0 } : c
          );
          return { ...prev, activeChatId: id, chats: newChats };
      });
      
      if (state.xmppConnected) {
          const parsedPrivate = parsePrivateChatId(id);
          if (parsedPrivate) {
            xmppService.fetchHistory(parsedPrivate.peerJid);
          }
      }
  };

  // --- Request Handlers ---
  const handleAcceptRequest = (user: User) => {
      const normalizedUserId = normalizeBareJid(user.id);
      xmppService.acceptSubscription(normalizedUserId);
      clearIncomingPresenceRequest(normalizedUserId);
      setUserDirectory(prev => {
        const exists = prev.some(entry => normalizeBareJid(entry.id) === normalizedUserId);
        if (!exists) {
          return [...prev, { id: normalizedUserId, jid: normalizedUserId, username: normalizedUserId.split('@')[0], isOnline: false, status: 'Offline', subscription: 'both', ask: null, contactStatus: 'mutual' } as User];
        }
        return prev.map(entry =>
          normalizeBareJid(entry.id) === normalizedUserId
            ? { ...entry, subscription: 'both', ask: null, contactStatus: 'mutual' }
            : entry
        );
      });
  };

  const handleDenyRequest = (user: User) => {
      xmppService.denySubscription(user.id);
      clearIncomingPresenceRequest(user.id);
  };

  const toggleChatPin = (chatId: string) => {
    setState(prev => {
        const updatedChats = prev.chats.map(c => 
            c.id === chatId ? { ...c, isPinned: !c.isPinned } : c
        );
        return { ...prev, chats: updatedChats };
    });
    const target = state.chats.find(c => c.id === chatId);
    enqueueSyncOperation(makeSyncOp('set_chat_pin', { chatId, value: !(target?.isPinned ?? false) }));
  };

  const resetChatEncryption = async (chatId: string) => {
    const chat = state.chats.find(c => c.id === chatId);
    if (!chat || chat.type !== ChatType.PRIVATE) return;

    const peerJid = getPeerJidFromPrivateChatId(chatId) || chatId;
    const confirmed = window.confirm(`${t.confirmResetChatEncryption}
${chat.name}`);
    if (!confirmed) return;

    const removed = await xmppService.resetOmemoSessionsForJid(peerJid, 'manual');
    notificationService.showNotification(
      t.resetChatEncryption,
      removed > 0 ? t.resetChatEncryptionDone : t.resetChatEncryptionNoSessions,
    );
  };

  const clearChat = async (chatId: string) => {
    const chatToClear = state.chats.find(c => c.id === chatId);
    if (!chatToClear || !canCurrentUserManageChat(chatToClear)) return;

    const confirmed = window.confirm(`${t.confirmClearChat}\n${chatToClear.name}`);
    if (!confirmed) return;

    if (state.xmppConnected && chatToClear.type === ChatType.PRIVATE) {
      const peerJid = getPeerJidFromPrivateChatId(chatId) || chatId;
      xmppService.sendChatDeleteCommand(peerJid, chatId, 'chat');
    }

    xmppService.releaseMediaBlobUrlsForChat(chatId);
    const cacheKeys = (state.messages[chatId] || []).map((message) => message.id);
    void dbService.deleteMediaCacheEntries(cacheKeys).catch((error) => console.warn('Failed to cleanup media cache for cleared chat', error));

    setState(prev => {
      const nextMessages = { ...prev.messages };
      delete nextMessages[chatId];

      const nextScheduledMessages = { ...prev.scheduledMessages };
      delete nextScheduledMessages[chatId];

      return {
        ...prev,
        messages: nextMessages,
        scheduledMessages: nextScheduledMessages,
        chats: prev.chats.map(chat =>
          chat.id === chatId
            ? { ...chat, lastMessage: undefined, unreadCount: 0 }
            : chat
        )
      };
    });
  };

  const deleteChat = async (chatId: string) => {
    const chatToDelete = state.chats.find(c => c.id === chatId);
    if (!chatToDelete || !canCurrentUserManageChat(chatToDelete)) return;

    const confirmed = window.confirm(`${t.confirmDeleteChat}
${chatToDelete.name}`);
    if (!confirmed) return;

    if (state.xmppConnected && chatToDelete.type === ChatType.PRIVATE) {
      const peerJid = getPeerJidFromPrivateChatId(chatId) || chatId;
      xmppService.sendChatDeleteCommand(peerJid, chatId, 'chat');
      const removal = await xmppService.removeContact(peerJid);
      if (!removal.success) {
        console.warn('[App] removeContact during deleteChat failed:', removal.error);
      } else {
        applyLocalContactCleanup(peerJid);
      }
    }

    xmppService.releaseMediaBlobUrlsForChat(chatId);
    const cacheKeys = (state.messages[chatId] || []).map((message) => message.id);
    void dbService.deleteMediaCacheEntries(cacheKeys).catch((error) => console.warn('Failed to cleanup media cache for deleted chat', error));

    setState(prev => {
      const nextMessages = { ...prev.messages };
      delete nextMessages[chatId];

      const nextScheduledMessages = { ...prev.scheduledMessages };
      delete nextScheduledMessages[chatId];

      return {
        ...prev,
        chats: prev.chats.filter(c => c.id !== chatId),
        messages: nextMessages,
        scheduledMessages: nextScheduledMessages,
        activeChatId: prev.activeChatId === chatId ? null : prev.activeChatId
      };
    });

    setShowProfile(false);
  };


  useEffect(() => {
    if (!state.currentUser) return;
    if (!state.xmppConnected) {
      if (pendingSyncOps.length > 0) {
        setSyncStatus(prev => (prev === 'offline' ? prev : 'offline'));
      }
      return;
    }
    if (pendingSyncOps.length === 0) {
      setSyncStatus(prev => (prev === 'conflict' || prev === 'synced' ? prev : 'synced'));
      return;
    }
    if (isSyncInFlightRef.current) return;

    let cancelled = false;
    const runSync = async () => {
      isSyncInFlightRef.current = true;
      setSyncStatus(prev => (prev === 'syncing' ? prev : 'syncing'));
      const baseEnvelope = syncEnvelopeRef.current;
      const nextEnvelope: SyncStateEnvelope = {
        ...baseEnvelope,
        pendingOps: [],
      };

      try {
        const response = await xmppService.pushPrivateSyncState(nextEnvelope, currentRevision);
        if (cancelled) return;

        if (response.conflict && response.serverEnvelope) {
          const merged = mergeSnapshotWithPending(response.serverEnvelope.snapshot, pendingSyncOps);
          setSyncConflicts(merged.conflicts.map(c => c.op.id));
          setSyncStatus(prev => (prev === 'conflict' ? prev : 'conflict'));
          const dropped = new Set(merged.conflicts.map(c => c.op.id));
          const survivors = pendingSyncOps.filter(op => !dropped.has(op.id));
          setPendingSyncOps(prev => (areSyncOpListsEqual(prev, survivors) ? prev : survivors));
          setSyncEnvelope(prev => ({ ...prev, snapshot: merged.merged }));
          setState(prev => applySnapshotToAppState(prev, merged.merged));
          return;
        }

        if (response.applied && response.serverEnvelope) {
          setSyncEnvelope(response.serverEnvelope);
          setPendingSyncOps(prev => (prev.length === 0 ? prev : []));
          setSyncConflicts([]);
          setSyncStatus(prev => (prev === 'synced' ? prev : 'synced'));
        } else {
          setSyncStatus(prev => (prev === 'error' ? prev : 'error'));
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Sync push failed:', error);
          setSyncStatus(prev => (prev === 'error' ? prev : 'error'));
        }
      } finally {
        isSyncInFlightRef.current = false;
      }
    };

    void runSync();
    return () => {
      cancelled = true;
    };
  }, [state.currentUser?.id, state.xmppConnected, pendingSyncOps, currentRevision]);

  const runtimeCriticalIssueCodes = new Set<RuntimeCapabilityIssueCode>(['INDEXEDDB_UNAVAILABLE', 'CRYPTO_SUBTLE_UNAVAILABLE']);
  const hasRuntimeCriticalFailure = Boolean(runtimeCapability?.issues.some((issue) => runtimeCriticalIssueCodes.has(issue.code)));

  const runtimeDegradedBanner = isRuntimeDegraded && runtimeCapability ? (
    <div className="mx-3 mt-3 rounded-md border border-yellow-500/60 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-bold">Degraded mode: insecure context on native platform</div>
          <div className="opacity-90">Шифрование работает с ограничениями. Рекомендуется обновить Android System WebView/Chrome и перезапустить приложение.</div>
        </div>
        <button
          type="button"
          onClick={() => setShowRuntimeDiagnostics((prev) => !prev)}
          className="shrink-0 px-2 py-1 border border-yellow-300/70 rounded hover:bg-yellow-500/20"
        >
          {showRuntimeDiagnostics ? 'Скрыть диагностику' : 'Диагностика'}
        </button>
      </div>
      {showRuntimeDiagnostics && (
        <div className="mt-2 space-y-1">
          {runtimeCapability.issues.map((issue) => (
            <div key={issue.code}>[{issue.code}] {issue.message}</div>
          ))}
          <div className="opacity-80">platform={runtimeCapability.platform.kind}</div>
        </div>
      )}
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="h-[100dvh] w-full bg-[var(--bg-color)] flex flex-col items-start justify-start p-10 font-mono text-[var(--primary-text)]">
        <div className="space-y-1">
          {bootLog.map((log, idx) => (
            <div key={idx} className="flex gap-2">
              <span className="opacity-50">[{idx * 0.12}s]</span>
              <span>{log}</span>
            </div>
          ))}
          <div className="cursor-blink"></div>
        </div>
      </div>
    );
  }

  if (runtimeCapability && hasRuntimeCriticalFailure) {
    return (
      <div className="h-[100dvh] w-full bg-[var(--bg-color)] flex items-center justify-center p-6 text-[var(--primary-text)]">
        <div className="max-w-xl w-full border border-red-500/40 rounded-lg p-5 bg-red-500/10">
          <h1 className="text-lg font-bold mb-3">Невозможно запустить защищённые функции</h1>
          <p className="mb-3 opacity-90">
            В текущей среде недоступны критичные возможности (IndexedDB/WebCrypto), поэтому БД и шифрование отключены для предотвращения потери данных.
          </p>
          <ul className="list-disc pl-5 space-y-1 text-sm opacity-90">
            {runtimeCapability.issues.map((issue) => (
              <li key={issue.code}>[{issue.code}] {issue.message}</li>
            ))}
          </ul>
          <p className="mt-4 text-sm">
            Что сделать: обновите Android System WebView и Chrome до последней версии, затем перезапустите приложение. Для веб-версии используйте запуск по HTTPS.
          </p>
        </div>
      </div>
    );
  }

  if (bootError && !state.currentUser) {
    return (
      <div className="h-[100dvh] w-full bg-[var(--bg-color)] flex flex-col items-start justify-center p-10 gap-4 font-mono text-[var(--primary-text)]">
        <div className="text-red-400">BOOT ERROR: {bootError}</div>
        <button
          type="button"
          onClick={retryBootSequence}
          className="px-4 py-2 border border-[var(--primary-text)] hover:bg-[var(--primary-text)] hover:text-[var(--bg-color)] transition-colors"
        >
          Retry Boot
        </button>
      </div>
    );
  }

  if (!state.currentUser) {
    return (
      <>
        <GlobalTapEffects />
        {runtimeDegradedBanner}
        <AuthScreen 
          onAuthenticated={handleAuthenticated} 
          currentLang={state.language}
          onLanguageChange={(l) => setState(prev => ({ ...prev, language: l }))}
        />
      </>
    );
  }

  // --- LOCK SCREEN INTERCEPTION ---
  if (state.isLocked && lockConfig && lockConfig.enabled) {
      return (
          <>
            <GlobalTapEffects />
            {runtimeDegradedBanner}
            <LockScreen 
              config={lockConfig}
              onUnlock={() => setState(prev => ({ ...prev, isLocked: false }))}
              onLogout={handleLogout}
              t={t}
            />
            <CallOverlay
              callState={state.callState}
              onAccept={handleAcceptCall}
              onReject={handleRejectCall}
              onEnd={handleEndCall}
              onToggleMute={() => callService.toggleMute()}
              onToggleSpeaker={() => void callService.toggleSpeaker()}
              onToggleCamera={() => callService.toggleCamera()}
              onToggleScreenShare={() => void callService.toggleScreenShare()}
              onRegisterPlaybackElement={handleRegisterCallPlaybackElement}
              localStream={localCallStream}
              remoteStream={remoteCallStream}
              diagnosticsTitle={t.callDiagnosticsTitle}
              diagnosticsSummaryLabel={t.callDiagnosticsSummaryLabel}
              closeLabel={t.cancel}
            />
          </>
      );
  }

  return (
    <div 
      className="flex flex-col w-full bg-[var(--bg-color)] overflow-hidden text-[var(--primary-text)] font-mono safe-top safe-bottom safe-inset-left safe-inset-right transition-[height] duration-200"
      style={{ height: '100dvh' }}
    >
      <GlobalTapEffects />
      {runtimeDegradedBanner}
      <div className="flex flex-1 overflow-hidden relative">
        <div className={`${state.activeChatId ? 'hidden md:flex' : 'flex'} w-full md:w-[350px] lg:w-[400px] h-full`}>
          <Sidebar 
            chats={normalizedChats} 
            messages={state.messages}
            activeChatId={state.activeChatId} 
            onSelectChat={handleSelectChat}
            onStartChat={handleStartChat}
            currentUser={state.currentUser}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onOpenSettings={handleOpenSettings}
            onOpenNewChat={() => setShowNewChat(true)}
            onOpenNewSecureChat={() => setShowNewChat(true)}
            onOpenNewGroup={() => setShowNewGroup(true)}
            onOpenNewChannel={() => setShowNewChannel(true)}
            onOpenContacts={() => setShowContacts(true)}
            onTogglePin={toggleChatPin}
            onToggleMute={toggleChatMute}
            onClearChat={clearChat}
            onDeleteChat={deleteChat}
            onResetChatEncryption={resetChatEncryption}
            users={userDirectory}
            globalChannelResults={globalChannelResults}
            pendingRequestsCount={incomingPresenceRequests.length}
            onJoinViaInviteLink={handleJoinViaInviteLink}
            onOpenGlobalChannel={(entry) => {
              if (!state.currentUser) return;

              setState(prev => {
                const existing = prev.chats.find(chat => chat.id === entry.id);
                if (existing) {
                  return { ...prev, activeChatId: existing.id };
                }

                const discoveredChat: Chat = {
                  id: entry.id,
                  type: ChatType.CHANNEL,
                  name: entry.name,
                  normalizedName: entry.normalizedName,
                  isHidden: false,
                  searchIndexedAt: entry.searchIndexedAt,
                  description: entry.description,
                  participants: [prev.currentUser?.id || state.currentUser.id],
                  unreadCount: 0,
                  adminIds: [],
                  subscriberCount: 0,
                  securityMode: 'transport' as const
                };

                return {
                  ...prev,
                  chats: upsertChatById(prev.chats, discoveredChat),
                  activeChatId: discoveredChat.id,
                };
              });

              if (state.currentUser?.username) {
                xmppService.joinRoom(entry.id, state.currentUser.username);
              }
            }}
            t={t}
          />
        </div>
        
        <main className={`${!state.activeChatId ? 'hidden md:flex' : 'flex'} flex-1 flex-col h-full bg-[var(--bg-color)] border-l-0 md:border-l border-[var(--border-color)]`}>
          {activeChat ? (
            <div className="flex flex-1 relative overflow-hidden">
              <ChatWindow 
                chat={activeChat} 
                messages={state.messages[activeChat.id] || []}
                currentUser={state.currentUser!}
                users={userDirectory}
                onSendMessage={sendMessage}
                onRetryMessage={handleRetryMediaMessage}
                onToggleProfile={() => setShowProfile(true)}
                onBack={() => setState(prev => ({ ...prev, activeChatId: null }))}
                highlightedMessageId={highlightedMessageId}
                scheduledMessages={state.scheduledMessages[activeChat.id] || []}
                onScheduleMessage={scheduleMessage}
                onCancelScheduledMessage={cancelScheduledMessage}
                onForwardMessage={(msg) => setMessageToForward(msg)}
                onDeleteMessage={handleDeleteMessage}
                onMentionClick={handleMentionClick}
                onStartCall={handleStartCall}
                onRequestMediaPreflight={runMediaPermissionFlow}
                onRequestContactApproval={handleRequestContactApproval}
                canSendXmppRequests={canSendXmppRequests}
                xmppRequestDisabledReason={xmppRequestDisabledReason}
                onReportPeer={handleReportPeer}
                onBlockPeer={handleBlockPeer}
                callState={state.callState}
                callControlsDisabled={!activePeerCompatibility.canCall}
                callControlsHint={activePeerCompatibility.callHint}
                disableRetract={!activePeerCompatibility.canRetract}
                retractHint={activePeerCompatibility.retractHint}
                t={t}
              />
               {showProfile && (
                <ProfilePanel 
                  chat={activeChat} 
                  messages={state.messages[activeChat.id] || []}
                  allUsers={userDirectory}
                  currentUser={state.currentUser}
                  onClose={() => setShowProfile(false)}
                  onScrollToMessage={(id) => {
                    setHighlightedMessageId(id);
                    setShowProfile(false);
                    setTimeout(() => setHighlightedMessageId(null), 2000);
                  }}
                  onViewMedia={(msgId) => setGalleryInitialId(msgId)}
                  onToggleMute={toggleChatMute}
                  onDeleteChat={deleteChat}
                  onManageMember={handleManageGroupMember}
                  onAddGroupMembers={handleAddGroupMembers}
                  onRemoveContact={(userId) => handleRemoveContact({ id: userId, username: userId.split('@')[0], isOnline: false })}
                  t={t}
                />
              )}
            </div>
          ) : (
            <div className="hidden md:flex flex-1 flex-col items-center justify-center opacity-20">
               <Terminal className="w-24 h-24 mb-4 animate-pulse" />
               <p className="text-sm font-black tracking-[0.5em] uppercase">{t.noSignals}</p>
               {state.xmppConnected ? (
                 <>
                   <p className="text-xs text-[var(--accent-color)] mt-2">XMPP UPLINK ESTABLISHED</p>
                   {state.e2eeInitializing && (
                     <p className="text-xs text-yellow-400 mt-1">E2EE INITIALIZING...</p>
                   )}
                   {state.e2eeInitFailed && (
                     <p className="text-xs text-red-400 mt-1">E2EE INIT FAILED (RETRY IN BACKGROUND)</p>
                   )}
                   {state.e2eePolicyBlocked && (
                     <p className="text-xs text-red-300 mt-1">E2EE недоступно из-за политики сервера.</p>
                   )}
                   {state.omemoPublishDiagnostic && (
                     <p className="text-xs text-yellow-300 mt-1">{state.omemoPublishDiagnostic}</p>
                   )}
                 </>
               ) : (
                 <p className="text-xs text-[var(--primary-text)] mt-2 opacity-50">RUNNING IN LOCAL MODE</p>
               )}
            </div>
          )}
        </main>
      </div>


      {syncStatus === 'conflict' && (
        <button
          className="absolute bottom-4 right-4 z-40 px-3 py-2 text-xs border border-[var(--danger-color)] text-[var(--danger-color)] bg-[var(--bg-color)] flex items-center gap-2"
          onClick={async () => {
            if (!state.currentUser) return;
            const remote = await xmppService.fetchPrivateSyncState();
            if (!remote) return;
            setSyncEnvelope(remote);
            setPendingSyncOps([]);
            setSyncConflicts([]);
            setSyncStatus('synced');
            setState(prev => applySnapshotToAppState(prev, remote.snapshot));
          }}
        >
          <RefreshCcw className="w-3 h-3" /> RECOVER SYNC
        </button>
      )}

      {unencryptedMediaDialog.open && (
        <div className="absolute inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md border-2 border-[var(--border-color)] bg-[var(--bg-color)] p-6 space-y-4">
            <h3 className="text-sm font-black uppercase tracking-widest">E2EE_MEDIA_REQUIRED</h3>
            <p className="text-xs uppercase tracking-wide opacity-80">Не удалось зашифровать медиа. Отправить без шифрования?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => resolveUnencryptedMediaFallback(false)}
                className="flex-1 border border-[var(--border-color)] py-2 text-xs font-black uppercase tracking-widest hover:bg-[var(--accent-color)] hover:text-[var(--accent-text)] transition-all"
              >
                отмена
              </button>
              <button
                type="button"
                onClick={() => resolveUnencryptedMediaFallback(true)}
                className="flex-1 border border-red-500 py-2 text-xs font-black uppercase tracking-widest text-red-400 hover:bg-red-500 hover:text-black transition-all"
              >
                отправить без шифрования
              </button>
            </div>
          </div>
        </div>
      )}

      {contactApprovalModal.open && (
        <div className="absolute inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md border-2 border-[var(--border-color)] bg-[var(--bg-color)] p-6 space-y-4">
            <h3 className="text-sm font-black uppercase tracking-widest">Нужно одобрение контакта</h3>
            <p className="text-xs uppercase tracking-wide opacity-80">You can’t message this user until contact request is approved.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCancelContactApproval}
                className="flex-1 border border-[var(--border-color)] py-2 text-xs font-black uppercase tracking-widest hover:bg-[var(--accent-color)] hover:text-[var(--accent-text)] transition-all"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleApproveContactAndSendRequest}
                className="flex-1 border border-[var(--border-color)] py-2 text-xs font-black uppercase tracking-widest hover:bg-[var(--primary-text)] hover:text-[var(--bg-color)] transition-all"
              >
                Отправить запрос
              </button>
            </div>
          </div>
        </div>
      )}

      <CallOverlay
        callState={state.callState}
        onAccept={handleAcceptCall}
        onReject={handleRejectCall}
        onEnd={handleEndCall}
        onToggleMute={() => callService.toggleMute()}
        onToggleSpeaker={() => void callService.toggleSpeaker()}
        onToggleCamera={() => callService.toggleCamera()}
        onToggleScreenShare={() => void callService.toggleScreenShare()}
        onRegisterPlaybackElement={handleRegisterCallPlaybackElement}
        localStream={localCallStream}
        remoteStream={remoteCallStream}
        diagnosticsTitle={t.callDiagnosticsTitle}
        diagnosticsSummaryLabel={t.callDiagnosticsSummaryLabel}
        closeLabel={t.cancel}
      />

      {blockedPermissionMessage && (
        <PermissionBlockedModal
          message={blockedPermissionMessage}
          onClose={() => setBlockedPermissionMessage(null)}
          canOpenSettings
          onOpenSettings={() => { void openMediaPermissionSettings(); }}
        />
      )}

      {showSettings && state.currentUser && (
        <SettingsView 
          user={state.currentUser} 
          theme={state.theme}
          notifications={state.notifications}
          soundSettings={state.soundSettings}
          allUsers={userDirectory}
          onUpdate={handleUpdateSettings}
          onClose={() => setShowSettings(false)}
          onLogout={handleLogout}
          onResetLocalSession={handleLocalSessionReset}
          t={t}
          currentLang={state.language}
        />
      )}

      {galleryInitialId && activeChat && (
        <MediaGallery
          messages={state.messages[activeChat.id] || []}
          initialMessageId={galleryInitialId}
          onClose={() => setGalleryInitialId(null)}
          t={t}
        />
      )}

      {showContacts && (
        <ContactsModal 
          users={userDirectory}
          pendingRequests={incomingPresenceRequests}
          messageRequests={state.pendingRequests}
          onStartChat={handleStartChat}
          onRemoveContact={handleRemoveContact}
          onAcceptRequest={handleAcceptRequest}
          onDenyRequest={handleDenyRequest}
          onReportUser={(user, reasonCode) => void handleReportPeer(user.id, reasonCode)}
          onBlockUser={(user, reasonCode) => void handleBlockPeer(user.id, reasonCode)}
          onClose={() => setShowContacts(false)}
          t={t}
        />
      )}
      {showNewChat && (
        <NewChatModal 
          users={userDirectory}
          currentUserId={state.currentUser ? state.currentUser.id : undefined}
          existingChatsByUserId={normalizedChats
            .filter(c => c.type === ChatType.PRIVATE)
            .reduce<Record<string, ChatSecurityMode[]>>((acc, chat) => {
              const peerParticipant = chat.participants.find(p => p !== (state.currentUser ? state.currentUser.id : undefined));
              if (!peerParticipant) return acc;
              const peerId = normalizeBareJid(peerParticipant);
              if (!peerId) return acc;
              const mode = resolveChatSecurityMode(chat.securityMode);
              if (!acc[peerId]) acc[peerId] = [];
              if (!acc[peerId].includes(mode)) acc[peerId].push(mode);
              return acc;
            }, {})}
          onStartChat={handleStartChat}
          onStartSecureChat={handleStartSecureChat}
          onClose={() => setShowNewChat(false)} 
          t={t}
        />
      )}
      {showNewGroup && (
        <NewGroupModal 
          users={userDirectory.filter(user => user.id !== state.currentUser?.id)} 
          onStartGroup={handleStartGroup} 
          onClose={() => setShowNewGroup(false)} 
          t={t}
        />
      )}
      {showNewChannel && (
        <NewChannelModal 
          onStartChannel={handleStartChannel} 
          onClose={() => setShowNewChannel(false)} 
          t={t}
        />
      )}
      
      {messageToForward && state.currentUser && (
        <ForwardModal 
          chats={normalizedChats}
          users={userDirectory}
          currentUserId={state.currentUser.id}
          onSelectChat={performForward}
          onStartChat={handleForwardToUser}
          onClose={() => setMessageToForward(null)}
          t={t}
        />
      )}
    </div>
  );
};

export default App;
