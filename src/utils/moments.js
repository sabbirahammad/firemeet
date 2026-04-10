const crypto = require('crypto');
const { ensureUserProfileData, isBlockedBetween } = require('./profile');

const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥'];
const HIGHLIGHT_TINTS = [
  ['#FF85C5', '#FFB86D'],
  ['#365CFF', '#8B6CFF'],
  ['#0FBF9F', '#5BE7C4'],
  ['#FF7A59', '#FF4D8D'],
];
const FEED_SCOPES = new Set(['feed', 'saved', 'mine', 'reported']);
const MOMENT_AUDIENCES = new Set(['public', 'followers', 'friends', 'team']);

const SEED_TEMPLATES = [
  {
    media: { type: 'image', imageKey: 'women', aspectRatio: 1.14 },
    caption: 'Soft light, calm coffee, and one good conversation can fix an entire week. #slowday #moments',
    location: 'Banani, Dhaka',
    tags: ['#slowday', '#moments'],
    minutesAgo: 2,
  },
  {
    media: {
      type: 'video',
      uri: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
      posterKey: 'love',
      durationSec: 28,
      aspectRatio: 0.75,
    },
    caption: 'Thirty seconds of city motion and neon rain. Double tap if this mood feels familiar. #citypulse #nightdrive',
    location: 'Gulshan, Dhaka',
    tags: ['#citypulse', '#nightdrive'],
    minutesAgo: 8,
  },
  {
    media: {
      type: 'text',
      accent: ['#4A7BFF', '#8D5CFF'],
      emphasis: 'Status drop',
    },
    caption: 'No pressure, no performance. Just honest people, clear words, and a little bit of warmth.',
    location: '',
    tags: ['#status', '#goodenergy'],
    minutesAgo: 17,
  },
  {
    media: { type: 'image', imageKey: 'men', aspectRatio: 0.88 },
    caption: 'Sunday reset: playlists, sunlight, and finishing the plans I kept delaying. #resetmode #weekend',
    location: 'Dhanmondi Lake',
    tags: ['#resetmode', '#weekend'],
    minutesAgo: 26,
  },
  {
    media: {
      type: 'video',
      uri: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      posterKey: 'women',
      durationSec: 30,
      aspectRatio: 0.8,
    },
    caption: 'A tiny travel clip, a loud playlist, and zero regrets. #microtrip #freemood',
    location: 'Coxs Bazar',
    tags: ['#microtrip', '#freemood'],
    minutesAgo: 41,
  },
  {
    media: { type: 'image', imageKey: 'love', aspectRatio: 1 },
    caption: 'Moments feel better when they are not over-edited. Just leave a little life in the frame. #rawpost #simple',
    location: 'Mirpur DOHS',
    tags: ['#rawpost', '#simple'],
    minutesAgo: 59,
  },
];

function formatRelativeTime(value) {
  const createdAt = new Date(value).getTime();
  if (!Number.isFinite(createdAt)) {
    return 'Just now';
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (diffSeconds < 45) {
    return 'Just now';
  }
  if (diffSeconds < 3600) {
    return `${Math.max(1, Math.floor(diffSeconds / 60))}m ago`;
  }
  if (diffSeconds < 86400) {
    return `${Math.max(1, Math.floor(diffSeconds / 3600))}h ago`;
  }
  return `${Math.max(1, Math.floor(diffSeconds / 86400))}d ago`;
}

function buildUserSummary(user = {}) {
  const profile = ensureUserProfileData(user);
  return {
    id: profile.id,
    name: profile.name,
    avatarKey: profile.avatarKey,
    verified: !!profile.verified,
  };
}

function buildReactionMap(reactions = []) {
  return REACTION_EMOJIS.reduce((summary, emoji) => {
    summary[emoji] = reactions.filter((item) => item.emoji === emoji).length;
    return summary;
  }, {});
}

function buildCommentTree(db, comments = [], options = {}) {
  const limit = Math.max(Number(options.limit) || comments.length || 0, 0);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const visibleComments = comments.slice(offset, offset + limit || comments.length);

  return visibleComments.map((comment) => {
    const user = (db.users || []).find((item) => item.id === comment.userId);
    return {
      id: comment.id,
      user: buildUserSummary(user || comment.userSnapshot || {}),
      text: comment.text,
      timestamp: formatRelativeTime(comment.createdAt),
      createdAt: comment.createdAt,
      replies: buildCommentTree(db, comment.replies || []),
    };
  });
}

function canViewerAccessMoment(db, moment, viewerId) {
  if (!moment || !viewerId) {
    return false;
  }
  if (String(moment.userId || '').trim() === String(viewerId || '').trim()) {
    return true;
  }

  const audience = String(moment.audience || 'public').trim().toLowerCase();
  if (audience === 'public') {
    return true;
  }

  const ownerId = String(moment.userId || '').trim();
  const viewerFollowsOwner = (db.follows || []).some(
    (item) => String(item.userId || '').trim() === String(viewerId || '').trim()
      && String(item.targetUserId || '').trim() === ownerId
  );
  const ownerFollowsViewer = (db.follows || []).some(
    (item) => String(item.userId || '').trim() === ownerId
      && String(item.targetUserId || '').trim() === String(viewerId || '').trim()
  );

  if (audience === 'followers') {
    return viewerFollowsOwner;
  }

  if (audience === 'friends') {
    return viewerFollowsOwner && ownerFollowsViewer;
  }

  if (audience === 'team') {
    const teamId = String(moment.teamId || '').trim();
    if (!teamId) {
      return false;
    }
    return (db.teams || []).some((team) => {
      if (String(team?.id || '').trim() !== teamId) {
        return false;
      }
      if (String(team?.ownerUserId || '').trim() === String(viewerId || '').trim()) {
        return true;
      }
      return Array.isArray(team?.players) && team.players.some(
        (player) => String(player?.connectedUserId || '').trim() === String(viewerId || '').trim()
      );
    });
  }

  return true;
}

function buildMomentForViewer(db, moment, viewerId, options = {}) {
  const owner = (db.users || []).find((item) => item.id === moment.userId);
  if (!owner) {
    return null;
  }
  if (isBlockedBetween(db, viewerId, moment.userId)) {
    return null;
  }
  if (!canViewerAccessMoment(db, moment, viewerId)) {
    return null;
  }

  const team = moment.teamId ? (db.teams || []).find((item) => item.id === moment.teamId) : null;
  const teamSummary = team ? { id: team.id, name: team.teamName || 'Unnamed Team', publicTeamId: team.publicTeamId || '' } : null;
  const reactions = Array.isArray(moment.reactions) ? moment.reactions : [];
  const rawComments = Array.isArray(moment.comments) ? moment.comments : [];
  const commentOffset = Math.max(Number(options.commentOffset) || 0, 0);
  const commentLimit = Math.min(Math.max(Number(options.commentLimit) || rawComments.length || 0, 0), 50);
  const comments = buildCommentTree(db, rawComments, {
    offset: commentOffset,
    limit: commentLimit || rawComments.length,
  });
  const viewerReaction = reactions.find((item) => item.userId === viewerId)?.emoji || '';

  return {
    id: moment.id,
    user: buildUserSummary(owner),
    team: teamSummary,
    timestamp: formatRelativeTime(moment.createdAt),
    createdAt: moment.createdAt,
    location: moment.location || '',
    caption: moment.caption || '',
    audience: String(moment.audience || 'public').trim().toLowerCase(),
    tags: Array.isArray(moment.tags) ? moment.tags : [],
    media: moment.media || (moment.tournamentContext ? null : { type: 'text', accent: ['#4A7BFF', '#8D5CFF'], emphasis: 'Status drop' }),
    tournamentContext: moment.tournamentContext || null,
    reactions: buildReactionMap(reactions),
    viewerReaction,
    comments,
    commentCount: countComments(moment.comments || []),
    commentMeta: {
      offset: commentOffset,
      limit: commentLimit || rawComments.length,
      hasMore: rawComments.length > commentOffset + comments.length,
    },
    shareCount: Array.isArray(moment.shares) ? moment.shares.length : 0,
    saved: Array.isArray(moment.savedByUserIds) ? moment.savedByUserIds.includes(viewerId) : false,
    flagged: Array.isArray(moment.reportEntries) ? moment.reportEntries.length > 0 : false,
    reportCount: Array.isArray(moment.reportEntries) ? moment.reportEntries.length : 0,
    isOwnMoment: moment.userId === viewerId,
    muted: true,
  };
}

function countComments(comments = []) {
  return comments.reduce((total, comment) => total + 1 + countComments(comment.replies || []), 0);
}

function getVisibleMoments(db, viewerId) {
  return (db.moments || [])
    .filter((moment) => moment.status !== 'removed')
    .filter((moment) => {
      const owner = (db.users || []).find((item) => item.id === moment.userId);
      return owner && !isBlockedBetween(db, viewerId, moment.userId) && canViewerAccessMoment(db, moment, viewerId);
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function getScopedMoments(db, viewerId, scope = 'feed') {
  const normalizedScope = FEED_SCOPES.has(String(scope || '').trim().toLowerCase())
    ? String(scope || '').trim().toLowerCase()
    : 'feed';
  const visibleMoments = getVisibleMoments(db, viewerId);

  if (normalizedScope === 'saved') {
    return visibleMoments.filter((moment) => Array.isArray(moment.savedByUserIds) && moment.savedByUserIds.includes(viewerId));
  }

  if (normalizedScope === 'mine') {
    return visibleMoments.filter((moment) => moment.userId === viewerId);
  }

  if (normalizedScope === 'reported') {
    return visibleMoments.filter((moment) => Array.isArray(moment.reportEntries) && moment.reportEntries.length > 0);
  }

  return visibleMoments;
}

function buildHighlights(db, viewerId, visibleMoments = []) {
  const usedUserIds = new Set();
  return visibleMoments
    .filter((moment) => !usedUserIds.has(moment.userId))
    .slice(0, 4)
    .map((moment, index) => {
      usedUserIds.add(moment.userId);
      const owner = (db.users || []).find((item) => item.id === moment.userId);
      const viewerMoment = buildMomentForViewer(db, moment, viewerId);
      return {
        id: `highlight-${moment.id}`,
        momentId: moment.id,
        moment: viewerMoment,
        title: Array.isArray(moment.tags) && moment.tags[0] ? String(moment.tags[0]).replace('#', '') : 'Daily drop',
        subtitle: owner ? ensureUserProfileData(owner).name : 'Moment',
        tint: HIGHLIGHT_TINTS[index % HIGHLIGHT_TINTS.length],
        avatarKey: owner ? ensureUserProfileData(owner).avatarKey : 'love',
      };
    });
}

function buildTrendingTags(visibleMoments = []) {
  const counts = new Map();
  visibleMoments.forEach((moment) => {
    (moment.tags || []).forEach((tag) => {
      const normalized = String(tag || '').trim();
      if (!normalized) {
        return;
      }
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([tag]) => tag);
}

function buildSuggestedUsers(db, viewerId) {
  return (db.users || [])
    .filter((user) => user.id !== viewerId)
    .filter((user) => !isBlockedBetween(db, viewerId, user.id))
    .slice(0, 3)
    .map((user) => {
      const profile = ensureUserProfileData(user);
      return {
        id: profile.id,
        name: profile.name,
        badge: Array.isArray(profile.interests) && profile.interests[0] ? profile.interests[0] : profile.city,
        avatarKey: profile.avatarKey,
      };
    });
}

function buildFeedPayload(db, viewerId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 8, 1), 20);
  const cursor = String(options.cursor || '').trim();
  const scope = FEED_SCOPES.has(String(options.scope || '').trim().toLowerCase())
    ? String(options.scope || '').trim().toLowerCase()
    : 'feed';
  const visibleMoments = getScopedMoments(db, viewerId, scope);
  let startIndex = 0;

  if (cursor) {
    const cursorIndex = visibleMoments.findIndex((moment) => moment.id === cursor);
    if (cursorIndex >= 0) {
      startIndex = cursorIndex + 1;
    }
  }

  const slice = visibleMoments.slice(startIndex, startIndex + limit);
  const posts = slice.map((moment) => buildMomentForViewer(db, moment, viewerId)).filter(Boolean);

  return {
    posts,
    sections: {
      highlights: scope === 'feed' ? buildHighlights(db, viewerId, visibleMoments) : [],
      trendingTags: scope === 'feed' ? buildTrendingTags(visibleMoments) : [],
      suggestedUsers: scope === 'feed' ? buildSuggestedUsers(db, viewerId) : [],
    },
    meta: {
      scope,
      hasMore: startIndex + slice.length < visibleMoments.length,
      nextCursor: slice.length ? slice[slice.length - 1].id : '',
      latestMomentId: visibleMoments[0]?.id || '',
      unreadNotificationCount: countUnreadMomentNotifications(db, viewerId),
    },
  };
}

function buildNotificationRecord({ userId, actorUserId, momentId, type, text }) {
  return {
    id: crypto.randomUUID(),
    userId,
    actorUserId,
    momentId,
    type,
    text,
    createdAt: new Date().toISOString(),
    readAt: '',
  };
}

function addMomentNotification(db, payload) {
  db.momentNotifications = db.momentNotifications || [];
  const notification = buildNotificationRecord(payload);
  db.momentNotifications.unshift(notification);
  db.momentNotifications = db.momentNotifications.slice(0, 100);
  return notification;
}

function getMomentNotifications(db, userId, limit = 20) {
  return (db.momentNotifications || [])
    .filter((item) => item.userId === userId)
    .slice(0, limit)
    .map((notification) => {
      const actor = (db.users || []).find((user) => user.id === notification.actorUserId);
      return {
        ...notification,
        read: Boolean(notification.readAt),
        actor: buildUserSummary(actor || {}),
        timestamp: formatRelativeTime(notification.createdAt),
      };
    });
}

function countUnreadMomentNotifications(db, userId) {
  return (db.momentNotifications || []).filter(
    (item) => item.userId === userId && !String(item.readAt || '').trim()
  ).length;
}

function markMomentNotificationsRead(db, userId, options = {}) {
  const momentId = String(options.momentId || '').trim();
  const readAt = new Date().toISOString();
  let changed = false;
  let readCount = 0;

  db.momentNotifications = (db.momentNotifications || []).map((notification) => {
    const isTargetUser = notification.userId === userId;
    const isTargetMoment = momentId ? notification.momentId === momentId : true;
    const isUnread = !String(notification.readAt || '').trim();

    if (!isTargetUser || !isTargetMoment || !isUnread) {
      return notification;
    }

    changed = true;
    readCount += 1;
    return {
      ...notification,
      readAt,
    };
  });

  return {
    changed,
    readCount,
    unreadCount: countUnreadMomentNotifications(db, userId),
  };
}

function buildSeedMoments(db) {
  const users = (db.users || []).slice(0, Math.max((db.users || []).length, 6));
  if (!users.length) {
    return [];
  }

  return SEED_TEMPLATES.map((template, index) => {
    const owner = users[index % users.length];
    const commentUser = users[(index + 1) % users.length];
    const replyUser = users[(index + 2) % users.length];
    const reactorUser = users[(index + 3) % users.length];
    return {
      id: crypto.randomUUID(),
      userId: owner.id,
      caption: template.caption,
      location: template.location,
      tags: template.tags,
      media: template.media,
      createdAt: new Date(Date.now() - template.minutesAgo * 60 * 1000).toISOString(),
      reactions: [
        { userId: reactorUser?.id || owner.id, emoji: REACTION_EMOJIS[index % REACTION_EMOJIS.length], createdAt: new Date().toISOString() },
      ],
      comments: [
        {
          id: crypto.randomUUID(),
          userId: commentUser?.id || owner.id,
          text: index % 2 === 0 ? 'This is clean. Love the tone here.' : 'Mood matches perfectly.',
          createdAt: new Date(Date.now() - Math.max(template.minutesAgo - 1, 1) * 60 * 1000).toISOString(),
          replies: [
            {
              id: crypto.randomUUID(),
              userId: replyUser?.id || owner.id,
              text: '@moment this one actually feels worth sharing.',
              createdAt: new Date(Date.now() - Math.max(template.minutesAgo - 1, 1) * 60 * 1000).toISOString(),
              replies: [],
            },
          ],
        },
      ],
      shares: [],
      savedByUserIds: [],
      reportEntries: [],
      status: 'active',
    };
  });
}

function ensureMomentsState(db) {
  let changed = false;
  db.moments = db.moments || [];
  db.momentNotifications = db.momentNotifications || [];

  if (!db.moments.length && Array.isArray(db.users) && db.users.length) {
    db.moments = buildSeedMoments(db);
    changed = true;
  }

  db.moments = db.moments.map((moment) => {
    const nextMoment = {
      reactions: [],
      comments: [],
      shares: [],
      savedByUserIds: [],
      reportEntries: [],
      status: 'active',
      audience: 'public',
      ...moment,
    };
    return nextMoment;
  });

  db.momentRateLimits = (db.momentRateLimits || []).filter((entry) => {
    const createdAt = new Date(entry?.createdAt || 0).getTime();
    return Number.isFinite(createdAt) && Date.now() - createdAt < 24 * 60 * 60 * 1000;
  });

  db.momentNotifications = db.momentNotifications.map((notification) => {
    const nextNotification = {
      readAt: '',
      ...notification,
    };
    if (String(nextNotification.readAt || '') !== String(notification.readAt || '')) {
      changed = true;
    }
    return nextNotification;
  });

  return changed;
}

function findMomentById(db, momentId) {
  return (db.moments || []).find((moment) => moment.id === momentId) || null;
}

module.exports = {
  FEED_SCOPES,
  MOMENT_AUDIENCES,
  REACTION_EMOJIS,
  addMomentNotification,
  buildFeedPayload,
  buildMomentForViewer,
  canViewerAccessMoment,
  countUnreadMomentNotifications,
  ensureMomentsState,
  findMomentById,
  formatRelativeTime,
  getVisibleMoments,
  getScopedMoments,
  getMomentNotifications,
  markMomentNotificationsRead,
};
