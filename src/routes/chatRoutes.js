const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { readDb, writeDb } = require('../data/db');
const { sendServerError } = require('../utils/common');
const { isBlockedBetween } = require('../utils/profile');
const { emitToUser, isUserOnline } = require('../socket');
const { CHAT_GIFT_CATALOG, CHAT_UPLOADS_DIR, SUPPORT_UPLOADS_DIR } = require('../config/constants');
const { assertAuthorizedUser } = require('../utils/authSession');
const {
  applyGiftCoinsToWoman,
  applyManToWomanTextCoins,
  applyManToWomanVoiceCoins,
} = require('../utils/interactionCoins');
const { recordDailyGiftSent, syncMissionSections } = require('../utils/missions');
const {
  getConversationUserIds,
  getConversationMessages,
  getSoulLinkConversationState,
  searchConversationMessages,
  buildConversationPreview,
  markConversationRead,
  markConversationDelivered,
} = require('../utils/chat');
const { buildDisplayName, notifyUserById } = require('../services/userPushService');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CHAT_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '') || '';
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

const supportStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SUPPORT_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '') || '';
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

const supportUpload = multer({
  storage: supportStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

const SUPPORT_ADMIN_PROFILE = {
  id: 'support-admin',
  name: 'Admin support',
  role: 'Customer care',
  status: 'Usually replies in a few minutes',
};
const SUPPORT_AUTO_REPLY_DELAY_MS = 4500;
const SUPPORT_AUTO_REPLY_TEXT =
  'আপনার মেসেজ আমরা পেয়েছি। একটু অপেক্ষা করুন, আমাদের অ্যাডমিন খুব দ্রুত আপনার সঙ্গে যোগাযোগ করবে।';

function getPagination(req) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const search = String(req.query.search || '').trim();
  return { limit, offset, search };
}

function buildMessageRecord({
  fromUserId,
  toUserId,
  text,
  type = 'text',
  giftName = null,
  fileUrl = null,
  fileName = null,
  mimeType = null,
  durationMs = null,
}) {
  return {
    id: crypto.randomUUID(),
    fromUserId,
    toUserId,
    text,
    type,
    giftName,
    fileUrl,
    fileName,
    mimeType,
    durationMs,
    editedAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
}

function buildSupportMessageRecord({
  userId,
  senderType = 'user',
  text,
  type = 'text',
  fileUrl = null,
  fileName = null,
  mimeType = null,
}) {
  return {
    id: crypto.randomUUID(),
    userId,
    senderType,
    text,
    type,
    fileUrl,
    fileName,
    mimeType,
    createdAt: new Date().toISOString(),
  };
}

function ensureSupportThread(db, userId) {
  db.supportThreads = db.supportThreads || [];
  let thread = db.supportThreads.find((item) => item.userId === userId);

  if (!thread) {
    const welcome = buildSupportMessageRecord({
      userId,
      senderType: 'admin',
      text: 'Welcome to online customer service. Send a message or image and our admin team will review it here.',
    });

    thread = {
      id: crypto.randomUUID(),
      userId,
      adminId: SUPPORT_ADMIN_PROFILE.id,
      createdAt: welcome.createdAt,
      updatedAt: welcome.createdAt,
      autoReplyQueuedAt: null,
      autoReplySentAt: null,
      messages: [welcome],
    };
    db.supportThreads.push(thread);
    return { thread, created: true };
  }

  if (!Array.isArray(thread.messages)) {
    thread.messages = [];
  }
  if (typeof thread.autoReplyQueuedAt !== 'string') {
    thread.autoReplyQueuedAt = null;
  }
  if (typeof thread.autoReplySentAt !== 'string') {
    thread.autoReplySentAt = null;
  }

  if (!thread.messages.length) {
    const welcome = buildSupportMessageRecord({
      userId,
      senderType: 'admin',
      text: 'Welcome to online customer service. Send a message or image and our admin team will review it here.',
    });
    thread.messages.push(welcome);
    thread.updatedAt = welcome.createdAt;
    thread.autoReplyQueuedAt = null;
    thread.autoReplySentAt = null;
    return { thread, created: true };
  }

  return { thread, created: false };
}

function scheduleSupportAutoReply(userId) {
  setTimeout(() => {
    try {
      const db = readDb();
      const supportSession = ensureSupportThread(db, userId);
      const thread = supportSession.thread;

      if (!thread || thread.autoReplySentAt) {
        return;
      }

      const hasUserMessage = (thread.messages || []).some((item) => item?.senderType === 'user');
      if (!hasUserMessage) {
        thread.autoReplyQueuedAt = null;
        writeDb(db);
        return;
      }

      const autoReply = buildSupportMessageRecord({
        userId,
        senderType: 'admin',
        text: SUPPORT_AUTO_REPLY_TEXT,
        type: 'text',
      });

      thread.messages.push(autoReply);
      thread.updatedAt = autoReply.createdAt;
      thread.autoReplyQueuedAt = null;
      thread.autoReplySentAt = autoReply.createdAt;
      writeDb(db);
    } catch (_error) {
    }
  }, SUPPORT_AUTO_REPLY_DELAY_MS);
}

function authorizeChatUser(req, res, explicitUserId) {
  const db = readDb();
  const auth = assertAuthorizedUser(db, req, explicitUserId);

  if (auth.error) {
    res.status(401).json({ message: auth.error });
    return null;
  }

  return { db, userId: auth.userId };
}

function emitConversationRefresh(db, leftUserId, rightUserId, message = null) {
  const leftPreview = buildConversationPreview(db, leftUserId, rightUserId);
  const rightPreview = buildConversationPreview(db, rightUserId, leftUserId);

  if (message) {
    emitToUser(leftUserId, 'chat:message:new', {
      conversationUserId: rightUserId,
      message,
      conversation: leftPreview,
    });
    emitToUser(rightUserId, 'chat:message:new', {
      conversationUserId: leftUserId,
      message,
      conversation: rightPreview,
    });
  }

  emitToUser(leftUserId, 'chat:conversation:update', { conversation: leftPreview });
  emitToUser(rightUserId, 'chat:conversation:update', { conversation: rightPreview });

  return { leftPreview, rightPreview };
}

function buildTournamentConversationPreview(db, tournament, viewerUserId) {
  const tournamentId = String(tournament?.id || '').trim();
  if (!tournamentId) {
    return null;
  }

  const messages = (db.tournamentChatMessages || [])
    .filter((item) => String(item?.tournamentId || '').trim() === tournamentId)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  const lastMessage = messages[messages.length - 1] || null;
  const assignments = (db.tournamentRoomAssignments || []).filter(
    (item) => String(item?.tournamentId || '').trim() === tournamentId
  );

  const canAccess =
    String(tournament?.ownerUserId || '').trim() === String(viewerUserId || '').trim() ||
    assignments.some((item) => String(item?.userId || '').trim() === String(viewerUserId || '').trim());

  if (!canAccess || !lastMessage) {
    return null;
  }

  return {
    id: tournamentId,
    name: `${String(tournament?.title || 'Tournament chat').trim() || 'Tournament chat'} (tour group)`,
    conversationType: 'tournament',
    tournamentId,
    tournamentTitle: String(tournament?.title || 'Tournament chat').trim() || 'Tournament chat',
    connectedCount: assignments.length,
    tint: '#F3E2EB',
    city: `${assignments.length} connected`,
    status: 'Tournament group',
    lastMessage: lastMessage.text || (lastMessage.type === 'image' ? 'Image' : lastMessage.type === 'voice' ? 'Voice message' : 'New message'),
    lastMessageAt: lastMessage.createdAt,
    lastMessageFromUserId: lastMessage.fromUserId,
    unreadCount: 0,
  };
}

function buildMissionActivityPayload(db, userId) {
  const result = syncMissionSections(db, userId);
  return {
    missionRewards: result.newlyClaimedMissions || [],
    coins: typeof result.user?.coins === 'number' ? result.user.coins : 0,
  };
}

function emitCoinUpdates(db, userIds = []) {
  Array.from(new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean))).forEach((userId) => {
    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return;
    }

    emitToUser(userId, 'profile:coins:update', {
      coins: typeof user.coins === 'number' ? user.coins : 0,
    });
  });
}

function buildChatPushBody(message = {}) {
  if (message.type === 'image') {
    return 'Sent you an image.';
  }
  if (message.type === 'voice') {
    return 'Sent you a voice message.';
  }
  if (message.type === 'gift') {
    return String(message.text || 'Sent you a gift.').trim();
  }
  return String(message.text || 'Sent you a message.').trim();
}

function notifyIncomingChatMessage(db, sender, receiver, message) {
  if (!sender?.id || !receiver?.id || !message || isUserOnline(receiver.id)) {
    return;
  }

  notifyUserById(
    db,
    receiver.id,
    {
      title: buildDisplayName(sender),
      body: buildChatPushBody(message),
      data: {
        tab: 'chat',
        screen: 'chat',
        notificationType: 'chat',
        conversationUserId: sender.id,
        userId: receiver.id,
        messageId: message.id,
      },
    },
    { settingKey: 'chatMessages' }
  ).catch(() => {});
}

router.get('/catalog/:userId', (req, res) => {
  const session = authorizeChatUser(req, res, String(req.params.userId || '').trim());
  if (!session) {
    return;
  }

  const user = session.db.users.find((item) => item.id === session.userId);

  return res.json({
    coins: user?.coins || 0,
    gifts: session.db.chatGiftCatalog || CHAT_GIFT_CATALOG,
    history: (session.db.giftTransactions || []).filter((item) => item.fromUserId === session.userId),
  });
});

router.get('/conversations/:userId', (req, res) => {
  const session = authorizeChatUser(req, res, String(req.params.userId || '').trim());
  if (!session) {
    return;
  }

  try {
    const { limit, offset, search } = getPagination(req);
    const db = session.db;
    const user = db.users.find((item) => item.id === session.userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const directConversations = getConversationUserIds(db, session.userId)
      .filter((otherUserId) => !isBlockedBetween(db, session.userId, otherUserId))
      .map((otherUserId) => buildConversationPreview(db, session.userId, otherUserId))
      .filter(Boolean);

    const tournamentConversations = (db.tournaments || [])
      .map((tournament) => buildTournamentConversationPreview(db, tournament, session.userId))
      .filter(Boolean);

    const allConversations = [...directConversations, ...tournamentConversations]
      .filter((item) => {
        if (!search) {
          return true;
        }

        const haystack = [item.name, item.city, item.status, item.lastMessage].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(search.toLowerCase());
      })
      .sort(
        (left, right) =>
          new Date(right.lastMessageAt || 0).getTime() - new Date(left.lastMessageAt || 0).getTime()
      );

    return res.json({
      total: allConversations.length,
      conversations: allConversations.slice(offset, offset + limit),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load conversations.');
  }
});

router.get('/calls/:userId', (req, res) => {
  const session = authorizeChatUser(req, res, String(req.params.userId || '').trim());
  if (!session) {
    return;
  }

  const logs = (session.db.callLogs || [])
    .filter((item) => item.fromUserId === session.userId || item.toUserId === session.userId)
    .sort((left, right) => new Date(right.createdAt || right.endedAt || 0).getTime() - new Date(left.createdAt || left.endedAt || 0).getTime());

  return res.json({
    total: logs.length,
    calls: logs,
  });
});

router.get('/support/:userId', (req, res) => {
  const explicitUserId = String(req.params.userId || '').trim();
  const session = authorizeChatUser(req, res, explicitUserId);
  if (!session) {
    return;
  }

  try {
    const user = session.db.users.find((item) => item.id === session.userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const supportSession = ensureSupportThread(session.db, session.userId);
    if (supportSession.created) {
      writeDb(session.db);
    }

    return res.json({
      admin: SUPPORT_ADMIN_PROFILE,
      threadId: supportSession.thread.id,
      messages: supportSession.thread.messages || [],
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load support messages.');
  }
});

router.post('/support/send', (req, res) => {
  try {
    const requestedUserId = String(req.body.userId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const userId = session.userId;
    const text = String(req.body.text || '').trim();

    if (!text) {
      return res.status(400).json({ message: 'Message text is required.' });
    }

    const user = session.db.users.find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const supportSession = ensureSupportThread(session.db, userId);
    const supportMessage = buildSupportMessageRecord({
      userId,
      senderType: 'user',
      text,
      type: 'text',
    });

    supportSession.thread.messages.push(supportMessage);
    supportSession.thread.updatedAt = supportMessage.createdAt;
    if (!supportSession.thread.autoReplyQueuedAt && !supportSession.thread.autoReplySentAt) {
      supportSession.thread.autoReplyQueuedAt = new Date().toISOString();
      scheduleSupportAutoReply(userId);
    }
    writeDb(session.db);

    return res.status(201).json({
      message: 'Support message sent successfully.',
      admin: SUPPORT_ADMIN_PROFILE,
      supportMessage,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send support message.');
  }
});

router.post('/support/send-image', supportUpload.single('image'), (req, res) => {
  try {
    const requestedUserId = String(req.body.userId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required.' });
    }

    const userId = session.userId;
    const user = session.db.users.find((item) => item.id === userId);
    if (!user) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'User not found.' });
    }

    const supportSession = ensureSupportThread(session.db, userId);
    const fileUrl = `/uploads/support/${path.basename(req.file.path)}`;
    const supportMessage = buildSupportMessageRecord({
      userId,
      senderType: 'user',
      text: 'Image',
      type: 'image',
      fileUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    supportSession.thread.messages.push(supportMessage);
    supportSession.thread.updatedAt = supportMessage.createdAt;
    if (!supportSession.thread.autoReplyQueuedAt && !supportSession.thread.autoReplySentAt) {
      supportSession.thread.autoReplyQueuedAt = new Date().toISOString();
      scheduleSupportAutoReply(userId);
    }
    writeDb(session.db);

    return res.status(201).json({
      message: 'Support image sent successfully.',
      admin: SUPPORT_ADMIN_PROFILE,
      supportMessage,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send support image.');
  }
});

router.get('/messages/:userId/:otherUserId', (req, res) => {
  const explicitUserId = String(req.params.userId || '').trim();
  const session = authorizeChatUser(req, res, explicitUserId);
  if (!session) {
    return;
  }

  try {
    const otherUserId = String(req.params.otherUserId || '').trim();
    const { limit, offset, search } = getPagination(req);
    const db = session.db;
    const user = db.users.find((item) => item.id === session.userId);
    const otherUser = db.users.find((item) => item.id === otherUserId);

    if (!user || !otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (isBlockedBetween(db, session.userId, otherUserId)) {
      return res.status(403).json({ message: 'Chat is unavailable for this profile.' });
    }

    const deliveredUpdates = markConversationDelivered(db, session.userId);
    const readUpdates = markConversationRead(db, session.userId, otherUserId);

    if (deliveredUpdates.length || readUpdates.length) {
      writeDb(db);
      emitConversationRefresh(db, session.userId, otherUserId);

      deliveredUpdates.forEach((item) => {
        emitToUser(item.fromUserId, 'chat:message:status', {
          conversationUserId: item.toUserId,
          messageId: item.id,
          deliveredAt: item.deliveredAt,
          readAt: item.readAt,
        });
      });

      readUpdates.forEach((item) => {
        emitToUser(item.fromUserId, 'chat:message:status', {
          conversationUserId: item.toUserId,
          messageId: item.id,
          deliveredAt: item.deliveredAt,
          readAt: item.readAt,
        });
      });
    }

    const messages = searchConversationMessages(db, session.userId, otherUserId, search);

    return res.json({
      total: messages.length,
      conversation: buildConversationPreview(db, session.userId, otherUserId),
      messages: messages.slice(offset, offset + limit),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load messages.');
  }
});

router.post('/send', (req, res) => {
  try {
    const requestedUserId = String(req.body.fromUserId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const fromUserId = session.userId;
    const toUserId = String(req.body.toUserId || '').trim();
    const text = String(req.body.text || '').trim();

    if (!toUserId || fromUserId === toUserId) {
      return res.status(400).json({ message: 'Valid sender and receiver are required.' });
    }

    if (!text) {
      return res.status(400).json({ message: 'Message text is required.' });
    }

    const db = session.db;
    const sender = db.users.find((item) => item.id === fromUserId);
    const receiver = db.users.find((item) => item.id === toUserId);

    if (!sender || !receiver) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (isBlockedBetween(db, fromUserId, toUserId)) {
      return res.status(403).json({ message: 'Chat is unavailable for this profile.' });
    }

    db.chatMessages = db.chatMessages || [];
    const message = buildMessageRecord({
      fromUserId,
      toUserId,
      text,
      type: 'text',
    });

    if (isUserOnline(toUserId)) {
      message.deliveredAt = new Date().toISOString();
    }

    db.chatMessages.push(message);
    const coinUserIds = applyManToWomanTextCoins(db, fromUserId, toUserId);
    const missionPayload = buildMissionActivityPayload(db, fromUserId);
    writeDb(db);

    const previews = emitConversationRefresh(db, fromUserId, toUserId, message);
    emitCoinUpdates(db, coinUserIds);
    notifyIncomingChatMessage(db, sender, receiver, message);

    return res.status(201).json({
      message: 'Message sent successfully.',
      chatMessage: message,
      conversation: previews.leftPreview,
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send message.');
  }
});

router.post('/send-gift', (req, res) => {
  try {
    const requestedUserId = String(req.body.fromUserId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const fromUserId = session.userId;
    const toUserId = String(req.body.toUserId || '').trim();
    const requestedGift = String(req.body.giftId || req.body.giftName || 'rose').trim().toLowerCase();
    const db = session.db;

    const sender = db.users.find((item) => item.id === fromUserId);
    const receiver = db.users.find((item) => item.id === toUserId);
    const gift = (db.chatGiftCatalog || CHAT_GIFT_CATALOG).find(
      (item) => item.id === requestedGift || item.name.toLowerCase() === requestedGift
    );
    const soulLinkState = getSoulLinkConversationState(db, fromUserId, toUserId);

    if (!sender || !receiver || !gift) {
      return res.status(404).json({ message: 'Gift or user not found.' });
    }

    if (soulLinkState.soulLinkLocked) {
      return res.status(403).json({ message: 'Unlock SoulLink first before sending gifts.' });
    }

    if (sender.coins < gift.coins) {
      return res.status(400).json({ message: 'Not enough coins for this gift.' });
    }

    sender.coins -= gift.coins;
    db.giftTransactions = db.giftTransactions || [];
    db.giftTransactions.push({
      id: crypto.randomUUID(),
      fromUserId,
      toUserId,
      giftId: gift.id,
      giftName: gift.name,
      coins: gift.coins,
      createdAt: new Date().toISOString(),
    });

    const message = buildMessageRecord({
      fromUserId,
      toUserId,
      type: 'gift',
      giftName: gift.name,
      text: `Sent a ${gift.name}`,
    });

    if (isUserOnline(toUserId)) {
      message.deliveredAt = new Date().toISOString();
    }

    db.chatMessages.push(message);
    recordDailyGiftSent(sender);
    const coinUserIds = applyGiftCoinsToWoman(db, fromUserId, toUserId, gift.coins);
    const missionPayload = buildMissionActivityPayload(db, fromUserId);
    writeDb(db);

    const previews = emitConversationRefresh(db, fromUserId, toUserId, message);
    emitCoinUpdates(db, coinUserIds);
    notifyIncomingChatMessage(db, sender, receiver, message);

    return res.status(201).json({
      message: `${gift.name} sent successfully.`,
      chatMessage: message,
      conversation: previews.leftPreview,
      coins: missionPayload.coins,
      missionRewards: missionPayload.missionRewards,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send gift.');
  }
});

router.post('/send-image', upload.single('image'), (req, res) => {
  try {
    const requestedUserId = String(req.body.fromUserId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const fromUserId = session.userId;
    const toUserId = String(req.body.toUserId || '').trim();

    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required.' });
    }

    const db = session.db;
    const sender = db.users.find((item) => item.id === fromUserId);
    const receiver = db.users.find((item) => item.id === toUserId);

    if (!sender || !receiver) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'User not found.' });
    }

    const fileUrl = `/uploads/chat/${path.basename(req.file.path)}`;
    const message = buildMessageRecord({
      fromUserId,
      toUserId,
      type: 'image',
      text: 'Image',
      fileUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    if (isUserOnline(toUserId)) {
      message.deliveredAt = new Date().toISOString();
    }

    db.chatMessages.push(message);
    const missionPayload = buildMissionActivityPayload(db, fromUserId);
    writeDb(db);
    const previews = emitConversationRefresh(db, fromUserId, toUserId, message);
    notifyIncomingChatMessage(db, sender, receiver, message);

    return res.status(201).json({
      message: 'Image sent successfully.',
      chatMessage: message,
      conversation: previews.leftPreview,
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send image.');
  }
});

router.post('/send-voice', upload.single('audio'), (req, res) => {
  try {
    const requestedUserId = String(req.body.fromUserId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const fromUserId = session.userId;
    const toUserId = String(req.body.toUserId || '').trim();
    const durationMs = Number(req.body.durationMs) || null;

    if (!req.file) {
      return res.status(400).json({ message: 'Audio file is required.' });
    }

    const db = session.db;
    const sender = db.users.find((item) => item.id === fromUserId);
    const receiver = db.users.find((item) => item.id === toUserId);

    if (!sender || !receiver) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'User not found.' });
    }

    const fileUrl = `/uploads/chat/${path.basename(req.file.path)}`;
    const message = buildMessageRecord({
      fromUserId,
      toUserId,
      type: 'voice',
      text: 'Voice message',
      fileUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      durationMs,
    });

    if (isUserOnline(toUserId)) {
      message.deliveredAt = new Date().toISOString();
    }

    db.chatMessages.push(message);
    const coinUserIds = applyManToWomanVoiceCoins(db, fromUserId, toUserId);
    const missionPayload = buildMissionActivityPayload(db, fromUserId);
    writeDb(db);
    const previews = emitConversationRefresh(db, fromUserId, toUserId, message);
    emitCoinUpdates(db, coinUserIds);
    notifyIncomingChatMessage(db, sender, receiver, message);

    return res.status(201).json({
      message: 'Voice message sent successfully.',
      chatMessage: message,
      conversation: previews.leftPreview,
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send voice message.');
  }
});

router.post('/edit', (req, res) => {
  try {
    const requestedUserId = String(req.body.userId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const userId = session.userId;
    const messageId = String(req.body.messageId || '').trim();
    const nextText = String(req.body.text || '').trim();
    const otherUserId = String(req.body.otherUserId || '').trim();

    if (!messageId || !nextText || !otherUserId) {
      return res.status(400).json({ message: 'Message id, text, and other user are required.' });
    }

    const db = session.db;
    const message = (db.chatMessages || []).find((item) => item.id === messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    if (message.fromUserId !== userId || message.type !== 'text') {
      return res.status(403).json({ message: 'Only your text messages can be edited.' });
    }

    message.text = nextText;
    message.editedAt = new Date().toISOString();
    writeDb(db);

    const previews = emitConversationRefresh(db, userId, otherUserId);
    emitToUser(userId, 'chat:message:edited', { message, conversationUserId: otherUserId });
    emitToUser(otherUserId, 'chat:message:edited', { message, conversationUserId: userId });

    return res.json({
      message: 'Message edited successfully.',
      chatMessage: message,
      conversation: previews.leftPreview,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not edit message.');
  }
});

router.post('/delete', (req, res) => {
  try {
    const requestedUserId = String(req.body.userId || '').trim();
    const session = authorizeChatUser(req, res, requestedUserId);
    if (!session) {
      return;
    }

    const userId = session.userId;
    const otherUserId = String(req.body.otherUserId || '').trim();
    const messageId = String(req.body.messageId || '').trim();

    if (!otherUserId || !messageId) {
      return res.status(400).json({ message: 'Conversation and message are required.' });
    }

    const db = session.db;
    const existingMessage = (db.chatMessages || []).find((item) => item.id === messageId);

    if (!existingMessage) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    const isConversationMessage =
      (existingMessage.fromUserId === userId && existingMessage.toUserId === otherUserId) ||
      (existingMessage.fromUserId === otherUserId && existingMessage.toUserId === userId);

    if (!isConversationMessage) {
      return res.status(403).json({ message: 'This message does not belong to the selected chat.' });
    }

    db.chatMessages = (db.chatMessages || []).filter((item) => item.id !== messageId);
    writeDb(db);

    const previews = emitConversationRefresh(db, userId, otherUserId);
    emitToUser(userId, 'chat:message:deleted', {
      messageId,
      conversationUserId: otherUserId,
      conversation: previews.leftPreview,
    });
    emitToUser(otherUserId, 'chat:message:deleted', {
      messageId,
      conversationUserId: userId,
      conversation: previews.rightPreview,
    });

    return res.json({
      message: 'Message deleted successfully.',
      messageId,
      conversation: previews.leftPreview,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not delete message.');
  }
});

router.post('/remove-all', (req, res) => {
  const session = authorizeChatUser(req, res, String(req.body.userId || '').trim());
  if (!session) {
    return;
  }

  try {
    const userId = session.userId;
    const db = session.db;

    // Remove all direct-chat traces for this user so conversations cannot rebuild on refresh.
    db.chatMessages = (db.chatMessages || []).filter(
      (item) => item.fromUserId !== userId && item.toUserId !== userId
    );
    db.hiMessages = (db.hiMessages || []).filter(
      (item) => item.fromUserId !== userId && item.toUserId !== userId
    );
    db.chatDrafts = (db.chatDrafts || []).filter(
      (item) => item.userId !== userId && item.otherUserId !== userId
    );
    db.callLogs = (db.callLogs || []).filter(
      (item) => item.fromUserId !== userId && item.toUserId !== userId
    );

    writeDb(db);

    // Notify the user that conversations are updated
    emitToUser(userId, 'chat:conversations:cleared', {});

    return res.json({
      message: 'All chats removed successfully.',
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not remove all chats.');
  }
});

router.post('/remove-selected', (req, res) => {
  const session = authorizeChatUser(req, res, String(req.body.userId || '').trim());
  if (!session) {
    return;
  }

  try {
    const userId = session.userId;
    const db = session.db;
    const conversationIds = Array.isArray(req.body.conversationIds)
      ? req.body.conversationIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (!conversationIds.length) {
      return res.status(400).json({ message: 'Select at least one conversation.' });
    }

    const selectedIds = new Set(conversationIds);

    db.chatMessages = (db.chatMessages || []).filter((item) => {
      const fromUserId = String(item?.fromUserId || '').trim();
      const toUserId = String(item?.toUserId || '').trim();
      const otherUserId = fromUserId === userId ? toUserId : toUserId === userId ? fromUserId : '';

      if (!otherUserId) {
        return true;
      }

      return !selectedIds.has(otherUserId);
    });

    db.callLogs = (db.callLogs || []).filter((item) => {
      const fromUserId = String(item?.fromUserId || '').trim();
      const toUserId = String(item?.toUserId || '').trim();
      const otherUserId = fromUserId === userId ? toUserId : toUserId === userId ? fromUserId : '';

      if (!otherUserId) {
        return true;
      }

      return !selectedIds.has(otherUserId);
    });
    db.hiMessages = (db.hiMessages || []).filter((item) => {
      const fromUserId = String(item?.fromUserId || '').trim();
      const toUserId = String(item?.toUserId || '').trim();
      const otherUserId = fromUserId === userId ? toUserId : toUserId === userId ? fromUserId : '';

      if (!otherUserId) {
        return true;
      }

      return !selectedIds.has(otherUserId);
    });
    db.chatDrafts = (db.chatDrafts || []).filter((item) => {
      const ownerUserId = String(item?.userId || '').trim();
      const otherUserId = String(item?.otherUserId || '').trim();
      const counterpartId =
        ownerUserId === userId ? otherUserId : otherUserId === userId ? ownerUserId : '';

      if (!counterpartId) {
        return true;
      }

      return !selectedIds.has(counterpartId);
    });

    writeDb(db);

    return res.json({
      message: 'Selected chats removed successfully.',
      removedConversationIds: conversationIds,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not remove selected chats.');
  }
});

module.exports = router;
