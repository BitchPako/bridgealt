
import { User, Chat, ChatType, MessageStatus } from './types';

// NOTE: Password fields are removed here. Users are initialized in authService with hashed passwords.
export const INITIAL_USER: User = {
  id: 'current-user',
  username: 'johndoe',
  bio: 'Living life one line of code at a time.',
  isOnline: true,
};

export const SEED_USERS: User[] = [
  {
    id: 'sarah_w',
    username: 'sarah_web',
    status: 'Available',
    isOnline: true,
  },
  {
    id: 'dev_group_bot',
    username: 'dev_bot',
    status: 'Automating...',
    isOnline: true,
    isBot: true,
    botCapabilities: ['moderation', 'auto-reply', 'commands'],
    botPermissions: ['read-messages', 'send-messages', 'delete-messages', 'manage-members'],
  },
  {
    id: 'alex_dev',
    username: 'alex_k',
    status: 'Coding...',
    isOnline: false,
  },
  {
    id: 'maria_design',
    username: 'maria_d',
    status: 'Designing the future',
    isOnline: true,
  },
  {
    id: 'linux_fan',
    username: 'tux_master',
    status: 'I use Arch btw',
    isOnline: true,
  }
];

export const INITIAL_CHATS: Chat[] = [];