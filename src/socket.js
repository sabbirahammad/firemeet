const { Server } = require('socket.io');
const crypto = require('crypto');
const { readDb, writeDb } = require('./data/db');
const { buildConversationPreview } = require('./utils/chat');
const {
  isBlockedBetween,
  ensureUserProfileData,
  sanitizePublicProfile,
  getPrivacySettings,
  buildRelationship,
  buildProfileStats,
} = require('./utils/profile');
const { applyCallCoins } = require('./utils/interactionCoins');
const { getAuthenticatedUserIdFromSocket } = require('./utils/authSession');

let io = null;
const onlineUsers = new Map();
const activeCalls = new Map();
const userActiveCalls = new Map();
const activeSoulLinks = new Map();

function upsertSoulLinkDraft(db, leftUserId, rightUserId) {
  db.chatDrafts = db.chatDrafts || [];
  db.chatDrafts = db.chatDrafts.filter(
    (item) =>
      !(
        (item.userId === leftUserId && item.otherUserId === rightUserId) ||
        (item.userId === rightUserId && item.otherUserId === leftUserId)
      )
  );

  const createdAt = new Date().toISOString();
  db.chatDrafts.push(
    {
      id: crypto.randomUUID(),
      userId: leftUserId,
      otherUserId: rightUserId,
      type: 'soullink',
      text: 'SoulLink connected',
      createdAt,
    },
    {
      id: crypto.randomUUID(),
      userId: rightUserId,
      otherUserId: leftUserId,
      type: 'soullink',
      text: 'SoulLink connected',
      createdAt,
    }
  );
}

function buildCallMessage({ fromUserId, toUserId, text, callStatus, durationMs = null, mediaType = 'audio' }) {
  return {
    id: crypto.randomUUID(),
    fromUserId,
    toUserId,
    text,
    type: 'call',
    callStatus,
    mediaType,
    giftName: null,
    fileUrl: null,
    fileName: null,
    mimeType: null,
    durationMs,
    editedAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
}

function appendCallLog({
  callId,
  fromUserId,
  toUserId,
  status,
  mediaType = 'audio',
  initiatedAt,
  acceptedAt = null,
  endedAt = null,
  durationMs = 0,
}) {
  const db = readDb();
  db.callLogs = db.callLogs || [];
  db.callLogs.push({
    id: crypto.randomUUID(),
    callId,
    fromUserId,
    toUserId,
    status,
    mediaType,
    initiatedAt,
    acceptedAt,
    endedAt,
    durationMs,
    createdAt: new Date().toISOString(),
  });
  const coinUserIds = applyCallCoins(db, fromUserId, toUserId, mediaType, durationMs);
  writeDb(db);
  emitCoinUpdates(db, coinUserIds);
}

function emitConversationLog(db, leftUserId, rightUserId, message) {
  const leftPreview = buildConversationPreview(db, leftUserId, rightUserId);
  const rightPreview = buildConversationPreview(db, rightUserId, leftUserId);

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

  emitToUser(leftUserId, 'chat:conversation:update', { conversation: leftPreview });
  emitToUser(rightUserId, 'chat:conversation:update', { conversation: rightPreview });
}

function persistCallLog(fromUserId, toUserId, text, callStatus, durationMs = null, mediaType = 'audio') {
  const db = readDb();
  db.chatMessages = db.chatMessages || [];
  const message = buildCallMessage({
    fromUserId,
    toUserId,
    text,
    callStatus,
    durationMs,
    mediaType,
  });

  if (isUserOnline(toUserId)) {
    message.deliveredAt = new Date().toISOString();
  }

  db.chatMessages.push(message);
  writeDb(db);
  emitConversationLog(db, fromUserId, toUserId, message);
  return message;
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

function clearCall(callId) {
  const session = activeCalls.get(callId);

  if (!session) {
    return null;
  }

  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }

  activeCalls.delete(callId);
  userActiveCalls.delete(session.fromUserId);
  userActiveCalls.delete(session.toUserId);
  return session;
}

function notifyCallEnded(callId, reason) {
  const session = clearCall(callId);

  if (!session) {
    return null;
  }

  emitToUser(session.fromUserId, 'call:ended', {
    callId,
    reason,
    fromUserId: session.fromUserId,
    toUserId: session.toUserId,
    mediaType: session.mediaType || 'audio',
  });
  emitToUser(session.toUserId, 'call:ended', {
    callId,
    reason,
    fromUserId: session.fromUserId,
    toUserId: session.toUserId,
    mediaType: session.mediaType || 'audio',
  });

  return session;
}

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => {
    const db = readDb();
    const authenticatedUserId = getAuthenticatedUserIdFromSocket(db, socket);

    if (!authenticatedUserId) {
      next(new Error('Authentication required for socket connection.'));
      return;
    }

    socket.data.authenticatedUserId = authenticatedUserId;
    next();
  });

  io.on('connection', (socket) => {
    socket.on('chat:join', ({ userId }) => {
      if (!userId) {
        return;
      }

      if (socket.data.authenticatedUserId !== userId) {
        socket.emit('call:error', { message: 'Socket authentication mismatch.' });
        return;
      }

      socket.data.userId = userId;
      socket.join(`user:${userId}`);
      onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
      io.to(`user:${userId}`).emit('chat:presence', { userId, online: true });
      emitPendingSoulLinksForUser(userId);
    });

    socket.on('chat:typing', ({ fromUserId, toUserId, typing }) => {
      if (!fromUserId || !toUserId) {
        return;
      }

      emitToUser(toUserId, 'chat:typing', {
        fromUserId,
        toUserId,
        typing: !!typing,
      });
    });

    socket.on('call:start', ({ callId, fromUserId, toUserId, offer, mediaType = 'audio' }) => {
      if (!callId || !fromUserId || !toUserId || !offer) {
        socket.emit('call:error', { message: 'Invalid call request.' });
        return;
      }

      if (socket.data.authenticatedUserId !== fromUserId) {
        socket.emit('call:error', { message: 'Call user mismatch.' });
        return;
      }

      if (!isUserOnline(toUserId)) {
        persistCallLog(fromUserId, toUserId, `${mediaType === 'video' ? 'Video' : 'Audio'} call missed`, 'offline', null, mediaType);
        socket.emit('call:ended', { callId, reason: 'offline', fromUserId, toUserId, mediaType });
        return;
      }

      if (userActiveCalls.has(fromUserId) || userActiveCalls.has(toUserId)) {
        persistCallLog(fromUserId, toUserId, `${mediaType === 'video' ? 'Video' : 'Audio'} call busy`, 'busy', null, mediaType);
        socket.emit('call:ended', { callId, reason: 'busy', fromUserId, toUserId, mediaType });
        return;
      }

      const db = readDb();
      const caller = db.users.find((item) => item.id === fromUserId);
      const receiver = db.users.find((item) => item.id === toUserId);

      if (!caller || !receiver) {
        socket.emit('call:error', { message: 'Call users were not found.' });
        return;
      }

      if (isBlockedBetween(db, fromUserId, toUserId)) {
        socket.emit('call:error', { message: 'Audio calling is unavailable for this profile.' });
        return;
      }

      userActiveCalls.set(fromUserId, callId);
      userActiveCalls.set(toUserId, callId);

      const timeoutId = setTimeout(() => {
        appendCallLog({
          callId,
          fromUserId,
          toUserId,
          status: 'missed',
          mediaType,
          initiatedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        });
        persistCallLog(fromUserId, toUserId, `${mediaType === 'video' ? 'Video' : 'Audio'} call missed`, 'missed', null, mediaType);
        notifyCallEnded(callId, 'missed');
      }, 30000);

      activeCalls.set(callId, {
        callId,
        fromUserId,
        toUserId,
        initiatedAt: new Date().toISOString(),
        acceptedAt: null,
        timeoutId,
        status: 'ringing',
        mediaType,
      });

      persistCallLog(fromUserId, toUserId, `${mediaType === 'video' ? 'Video' : 'Audio'} call started`, 'started', null, mediaType);

      emitToUser(toUserId, 'call:incoming', {
        callId,
        fromUserId,
        toUserId,
        mediaType,
        offer,
        fromUser: buildConversationPreview(db, toUserId, fromUserId),
      });
      emitToUser(fromUserId, 'call:ringing', {
        callId,
        toUserId,
        mediaType,
        toUser: buildConversationPreview(db, fromUserId, toUserId),
      });
    });

    socket.on('call:accept', ({ callId, userId, answer, mediaType = 'audio' }) => {
      const session = activeCalls.get(callId);

      if (!session || session.toUserId !== userId || !answer || socket.data.authenticatedUserId !== userId) {
        socket.emit('call:error', { message: 'Could not accept the call.' });
        return;
      }

      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }

      session.timeoutId = null;
      session.status = 'active';
      session.acceptedAt = new Date().toISOString();
      persistCallLog(session.fromUserId, session.toUserId, `${session.mediaType === 'video' ? 'Video' : 'Audio'} call accepted`, 'accepted', null, session.mediaType);

      emitToUser(session.fromUserId, 'call:accepted', {
        callId,
        fromUserId: session.fromUserId,
        toUserId: session.toUserId,
        mediaType: session.mediaType || mediaType,
        answer,
      });
    });

    socket.on('call:reject', ({ callId, userId, reason }) => {
      const session = activeCalls.get(callId);

      if (!session || (session.fromUserId !== userId && session.toUserId !== userId) || socket.data.authenticatedUserId !== userId) {
        return;
      }

      const logFromUserId = session.fromUserId === userId ? session.fromUserId : session.toUserId;
      const logToUserId = session.fromUserId === userId ? session.toUserId : session.fromUserId;
      appendCallLog({
        callId,
        fromUserId: logFromUserId,
        toUserId: logToUserId,
        status: reason || 'declined',
        mediaType: session.mediaType,
        initiatedAt: session.initiatedAt,
        acceptedAt: session.acceptedAt,
        endedAt: new Date().toISOString(),
        durationMs: session.acceptedAt ? Math.max(Date.now() - new Date(session.acceptedAt).getTime(), 0) : 0,
      });
      persistCallLog(logFromUserId, logToUserId, `${session.mediaType === 'video' ? 'Video' : 'Audio'} call declined`, reason || 'declined', null, session.mediaType);
      notifyCallEnded(callId, reason || 'declined');
    });

    socket.on('call:signal', ({ callId, userId, candidate }) => {
      const session = activeCalls.get(callId);

      if (!session || !candidate) {
        return;
      }

      if ((session.fromUserId !== userId && session.toUserId !== userId) || socket.data.authenticatedUserId !== userId) {
        return;
      }

      const targetUserId = session.fromUserId === userId ? session.toUserId : session.fromUserId;
      emitToUser(targetUserId, 'call:signal', {
        callId,
        userId,
        candidate,
      });
    });

    socket.on('call:end', ({ callId, userId, reason }) => {
      const session = activeCalls.get(callId);

      if (!session || (session.fromUserId !== userId && session.toUserId !== userId) || socket.data.authenticatedUserId !== userId) {
        return;
      }

      const logFromUserId = session.fromUserId === userId ? session.fromUserId : session.toUserId;
      const logToUserId = session.fromUserId === userId ? session.toUserId : session.fromUserId;
      const durationMs = session.acceptedAt ? Math.max(Date.now() - new Date(session.acceptedAt).getTime(), 0) : 0;
      appendCallLog({
        callId,
        fromUserId: logFromUserId,
        toUserId: logToUserId,
        status: reason || 'ended',
        mediaType: session.mediaType,
        initiatedAt: session.initiatedAt,
        acceptedAt: session.acceptedAt,
        endedAt: new Date().toISOString(),
        durationMs,
      });
      persistCallLog(
        logFromUserId,
        logToUserId,
        durationMs > 0
          ? `${session.mediaType === 'video' ? 'Video' : 'Audio'} call ended (${Math.round(durationMs / 1000)}s)`
          : `${session.mediaType === 'video' ? 'Video' : 'Audio'} call ended`,
        reason || 'ended',
        durationMs,
        session.mediaType
      );
      notifyCallEnded(callId, reason || 'ended');
    });

    socket.on('soullink:accept', ({ sessionId, userId }) => {
      const session = getSoulLinkSession(sessionId);

      if (
        !session ||
        socket.data.authenticatedUserId !== userId ||
        session.acceptedByUserId
      ) {
        socket.emit('call:error', { message: 'Could not accept SoulLink request.' });
        return;
      }

      session.acceptedByUserId = userId;
      const db = readDb();
      upsertSoulLinkDraft(db, session.fromUserId, userId);
      emitToUser(session.fromUserId, 'soullink:accepted', {
        sessionId,
        peerUser: buildConversationPreview(db, session.fromUserId, userId),
      });
      emitToUser(userId, 'soullink:accepted', {
        sessionId,
        peerUser: buildConversationPreview(db, userId, session.fromUserId),
      });
      emitToUser(session.fromUserId, 'chat:conversation:update', {
        conversation: buildConversationPreview(db, session.fromUserId, userId),
      });
      emitToUser(userId, 'chat:conversation:update', {
        conversation: buildConversationPreview(db, userId, session.fromUserId),
      });
      db.soulLinkInvites = (db.soulLinkInvites || []).map((item) =>
        item.sessionId === sessionId
          ? {
              ...item,
              acceptedByUserId: userId,
              status: 'accepted',
            }
          : item
      );
      writeDb(db);
      clearSoulLinkSession(sessionId);
    });

    socket.on('soullink:reject', ({ sessionId, userId }) => {
      const session = getSoulLinkSession(sessionId);

      if (!session || socket.data.authenticatedUserId !== userId) {
        return;
      }

      emitToUser(userId, 'soullink:closed', {
        sessionId,
        reason: 'rejected',
      });
      const db = readDb();
      session.rejectedUserIds = Array.from(new Set([...(session.rejectedUserIds || []), userId]));
      db.soulLinkInvites = (db.soulLinkInvites || []).map((item) =>
        item.sessionId === sessionId
          ? {
              ...item,
              rejectedUserIds: Array.from(new Set([...(item.rejectedUserIds || []), userId])),
            }
          : item
      );
      writeDb(db);
    });

    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) {
        return;
      }

      const nextCount = (onlineUsers.get(userId) || 1) - 1;
      if (nextCount <= 0) {
        onlineUsers.delete(userId);
        const db = readDb();
        const userIndex = (db.users || []).findIndex((item) => item.id === userId);
        if (userIndex >= 0) {
          db.users[userIndex] = {
            ...db.users[userIndex],
            lastActiveAt: new Date().toISOString(),
          };
          writeDb(db);
        }
        emitToUser(userId, 'chat:presence', { userId, online: false });

        const activeCallId = userActiveCalls.get(userId);
        if (activeCallId) {
          const activeSession = activeCalls.get(activeCallId);
          if (activeSession) {
            const otherUserId = activeSession.fromUserId === userId ? activeSession.toUserId : activeSession.fromUserId;
            const durationMs = activeSession.acceptedAt
              ? Math.max(Date.now() - new Date(activeSession.acceptedAt).getTime(), 0)
              : 0;
            appendCallLog({
              callId: activeCallId,
              fromUserId: otherUserId,
              toUserId: userId,
              status: 'disconnected',
              mediaType: activeSession.mediaType,
              initiatedAt: activeSession.initiatedAt,
              acceptedAt: activeSession.acceptedAt,
              endedAt: new Date().toISOString(),
              durationMs,
            });
            persistCallLog(
              otherUserId,
              userId,
              `${activeSession.mediaType === 'video' ? 'Video' : 'Audio'} call disconnected`,
              'disconnected',
              durationMs,
              activeSession.mediaType
            );
          }
          notifyCallEnded(activeCallId, 'disconnected');
        }
      } else {
        onlineUsers.set(userId, nextCount);
      }
    });
  });

  return io;
}

function emitToUser(userId, event, payload) {
  if (!io || !userId) {
    return;
  }

  io.to(`user:${userId}`).emit(event, payload);
}

function isUserOnline(userId) {
  return onlineUsers.has(userId);
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

function registerSoulLinkSession({ sessionId, fromUserId, targetGender, notifiedUserIds = [] }) {
  const db = readDb();
  const normalizedNotifiedUserIds = Array.from(
    new Set((Array.isArray(notifiedUserIds) ? notifiedUserIds : []).filter(Boolean))
  );
  const createdAt = new Date().toISOString();
  db.soulLinkInvites = db.soulLinkInvites || [];
  db.soulLinkInvites = db.soulLinkInvites.filter(
    (item) => item.sessionId !== sessionId && !(item.fromUserId === fromUserId && item.status === 'searching')
  );
  db.soulLinkInvites.push({
    sessionId,
    fromUserId,
    targetGender,
    acceptedByUserId: null,
    notifiedUserIds: normalizedNotifiedUserIds,
    rejectedUserIds: [],
    status: 'searching',
    createdAt,
  });
  writeDb(db);

  activeSoulLinks.set(sessionId, {
    sessionId,
    fromUserId,
    targetGender,
    acceptedByUserId: null,
    notifiedUserIds: normalizedNotifiedUserIds,
    rejectedUserIds: [],
    createdAt,
  });
}

function clearSoulLinkSession(sessionId) {
  const session = activeSoulLinks.get(sessionId) || null;
  const db = readDb();
  db.soulLinkInvites = (db.soulLinkInvites || []).filter((item) => item.sessionId !== sessionId);
  writeDb(db);

  if (session) {
    activeSoulLinks.delete(sessionId);
  }
  return session;
}

function getSoulLinkSession(sessionId) {
  const activeSession = activeSoulLinks.get(sessionId);
  if (activeSession) {
    return activeSession;
  }

  const db = readDb();
  const savedSession = (db.soulLinkInvites || []).find((item) => item.sessionId === sessionId);
  if (!savedSession) {
    return null;
  }

  const restored = {
    sessionId: savedSession.sessionId,
    fromUserId: savedSession.fromUserId,
    targetGender: savedSession.targetGender,
    acceptedByUserId: savedSession.acceptedByUserId || null,
    notifiedUserIds: Array.isArray(savedSession.notifiedUserIds) ? savedSession.notifiedUserIds : [],
    rejectedUserIds: Array.isArray(savedSession.rejectedUserIds) ? savedSession.rejectedUserIds : [],
    createdAt: savedSession.createdAt,
  };
  activeSoulLinks.set(sessionId, restored);
  return restored;
}

function emitPendingSoulLinksForUser(userId) {
  if (!io || !userId) {
    return;
  }

  const db = readDb();
  const userIndex = db.users.findIndex((item) => item.id === userId);
  const viewer = userIndex >= 0 ? ensureUserProfileData(db.users[userIndex], userIndex) : null;

  if (!viewer?.gender) {
    return;
  }

  const invite = (db.soulLinkInvites || [])
    .filter((item) => item.status === 'searching')
    .filter((item) => item.fromUserId !== userId)
    .filter((item) => item.targetGender === viewer.gender)
    .filter((item) => Array.isArray(item.notifiedUserIds) && item.notifiedUserIds.includes(userId))
    .filter((item) => !(item.rejectedUserIds || []).includes(userId))
    .filter((item) => !isBlockedBetween(db, userId, item.fromUserId))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

  if (!invite) {
    return;
  }

  const fromUserIndex = db.users.findIndex((item) => item.id === invite.fromUserId);
  const fromUser = fromUserIndex >= 0 ? ensureUserProfileData(db.users[fromUserIndex], fromUserIndex) : null;

  if (!fromUser) {
    return;
  }

  emitToUser(userId, 'soullink:incoming', {
    sessionId: invite.sessionId,
    fromUserId: invite.fromUserId,
    fromUser: sanitizePublicProfile(fromUser, {
      viewerId: userId,
      privacySettings: getPrivacySettings(db, fromUser.id),
      relationship: buildRelationship(db, userId, fromUser.id),
      stats: buildProfileStats(db, fromUser.id),
    }),
  });
}

module.exports = {
  initSocket,
  emitToUser,
  isUserOnline,
  getOnlineUserIds,
  registerSoulLinkSession,
  clearSoulLinkSession,
};
