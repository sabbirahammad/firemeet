const { ALLOWED_AVATAR_KEYS, DEFAULT_CITIES, DEFAULT_INTERESTS } = require('../config/constants');
const { titleCaseLocalPart } = require('./profile');

const MISSION_DEFINITIONS = [
  {
    key: 'completeProfile',
    serial: '01',
    text: 'Complete your profile bio',
    coins: 10,
    focusSection: 'profileInfo',
  },
  {
    key: 'uploadPhotos',
    serial: '02',
    text: 'Upload 3 clear profile photos',
    coins: 5,
  },
  {
    key: 'startConversations',
    serial: '03',
    text: 'Start 2 new conversations',
    coins: 10,
  },
  {
    key: 'addVoiceIntro',
    serial: '04',
    text: 'Add a voice intro',
    coins: 5,
    focusSection: 'voiceIntro',
  },
];

const DAILY_DEFINITIONS = [
  {
    key: 'dailyLogin',
    serial: '01',
    text: 'Daily login check-in',
    coins: 2,
  },
  {
    key: 'sendHiMessages',
    serial: '02',
    text: 'Send 5 Hi messages today',
    coins: 2,
  },
  {
    key: 'sendGiftFriend',
    serial: '03',
    text: 'Send any gift to your friend',
    coins: 2,
  },
];

const DEFAULT_PROGRESS = {
  missions: {
    completeProfile: 0,
    uploadPhotos: 0,
    startConversations: 0,
    addVoiceIntro: 0,
  },
  daily: {
    dailyLogin: 0,
    sendHiMessages: 0,
    sendGiftFriend: 0,
  },
};

function getDhakaDateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const valueMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${valueMap.year}-${valueMap.month}-${valueMap.day}`;
}

function clampProgress(value) {
  if (typeof value !== 'number') {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeTextList(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean)
    .join('|');
}

function ensureMissionState(user = {}) {
  let changed = false;

  if (!user.missionsProgress || typeof user.missionsProgress !== 'object') {
    user.missionsProgress = {};
    changed = true;
  }
  if (!user.missionsProgress.missions || typeof user.missionsProgress.missions !== 'object') {
    user.missionsProgress.missions = {};
    changed = true;
  }
  if (!user.missionsProgress.daily || typeof user.missionsProgress.daily !== 'object') {
    user.missionsProgress.daily = {};
    changed = true;
  }

  if (!user.missionRewardClaims || typeof user.missionRewardClaims !== 'object') {
    user.missionRewardClaims = {};
    changed = true;
  }
  if (!user.missionRewardClaims.missions || typeof user.missionRewardClaims.missions !== 'object') {
    user.missionRewardClaims.missions = {};
    changed = true;
  }
  if (!user.missionRewardClaims.daily || typeof user.missionRewardClaims.daily !== 'object') {
    user.missionRewardClaims.daily = {};
    changed = true;
  }

  return changed;
}

function ensureDailyMissionActivity(user = {}, currentDateKey = getDhakaDateKey()) {
  let changed = false;

  if (!user.dailyMissionActivity || typeof user.dailyMissionActivity !== 'object') {
    user.dailyMissionActivity = {};
    changed = true;
  }

  const storedDateKey = normalizeText(user.dailyMissionActivity.date);
  if (storedDateKey !== currentDateKey) {
    user.dailyMissionActivity = {
      date: currentDateKey,
      loggedIn: false,
      sentHiCount: 0,
      sentGiftCount: 0,
    };
    if (!user.missionRewardClaims || typeof user.missionRewardClaims !== 'object') {
      user.missionRewardClaims = {};
    }
    user.missionRewardClaims.daily = {};
    changed = true;
  }

  if (typeof user.dailyMissionActivity.loggedIn !== 'boolean') {
    user.dailyMissionActivity.loggedIn = false;
    changed = true;
  }
  if (!Number.isFinite(user.dailyMissionActivity.sentHiCount) || user.dailyMissionActivity.sentHiCount < 0) {
    user.dailyMissionActivity.sentHiCount = 0;
    changed = true;
  }
  if (!Number.isFinite(user.dailyMissionActivity.sentGiftCount) || user.dailyMissionActivity.sentGiftCount < 0) {
    user.dailyMissionActivity.sentGiftCount = 0;
    changed = true;
  }

  return changed;
}

function buildGeneratedProfileDefaults(user = {}, index = 0) {
  const gender = user.gender || (index % 2 === 0 ? 'man' : 'woman');
  const localName = titleCaseLocalPart(user.email);

  return {
    name: localName,
    age: 22 + (index % 7),
    city: DEFAULT_CITIES[index % DEFAULT_CITIES.length],
    status:
      gender === 'woman'
        ? 'Open to meaningful connection and calm energy.'
        : 'Looking for something real, steady, and honest.',
    about: `${localName} prefers clear communication, soft energy, and genuine connection over noise.`,
    interests: DEFAULT_INTERESTS[gender].slice(0, 4),
  };
}

function hasCustomProfileValues(user = {}, index = 0) {
  const defaults = buildGeneratedProfileDefaults(user, index);

  return (
    normalizeText(user.name) !== normalizeText(defaults.name) ||
    Number(user.age) !== Number(defaults.age) ||
    normalizeText(user.city) !== normalizeText(defaults.city) ||
    normalizeText(user.status) !== normalizeText(defaults.status) ||
    normalizeText(user.about) !== normalizeText(defaults.about) ||
    normalizeTextList(user.interests) !== normalizeTextList(defaults.interests)
  );
}

function buildCompleteProfileProgress(user = {}, index = 0) {
  if (user.profileEditedAt) {
    return 100;
  }

  const defaults = buildGeneratedProfileDefaults(user, index);
  let progress = 0;

  if (normalizeText(user.about) && normalizeText(user.about) !== normalizeText(defaults.about)) {
    progress += 45;
  }

  if (normalizeText(user.status) && normalizeText(user.status) !== normalizeText(defaults.status)) {
    progress += 25;
  }

  if (normalizeTextList(user.interests) && normalizeTextList(user.interests) !== normalizeTextList(defaults.interests)) {
    progress += 20;
  }

  if (
    normalizeText(user.name) !== normalizeText(defaults.name) ||
    Number(user.age) !== Number(defaults.age) ||
    normalizeText(user.city) !== normalizeText(defaults.city)
  ) {
    progress += 10;
  }

  return clampProgress(progress);
}

function countUploadedProfilePhotos(user = {}) {
  const allowedKeys = new Set(ALLOWED_AVATAR_KEYS.map((item) => normalizeText(item)));
  return (Array.isArray(user.galleryKeys) ? user.galleryKeys : []).slice(0, 6).filter((item) => {
    const value = normalizeText(item);
    return Boolean(value) && !allowedKeys.has(value);
  }).length;
}

function buildUploadPhotosProgress(user = {}) {
  return clampProgress((countUploadedProfilePhotos(user) / 3) * 100);
}

function countStartedConversations(db = {}, userId = '') {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return 0;
  }

  const conversationPeers = new Set();

  (db.hiMessages || []).forEach((item) => {
    if (normalizeText(item.fromUserId) === normalizedUserId && normalizeText(item.toUserId)) {
      conversationPeers.add(normalizeText(item.toUserId));
    }
  });

  (db.chatMessages || []).forEach((item) => {
    if (normalizeText(item.fromUserId) === normalizedUserId && normalizeText(item.toUserId)) {
      conversationPeers.add(normalizeText(item.toUserId));
    }
  });

  return conversationPeers.size;
}

function buildStartConversationsProgress(db = {}, userId = '') {
  return clampProgress((countStartedConversations(db, userId) / 2) * 100);
}

function buildVoiceIntroProgress(user = {}) {
  const voiceIntroUrl = normalizeText(user.voiceIntroUrl);
  if (!voiceIntroUrl) {
    return 0;
  }

  const durationSec = Math.max(Number(user.voiceIntroDurationSec) || 0, 0);
  return clampProgress((durationSec / 10) * 100);
}

function buildDailyProgress(definition = {}, user = {}) {
  const activity = user.dailyMissionActivity || {};

  if (definition.key === 'dailyLogin') {
    return activity.loggedIn ? 100 : 0;
  }

  if (definition.key === 'sendHiMessages') {
    return clampProgress(((Number(activity.sentHiCount) || 0) / 5) * 100);
  }

  if (definition.key === 'sendGiftFriend') {
    return Number(activity.sentGiftCount) > 0 ? 100 : 0;
  }

  return 0;
}

function markDailyLogin(user = {}) {
  ensureMissionState(user);
  ensureDailyMissionActivity(user);
  user.dailyMissionActivity.loggedIn = true;
}

function recordDailyHiMessage(user = {}) {
  ensureMissionState(user);
  ensureDailyMissionActivity(user);
  user.dailyMissionActivity.sentHiCount = (Number(user.dailyMissionActivity.sentHiCount) || 0) + 1;
}

function recordDailyGiftSent(user = {}) {
  ensureMissionState(user);
  ensureDailyMissionActivity(user);
  user.dailyMissionActivity.sentGiftCount = (Number(user.dailyMissionActivity.sentGiftCount) || 0) + 1;
}

function computeMissionProgress(definition = {}, db = {}, user = {}, userIndex = 0) {
  if (definition.key === 'completeProfile') {
    return buildCompleteProfileProgress(user, userIndex);
  }

  if (definition.key === 'uploadPhotos') {
    return buildUploadPhotosProgress(user);
  }

  if (definition.key === 'startConversations') {
    return buildStartConversationsProgress(db, user.id);
  }

  if (definition.key === 'addVoiceIntro') {
    return buildVoiceIntroProgress(user);
  }

  return 0;
}

function syncMissionSections(db = {}, userId = '') {
  const normalizedUserId = normalizeText(userId);
  const userIndex = (db.users || []).findIndex((item) => item.id === normalizedUserId);

  if (userIndex < 0) {
    return {
      sections: [],
      changed: false,
      user: null,
    };
  }

  const user = db.users[userIndex];
  let changed = ensureMissionState(user);
  changed = ensureDailyMissionActivity(user) || changed;
  const missionProgressState = user.missionsProgress.missions;
  const dailyProgressState = user.missionsProgress.daily;
  const missionClaims = user.missionRewardClaims.missions;
  const dailyClaims = user.missionRewardClaims.daily;
  const newlyClaimedMissions = [];

  const missionTasks = MISSION_DEFINITIONS.map((definition) => {
    const alreadyClaimed = Boolean(missionClaims[definition.key]);
    let progress = alreadyClaimed ? 100 : computeMissionProgress(definition, db, user, userIndex);
    let claimedEntry = missionClaims[definition.key] || null;

    if (!alreadyClaimed && progress >= 100) {
      claimedEntry = {
        claimedAt: new Date().toISOString(),
        coins: definition.coins || 0,
      };
      missionClaims[definition.key] = claimedEntry;
      user.coins = (typeof user.coins === 'number' ? user.coins : 0) + (definition.coins || 0);
      progress = 100;
      changed = true;
      newlyClaimedMissions.push({
        key: definition.key,
        serial: definition.serial,
        text: definition.text,
        coins: definition.coins || 0,
        focusSection: definition.focusSection || '',
        claimedAt: claimedEntry.claimedAt,
      });
    }

    if (missionProgressState[definition.key] !== progress) {
      missionProgressState[definition.key] = progress;
      changed = true;
    }

    return {
      ...definition,
      progress,
      completed: progress >= 100,
      claimed: Boolean(claimedEntry),
      claimedAt: claimedEntry?.claimedAt || '',
    };
  });

  const dailyTasks = DAILY_DEFINITIONS.map((definition) => {
    const alreadyClaimed = Boolean(dailyClaims[definition.key]);
    let progress = buildDailyProgress(definition, user);
    let claimedEntry = dailyClaims[definition.key] || null;

    if (!alreadyClaimed && progress >= 100) {
      claimedEntry = {
        claimedAt: new Date().toISOString(),
        coins: definition.coins || 0,
      };
      dailyClaims[definition.key] = claimedEntry;
      user.coins = (typeof user.coins === 'number' ? user.coins : 0) + (definition.coins || 0);
      progress = 100;
      changed = true;
      newlyClaimedMissions.push({
        key: definition.key,
        serial: definition.serial,
        text: definition.text,
        coins: definition.coins || 0,
        focusSection: definition.focusSection || '',
        claimedAt: claimedEntry.claimedAt,
      });
    }

    if (dailyProgressState[definition.key] !== progress) {
      dailyProgressState[definition.key] = progress;
      changed = true;
    }

    return {
      ...definition,
      progress,
      completed: progress >= 100,
      claimed: Boolean(claimedEntry),
      claimedAt: claimedEntry?.claimedAt || '',
    };
  });

  return {
    sections: [
      {
        key: 'missions',
        title: 'Missions',
        hint: 'Profile growth rewards',
        tasks: missionTasks,
      },
      {
        key: 'daily',
        title: 'Daily tasks',
        hint: 'Quick rewards every day',
        tasks: dailyTasks,
      },
    ],
    changed,
    user,
    newlyClaimedMissions,
  };
}

function buildMissionSections(user = {}) {
  ensureMissionState(user);
  ensureDailyMissionActivity(user);

  const missionTasks = MISSION_DEFINITIONS.map((definition) => {
    const progress = clampProgress(user.missionsProgress.missions?.[definition.key] ?? DEFAULT_PROGRESS.missions[definition.key]);
    return {
      ...definition,
      progress,
      completed: progress >= 100,
      claimed: Boolean(user.missionRewardClaims.missions?.[definition.key]),
      claimedAt: user.missionRewardClaims.missions?.[definition.key]?.claimedAt || '',
    };
  });

  const dailyTasks = DAILY_DEFINITIONS.map((definition) => {
    const progress = buildDailyProgress(definition, user);
    return {
      ...definition,
      progress,
      completed: progress >= 100,
      claimed: Boolean(user.missionRewardClaims.daily?.[definition.key]),
      claimedAt: user.missionRewardClaims.daily?.[definition.key]?.claimedAt || '',
    };
  });

  return [
    {
      key: 'missions',
      title: 'Missions',
      hint: 'Profile growth rewards',
      tasks: missionTasks,
    },
    {
      key: 'daily',
      title: 'Daily tasks',
      hint: 'Quick rewards every day',
      tasks: dailyTasks,
    },
  ];
}

module.exports = {
  buildMissionSections,
  countStartedConversations,
  countUploadedProfilePhotos,
  hasCustomProfileValues,
  markDailyLogin,
  recordDailyGiftSent,
  recordDailyHiMessage,
  syncMissionSections,
};
