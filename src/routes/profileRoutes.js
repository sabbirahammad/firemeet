const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { REPORT_REASONS } = require('../config/constants');
const { readDb, writeDb } = require('../data/db');
const {
  sanitizeOwnProfile,
  sanitizePublicProfile,
  sanitizeUser,
  getPrivacySettings,
  getNotificationSettings,
  upsertPrivacySettings,
  upsertNotificationSettings,
  isBlockedBetween,
  buildRelationship,
  buildProfileStats,
  buildOwnProfileStats,
  buildOwnProfileConnectionList,
} = require('../utils/profile');
const { syncMissionSections } = require('../utils/missions');
const { validateProfileUpdateInput, validateReportInput } = require('../utils/profileValidation');
const { validateGallerySlotInput } = require('../utils/galleryValidation');
const { ALLOWED_AVATAR_KEYS, PROFILE_VOICE_UPLOADS_DIR } = require('../config/constants');
const { assertAuthorizedUser } = require('../utils/authSession');
const { emitToUser, isUserOnline } = require('../socket');
const { buildDisplayName, notifyUserById } = require('../services/userPushService');

const router = express.Router();
const WITHDRAW_PACKAGES = [
  { packageId: 'withdraw-250', gold: 250, amount: 200 },
  { packageId: 'withdraw-600', gold: 600, amount: 500 },
  { packageId: 'withdraw-1200', gold: 1200, amount: 1000 },
  { packageId: 'withdraw-6000', gold: 6000, amount: 5000 },
];
const WITHDRAW_METHODS = new Set(['bkash', 'nogod']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const voiceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PROFILE_VOICE_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '') || '.m4a';
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});
const voiceUpload = multer({
  storage: voiceStorage,
  limits: { fileSize: 12 * 1024 * 1024 },
});

function formatInteractionRelativeTime(value) {
  if (!value) {
    return 'Just now';
  }

  const diffMs = Math.max(Date.now() - new Date(value).getTime(), 0);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(value).toLocaleDateString('en-GB');
}

function sanitizeInteractionNotification(notification, db, viewerId) {
  const actor = (db.users || []).find((item) => item.id === notification.actorUserId);
  const actorProfile = actor
    ? sanitizePublicProfile(actor, {
        viewerId,
        privacySettings: getPrivacySettings(db, actor.id),
        relationship: buildRelationship(db, viewerId, actor.id),
        stats: buildProfileStats(db, actor.id),
        isOnline: isUserOnline(actor.id),
      })
    : null;

  return {
    id: String(notification?.id || '').trim(),
    userId: String(notification?.userId || '').trim(),
    actorUserId: String(notification?.actorUserId || '').trim(),
    type: String(notification?.type || 'follow').trim(),
    text: String(notification?.text || '').trim() || 'started following you',
    read: Boolean(notification?.readAt),
    createdAt: notification?.createdAt || '',
    timestamp: formatInteractionRelativeTime(notification?.createdAt),
    actor: actorProfile,
  };
}

function buildMissionSyncPayload(db, userId) {
  const result = syncMissionSections(db, userId);
  return {
    changed: result.changed,
    missionRewards: result.newlyClaimedMissions || [],
    coins: typeof result.user?.coins === 'number' ? result.user.coins : 0,
    sections: result.sections || [],
  };
}

function sendServerError(res, error, fallbackMessage) {
  return res.status(500).json({ message: error.message || fallbackMessage });
}

function findUserById(db, userId) {
  return (db.users || []).find((item) => String(item?.id || '').trim() === String(userId || '').trim()) || null;
}

function findUserByAppProfileId(db, appProfileId) {
  const normalizedAppProfileId = String(appProfileId || '').trim();
  return (
    (db.users || []).find((item) => String(item?.appProfileId || '').trim() === normalizedAppProfileId) || null
  );
}

function ensureAuthorizedParamUser(db, req, userId) {
  const authorization = assertAuthorizedUser(db, req, userId);
  if (authorization.error) {
    return { errorResponse: { message: authorization.error, status: 401 } };
  }

  return { userId: authorization.userId };
}

function loadUserContext(userId, options = {}) {
  const { req = null, authorize = false, notFoundMessage = 'User not found.' } = options;
  const db = readDb();

  if (authorize) {
    const authorization = ensureAuthorizedParamUser(db, req, userId);
    if (authorization.errorResponse) {
      return { errorResponse: authorization.errorResponse };
    }
  }

  const user = findUserById(db, userId);
  if (!user) {
    return { errorResponse: { status: 404, message: notFoundMessage } };
  }

  return { db, user };
}

function requireUserId(value) {
  const userId = String(value || '').trim();
  if (!userId) {
    return { errorResponse: { status: 400, message: 'User id is required.' } };
  }
  return { userId };
}

function buildInteractionNotificationsResponse(db, userId, limit = 30) {
  const notifications = (db.interactionNotifications || [])
    .filter((item) => String(item?.userId || '').trim() === userId)
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
    .slice(0, limit)
    .map((item) => sanitizeInteractionNotification(item, db, userId));

  return {
    notifications,
    unreadCount: notifications.filter((item) => !item.read).length,
  };
}

router.get('/me/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user } = context;

    const missionPayload = buildMissionSyncPayload(db, userId);
    if (missionPayload.changed) {
      writeDb(db);
    }

    const nextProfile = sanitizeOwnProfile(
      missionPayload.user || user,
      getPrivacySettings(db, userId)
    );

    return res.json({
      profile: nextProfile,
      stats: buildOwnProfileStats(db, userId),
      coins: missionPayload.coins,
      missionRewards: missionPayload.missionRewards,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load profile.');
  }
});

router.get('/missions/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user } = context;

    const missionPayload = buildMissionSyncPayload(db, userId);

    if (missionPayload.changed) {
      writeDb(db);
    }

    return res.json({
      sections: missionPayload.sections,
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load missions.');
  }
});

router.get('/connections/:userId/:type', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const type = String(req.params.type || '').trim().toLowerCase();
    const validTypes = new Set(['follow', 'friend', 'following']);
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user } = context;

    if (!validTypes.has(type)) {
      return res.status(400).json({ message: 'Invalid connection type.' });
    }

    const connectionUsers = buildOwnProfileConnectionList(db, userId, type).filter(
      (item) => !isBlockedBetween(db, userId, item.id)
    );
    const users = connectionUsers
      .map((item) => {
        const targetUser = db.users.find((entry) => entry.id === item.id);
        if (!targetUser) {
          return null;
        }
        return sanitizePublicProfile(targetUser, {
          viewerId: userId,
          privacySettings: getPrivacySettings(db, targetUser.id),
          relationship: buildRelationship(db, userId, targetUser.id),
          stats: buildProfileStats(db, targetUser.id),
          isOnline: isUserOnline(targetUser.id),
        });
      })
      .filter(Boolean);

    return res.json({ users });
  } catch (error) {
    return sendServerError(res, error, 'Could not load connections.');
  }
});

router.get('/user/:viewerId/:profileId', (req, res) => {
  try {
    const viewerId = String(req.params.viewerId || '').trim();
    const profileId = String(req.params.profileId || '').trim();
    const context = loadUserContext(viewerId, { req, authorize: true, notFoundMessage: 'Viewer not found.' });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user: viewer } = context;
    const user = findUserById(db, profileId);

    if (!viewer) {
      return res.status(404).json({ message: 'Viewer not found.' });
    }

    if (!user) {
      return res.status(404).json({ message: 'Profile not found.' });
    }

    const relationship = buildRelationship(db, viewerId, profileId);

    if (relationship.isBlocked) {
      return res.status(403).json({ message: 'This profile is not available.' });
    }

    return res.json({
      profile: sanitizePublicProfile(user, {
        viewerId,
        privacySettings: getPrivacySettings(db, profileId),
        relationship,
        stats: buildProfileStats(db, profileId),
        isOnline: isUserOnline(profileId),
      }),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load user profile.');
  }
});

router.get('/user-by-app-id/:viewerId/:appProfileId', (req, res) => {
  try {
    const viewerId = String(req.params.viewerId || '').trim();
    const appProfileId = String(req.params.appProfileId || '').trim();
    const context = loadUserContext(viewerId, { req, authorize: true, notFoundMessage: 'Viewer not found.' });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user: viewer } = context;
    const user = findUserByAppProfileId(db, appProfileId);

    if (!viewer) {
      return res.status(404).json({ message: 'Viewer not found.' });
    }

    if (!user) {
      return res.status(404).json({ message: 'Profile not found.' });
    }

    const relationship = buildRelationship(db, viewerId, user.id);

    if (relationship.isBlocked) {
      return res.status(403).json({ message: 'This profile is not available.' });
    }

    return res.json({
      profile: sanitizePublicProfile(user, {
        viewerId,
        privacySettings: getPrivacySettings(db, user.id),
        relationship,
        stats: buildProfileStats(db, user.id),
        isOnline: isUserOnline(user.id),
      }),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load user profile.');
  }
});

router.get('/search/:viewerId', (req, res) => {
  try {
    const viewerId = String(req.params.viewerId || '').trim();
    const query = String(req.query.q || '').trim().toLowerCase();
    const db = readDb();
    const viewer = db.users.find((item) => item.id === viewerId);

    if (!viewer) {
      return res.status(404).json({ message: 'Viewer not found.' });
    }

    if (!query) {
      return res.json({ users: [] });
    }

    const targetGender =
      viewer.gender === 'man' ? 'woman' :
      viewer.gender === 'woman' ? 'man' :
      '';

    const users = (db.users || [])
      .filter((item) => item.id !== viewerId)
      .filter((item) => !targetGender || String(item?.gender || '').trim().toLowerCase() === targetGender)
      .filter((item) => !isBlockedBetween(db, viewerId, item.id))
      .filter((item) => {
        const values = [
          item.name,
          item.appProfileId,
          item.gamePlayerId,
          item.city,
        ]
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean);
        return values.some((value) => value.includes(query));
      })
      .slice(0, 12)
      .map((item) =>
        sanitizePublicProfile(item, {
          viewerId,
          privacySettings: getPrivacySettings(db, item.id),
          relationship: buildRelationship(db, viewerId, item.id),
          stats: buildProfileStats(db, item.id),
          isOnline: isUserOnline(item.id),
        })
      );

    return res.json({ users });
  } catch (error) {
    return sendServerError(res, error, 'Could not search profiles.');
  }
});

router.post('/update', (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const context = loadUserContext(userId);
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user } = context;

    const { error, updates } = validateProfileUpdateInput(req.body);

    if (error) {
      return res.status(400).json({ message: error });
    }

    Object.assign(user, updates);
    user.profileEditedAt = new Date().toISOString();
    const missionPayload = buildMissionSyncPayload(db, userId);

    writeDb(db);
    return res.json({
      message: 'Profile updated successfully.',
      profile: sanitizeOwnProfile(user, getPrivacySettings(db, userId)),
      stats: buildOwnProfileStats(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update profile.');
  }
});

router.get('/media-options', (_req, res) => {
  return res.json({ mediaKeys: ALLOWED_AVATAR_KEYS });
});

function buildGalleryKeys(user) {
  const galleryKeys = Array.isArray(user.galleryKeys) ? user.galleryKeys.slice(0, 6) : [];
  while (galleryKeys.length < 6) {
    galleryKeys.push(null);
  }
  return galleryKeys;
}

function buildProfilePayload(db, userId) {
  const user = db.users.find((item) => item.id === userId);
  return {
    profile: sanitizeOwnProfile(user, getPrivacySettings(db, userId)),
    stats: buildOwnProfileStats(db, userId),
  };
}

function removeLocalVoiceFile(fileUrl) {
  const normalized = String(fileUrl || '').trim();
  if (!normalized.startsWith('/uploads/profile-voice/')) {
    return;
  }

  const filePath = path.join(PROFILE_VOICE_UPLOADS_DIR, path.basename(normalized));
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

router.post('/gallery-slot', (req, res) => {
  try {
    const validation = validateGallerySlotInput(req.body);
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const { userId, slotIndex, mediaKey } = validation.value;
    const db = readDb();
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const galleryKeys = buildGalleryKeys(user);
    galleryKeys[slotIndex] = mediaKey;
    user.galleryKeys = galleryKeys;

    if (slotIndex === 0) {
      user.avatarKey = mediaKey;
    }

    const missionPayload = buildMissionSyncPayload(db, userId);

    writeDb(db);

    return res.json({
      message: 'Gallery updated successfully.',
      ...buildProfilePayload(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update gallery slot.' });
  }
});

router.post('/gallery-upload', upload.single('image'), (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const slotIndex = Number(req.body.slotIndex);

    if (!userId) {
      return res.status(400).json({ message: 'User id is required.' });
    }

    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 5) {
      return res.status(400).json({ message: 'Slot index must be between 0 and 5.' });
    }

    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({ message: 'Image file is required.' });
    }

    const db = readDb();
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const mimeType = req.file.mimetype || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;
    const galleryKeys = buildGalleryKeys(user);
    galleryKeys[slotIndex] = dataUri;
    user.galleryKeys = galleryKeys;

    if (!user.avatarKey || !galleryKeys.includes(user.avatarKey)) {
      user.avatarKey = dataUri;
    }

    const missionPayload = buildMissionSyncPayload(db, userId);
    writeDb(db);
    return res.json({
      message: 'Image uploaded successfully.',
      ...buildProfilePayload(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not upload image.' });
  }
});

router.post('/gallery-delete', (req, res) => {
  try {
    const validation = validateGallerySlotInput(req.body, { allowEmpty: true });
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const { userId, slotIndex } = validation.value;
    const db = readDb();
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const galleryKeys = buildGalleryKeys(user);
    galleryKeys[slotIndex] = null;
    user.galleryKeys = galleryKeys;

    if (user.avatarKey && user.avatarKey === req.body.mediaKey) {
      const nextAvatarKey = galleryKeys.find((item) => item) || 'love';
      user.avatarKey = nextAvatarKey;
    }

    if (!galleryKeys.includes(user.avatarKey)) {
      user.avatarKey = galleryKeys.find((item) => item) || 'love';
    }

    const missionPayload = buildMissionSyncPayload(db, userId);
    writeDb(db);
    return res.json({
      message: 'Image deleted successfully.',
      ...buildProfilePayload(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not delete image.' });
  }
});

router.post('/voice-intro-upload', voiceUpload.single('audio'), (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = assertAuthorizedUser(db, req, targetUserId);
    if (authorization.error) {
      return res.status(401).json({ message: authorization.error });
    }

    const userId = authorization.userId;
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!req.file?.path) {
      return res.status(400).json({ message: 'Audio file is required.' });
    }

    const durationMs = Math.max(Number(req.body.durationMs) || 0, 0);
    const voiceIntroText = String(req.body.voiceIntroText || user.voiceIntroText || '').trim().slice(0, 140);

    removeLocalVoiceFile(user.voiceIntroUrl);
    user.voiceIntroUrl = `/uploads/profile-voice/${path.basename(req.file.path)}`;
    user.voiceIntroDurationSec = Math.min(Math.max(Math.round(durationMs / 1000), 1), 59);
    user.voiceIntroText = voiceIntroText || user.voiceIntroText || '';

    const missionPayload = buildMissionSyncPayload(db, userId);
    writeDb(db);
    return res.json({
      message: 'Voice intro uploaded successfully.',
      ...buildProfilePayload(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not upload voice intro.' });
  }
});

router.post('/voice-intro-delete', (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = assertAuthorizedUser(db, req, targetUserId);
    if (authorization.error) {
      return res.status(401).json({ message: authorization.error });
    }

    const userId = authorization.userId;
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    removeLocalVoiceFile(user.voiceIntroUrl);
    user.voiceIntroUrl = '';
    user.voiceIntroDurationSec = 18;

    const missionPayload = buildMissionSyncPayload(db, userId);
    writeDb(db);
    return res.json({
      message: 'Voice intro deleted successfully.',
      ...buildProfilePayload(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not delete voice intro.' });
  }
});

router.post('/gallery-set-profile', (req, res) => {
  try {
    const validation = validateGallerySlotInput(req.body, { allowEmpty: true });
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const { userId, slotIndex } = validation.value;
    const db = readDb();
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const galleryKeys = buildGalleryKeys(user);
    const selectedKey = galleryKeys[slotIndex];

    if (!selectedKey) {
      return res.status(400).json({ message: 'Upload an image first.' });
    }

    user.avatarKey = selectedKey;
    const missionPayload = buildMissionSyncPayload(db, userId);
    writeDb(db);

    return res.json({
      message: 'Profile photo updated successfully.',
      ...buildProfilePayload(db, userId),
      missionRewards: missionPayload.missionRewards,
      coins: missionPayload.coins,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update profile photo.' });
  }
});

router.get('/relationship/:viewerId/:profileId', (req, res) => {
  try {
    const viewerId = String(req.params.viewerId || '').trim();
    const profileId = String(req.params.profileId || '').trim();
    const db = readDb();
    const viewer = db.users.find((item) => item.id === viewerId);
    const user = db.users.find((item) => item.id === profileId);

    if (!viewer || !user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({
      relationship: buildRelationship(db, viewerId, profileId),
      stats: buildProfileStats(db, profileId),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load relationship.' });
  }
});

router.post('/follow-toggle', (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const targetUserId = String(req.body.targetUserId || '').trim();

    if (!userId || !targetUserId || userId === targetUserId) {
      return res.status(400).json({ message: 'Valid user and target are required.' });
    }

    const db = readDb();
    const user = db.users.find((item) => item.id === userId);
    const target = db.users.find((item) => item.id === targetUserId);

    if (!user || !target) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (isBlockedBetween(db, userId, targetUserId)) {
      return res.status(403).json({ message: 'Follow is unavailable for this profile.' });
    }

    db.follows = db.follows || [];
    const index = db.follows.findIndex((item) => item.userId === userId && item.targetUserId === targetUserId);

    let following;
    if (index >= 0) {
      db.follows.splice(index, 1);
      following = false;
    } else {
      const createdAt = new Date().toISOString();
      db.follows.push({ userId, targetUserId, createdAt });
      db.interactionNotifications = db.interactionNotifications || [];
      const notification = {
        id: crypto.randomUUID(),
        userId: targetUserId,
        actorUserId: userId,
        type: 'follow',
        text: 'started following you',
        createdAt,
        readAt: '',
      };
      db.interactionNotifications.unshift(notification);
      following = true;
      emitToUser(targetUserId, 'profile:interaction-notification', {
        notification: sanitizeInteractionNotification(notification, db, targetUserId),
      });
      notifyUserById(
        db,
        targetUserId,
        {
          title: `${buildDisplayName(user)} followed you`,
          body: 'Open the app to view their profile.',
          data: {
            tab: 'notifications',
            screen: 'notifications',
            notificationType: 'interaction',
            actorUserId: userId,
            userId: targetUserId,
          },
        },
        { settingKey: 'interactionAlerts' }
      ).catch(() => {});
    }

    writeDb(db);
    return res.json({
      message: following ? 'Followed successfully.' : 'Unfollowed successfully.',
      following,
      relationship: buildRelationship(db, userId, targetUserId),
      stats: buildProfileStats(db, targetUserId),
      viewerStats: buildOwnProfileStats(db, userId),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update follow state.' });
  }
});

router.get('/interaction-notifications/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 60);
    const context = loadUserContext(userId);
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    return res.json(buildInteractionNotificationsResponse(db, userId, limit));
  } catch (error) {
    return sendServerError(res, error, 'Could not load interaction notifications.');
  }
});

router.post('/interaction-notifications/:userId/read', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const notificationId = String(req.body.notificationId || '').trim();
    const context = loadUserContext(userId);
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    const now = new Date().toISOString();
    db.interactionNotifications = (db.interactionNotifications || []).map((item) => {
      if (String(item?.userId || '').trim() !== userId) {
        return item;
      }
      if (notificationId && String(item?.id || '').trim() !== notificationId) {
        return item;
      }
      if (String(item?.readAt || '').trim()) {
        return item;
      }
      return {
        ...item,
        readAt: now,
      };
    });

    writeDb(db);
    return res.json({
      message: 'Interaction notifications marked as read.',
      ...buildInteractionNotificationsResponse(db, userId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update interaction notifications.');
  }
});

router.post('/interaction-notifications/:userId/clear', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId);
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    // Remove all notifications for this user
    db.interactionNotifications = (db.interactionNotifications || []).filter(
      (item) => String(item?.userId || '').trim() !== userId
    );

    writeDb(db);

    return res.json({
      message: 'All interaction notifications cleared.',
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not clear interaction notifications.');
  }
});

router.get('/report-reasons', (_req, res) => {
  return res.json({ reasons: REPORT_REASONS });
});

router.get('/privacy/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    return res.json({ settings: getPrivacySettings(db, userId) });
  } catch (error) {
    return sendServerError(res, error, 'Could not load privacy settings.');
  }
});

router.get('/settings/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    const privacy = getPrivacySettings(db, userId);
    const notifications = getNotificationSettings(db, userId);
    const reports = (db.reports || [])
      .filter((item) => item.userId === userId)
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
    const blockedCount = (db.blocks || []).filter((item) => item.userId === userId).length;
    const unreadInteractions = (db.interactionNotifications || []).filter(
      (item) => String(item?.userId || '').trim() === userId && !String(item?.readAt || '').trim()
    ).length;

    return res.json({
      privacy,
      notifications,
      reports: reports.slice(0, 4),
      summary: {
        visibleFields: Object.values(privacy).filter(Boolean).length,
        alertsEnabled: Object.entries(notifications)
          .filter(([key]) => key !== 'userId' && key !== 'updatedAt')
          .filter(([, value]) => Boolean(value)).length,
        reportsCount: reports.length,
        blockedCount,
        unreadInteractions,
      },
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load settings.');
  }
});

router.get('/ui-state/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const db = readDb();
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const saved = (db.uiState || []).find((item) => String(item?.userId || '').trim() === userId) || {};

    return res.json({
      state: {
        userId,
        eventEntryDismissedAt: String(saved?.eventEntryDismissedAt || '').trim(),
        eventCreateTournamentCardDismissedAt: String(saved?.eventCreateTournamentCardDismissedAt || '').trim(),
        eventTournamentPromptDismissedAt: String(saved?.eventTournamentPromptDismissedAt || '').trim(),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load UI state.' });
  }
});

router.post('/privacy', (req, res) => {
  try {
    const userValidation = requireUserId(req.body.userId);
    if (userValidation.errorResponse) {
      return res.status(userValidation.errorResponse.status).json({ message: userValidation.errorResponse.message });
    }
    const { userId } = userValidation;

    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    const settings = upsertPrivacySettings(db, userId, {
      showAge: req.body.showAge !== undefined ? !!req.body.showAge : undefined,
      showCity: req.body.showCity !== undefined ? !!req.body.showCity : undefined,
      showStatus: req.body.showStatus !== undefined ? !!req.body.showStatus : undefined,
      showInterests: req.body.showInterests !== undefined ? !!req.body.showInterests : undefined,
    });

    writeDb(db);
    return res.json({ message: 'Privacy settings updated.', settings });
  } catch (error) {
    return sendServerError(res, error, 'Could not update privacy settings.');
  }
});

router.post('/settings/notifications', (req, res) => {
  try {
    const userValidation = requireUserId(req.body.userId);
    if (userValidation.errorResponse) {
      return res.status(userValidation.errorResponse.status).json({ message: userValidation.errorResponse.message });
    }
    const { userId } = userValidation;

    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    const settings = upsertNotificationSettings(db, userId, {
      chatMessages: req.body.chatMessages !== undefined ? !!req.body.chatMessages : undefined,
      interactionAlerts: req.body.interactionAlerts !== undefined ? !!req.body.interactionAlerts : undefined,
      momentReplies: req.body.momentReplies !== undefined ? !!req.body.momentReplies : undefined,
      tournamentAlerts: req.body.tournamentAlerts !== undefined ? !!req.body.tournamentAlerts : undefined,
      emailUpdates: req.body.emailUpdates !== undefined ? !!req.body.emailUpdates : undefined,
    });

    writeDb(db);
    return res.json({ message: 'Notification settings updated.', settings });
  } catch (error) {
    return sendServerError(res, error, 'Could not update notification settings.');
  }
});

router.post('/ui-state', (req, res) => {
  try {
    const userValidation = requireUserId(req.body.userId);
    if (userValidation.errorResponse) {
      return res.status(userValidation.errorResponse.status).json({ message: userValidation.errorResponse.message });
    }
    const { userId } = userValidation;

    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    db.uiState = db.uiState || [];
    const index = db.uiState.findIndex((item) => String(item?.userId || '').trim() === userId);
    const nextState = {
      userId,
      ...(index >= 0 ? db.uiState[index] : {}),
      eventEntryDismissedAt:
        req.body.eventEntryDismissedAt !== undefined
          ? String(req.body.eventEntryDismissedAt || '').trim()
          : String(index >= 0 ? db.uiState[index]?.eventEntryDismissedAt || '' : '').trim(),
      eventTournamentPromptDismissedAt:
        req.body.eventTournamentPromptDismissedAt !== undefined
          ? String(req.body.eventTournamentPromptDismissedAt || '').trim()
          : String(index >= 0 ? db.uiState[index]?.eventTournamentPromptDismissedAt || '' : '').trim(),
      eventCreateTournamentCardDismissedAt:
        req.body.eventCreateTournamentCardDismissedAt !== undefined
          ? String(req.body.eventCreateTournamentCardDismissedAt || '').trim()
          : String(index >= 0 ? db.uiState[index]?.eventCreateTournamentCardDismissedAt || '' : '').trim(),
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) {
      db.uiState[index] = nextState;
    } else {
      db.uiState.push(nextState);
    }

    writeDb(db);
    return res.json({ message: 'UI state updated.', state: nextState });
  } catch (error) {
    return sendServerError(res, error, 'Could not update UI state.');
  }
});

router.post('/block-toggle', (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const targetUserId = String(req.body.targetUserId || '').trim();

    if (!userId || !targetUserId || userId === targetUserId) {
      return res.status(400).json({ message: 'Valid user and target are required.' });
    }

    const db = readDb();
    const authorization = ensureAuthorizedParamUser(db, req, userId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }
    const user = db.users.find((item) => item.id === userId);
    const target = db.users.find((item) => item.id === targetUserId);

    if (!user || !target) {
      return res.status(404).json({ message: 'User not found.' });
    }

    db.blocks = db.blocks || [];
    const index = db.blocks.findIndex((item) => item.userId === userId && item.targetUserId === targetUserId);

    let blocked;
    if (index >= 0) {
      db.blocks.splice(index, 1);
      blocked = false;
    } else {
      db.blocks.push({ userId, targetUserId, createdAt: new Date().toISOString() });
      db.follows = (db.follows || []).filter(
        (item) =>
          !(
            (item.userId === userId && item.targetUserId === targetUserId) ||
            (item.userId === targetUserId && item.targetUserId === userId)
          )
      );
      db.hiMessages = (db.hiMessages || []).filter(
        (item) =>
          !(
            (item.fromUserId === userId && item.toUserId === targetUserId) ||
            (item.fromUserId === targetUserId && item.toUserId === userId)
          )
      );
      blocked = true;
    }

    writeDb(db);
    return res.json({
      message: blocked ? 'Profile blocked successfully.' : 'Profile unblocked successfully.',
      blocked,
      relationship: buildRelationship(db, userId, targetUserId),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update block state.' });
  }
});

router.get('/blocked/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    const blockedProfiles = (db.blocks || [])
      .filter((item) => item.userId === userId)
      .map((item) => db.users.find((userItem) => userItem.id === item.targetUserId))
      .filter(Boolean)
      .map((profile) =>
        sanitizePublicProfile(profile, {
          viewerId: userId,
          privacySettings: getPrivacySettings(db, profile.id),
          relationship: buildRelationship(db, userId, profile.id),
          stats: buildProfileStats(db, profile.id),
        })
      );

    return res.json({ users: blockedProfiles });
  } catch (error) {
    return sendServerError(res, error, 'Could not load blocked profiles.');
  }
});

router.post('/report', (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const targetUserId = String(req.body.targetUserId || '').trim();
    const reason = String(req.body.reason || '').trim();
    const details = String(req.body.details || '').trim();

    if (!userId || !targetUserId || userId === targetUserId) {
      return res.status(400).json({ message: 'Valid user and target are required.' });
    }

    const db = readDb();
    const authorization = ensureAuthorizedParamUser(db, req, userId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }
    const user = db.users.find((item) => item.id === userId);
    const target = db.users.find((item) => item.id === targetUserId);

    if (!user || !target) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const validation = validateReportInput(reason, details);
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    db.reports = db.reports || [];
    db.reports.push({
      id: crypto.randomUUID(),
      userId,
      targetUserId,
      ...validation.report,
      createdAt: new Date().toISOString(),
    });

    writeDb(db);
    return res.status(201).json({ message: 'Report submitted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not submit report.' });
  }
});

router.get('/reports/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db } = context;

    const reports = (db.reports || [])
      .filter((item) => item.userId === userId)
      .map((item) => {
        const target = db.users.find((userItem) => userItem.id === item.targetUserId);
        return {
          id: item.id,
          reason: item.reason,
          details: item.details,
          createdAt: item.createdAt,
          targetUserId: item.targetUserId,
          targetName: target ? target.name : 'Unknown',
        };
      });

    return res.json({ reports });
  } catch (error) {
    return sendServerError(res, error, 'Could not load reports.');
  }
});

router.post('/withdraw-request', (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = assertAuthorizedUser(db, req, targetUserId);
    if (authorization.error) {
      return res.status(401).json({ message: authorization.error });
    }

    const userId = authorization.userId;
    const user = db.users.find((item) => item.id === userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const packageId = String(req.body.packageId || '').trim();
    const paymentMethod = String(req.body.paymentMethod || '').trim().toLowerCase();
    const paymentNumber = String(req.body.paymentNumber || '').trim();
    const packageItem = WITHDRAW_PACKAGES.find((item) => item.packageId === packageId);

    if (!packageItem) {
      return res.status(400).json({ message: 'Invalid withdraw package.' });
    }

    if (!WITHDRAW_METHODS.has(paymentMethod)) {
      return res.status(400).json({ message: 'Select a valid payment method.' });
    }

    if (!paymentNumber || paymentNumber.length < 10) {
      return res.status(400).json({ message: 'Enter a valid payment number.' });
    }

    if ((typeof user.coins === 'number' ? user.coins : 0) < packageItem.gold) {
      return res.status(400).json({ message: 'Not enough gold for this withdraw package.' });
    }

    db.withdrawRequests = db.withdrawRequests || [];
    user.coins = (typeof user.coins === 'number' ? user.coins : 0) - packageItem.gold;
    db.withdrawRequests.push({
      id: crypto.randomUUID(),
      userId,
      packageId: packageItem.packageId,
      gold: packageItem.gold,
      amount: packageItem.amount,
      paymentMethod,
      paymentNumber,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    writeDb(db);

    return res.status(201).json({
      message: `Withdraw request for Tk ${packageItem.amount} submitted successfully.`,
      coins: user.coins,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not submit withdraw request.' });
  }
});

router.post('/select-gender', (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const gender = String(req.body.gender || '').trim().toLowerCase();

    if (!userId) {
      return res.status(400).json({ message: 'User id is required.' });
    }

    if (!['man', 'woman'].includes(gender)) {
      return res.status(400).json({ message: 'Gender must be man or woman.' });
    }

    const context = loadUserContext(userId, { req, authorize: true });
    if (context.errorResponse) {
      return res.status(context.errorResponse.status).json({ message: context.errorResponse.message });
    }
    const { db, user } = context;

    user.gender = gender;
    writeDb(db);

    return res.json({
      message: 'Gender saved successfully.',
      user: sanitizeUser(user),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not save gender.');
  }
});

function normalizeId(value) {
  return String(value || '').trim();
}

function matchesUserId(value, normalizedId) {
  if (!normalizedId) {
    return false;
  }

  return normalizeId(value) === normalizedId;
}

function filterRecordsByFields(records, normalizedId, fields = []) {
  if (!Array.isArray(records)) {
    return [];
  }

  if (!normalizedId) {
    return records;
  }

  return records.filter((record) => !fields.some((field) => matchesUserId(record?.[field], normalizedId)));
}

function sanitizeMomentEntryForDeletion(moment, normalizedId) {
  if (!moment || !normalizedId) {
    return moment;
  }

  const sanitizedComments = (moment.comments || [])
    .map((comment) => ({
      ...comment,
      replies: (comment.replies || []).filter((reply) => !matchesUserId(reply?.userId, normalizedId)),
    }))
    .filter((comment) => !matchesUserId(comment.userId, normalizedId));

  return {
    ...moment,
    reactions: filterRecordsByFields(moment.reactions, normalizedId, ['userId']),
    shares: filterRecordsByFields(moment.shares, normalizedId, ['userId']),
    reportEntries: filterRecordsByFields(moment.reportEntries, normalizedId, ['userId']),
    savedByUserIds: (moment.savedByUserIds || []).filter((entry) => !matchesUserId(entry, normalizedId)),
    comments: sanitizedComments,
  };
}

function removeUserReferences(db, rawUserId) {
  const userId = normalizeId(rawUserId);
  if (!userId) {
    return;
  }

  db.sessions = filterRecordsByFields(db.sessions, userId, ['userId']);
  db.privacySettings = filterRecordsByFields(db.privacySettings, userId, ['userId']);
  db.follows = filterRecordsByFields(db.follows, userId, ['userId', 'targetUserId']);
  db.blocks = filterRecordsByFields(db.blocks, userId, ['userId', 'targetUserId']);
  db.reports = filterRecordsByFields(db.reports, userId, ['userId', 'targetUserId']);
  db.hiMessages = filterRecordsByFields(db.hiMessages, userId, ['fromUserId', 'toUserId']);
  db.chatMessages = filterRecordsByFields(db.chatMessages, userId, ['fromUserId', 'toUserId']);
  db.chatDrafts = filterRecordsByFields(db.chatDrafts, userId, ['userId', 'otherUserId']);
  db.giftTransactions = filterRecordsByFields(db.giftTransactions, userId, ['fromUserId', 'toUserId']);
  db.callLogs = filterRecordsByFields(db.callLogs, userId, ['userId', 'fromUserId', 'toUserId']);
  db.withdrawRequests = filterRecordsByFields(db.withdrawRequests, userId, ['userId']);
  db.supportThreads = filterRecordsByFields(db.supportThreads, userId, ['userId']);
  db.tournamentRoomAssignments = filterRecordsByFields(db.tournamentRoomAssignments, userId, ['userId']);
  db.momentNotifications = filterRecordsByFields(db.momentNotifications, userId, ['userId', 'actorUserId']);
  db.moments = (db.moments || [])
    .filter((moment) => !matchesUserId(moment.userId, userId))
    .map((moment) => sanitizeMomentEntryForDeletion(moment, userId));
}

router.post('/delete', (req, res) => {
  try {
    const userValidation = requireUserId(req.body.userId);
    if (userValidation.errorResponse) {
      return res.status(userValidation.errorResponse.status).json({ message: userValidation.errorResponse.message });
    }
    const { userId } = userValidation;

    const db = readDb();
    const authorization = ensureAuthorizedParamUser(db, req, userId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }
    const userIndex = (db.users || []).findIndex((item) => String(item.id || '').trim() === userId);
    if (userIndex === -1) {
      return res.status(404).json({ message: 'User not found.' });
    }

    db.users.splice(userIndex, 1);
    removeUserReferences(db, userId);
    writeDb(db);

    return res.status(200).json({ message: 'Account deleted successfully.' });
  } catch (error) {
    return sendServerError(res, error, 'Could not delete account.');
  }
});

module.exports = router;
module.exports.removeUserReferences = removeUserReferences;
