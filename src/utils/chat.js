const { buildRelationship, getPrivacySettings, sanitizePublicProfile, buildProfileStats } = require('./profile');

function getConversationUserIds(db, userId) {
  const ids = new Set();

  (db.chatMessages || []).forEach((item) => {
    if (item.fromUserId === userId) {
      ids.add(item.toUserId);
    }
    if (item.toUserId === userId) {
      ids.add(item.fromUserId);
    }
  });

  (db.hiMessages || []).forEach((item) => {
    if (item.fromUserId === userId) {
      ids.add(item.toUserId);
    }
    if (item.toUserId === userId) {
      ids.add(item.fromUserId);
    }
  });

  (db.chatDrafts || []).forEach((item) => {
    if (item.userId === userId && item.otherUserId) {
      ids.add(item.otherUserId);
    }
    if (item.otherUserId === userId && item.userId) {
      ids.add(item.userId);
    }
  });

  return Array.from(ids);
}

function getConversationMessages(db, userId, otherUserId) {
  return (db.chatMessages || [])
    .filter(
      (item) =>
        (item.fromUserId === userId && item.toUserId === otherUserId) ||
        (item.fromUserId === otherUserId && item.toUserId === userId)
    )
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function getConversationDraftRecord(db, userId, otherUserId) {
  return (db.chatDrafts || [])
    .filter(
      (item) =>
        (item.userId === userId && item.otherUserId === otherUserId) ||
        (item.userId === otherUserId && item.otherUserId === userId)
    )
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())[0];
}

function searchConversationMessages(db, userId, otherUserId, search) {
  const normalized = String(search || '').trim().toLowerCase();
  const items = getConversationMessages(db, userId, otherUserId);

  if (!normalized) {
    return items;
  }

  return items.filter((item) => {
    const haystack = [
      item.text,
      item.giftName,
      item.fileName,
      item.type,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

function getSoulLinkProgress(messages) {
  const orderedTextMessages = messages
    .filter((item) => (item.type || 'text') === 'text' && String(item.text || '').trim())
    .slice()
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

  let turns = 0;
  let lastSenderId = null;

  orderedTextMessages.forEach((item) => {
    if (!item.fromUserId) {
      return;
    }

    if (item.fromUserId !== lastSenderId) {
      turns += 1;
      lastSenderId = item.fromUserId;
    }
  });

  return Math.min(turns * 10, 100);
}

function getSoulLinkConversationState(db, userId, otherUserId) {
  const messages = getConversationMessages(db, userId, otherUserId);
  const draftRecord = getConversationDraftRecord(db, userId, otherUserId);
  const conversationType = draftRecord?.type || null;
  const isSoulLink = conversationType === 'soullink';
  const soulLinkProgress = isSoulLink ? getSoulLinkProgress(messages) : 0;
  const soulLinkUnlocked = soulLinkProgress >= 100;

  return {
    conversationType,
    draftRecord,
    isSoulLink,
    soulLinkProgress,
    soulLinkUnlocked,
    soulLinkLocked: isSoulLink && !soulLinkUnlocked,
    messages,
  };
}

function buildConversationPreview(db, userId, otherUserId) {
  const otherUser = db.users.find((item) => item.id === otherUserId);

  if (!otherUser) {
    return null;
  }

  const soulLinkState = getSoulLinkConversationState(db, userId, otherUserId);
  const messages = soulLinkState.messages;
  const lastMessage = messages[messages.length - 1] || null;
  const hiRecord = (db.hiMessages || [])
    .filter(
      (item) =>
        (item.fromUserId === userId && item.toUserId === otherUserId) ||
        (item.fromUserId === otherUserId && item.toUserId === userId)
    )
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

  const unreadCount = messages.filter((item) => item.toUserId === userId && !item.readAt).length;
  const { draftRecord, conversationType, isSoulLink, soulLinkProgress, soulLinkUnlocked } = soulLinkState;
  const lastMessageText = lastMessage
    ? lastMessage.type === 'gift'
      ? `Sent a ${lastMessage.giftName || 'gift'}`
      : lastMessage.text
    : hiRecord
      ? 'Hi sent'
      : draftRecord?.text || 'Start your conversation.';
  const profile = sanitizePublicProfile(otherUser, {
    viewerId: userId,
    privacySettings: getPrivacySettings(db, otherUserId),
    relationship: buildRelationship(db, userId, otherUserId),
    stats: buildProfileStats(db, otherUserId),
  });

  return {
    ...profile,
    conversationType,
    isSoulLink,
    soulLinkProgress,
    soulLinkUnlocked,
    lastMessage: lastMessageText,
    lastMessageAt: lastMessage ? lastMessage.createdAt : hiRecord ? hiRecord.createdAt : draftRecord?.createdAt || otherUser.createdAt,
    lastMessageFromUserId: lastMessage ? lastMessage.fromUserId : hiRecord ? hiRecord.fromUserId : draftRecord?.userId || null,
    unreadCount,
  };
}

function markConversationRead(db, userId, otherUserId) {
  const changedMessages = [];

  (db.chatMessages || []).forEach((item) => {
    if (item.fromUserId === otherUserId && item.toUserId === userId && !item.readAt) {
      item.readAt = new Date().toISOString();
      changedMessages.push(item);
    }
  });

  return changedMessages;
}

function markConversationDelivered(db, userId) {
  const changedMessages = [];

  (db.chatMessages || []).forEach((item) => {
    if (item.toUserId === userId && !item.deliveredAt) {
      item.deliveredAt = new Date().toISOString();
      changedMessages.push(item);
    }
  });

  return changedMessages;
}

module.exports = {
  getConversationUserIds,
  getConversationMessages,
  getSoulLinkConversationState,
  searchConversationMessages,
  buildConversationPreview,
  markConversationRead,
  markConversationDelivered,
};
