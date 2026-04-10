const crypto = require('crypto');
const { DEFAULT_CITIES, DEFAULT_INTERESTS } = require('../config/constants');
const { normalizeEmail } = require('./common');

const DEFAULT_PRIVACY_SETTINGS = {
  showAge: true,
  showCity: true,
  showStatus: true,
  showInterests: true,
};
const DEFAULT_NOTIFICATION_SETTINGS = {
  chatMessages: true,
  interactionAlerts: true,
  momentReplies: true,
  tournamentAlerts: true,
  emailUpdates: false,
};
const MOMENTS_ADMIN_EMAILS = new Set(
  String(process.env.MOMENTS_ADMIN_EMAILS || process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => normalizeEmail(item))
    .filter(Boolean)
);

function buildDefaultGallery(gender) {
  const primary = gender === 'woman' ? 'women' : 'men';
  const secondary = gender === 'woman' ? 'men' : 'women';
  return [primary, secondary, primary, secondary, primary, secondary];
}

function titleCaseLocalPart(email) {
  const localPart = normalizeEmail(email).split('@')[0] || 'Profile';
  return (
    localPart
      .split(/[._\d-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Profile'
  );
}

function buildAppProfileId(user, usedIds = new Set()) {
  const existing = String(user.appProfileId || '').trim();
  if (existing && !usedIds.has(existing)) {
    usedIds.add(existing);
    return existing;
  }

  const baseSeed = `${user.id || ''}|${user.email || ''}|${user.createdAt || ''}`;
  let counter = 0;

  while (counter < 50) {
    const hash = crypto.createHash('sha256').update(`${baseSeed}|${counter}`).digest('hex');
    const numeric = parseInt(hash.slice(0, 12), 16);
    const candidate = String((numeric % 90000000) + 10000000);
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
    counter += 1;
  }

  const fallback = String(Date.now()).slice(-8);
  usedIds.add(fallback);
  return fallback;
}

function ensureUserProfileData(user, index = 0, usedIds = new Set()) {
  const gender = user.gender || (index % 2 === 0 ? 'man' : 'woman');

  return {
    ...user,
    appProfileId: buildAppProfileId(user, usedIds),
    gamePlayerId: typeof user.gamePlayerId === 'string' ? user.gamePlayerId.trim().slice(0, 40) : '',
    gender,
    name: user.name || titleCaseLocalPart(user.email),
    age: user.age || 22 + (index % 7),
    city: user.city || DEFAULT_CITIES[index % DEFAULT_CITIES.length],
    status:
      user.status ||
      (gender === 'woman'
        ? 'Open to meaningful connection and calm energy.'
        : 'Looking for something real, steady, and honest.'),
    about:
      user.about ||
      `${titleCaseLocalPart(user.email)} prefers clear communication, soft energy, and genuine connection over noise.`,
    interests:
      Array.isArray(user.interests) && user.interests.length
        ? user.interests
        : DEFAULT_INTERESTS[gender].slice(0, 4),
    avatarKey: user.avatarKey || (gender === 'woman' ? 'women' : 'men'),
    galleryKeys:
      Array.isArray(user.galleryKeys) && user.galleryKeys.length >= 6
        ? user.galleryKeys.slice(0, 6)
        : buildDefaultGallery(gender),
    verified: user.verified !== false,
    voiceIntroText:
      user.voiceIntroText ||
      (gender === 'woman'
        ? 'A soft hello, a calm laugh, and a little warmth for the right conversation.'
        : 'A calm voice, honest energy, and a little invitation to start something real.'),
    voiceIntroDurationSec:
      Number.isFinite(user.voiceIntroDurationSec) && user.voiceIntroDurationSec > 0
        ? Math.min(Math.round(user.voiceIntroDurationSec), 59)
        : 18,
    voiceIntroUrl: typeof user.voiceIntroUrl === 'string' ? user.voiceIntroUrl : '',
    lastActiveAt: user.lastActiveAt || user.createdAt,
  };
}

function isMomentsAdminUser(user = {}) {
  const role = String(user?.role || '').trim().toLowerCase();
  const permissions = Array.isArray(user?.permissions)
    ? user.permissions.map((item) => String(item || '').trim().toLowerCase())
    : [];
  const normalizedEmail = normalizeEmail(user?.email);

  return (
    user?.isMomentsAdmin === true ||
    user?.isAdmin === true ||
    role === 'admin' ||
    role === 'superadmin' ||
    role === 'moderator' ||
    permissions.includes('moments:review') ||
    permissions.includes('admin') ||
    MOMENTS_ADMIN_EMAILS.has(normalizedEmail)
  );
}

function sanitizeUser(user) {
  return {
    id: user.id,
    appProfileId: user.appProfileId,
    gamePlayerId: user.gamePlayerId || '',
    email: user.email,
    gender: user.gender || null,
    name: user.name,
    coins: typeof user.coins === 'number' ? user.coins : 0,
    isMomentsAdmin: isMomentsAdminUser(user),
    createdAt: user.createdAt,
  };
}

function sanitizeOwnProfile(user, privacySettings = DEFAULT_PRIVACY_SETTINGS) {
  return {
    id: user.id,
    appProfileId: user.appProfileId,
    gamePlayerId: user.gamePlayerId || '',
    email: user.email,
    gender: user.gender || null,
    name: user.name,
    age: user.age,
    city: user.city,
    status: user.status,
    about: user.about,
    interests: user.interests || [],
    avatarKey: user.avatarKey,
    galleryKeys: user.galleryKeys || buildDefaultGallery(user.gender),
    verified: user.verified !== false,
    lastActiveAt: user.lastActiveAt || user.createdAt,
    voiceIntroText: user.voiceIntroText || '',
    voiceIntroDurationSec: user.voiceIntroDurationSec || 18,
    voiceIntroUrl: user.voiceIntroUrl || '',
    coins: typeof user.coins === 'number' ? user.coins : 0,
    isMomentsAdmin: isMomentsAdminUser(user),
    createdAt: user.createdAt,
    isOwnProfile: true,
    privacySettings,
  };
}

function buildOwnProfileStats(db, userId) {
  const followers = (db.follows || []).filter((item) => item.targetUserId === userId);
  const following = (db.follows || []).filter((item) => item.userId === userId);
  const followerIds = new Set(followers.map((item) => item.userId));
  const friendCount = following.filter((item) => followerIds.has(item.targetUserId)).length;

  return {
    followCount: followers.length,
    friendCount,
    followingCount: following.length,
  };
}

function sanitizeConnectionUser(user, index = 0) {
  const profile = ensureUserProfileData(user, index);

  return {
    id: profile.id,
    name: profile.name,
    city: profile.city,
    status: profile.status,
    avatarKey: profile.avatarKey,
  };
}

function buildOwnProfileConnectionList(db, userId, type) {
  const followers = (db.follows || []).filter((item) => item.targetUserId === userId);
  const following = (db.follows || []).filter((item) => item.userId === userId);
  const followerIds = new Set(followers.map((item) => item.userId));

  let targetIds = [];

  if (type === 'follow') {
    targetIds = followers.map((item) => item.userId);
  } else if (type === 'friend') {
    targetIds = following.filter((item) => followerIds.has(item.targetUserId)).map((item) => item.targetUserId);
  } else if (type === 'following') {
    targetIds = following.map((item) => item.targetUserId);
  }

  return targetIds
    .map((targetId, index) => {
      const user = db.users.find((item) => item.id === targetId);
      return user ? sanitizeConnectionUser(user, index) : null;
    })
    .filter(Boolean);
}

function sanitizePublicProfile(user, options = {}) {
  const {
    viewerId = '',
    privacySettings = DEFAULT_PRIVACY_SETTINGS,
    relationship = {},
    stats = {},
    isOnline = false,
  } = options;

  const profile = ensureUserProfileData(user);

  return {
    id: profile.id,
    appProfileId: profile.appProfileId,
    gamePlayerId: profile.gamePlayerId || '',
    gender: profile.gender || null,
    name: profile.name,
    age: privacySettings.showAge ? profile.age : null,
    city: privacySettings.showCity ? profile.city : null,
    status: privacySettings.showStatus ? profile.status : null,
    about: profile.about,
    interests: privacySettings.showInterests ? profile.interests || [] : [],
    avatarKey: profile.avatarKey,
    galleryKeys: profile.galleryKeys || buildDefaultGallery(profile.gender),
    createdAt: profile.createdAt,
    verified: !!profile.verified,
    isOnline: !!isOnline,
    lastActiveAt: profile.lastActiveAt || profile.createdAt,
    voiceIntroText: profile.voiceIntroText || '',
    voiceIntroDurationSec: profile.voiceIntroDurationSec || 18,
    voiceIntroUrl: profile.voiceIntroUrl || '',
    isOwnProfile: viewerId ? viewerId === profile.id : false,
    relationship: {
      isFollowing: !!relationship.isFollowing,
      hasSentHi: !!relationship.hasSentHi,
      isBlocked: !!relationship.isBlocked,
      blockedByViewer: !!relationship.blockedByViewer,
      blockedByProfileOwner: !!relationship.blockedByProfileOwner,
    },
    stats: {
      followersCount: stats.followersCount || 0,
      followingCount: stats.followingCount || 0,
      receivedHiCount: stats.receivedHiCount || 0,
      reportsCount: stats.reportsCount || 0,
    },
  };
}

function getPrivacySettings(db, userId) {
  const saved = (db.privacySettings || []).find((item) => item.userId === userId);
  return {
    ...DEFAULT_PRIVACY_SETTINGS,
    ...(saved || {}),
  };
}

function getNotificationSettings(db, userId) {
  const saved = (db.notificationSettings || []).find((item) => item.userId === userId);
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(saved || {}),
    userId,
  };
}

function upsertPrivacySettings(db, userId, changes) {
  db.privacySettings = db.privacySettings || [];
  const index = db.privacySettings.findIndex((item) => item.userId === userId);
  const filteredChanges = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined)
  );
  const nextValue = {
    userId,
    ...DEFAULT_PRIVACY_SETTINGS,
    ...(index >= 0 ? db.privacySettings[index] : {}),
    ...filteredChanges,
  };

  if (index >= 0) {
    db.privacySettings[index] = nextValue;
  } else {
    db.privacySettings.push(nextValue);
  }

  return nextValue;
}

function upsertNotificationSettings(db, userId, changes) {
  db.notificationSettings = db.notificationSettings || [];
  const index = db.notificationSettings.findIndex((item) => item.userId === userId);
  const filteredChanges = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined)
  );
  const nextValue = {
    userId,
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(index >= 0 ? db.notificationSettings[index] : {}),
    ...filteredChanges,
    updatedAt: new Date().toISOString(),
  };

  if (index >= 0) {
    db.notificationSettings[index] = nextValue;
  } else {
    db.notificationSettings.push(nextValue);
  }

  return nextValue;
}

function isBlockedBetween(db, firstUserId, secondUserId) {
  return (db.blocks || []).some(
    (item) =>
      (item.userId === firstUserId && item.targetUserId === secondUserId) ||
      (item.userId === secondUserId && item.targetUserId === firstUserId)
  );
}

function buildRelationship(db, viewerId, profileId) {
  const blockedByViewer = (db.blocks || []).some(
    (item) => item.userId === viewerId && item.targetUserId === profileId
  );
  const blockedByProfileOwner = (db.blocks || []).some(
    (item) => item.userId === profileId && item.targetUserId === viewerId
  );

  return {
    isFollowing: (db.follows || []).some(
      (item) => item.userId === viewerId && item.targetUserId === profileId
    ),
    hasSentHi: (db.hiMessages || []).some(
      (item) => item.fromUserId === viewerId && item.toUserId === profileId
    ),
    isBlocked: blockedByViewer || blockedByProfileOwner,
    blockedByViewer,
    blockedByProfileOwner,
  };
}

function buildProfileStats(db, userId) {
  return {
    followersCount: (db.follows || []).filter((item) => item.targetUserId === userId).length,
    followingCount: (db.follows || []).filter((item) => item.userId === userId).length,
    receivedHiCount: (db.hiMessages || []).filter((item) => item.toUserId === userId).length,
    reportsCount: (db.reports || []).filter((item) => item.targetUserId === userId).length,
  };
}

module.exports = {
  DEFAULT_PRIVACY_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  buildDefaultGallery,
  titleCaseLocalPart,
  buildAppProfileId,
  ensureUserProfileData,
  isMomentsAdminUser,
  sanitizeUser,
  sanitizeOwnProfile,
  sanitizePublicProfile,
  getPrivacySettings,
  getNotificationSettings,
  upsertPrivacySettings,
  upsertNotificationSettings,
  isBlockedBetween,
  buildRelationship,
  buildProfileStats,
  buildOwnProfileStats,
  buildOwnProfileConnectionList,
};
