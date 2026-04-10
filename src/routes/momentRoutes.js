const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { readDb, writeDb } = require('../data/db');
const { MOMENT_UPLOADS_DIR } = require('../config/constants');
const { assertAuthorizedUser } = require('../utils/authSession');
const { sendServerError } = require('../utils/common');
const {
  REACTION_EMOJIS,
  MOMENT_AUDIENCES,
  addMomentNotification,
  buildFeedPayload,
  buildMomentForViewer,
  canViewerAccessMoment,
  countUnreadMomentNotifications,
  ensureMomentsState,
  findMomentById,
  getVisibleMoments,
  getMomentNotifications,
  markMomentNotificationsRead,
} = require('../utils/moments');
const { isMomentsAdminUser } = require('../utils/profile');
const { emitToUser, getOnlineUserIds } = require('../socket');
const { buildDisplayName, notifyUserById } = require('../services/userPushService');

const router = express.Router();
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MOMENT_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '') || '';
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 35 * 1024 * 1024 },
});
const CREATE_WINDOW_MS = 3 * 60 * 1000;
const COMMENT_WINDOW_MS = 60 * 1000;
const REACT_WINDOW_MS = 20 * 1000;
const ACTION_LIMITS = {
  create: { windowMs: CREATE_WINDOW_MS, max: 5, message: 'You are posting too fast. Try again in a moment.' },
  comment: { windowMs: COMMENT_WINDOW_MS, max: 10, message: 'Too many comments in a short time. Please slow down.' },
  react: { windowMs: REACT_WINDOW_MS, max: 40, message: 'Too many quick reactions. Please wait a moment.' },
};

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6);
  }

  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6);
    }
  } catch (_error) {
  }

  return raw
    .split(/[\s,]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function parseAccentGradient(value) {
  const fallback = ['#4A7BFF', '#8D5CFF'];
  const raw = String(value || '').trim();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const colors = parsed
        .map((item) => String(item || '').trim())
        .filter((item) => /^#([0-9A-Fa-f]{6})$/.test(item))
        .slice(0, 3);
      return colors.length >= 2 ? colors : fallback;
    }
  } catch (_error) {
  }
  return fallback;
}

function emitMomentToOnlineUsers(db, moment) {
  getOnlineUserIds().forEach((userId) => {
    const payload = buildMomentForViewer(db, moment, userId);
    if (payload) {
      emitToUser(userId, 'moments:new', { moment: payload });
    }
  });
}

function emitMomentNotification(db, targetUserId, actorUserId, momentId, type, text) {
  if (!targetUserId || !actorUserId || targetUserId === actorUserId) {
    return null;
  }

  const notification = addMomentNotification(db, {
    userId: targetUserId,
    actorUserId,
    momentId,
    type,
    text,
  });
  emitToUser(targetUserId, 'moments:notification', {
    notification: {
      ...notification,
      read: false,
      timestamp: 'Just now',
    },
  });
  const actor = (db.users || []).find((user) => user.id === actorUserId);
  notifyUserById(
    db,
    targetUserId,
    {
      title: `${buildDisplayName(actor)} ${text}`,
      body: 'Tap to open your moment activity.',
      data: {
        tab: 'newsfeed',
        screen: 'newsfeed',
        notificationType: 'moment',
        momentId,
        actorUserId,
        userId: targetUserId,
        type,
      },
    },
    { settingKey: 'momentReplies' }
  ).catch(() => {});
  return notification;
}

function buildMomentResponse(db, moment, userId) {
  return moment?.status === 'removed'
    ? null
    : buildMomentForViewer(db, moment, userId);
}

function pruneRateLimitEntries(db) {
  db.momentRateLimits = (db.momentRateLimits || []).filter((entry) => {
    const createdAt = new Date(entry?.createdAt || 0).getTime();
    return Number.isFinite(createdAt) && Date.now() - createdAt < 24 * 60 * 60 * 1000;
  });
}

function assertMomentActionAllowed(db, userId, action) {
  pruneRateLimitEntries(db);
  const config = ACTION_LIMITS[action];
  if (!config) {
    return null;
  }
  const recentEntries = (db.momentRateLimits || []).filter((entry) =>
    String(entry?.userId || '').trim() === String(userId || '').trim()
    && String(entry?.action || '').trim() === action
    && Date.now() - new Date(entry?.createdAt || 0).getTime() <= config.windowMs
  );
  if (recentEntries.length >= config.max) {
    return config.message;
  }
  db.momentRateLimits.push({
    id: crypto.randomUUID(),
    userId,
    action,
    createdAt: new Date().toISOString(),
  });
  return null;
}

function resolveMomentUploadPath(media = {}) {
  const rawUri = String(media?.uri || '').trim();
  if (!rawUri.startsWith('/uploads/moments/')) {
    return '';
  }
  return path.join(MOMENT_UPLOADS_DIR, path.basename(rawUri));
}

function deleteMomentMediaFile(moment = {}) {
  const targetPath = resolveMomentUploadPath(moment?.media);
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }
  try {
    fs.unlinkSync(targetPath);
  } catch (_error) {
  }
}

router.get('/feed/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    const changed = ensureMomentsState(db);
    if (changed) {
      writeDb(db);
    }

    const viewer = (db.users || []).find((item) => item.id === userId);
    const scope = String(req.query.scope || 'feed').trim().toLowerCase();
    if (scope === 'reported' && !isMomentsAdminUser(viewer)) {
      return res.status(403).json({ message: 'Only moderators can review reported moments.' });
    }

    return res.json(buildFeedPayload(db, userId, req.query));
  } catch (error) {
    return sendServerError(res, error, 'Could not load moments feed.');
  }
});

router.get('/profile/:viewerId/:profileUserId', (req, res) => {
  try {
    const viewerId = String(req.params.viewerId || '').trim();
    const profileUserId = String(req.params.profileUserId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, viewerId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const posts = getVisibleMoments(db, viewerId)
      .filter((moment) => String(moment.userId || '').trim() === profileUserId)
      .map((moment) => buildMomentForViewer(db, moment, viewerId))
      .filter(Boolean);

    return res.json({ posts });
  } catch (error) {
    return sendServerError(res, error, 'Could not load profile posts.');
  }
});

router.get('/notifications/:userId', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    return res.json({
      notifications: getMomentNotifications(db, userId, Math.min(Math.max(Number(req.query.limit) || 20, 1), 40)),
      unreadCount: countUnreadMomentNotifications(db, userId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load moment notifications.');
  }
});

router.post('/notifications/:userId/read', (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const momentId = String(req.body.momentId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const result = markMomentNotificationsRead(db, userId, { momentId });
    if (result.changed) {
      writeDb(db);
    }

    return res.json({
      message: result.readCount ? 'Moment alerts marked as read.' : 'No unread moment alerts remained.',
      readCount: result.readCount,
      unreadCount: result.unreadCount,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update moment alerts.');
  }
});

router.get('/:momentId/view/:userId', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.params.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment || moment.status === 'removed') {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    const payload = buildMomentResponse(db, moment, userId);
    if (!payload) {
      return res.status(404).json({ message: 'Moment is no longer available.' });
    }

    return res.json({ moment: payload });
  } catch (error) {
    return sendServerError(res, error, 'Could not open this moment.');
  }
});

router.get('/:momentId/comments/:userId', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.params.userId || '').trim();
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment || moment.status === 'removed') {
      return res.status(404).json({ message: 'Moment not found.' });
    }
    if (!canViewerAccessMoment(db, moment, userId)) {
      return res.status(403).json({ message: 'This moment is not available.' });
    }

    const payload = buildMomentForViewer(db, moment, userId, {
      commentOffset: offset,
      commentLimit: limit,
    });
    return res.json({
      comments: payload?.comments || [],
      commentCount: payload?.commentCount || 0,
      meta: payload?.commentMeta || { offset, limit, hasMore: false },
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load comments.');
  }
});

router.post('/create', upload.single('media'), (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const mode = String(req.body.mode || 'status').trim().toLowerCase();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!['status', 'image', 'video'].includes(mode)) {
      return res.status(400).json({ message: 'Unsupported moment type.' });
    }

    const caption = String(req.body.caption || '').trim();
    const location = String(req.body.location || '').trim();
    const tags = parseTags(req.body.tags);
    const teamId = String(req.body.teamId || '').trim() || null;
    const audience = MOMENT_AUDIENCES.has(String(req.body.audience || '').trim().toLowerCase())
      ? String(req.body.audience || '').trim().toLowerCase()
      : 'public';
    const durationSec = Math.max(1, Math.min(Number(req.body.durationSec) || 0, 30));
    const statusUseBackground = !['0', 'false', 'no'].includes(String(req.body.statusUseBackground || 'true').trim().toLowerCase());
    const statusAccentGradient = parseAccentGradient(req.body.statusAccentGradient);

    if (mode === 'status' && !caption) {
      return res.status(400).json({ message: 'Status posts need text.' });
    }

    if ((mode === 'image' || mode === 'video') && !req.file) {
      return res.status(400).json({ message: `Please upload a ${mode}.` });
    }

    if (mode === 'video' && durationSec > 30) {
      return res.status(400).json({ message: 'Video moments must be 30 seconds or shorter.' });
    }

    const rateLimitMessage = assertMomentActionAllowed(db, userId, 'create');
    if (rateLimitMessage) {
      return res.status(429).json({ message: rateLimitMessage });
    }

    let media = {
      type: 'text',
      accent: statusAccentGradient,
      emphasis: 'Status drop',
      useBackground: statusUseBackground,
    };

    if (mode === 'image') {
      if (!String(req.file?.mimetype || '').startsWith('image/')) {
        return res.status(400).json({ message: 'Uploaded file must be an image.' });
      }
      media = {
        type: 'image',
        uri: `/uploads/moments/${req.file.filename}`,
        mimeType: req.file.mimetype,
        aspectRatio: 1,
      };
    }

    if (mode === 'video') {
      if (!String(req.file?.mimetype || '').startsWith('video/')) {
        return res.status(400).json({ message: 'Uploaded file must be a video.' });
      }
      media = {
        type: 'video',
        uri: `/uploads/moments/${req.file.filename}`,
        mimeType: req.file.mimetype,
        durationSec,
        aspectRatio: 0.82,
      };
    }

    const moment = {
      id: crypto.randomUUID(),
      userId,
      teamId,
      caption,
      location,
      tags,
      audience,
      media,
      createdAt: new Date().toISOString(),
      reactions: [],
      comments: [],
      shares: [],
      savedByUserIds: [],
      reportEntries: [],
      status: 'active',
    };

    ensureMomentsState(db);
    db.moments.unshift(moment);
    writeDb(db);
    emitMomentToOnlineUsers(db, moment);

    return res.json({
      message: 'Moment posted successfully.',
      moment: buildMomentForViewer(db, moment, userId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not create moment.');
  }
});

router.post('/:momentId/react', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const emoji = String(req.body.emoji || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    if (emoji && !REACTION_EMOJIS.includes(emoji)) {
      return res.status(400).json({ message: 'Unsupported reaction.' });
    }

    const rateLimitMessage = assertMomentActionAllowed(db, userId, 'react');
    if (rateLimitMessage) {
      return res.status(429).json({ message: rateLimitMessage });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    moment.reactions = (moment.reactions || []).filter((item) => item.userId !== userId);
    if (emoji) {
      moment.reactions.push({
        userId,
        emoji,
        createdAt: new Date().toISOString(),
      });
      emitMomentNotification(db, moment.userId, userId, moment.id, 'like', 'reacted to your moment');
    }

    writeDb(db);
    return res.json({ moment: buildMomentForViewer(db, moment, userId) });
  } catch (error) {
    return sendServerError(res, error, 'Could not update reaction.');
  }
});

router.post('/:momentId/save', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    const saved = (moment.savedByUserIds || []).includes(userId);
    moment.savedByUserIds = saved
      ? moment.savedByUserIds.filter((item) => item !== userId)
      : [...(moment.savedByUserIds || []), userId];

    writeDb(db);
    return res.json({
      saved: !saved,
      moment: buildMomentForViewer(db, moment, userId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update save state.');
  }
});

router.post('/:momentId/share', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    moment.shares = moment.shares || [];
    moment.shares.push({
      id: crypto.randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
    });

    writeDb(db);
    return res.json({ moment: buildMomentForViewer(db, moment, userId) });
  } catch (error) {
    return sendServerError(res, error, 'Could not update share count.');
  }
});

router.post('/:momentId/comment', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const text = String(req.body.text || '').trim().slice(0, 400);
    const replyToCommentId = String(req.body.replyToCommentId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    if (!text) {
      return res.status(400).json({ message: 'Comment text is required.' });
    }

    const rateLimitMessage = assertMomentActionAllowed(db, userId, 'comment');
    if (rateLimitMessage) {
      return res.status(429).json({ message: rateLimitMessage });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    moment.comments = moment.comments || [];
    const entry = {
      id: crypto.randomUUID(),
      userId,
      text,
      createdAt: new Date().toISOString(),
      replies: [],
    };

    if (replyToCommentId) {
      const comment = moment.comments.find((item) => item.id === replyToCommentId);
      if (!comment) {
        return res.status(404).json({ message: 'Comment not found.' });
      }
      comment.replies = comment.replies || [];
      comment.replies.push(entry);
      emitMomentNotification(db, moment.userId, userId, moment.id, 'reply', 'replied inside your moment');
      emitMomentNotification(db, comment.userId, userId, moment.id, 'reply', 'replied to your comment');
    } else {
      moment.comments.unshift(entry);
      emitMomentNotification(db, moment.userId, userId, moment.id, 'comment', 'commented on your moment');
    }

    writeDb(db);
    return res.json({ moment: buildMomentForViewer(db, moment, userId) });
  } catch (error) {
    return sendServerError(res, error, 'Could not post comment.');
  }
});

router.post('/:momentId/edit', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment || moment.status === 'removed') {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    if (moment.userId !== userId) {
      return res.status(403).json({ message: 'Only the owner can edit this moment.' });
    }

    const caption = String(req.body.caption || '').trim().slice(0, 600);
    const location = String(req.body.location || '').trim().slice(0, 80);
    const tags = parseTags(req.body.tags);
    const audience = MOMENT_AUDIENCES.has(String(req.body.audience || '').trim().toLowerCase())
      ? String(req.body.audience || '').trim().toLowerCase()
      : String(moment.audience || 'public').trim().toLowerCase();

    if ((moment.media?.type || 'text') === 'text' && !caption) {
      return res.status(400).json({ message: 'Status moments need text.' });
    }

    moment.caption = caption;
    moment.location = location;
    moment.tags = tags;
    moment.audience = audience;
    moment.updatedAt = new Date().toISOString();
    writeDb(db);

    return res.json({
      message: 'Moment updated successfully.',
      moment: buildMomentResponse(db, moment, userId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not edit this moment.');
  }
});

router.post('/:momentId/remove', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment || moment.status === 'removed') {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    if (moment.userId !== userId) {
      return res.status(403).json({ message: 'Only the owner can delete this moment.' });
    }

    deleteMomentMediaFile(moment);
    moment.status = 'removed';
    moment.removedAt = new Date().toISOString();
    writeDb(db);

    return res.json({
      removed: true,
      momentId,
      message: 'Moment deleted successfully.',
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not delete this moment.');
  }
});

router.post('/:momentId/review', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const action = String(req.body.action || '').trim().toLowerCase();
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    const reviewer = (db.users || []).find((item) => item.id === userId);
    if (!isMomentsAdminUser(reviewer)) {
      return res.status(403).json({ message: 'Only moderators can review reported moments.' });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment || moment.status === 'removed') {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    if (!['clear', 'remove'].includes(action)) {
      return res.status(400).json({ message: 'Unsupported review action.' });
    }

    if (action === 'clear') {
      moment.reportEntries = [];
      moment.reviewedAt = new Date().toISOString();
    } else {
      deleteMomentMediaFile(moment);
      moment.status = 'removed';
      moment.removedAt = new Date().toISOString();
    }

    writeDb(db);

    return res.json({
      action,
      removed: action === 'remove',
      message: action === 'clear' ? 'Reports cleared successfully.' : 'Moment removed from the feed.',
      moment: buildMomentResponse(db, moment, userId),
      momentId,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not review this moment.');
  }
});

router.post('/:momentId/report', (req, res) => {
  try {
    const momentId = String(req.params.momentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const reason = String(req.body.reason || 'Inappropriate content').trim().slice(0, 160);
    const db = readDb();
    const auth = assertAuthorizedUser(db, req, userId);
    if (auth.error) {
      return res.status(401).json({ message: auth.error });
    }

    ensureMomentsState(db);
    const moment = findMomentById(db, momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    moment.reportEntries = (moment.reportEntries || []).filter((item) => item.userId !== userId);
    moment.reportEntries.push({
      id: crypto.randomUUID(),
      userId,
      reason,
      createdAt: new Date().toISOString(),
    });

    writeDb(db);
    return res.json({ moment: buildMomentForViewer(db, moment, userId) });
  } catch (error) {
    return sendServerError(res, error, 'Could not report moment.');
  }
});

module.exports = router;
