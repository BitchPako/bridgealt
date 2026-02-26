
export enum ChatType {
  PRIVATE = 'PRIVATE',
  GROUP = 'GROUP',
  CHANNEL = 'CHANNEL',
  SAVED = 'SAVED'
}

export type ChatSecurityMode = 'transport' | 'e2ee_text_only';

export const DEFAULT_CHAT_SECURITY_MODE: ChatSecurityMode = 'transport';

export const resolveChatSecurityMode = (
  candidate?: unknown,
): ChatSecurityMode => candidate === 'e2ee_text_only' ? 'e2ee_text_only' : DEFAULT_CHAT_SECURITY_MODE;

export enum MessageStatus {
  QUEUED = 'QUEUED',
  SENDING = 'SENDING',
  RETRY = 'RETRY',
  FAILED = 'FAILED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  SCHEDULED = 'SCHEDULED'
}

export type OutboxState = 'queued' | 'sending' | 'failed' | 'sent';

export interface User {
  id: string;
  username: string;
  jid?: string; // XMPP JID
  passwordHash?: string;
  salt?: string;
  status?: string;
  bio?: string;
  isOnline: boolean;
  isBot?: boolean;
  botCapabilities?: BotCapability[];
  botPermissions?: BotPermission[];
  lastSeen?: string;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string;
  blockedUserIds?: string[];
  subscription?: 'both' | 'to' | 'from' | 'none'; // Legacy roster subscription state
  contactStatus?: 'unknown' | 'requested' | 'mutual'; // Normalized contact status
  ask?: 'subscribe' | 'unsubscribe' | null;
  currentSessionId?: string;
  sessionStartedAt?: number;
  privacySettings?: PrivacySettings;
  securitySettings?: SecuritySettings;
}

export type PrivacyAudience = 'everyone' | 'contacts' | 'nobody';


export type BotCapability = 'moderation' | 'auto-reply' | 'analytics' | 'commands';
export type BotPermission = 'read-messages' | 'send-messages' | 'delete-messages' | 'manage-members';

export interface PrivacySettings {
  bio: PrivacyAudience;
  calls: PrivacyAudience;
  groups: PrivacyAudience;
}

export interface SecuritySettings {
  requireEncryptedMedia: boolean;
  removePhotoMetadataBeforeSend: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  bio: 'everyone',
  calls: 'contacts',
  groups: 'contacts',
};

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  requireEncryptedMedia: true,
  removePhotoMetadataBeforeSend: true,
};

const PRIVACY_SETTING_KEYS = ['bio', 'calls', 'groups'] as const;

export const sanitizePrivacySettings = (privacySettings?: Record<string, unknown> | PrivacySettings | null): PrivacySettings => {
  if (!privacySettings || typeof privacySettings !== 'object') {
    return { ...DEFAULT_PRIVACY_SETTINGS };
  }

  return PRIVACY_SETTING_KEYS.reduce<PrivacySettings>((acc, key) => {
    const candidate = privacySettings[key];
    const isSupportedValue = candidate === 'everyone' || candidate === 'contacts' || candidate === 'nobody';
    acc[key] = isSupportedValue ? candidate : DEFAULT_PRIVACY_SETTINGS[key];
    return acc;
  }, { ...DEFAULT_PRIVACY_SETTINGS });
};

export const sanitizeSecuritySettings = (securitySettings?: Record<string, unknown> | SecuritySettings | null): SecuritySettings => {
  if (!securitySettings || typeof securitySettings !== 'object') {
    return { ...DEFAULT_SECURITY_SETTINGS };
  }

  return {
    requireEncryptedMedia: typeof securitySettings.requireEncryptedMedia === 'boolean'
      ? securitySettings.requireEncryptedMedia
      : DEFAULT_SECURITY_SETTINGS.requireEncryptedMedia,
    removePhotoMetadataBeforeSend: typeof securitySettings.removePhotoMetadataBeforeSend === 'boolean'
      ? securitySettings.removePhotoMetadataBeforeSend
      : DEFAULT_SECURITY_SETTINGS.removePhotoMetadataBeforeSend,
  };
};

export type ModerationReasonCode =
  | 'spam'
  | 'abuse'
  | 'impersonation'
  | 'adult_content'
  | 'scam'
  | 'flood'
  | 'other';

export interface ModerationEvent {
  id: string;
  createdAt: number;
  actorId: string;
  targetId: string;
  action: 'report' | 'block' | 'silence' | 'reject_message';
  reasonCode: ModerationReasonCode;
  source: 'local' | 'server';
  metadata?: Record<string, string | number | boolean>;
}


export interface DeviceSession {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  lastActiveAt: number;
  isCurrent: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface Message {
  id: string;
  clientId?: string;
  chatId: string;
  senderId: string;
  text: string;
  timestamp: number;
  status: MessageStatus;
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  mediaUrl?: string;
  mediaMime?: string;
  mediaVariants?: {
    audio?: Array<{
      mime: string;
      url: string;
    }>;
  };
  mediaCiphertextUrl?: string;
  mediaIv?: string;
  mediaKeyId?: string;
  mediaKeyEnvelope?: string;
  mediaKey?: string;
  mediaTransportScheme?: string;
  mediaDecryptFailed?: boolean;
  mediaDecryptPending?: boolean;
  mediaDecryptFailureReason?: string;
  isLegacyUnencryptedMedia?: boolean;
  replyToId?: string;
  isEdited?: boolean;
  reactions: Reaction[];
  scheduledFor?: number;
  forwardedFrom?: {
    userId: string;
    username: string;
  };
  isEncrypted?: boolean;
  encryptionScheme?: string;
  groupEncryption?: 'encrypted' | 'unencrypted';
  outboxAttempt?: number;
  outboxNextRetryAt?: number;
  outboxState?: OutboxState | 'waiting_network' | 'retry' | 'in_progress' | 'pending';
  outboxErrorCode?: string;
  outboxErrorHint?: string;
  outboxTaskId?: string;
  bot?: {
    botId?: string;
    slashCommand?: string;
    structuredPayload?: BotIntentPayload;
    inlineResponse?: BotInlineResponse;
    actionCards?: BotActionCard[];
    correlationId?: string;
  };
}

export type BotAccessLevel = 'allow' | 'restricted' | 'deny';

export interface BotPermissionModel {
  chatAccess: BotAccessLevel;
  mediaAccess: BotAccessLevel;
  participantsAccess: BotAccessLevel;
  canSendMessages?: boolean;
}

export interface BotIntentPayload {
  intent: string;
  command?: string;
  args?: string[];
  entities?: Record<string, string | number | boolean>;
  metadata?: Record<string, string | number | boolean>;
}

export interface BotAction {
  id: string;
  label: string;
  intent: string;
  payload?: Record<string, string | number | boolean>;
}

export interface BotActionCard {
  id: string;
  title: string;
  description?: string;
  actions: BotAction[];
}

export interface BotInlineResponse {
  type: 'text' | 'card' | 'actions';
  text?: string;
  cards?: BotActionCard[];
  actions?: BotAction[];
}

export interface BotProfile {
  id: string;
  name: string;
  description?: string;
  commands?: string[];
  webhookUrl?: string;
  permissions: BotPermissionModel;
}

export interface Chat {
  id: string;
  type: ChatType;
  name: string;
  normalizedName: string;
  isHidden: boolean;
  searchIndexedAt?: number;
  participants: string[]; // User IDs (JIDs)
  lastMessage?: Message;
  unreadCount: number;
  isPinned?: boolean;
  description?: string;
  adminIds: string[];
  ownerId?: string;
  roles?: Record<string, 'owner' | 'admin' | 'member'>;
  subscriberCount?: number; // For channels
  isMuted?: boolean;
  inviteCode?: string;
  botProfile?: BotProfile;
  botPermissions?: BotPermissionModel;
  botIds?: string[];
  allowsBots?: boolean;
  securityMode: ChatSecurityMode;
  moderation?: {
    antiLinkSpam?: boolean;
    floodProtection?: boolean;
    slowModeSeconds?: number;
  };
}

export interface ChannelDirectoryEntry {
  id: string;
  jid?: string;
  name: string;
  normalizedName?: string;
  description?: string;
  memberCount?: number;
  searchIndexedAt?: number;
}

export interface PendingMediaPayload {
  blob?: Blob;
  attachmentId?: string;
  type?: Message['type'];
  fileName?: string;
  mime?: string;
  name?: string;
  size?: number;
  mediaUrl?: string;
  mediaMime?: string;
  mediaVariants?: {
    audio?: Array<{
      mime: string;
      url: string;
    }>;
  };
  mediaSize?: number;
  mediaIv?: string;
  mediaKeyId?: string;
  mediaKeyEnvelope?: string;
  encrypted?: boolean;
  scheme?: string;
  chunkSize?: number;
  chunkCount?: number;
  encryptedAttachmentId?: string;
}

export interface OutboxTask {
  id: string;
  userId: string;
  chatId: string;
  type: 'media-upload' | 'media-message';
  state: 'pending' | 'in_progress' | 'retry' | 'failed' | 'waiting_network' | 'sent';
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextRetryAt?: number;
  progress?: number;
  currentStage?: 'preparing' | 'encrypting' | 'uploading' | 'sent';
  stageProgress?: Partial<Record<'preparing' | 'encrypting' | 'uploading' | 'sent', {
    progress: number;
    weight: number;
  }>>;
  error?: string;
  payload: {
    text: string;
    messageType: Message['type'];
    replyToId?: string;
    clientId: string;
    tempMessageId: string;
    targetJid: string;
    stanzaType: 'chat' | 'groupchat';
    securityMode?: 'transport' | 'e2ee_text_only';
    allowMedia?: boolean;
    media?: PendingMediaPayload;
    mediaUrl?: string;
    mediaMime?: string;
    mediaVariants?: {
      audio?: Array<{
        mime: string;
        url: string;
      }>;
    };
    mediaSize?: number;
    mediaIv?: string;
    mediaKeyId?: string;
    mediaKeyEnvelope?: string;
    encrypted?: boolean;
    scheme?: string;
    chunkSize?: number;
    chunkCount?: number;
    allowUnencryptedMedia?: boolean;
    uploadTaskId?: string;
  };
}

export type GroupMemberManageAction = 'promote' | 'demote' | 'kick';
export type AddGroupMembersHandler = (chatId: string, memberIds: string[]) => void;

export interface LockConfig {
  enabled: boolean;
  passcodeHash?: string;
  biometricsEnabled: boolean;
}

export interface SoundSettings {
  enabled: boolean;
  messageToneEnabled: boolean;
  incomingRingtoneEnabled: boolean;
  messageToneVolume: number;
  incomingRingtoneVolume: number;
  playMessageToneInActiveChat: boolean;
}

export interface AppState {
  currentUser: User | null;
  chats: Chat[];
  messages: Record<string, Message[]>; // Keyed by chatId
  scheduledMessages: Record<string, Message[]>; // Keyed by chatId
  activeChatId: string | null;
  isDarkMode: boolean;
  theme: string;
  notifications: boolean;
  soundSettings: SoundSettings;
  language: 'en' | 'ru';
  xmppConnected: boolean; // Connection Status
  xmppSessionReady: boolean;
  e2eeInitializing: boolean;
  e2eeInitFailed: boolean;
  e2eePolicyBlocked: boolean;
  omemoPublishDiagnostic: string | null;
  pendingRequests: User[]; // Users requesting subscription
  isLocked: boolean; // UI State for lock screen
  callState: CallState;
  outboxTasks: OutboxTask[];
}

export type CallMediaType = 'audio' | 'video' | 'screen';
export type CallDirection = 'incoming' | 'outgoing';
export type CallStatus =
  | 'idle'
  | 'requesting'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'failed';

export type CallSignalAction = 'offer' | 'answer' | 'ice-candidate' | 'hangup' | 'reject' | 'accept' | 'reconnect-offer' | 'invite-token' | 'e2ee-key';

export const LEGACY_CALL_ACTION_FALLBACK_MAP: Partial<Record<CallSignalAction, CallSignalAction>> = {
  'reconnect-offer': 'offer',
  accept: 'answer',
};

export interface CallSignalPayload {
  callId: string;
  action: 'offer' | 'answer' | 'ice-candidate' | 'hangup' | 'reject' | 'accept' | 'reconnect-offer' | 'invite-token' | 'e2ee-key';
  media: CallMediaType;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
  conferenceId?: string;
  participants?: string[];
  inviteToken?: string;
  videoSource?: 'camera' | 'screen';
  e2eeKeyEnvelope?: string;
  e2eeKeyId?: string;
  e2eeKeyEpoch?: number;
}

export type BridgePayloadKind = 'message' | 'call' | 'chat-control';

export type BridgeCapabilityFlag =
  | 'envelope-v1'
  | 'media-metadata-v1'
  | 'call-signaling-v1'
  | 'chat-control-v1'
  | 'security-mode-e2ee-text-only-v1';

export interface BridgeEnvelope<TPayload = unknown, TKind extends BridgePayloadKind = BridgePayloadKind> {
  v: number;
  kind: TKind;
  features: BridgeCapabilityFlag[];
  payload: TPayload;
}

export interface BridgeMediaPayload {
  type?: string;
  mediaUrl?: string;
  fastenedPlaintextMedia?: {
    url?: string;
    accessPolicy?: string;
  };
  mediaMime?: string;
  mediaVariants?: {
    audio?: Array<{
      mime?: string;
      url?: string;
    }>;
  };
  mediaSize?: number;
  replyToId?: string;
  mediaIv?: string;
  mediaKeyId?: string;
  mediaKeyEnvelope?: string;
  mediaKey?: string;
  clientMsgId?: string;
  encrypted?: boolean;
  encryptionScheme?: string;
  mediaScheme?: string;
  mediaTransportScheme?: string;
  /** @deprecated use encryptionScheme or mediaScheme/mediaTransportScheme */
  scheme?: string;
  chunkSize?: number;
  chunkCount?: number;
}

export interface BridgeChatControlPayload {
  action?: string;
  chatId?: string;
  peerJid?: string;
  securityMode?: ChatSecurityMode;
}

export interface CallState {
  callId: string | null;
  chatId: string | null;
  peerJid: string | null;
  direction: CallDirection | null;
  media: CallMediaType;
  status: CallStatus;
  isMuted: boolean;
  isSpeakerOn: boolean;
  isCameraOn: boolean;
  isScreenSharing?: boolean;
  videoSource?: 'camera' | 'screen';
  participants?: string[];
  conferenceId?: string | null;
  permissionError?: string;
  callFailureReason?: string;
  diagnosticsEvents?: CallDiagnosticsEvent[];
  platformHint?: 'ios' | 'android' | 'desktop';
  canUseSpeakerToggle?: boolean;
}

export interface CallDiagnosticsEvent {
  timestamp: number;
  type:
    | 'ice-connection-state'
    | 'connection-state'
    | 'ice-gathering-state'
    | 'selected-candidate-pair'
    | 'candidate-pair-failed'
    | 'reconnect-attempt'
    | 'turn-credentials';
  message: string;
}

export interface TurnRestCredentialsConfig {
  endpoint: string;
  token?: string;
  ttlSeconds?: number;
}

export interface CallNetworkConfig {
  iceServers: RTCIceServer[];
  turnRest?: TurnRestCredentialsConfig;
}

export interface PreCallCheckResult {
  hasMicrophone: boolean;
  hasCamera: boolean;
  hasAudioOutputSelection: boolean;
  devices: MediaDeviceInfo[];
}
