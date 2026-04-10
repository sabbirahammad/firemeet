const express = require('express');
const crypto = require('crypto');
const { readDb, writeDb } = require('../data/db');
const { sendServerError } = require('../utils/common');
const {
  sanitizePublicProfile,
  ensureUserProfileData,
  getPrivacySettings,
  buildRelationship,
  isBlockedBetween,
  buildProfileStats,
} = require('../utils/profile');
const { buildConversationPreview } = require('../utils/chat');
const { applyManToWomanTextCoins } = require('../utils/interactionCoins');
const { recordDailyHiMessage, syncMissionSections } = require('../utils/missions');
const { emitToUser, isUserOnline, getOnlineUserIds, registerSoulLinkSession } = require('../socket');
const { buildDisplayName, notifyUserById } = require('../services/userPushService');

const router = express.Router();

router.get('/users/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const db = readDb();
    const viewer = db.users.find((item) => item.id === userId);
    const search = String(req.query.search || '').trim().toLowerCase();
    const sort = String(req.query.sort || '').trim().toLowerCase();
    const oppositeOnly =
      String(req.query.oppositeOnly || '').trim() === '1' ||
      String(req.query.oppositeOnly || '').trim().toLowerCase() === 'true';

    if (!viewer) {
      return res.status(404).json({ message: 'Viewer not found.' });
    }

    const targetGender =
      viewer.gender === 'man' ? 'woman' : viewer.gender === 'woman' ? 'man' : '';

    let users = db.users
      .filter((item) => item.id !== userId)
      .filter((item) => !isBlockedBetween(db, userId, item.id))
      .filter((item) => (oppositeOnly && targetGender ? item.gender === targetGender : true))
      .map((item) =>
        ({
          ...sanitizePublicProfile(item, {
            viewerId: userId,
            privacySettings: getPrivacySettings(db, item.id),
            relationship: buildRelationship(db, userId, item.id),
            stats: buildProfileStats(db, item.id),
          }),
          isOnline: isUserOnline(item.id),
        })
      );

    if (search) {
      users = users.filter((item) => {
        const haystack = [
          item.name,
          item.city,
          item.status,
          item.appProfileId,
          item.gamePlayerId,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(search);
      });
    }

    if (sort === 'new' || sort === 'newest') {
      users = users.sort(
        (left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
      );
    }

    return res.json({ users });
  } catch (error) {
    return sendServerError(res, error, 'Could not load discover users.');
  }
});

router.post('/send-hi', (req, res) => {
  try {
    const fromUserId = String(req.body.fromUserId || '').trim();
    const toUserId = String(req.body.toUserId || '').trim();

    if (!fromUserId || !toUserId || fromUserId === toUserId) {
      return res.status(400).json({ message: 'Valid sender and receiver are required.' });
    }

    const db = readDb();
    const sender = db.users.find((item) => item.id === fromUserId);
    const receiver = db.users.find((item) => item.id === toUserId);

    if (!sender || !receiver) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (isBlockedBetween(db, fromUserId, toUserId)) {
      return res.status(403).json({ message: 'Hi is unavailable for this profile.' });
    }

    db.hiMessages = db.hiMessages || [];
    db.chatMessages = db.chatMessages || [];
    const exists = db.hiMessages.some((item) => item.fromUserId === fromUserId && item.toUserId === toUserId);
    const createdAt = new Date().toISOString();

    if (!exists) {
      db.hiMessages.push({ fromUserId, toUserId, createdAt });
    }

    const chatMessage = {
      id: crypto.randomUUID(),
      fromUserId,
      toUserId,
      text: 'Hi',
      type: 'text',
      giftName: null,
      fileUrl: null,
      fileName: null,
      mimeType: null,
      durationMs: null,
      editedAt: null,
      deliveredAt: isUserOnline(toUserId) ? createdAt : null,
      createdAt,
      readAt: null,
    };

    db.chatMessages.push(chatMessage);
    recordDailyHiMessage(sender);
    const coinUserIds = applyManToWomanTextCoins(db, fromUserId, toUserId);
    const missionResult = syncMissionSections(db, fromUserId);
    writeDb(db);

    const senderConversation = buildConversationPreview(db, fromUserId, toUserId);
    const receiverConversation = buildConversationPreview(db, toUserId, fromUserId);

    emitToUser(fromUserId, 'chat:message:new', {
      conversationUserId: toUserId,
      message: chatMessage,
      conversation: senderConversation,
    });
    emitToUser(toUserId, 'chat:message:new', {
      conversationUserId: fromUserId,
      message: chatMessage,
      conversation: receiverConversation,
    });

    emitToUser(fromUserId, 'chat:conversation:update', { conversation: senderConversation });
    emitToUser(toUserId, 'chat:conversation:update', { conversation: receiverConversation });
    coinUserIds.forEach((userId) => {
      const targetUser = db.users.find((item) => item.id === userId);
      if (!targetUser) {
        return;
      }
      emitToUser(userId, 'profile:coins:update', { coins: targetUser.coins || 0 });
    });

    if (!isUserOnline(toUserId)) {
      notifyUserById(
        db,
        toUserId,
        {
          title: buildDisplayName(sender),
          body: 'Sent you a Hi.',
          data: {
            tab: 'chat',
            screen: 'chat',
            notificationType: 'chat',
            conversationUserId: fromUserId,
            userId: toUserId,
            messageId: chatMessage.id,
          },
        },
        { settingKey: 'chatMessages' }
      ).catch(() => {});
    }

    return res.json({
      message: 'Hi sent successfully.',
      sent: true,
      chatMessage,
      conversation: senderConversation,
      missionRewards: missionResult.newlyClaimedMissions || [],
      coins: typeof missionResult.user?.coins === 'number' ? missionResult.user.coins : sender.coins || 0,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send hi.');
  }
});

router.post('/soul-link', (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const db = readDb();
    const viewerIndex = db.users.findIndex((item) => item.id === userId);
    const viewer = viewerIndex >= 0 ? ensureUserProfileData(db.users[viewerIndex], viewerIndex) : null;

    if (!viewer) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!viewer.gender || !['man', 'woman'].includes(viewer.gender)) {
      return res.status(400).json({ message: 'Select your gender first before using SoulLink.' });
    }

    const targetGender = viewer.gender === 'man' ? 'woman' : 'man';

    const activeRecipients = db.users
      .map((item, index) => ensureUserProfileData(item, index))
      .filter((item) => item.id !== userId)
      .filter((item) => item.gender === targetGender)
      .filter((item) => getOnlineUserIds().includes(item.id))
      .filter((item) => !isBlockedBetween(db, userId, item.id));

    const sessionId = crypto.randomUUID();

    registerSoulLinkSession({
      sessionId,
      fromUserId: userId,
      targetGender,
      notifiedUserIds: activeRecipients.map((item) => item.id),
    });

    activeRecipients.forEach((candidateUser) => {
      emitToUser(candidateUser.id, 'soullink:incoming', {
        sessionId,
        fromUserId: userId,
        fromUser: sanitizePublicProfile(viewer, {
          viewerId: candidateUser.id,
          privacySettings: getPrivacySettings(db, userId),
          relationship: buildRelationship(db, candidateUser.id, userId),
          stats: buildProfileStats(db, userId),
        }),
      });
    });

    return res.json({
      searching: true,
      sessionId,
      message: `Searching ${targetGender} users now.`,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not complete SoulLink search.');
  }
});

router.get('/soul-link/pending/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const db = readDb();
    const userIndex = db.users.findIndex((item) => item.id === userId);
    const viewer = userIndex >= 0 ? ensureUserProfileData(db.users[userIndex], userIndex) : null;

    if (!viewer || !viewer.gender) {
      return res.json({ invite: null });
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
      return res.json({ invite: null });
    }

    const fromUser = db.users.find((item) => item.id === invite.fromUserId);
    const fromUserIndex = db.users.findIndex((item) => item.id === invite.fromUserId);

    if (!fromUser) {
      return res.json({ invite: null });
    }

    return res.json({
      invite: {
        ...invite,
        fromUser: sanitizePublicProfile(ensureUserProfileData(fromUser, fromUserIndex), {
          viewerId: userId,
          privacySettings: getPrivacySettings(db, fromUser.id),
          relationship: buildRelationship(db, userId, fromUser.id),
          stats: buildProfileStats(db, fromUser.id),
        }),
      },
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load pending SoulLink invite.');
  }
});

module.exports = router;
