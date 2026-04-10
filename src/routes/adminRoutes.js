const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readDb, writeDb } = require('../data/db');
const { createSession, removeSessionByToken } = require('../utils/authSession');
const { normalizeEmail } = require('../utils/common');
const {
  sanitizeOwnProfile,
  sanitizePublicProfile,
  sanitizeUser,
  getPrivacySettings,
  buildRelationship,
  buildProfileStats,
  buildOwnProfileStats,
  isBlockedBetween,
} = require('../utils/profile');
const {
  getConversationUserIds,
  getConversationMessages,
  searchConversationMessages,
  buildConversationPreview,
} = require('../utils/chat');

const router = express.Router();
const ENV_ADMIN_USER_ID = '__admin_env__';
const ROLE_PERMISSIONS = {
  super_admin: ['admin', 'dashboard:read', 'users:write', 'reports:write', 'moments:write', 'support:write', 'chat:read', 'teams:write', 'players:write', 'tournaments:write', 'hosts:write', 'finance:write', 'settings:read', 'admins:write'],
  moderator: ['admin', 'dashboard:read', 'reports:write', 'moments:write', 'chat:read', 'teams:write', 'players:write', 'tournaments:write', 'settings:read'],
  support: ['admin', 'dashboard:read', 'support:write', 'chat:read', 'settings:read'],
  finance: ['admin', 'dashboard:read', 'finance:write', 'settings:read'],
};

function getEnvAdminCredentials() {
  return {
    email: normalizeEmail(process.env.ADMIN_EMAIL || 'admin@mydating.local'),
    password: String(process.env.ADMIN_PASSWORD || 'admin123').trim(),
    role: String(process.env.ADMIN_ROLE || 'super_admin').trim().toLowerCase(),
    name: String(process.env.ADMIN_NAME || 'MyDating Admin').trim(),
  };
}

function getAdminPermissions(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.super_admin;
}

function sanitizeAdminSession(actor = {}) {
  const role = String(actor.role || 'moderator').trim().toLowerCase();
  return {
    id: String(actor.id || '').trim(),
    name: String(actor.name || '').trim() || 'Admin',
    email: normalizeEmail(actor.email || ''),
    role,
    permissions: getAdminPermissions(role),
  };
}

function findAdminUserBySession(db, token) {
  const sessionToken = String(token || '').trim();
  if (!sessionToken) {
    return null;
  }

  const session = (db.sessions || []).find((item) => item.token === sessionToken);
  if (!session) {
    return null;
  }

  session.lastUsedAt = new Date().toISOString();
  if (session.userId === ENV_ADMIN_USER_ID) {
    const envAdmin = getEnvAdminCredentials();
    return {
      session,
      actor: sanitizeAdminSession({
        id: ENV_ADMIN_USER_ID,
        name: envAdmin.name,
        email: envAdmin.email,
        role: envAdmin.role,
      }),
    };
  }

  const user = (db.users || []).find((item) => item.id === session.userId);
  if (!user) {
    return null;
  }
  if (user.disabled) {
    return null;
  }

  const role = String(user.role || '').trim().toLowerCase();
  const permissions = Array.isArray(user.permissions)
    ? user.permissions.map((item) => String(item || '').trim().toLowerCase())
    : [];
  const isAdmin =
    user.isAdmin === true ||
    user.isMomentsAdmin === true ||
    role === 'admin' ||
    role === 'super_admin' ||
    role === 'superadmin' ||
    role === 'moderator' ||
    permissions.includes('admin');

  if (!isAdmin) {
    return null;
  }

  return {
    session,
    actor: sanitizeAdminSession({
      id: user.id,
      name: user.name || user.email,
      email: user.email,
      role: role === 'superadmin' ? 'super_admin' : role || 'moderator',
    }),
  };
}

function requireAdmin(req, res, next) {
  try {
    const db = readDb();
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const auth = findAdminUserBySession(db, token);
    if (!auth) {
      return res.status(401).json({ message: 'Admin authentication required.' });
    }

    writeDb(db);
    req.adminDb = db;
    req.adminSession = auth.session;
    req.adminActor = auth.actor;
    return next();
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not verify admin session.' });
  }
}

function hasAdminPermission(actor = {}, permission = '') {
  const normalized = String(permission || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const granted = Array.isArray(actor?.permissions) ? actor.permissions.map((item) => String(item || '').trim().toLowerCase()) : [];
  return granted.includes('admin') || granted.includes(normalized);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.adminActor || !hasAdminPermission(req.adminActor, permission)) {
      return res.status(403).json({ message: 'You do not have permission for this admin action.' });
    }
    return next();
  };
}

function sanitizePlayer(player = {}, index = 0) {
  return {
    slot: index,
    name: String(player.name || '').trim(),
    playerId: String(player.playerId || '').trim(),
    realName: String(player.realName || '').trim(),
    countryFlag: String(player.countryFlag || 'BD').trim().toUpperCase(),
    region: String(player.region || 'South Asia').trim(),
    roleTag: String(player.roleTag || (index === 0 ? 'IGL' : 'Rusher')).trim(),
    statusBadge: String(player.statusBadge || 'Active').trim(),
    kdRatio: String(player.kdRatio || '').trim(),
    headshotPct: String(player.headshotPct || '').trim(),
    mvpCount: String(player.mvpCount || '').trim(),
    trend: String(player.trend || 'Stable').trim(),
    verified: Boolean(player.verified),
    bio: String(player.bio || '').trim(),
    connectedProfile: Boolean(player.connectedProfile),
    connectedProfileValue: String(player.connectedProfileValue || '').trim(),
    connectedUserId: String(player.connectedUserId || '').trim(),
  };
}

function sanitizeTeam(team = {}) {
  return {
    id: team.id,
    teamName: String(team.teamName || '').trim(),
    publicTeamId: String(team.publicTeamId || '').trim(),
    verified: Boolean(team.verified),
    tagline: String(team.tagline || '').trim(),
    bio: String(team.bio || '').trim(),
    facebook: String(team.facebook || '').trim(),
    youtube: String(team.youtube || '').trim(),
    logoUrl: team.logoUrl || '',
    coverUrl: team.coverUrl || '',
    leaderIndex: Number.isInteger(team.leaderIndex) ? team.leaderIndex : 0,
    players: (team.players || []).map(sanitizePlayer),
    updatedAt: team.updatedAt || '',
  };
}

function buildPlayerLookup(team = {}, player = {}, index = 0) {
  return {
    team: sanitizeTeam(team),
    player: sanitizePlayer(player, index),
    slot: index,
  };
}

function sanitizeAdminPlayer(team = {}, player = {}, index = 0, db) {
  const connectedUserId = String(player?.connectedUserId || '').trim();
  const connectedUser = connectedUserId ? (db.users || []).find((item) => item.id === connectedUserId) : null;
  return {
    ...sanitizePlayer(player, index),
    teamId: String(team.id || '').trim(),
    teamName: String(team.teamName || '').trim(),
    publicTeamId: String(team.publicTeamId || '').trim(),
    leader: Number(team.leaderIndex) === index,
    connectedUser: connectedUser ? sanitizeAdminUserListItem(connectedUser, db) : null,
  };
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function appendAdminAuditLog(db, actor = {}, action = '', targetType = '', targetId = '', details = {}) {
  db.adminAuditLogs = db.adminAuditLogs || [];
  db.adminAuditLogs.unshift({
    id: crypto.randomUUID(),
    actorId: String(actor.id || '').trim(),
    actorName: String(actor.name || '').trim(),
    actorRole: String(actor.role || '').trim(),
    action: String(action || '').trim(),
    targetType: String(targetType || '').trim(),
    targetId: String(targetId || '').trim(),
    details: details && typeof details === 'object' ? details : {},
    createdAt: new Date().toISOString(),
  });
  db.adminAuditLogs = db.adminAuditLogs.slice(0, 500);
}

function sanitizeAdminUserListItem(user = {}, db) {
  const stats = buildProfileStats(db, user.id);
  const reportCount = (db.reports || []).filter((item) => String(item?.targetUserId || '').trim() === String(user.id || '').trim()).length;
  const blockedByOthers = (db.blocks || []).filter((item) => String(item?.targetUserId || '').trim() === String(user.id || '').trim()).length;
  const blockedByUser = (db.blocks || []).filter((item) => String(item?.userId || '').trim() === String(user.id || '').trim()).length;

  return {
    ...sanitizeUser(user),
    city: String(user.city || '').trim(),
    status: String(user.status || '').trim(),
    verified: user.verified !== false,
    suspended: Boolean(user.suspended),
    reportsCount: reportCount,
    blockedByOthers,
    blockedByUser,
    followersCount: stats.followersCount || 0,
    followingCount: stats.followingCount || 0,
    friendCount: stats.friendCount || 0,
    lastActiveAt: user.lastActiveAt || user.createdAt || '',
  };
}

function sanitizeAdminReport(report = {}, db) {
  const reporter = (db.users || []).find((item) => item.id === report.userId);
  const target = (db.users || []).find((item) => item.id === report.targetUserId);
  return {
    id: String(report.id || '').trim(),
    reason: String(report.reason || '').trim(),
    details: String(report.details || '').trim(),
    status: String(report.status || 'under_review').trim(),
    adminNote: String(report.adminNote || '').trim(),
    moderationAction: String(report.moderationAction || '').trim(),
    createdAt: report.createdAt || '',
    reviewedAt: report.reviewedAt || '',
    reporter: reporter ? sanitizeAdminUserListItem(reporter, db) : null,
    target: target ? sanitizeAdminUserListItem(target, db) : null,
  };
}

function sanitizeAdminMoment(moment = {}, db) {
  const owner = (db.users || []).find((item) => item.id === moment.userId);
  const reportEntries = Array.isArray(moment.reportEntries) ? moment.reportEntries : [];
  const reactionCount = Array.isArray(moment.reactions) ? moment.reactions.length : 0;
  const commentCount = Array.isArray(moment.comments) ? moment.comments.length : 0;
  const shareCount = Array.isArray(moment.shares) ? moment.shares.length : 0;
  return {
    id: String(moment.id || '').trim(),
    caption: String(moment.caption || '').trim(),
    status: String(moment.status || 'published').trim(),
    audience: String(moment.audience || 'public').trim(),
    location: String(moment.location || '').trim(),
    tags: Array.isArray(moment.tags) ? moment.tags : [],
    createdAt: moment.createdAt || '',
    updatedAt: moment.updatedAt || '',
    removedAt: moment.removedAt || '',
    reviewedAt: moment.reviewedAt || '',
    reportCount: reportEntries.length,
    reportEntries: reportEntries.map((entry) => ({
      id: String(entry?.id || '').trim(),
      userId: String(entry?.userId || '').trim(),
      reason: String(entry?.reason || '').trim(),
      createdAt: entry?.createdAt || '',
      reporter: sanitizeAdminUserListItem(
        (db.users || []).find((item) => item.id === entry?.userId) || {},
        db
      ),
    })),
    reactionCount,
    commentCount,
    shareCount,
    media: moment.media
      ? {
          type: String(moment.media.type || 'text').trim(),
          uri: moment.media.uri || '',
          thumbUri: moment.media.thumbUri || '',
          width: Number(moment.media.width) || 0,
          height: Number(moment.media.height) || 0,
          durationMs: Number(moment.media.durationMs) || 0,
        }
      : null,
    owner: owner ? sanitizeAdminUserListItem(owner, db) : null,
  };
}

function sanitizeSupportMessage(message = {}) {
  return {
    id: String(message.id || '').trim(),
    userId: String(message.userId || '').trim(),
    senderType: String(message.senderType || 'user').trim(),
    text: String(message.text || '').trim(),
    type: String(message.type || 'text').trim(),
    fileUrl: message.fileUrl || '',
    fileName: String(message.fileName || '').trim(),
    mimeType: String(message.mimeType || '').trim(),
    createdAt: message.createdAt || '',
  };
}

function sanitizeSupportThread(thread = {}, db) {
  const user = (db.users || []).find((item) => item.id === thread.userId);
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const lastMessage = messages[messages.length - 1] || null;
  const unresolvedUserMessage = [...messages]
    .reverse()
    .find((item) => String(item?.senderType || '').trim().toLowerCase() === 'user');
  return {
    id: String(thread.id || '').trim(),
    userId: String(thread.userId || '').trim(),
    adminId: String(thread.adminId || '').trim(),
    status: String(thread.status || 'open').trim().toLowerCase(),
    createdAt: thread.createdAt || '',
    updatedAt: thread.updatedAt || '',
    autoReplyQueuedAt: thread.autoReplyQueuedAt || '',
    autoReplySentAt: thread.autoReplySentAt || '',
    messageCount: messages.length,
    imageCount: messages.filter((item) => String(item?.type || '').trim().toLowerCase() === 'image').length,
    lastMessage: lastMessage ? sanitizeSupportMessage(lastMessage) : null,
    lastUserMessageAt: unresolvedUserMessage?.createdAt || '',
    user: user ? sanitizeAdminUserListItem(user, db) : null,
    messages: messages.map(sanitizeSupportMessage),
  };
}

function sanitizeAdminChatMessage(message = {}, db) {
  const fromUser = (db.users || []).find((item) => item.id === message.fromUserId);
  const toUser = (db.users || []).find((item) => item.id === message.toUserId);
  return {
    id: String(message.id || '').trim(),
    fromUserId: String(message.fromUserId || '').trim(),
    toUserId: String(message.toUserId || '').trim(),
    text: String(message.text || '').trim(),
    type: String(message.type || 'text').trim(),
    giftName: String(message.giftName || '').trim(),
    fileUrl: message.fileUrl || '',
    fileName: String(message.fileName || '').trim(),
    mimeType: String(message.mimeType || '').trim(),
    durationMs: Number(message.durationMs) || 0,
    createdAt: message.createdAt || '',
    readAt: message.readAt || '',
    deliveredAt: message.deliveredAt || '',
    fromUser: fromUser ? sanitizeAdminUserListItem(fromUser, db) : null,
    toUser: toUser ? sanitizeAdminUserListItem(toUser, db) : null,
  };
}

function sanitizeTournamentAssignment(assignment = {}) {
  return {
    id: String(assignment.id || '').trim(),
    roomCode: String(assignment.roomCode || '').trim(),
    tournamentId: String(assignment.tournamentId || '').trim(),
    slot: String(assignment.slot || '').trim(),
    userId: String(assignment.userId || '').trim(),
    teamId: String(assignment.teamId || '').trim(),
    teamName: String(assignment.teamName || '').trim(),
    eventKey: String(assignment.eventKey || '').trim(),
    publicTeamId: String(assignment.publicTeamId || '').trim(),
    playerNames: Array.isArray(assignment.playerNames) ? assignment.playerNames : [],
    bookingStatus: String(assignment.bookingStatus || 'confirmed').trim(),
    createdAt: assignment.createdAt || '',
    updatedAt: assignment.updatedAt || '',
  };
}

function sanitizeTournamentBookingRequest(request = {}) {
  return {
    id: String(request.id || '').trim(),
    tournamentId: String(request.tournamentId || '').trim(),
    roomCode: String(request.roomCode || '').trim(),
    teamId: String(request.teamId || '').trim(),
    teamName: String(request.teamName || '').trim(),
    publicTeamId: String(request.publicTeamId || '').trim(),
    userId: String(request.userId || '').trim(),
    status: String(request.status || 'pending').trim().toLowerCase(),
    note: String(request.note || request.adminNote || '').trim(),
    playerNames: Array.isArray(request.playerNames) ? request.playerNames : [],
    createdAt: request.createdAt || '',
    updatedAt: request.updatedAt || '',
  };
}

function sanitizeAdminTournament(tournament = {}, db) {
  const tournamentId = String(tournament?.id || '').trim();
  const assignments = (db.tournamentRoomAssignments || [])
    .filter((item) => String(item?.tournamentId || '').trim() === tournamentId)
    .map(sanitizeTournamentAssignment);
  const bookingRequests = (db.tournamentBookingRequests || [])
    .filter((item) => String(item?.tournamentId || '').trim() === tournamentId)
    .map(sanitizeTournamentBookingRequest);
  const owner = (db.users || []).find((item) => item.id === String(tournament?.ownerUserId || '').trim());
  const hostApplication = (db.hostApplications || []).find(
    (item) => String(item?.userId || '').trim() === String(tournament?.ownerUserId || '').trim()
  );
  return {
    id: tournamentId,
    ownerUserId: String(tournament?.ownerUserId || '').trim(),
    title: String(tournament?.title || '').trim(),
    badge: String(tournament?.badge || '').trim(),
    status: String(tournament?.status || '').trim(),
    stage: String(tournament?.stage || '').trim(),
    description: String(tournament?.description || '').trim(),
    prizePool: String(tournament?.prizePool || '').trim(),
    entryFee: String(tournament?.entryFee || '').trim(),
    teamLimit: Number(tournament?.teamLimit) || 0,
    confirmedTeams: assignments.length,
    roomCode: String(tournament?.roomCode || '').trim(),
    boardTitle: String(tournament?.boardTitle || '').trim(),
    startsAt: String(tournament?.startsAt || '').trim(),
    format: String(tournament?.format || '').trim(),
    stream: String(tournament?.stream || '').trim(),
    primaryAction: String(tournament?.primaryAction || '').trim(),
    secondaryAction: String(tournament?.secondaryAction || '').trim(),
    footerTitle: String(tournament?.footerTitle || '').trim(),
    footerText: String(tournament?.footerText || '').trim(),
    roomStatus: String(tournament?.roomStatus || '').trim(),
    boardText: String(tournament?.boardText || '').trim(),
    note: String(tournament?.note || '').trim(),
    observerSeats: String(tournament?.observerSeats || '').trim(),
    broadcastLane: String(tournament?.broadcastLane || '').trim(),
    createdAt: tournament?.createdAt || '',
    updatedAt: tournament?.updatedAt || '',
    owner: owner ? sanitizeAdminUserListItem(owner, db) : null,
    hostApplication: hostApplication
      ? {
          id: String(hostApplication.id || '').trim(),
          name: String(hostApplication.name || '').trim(),
          status: String(hostApplication.status || 'pending').trim(),
          hostImageUrl: String(hostApplication.hostImageUrl || '').trim(),
          nidCardImageUrl: String(hostApplication.nidCardImageUrl || '').trim(),
        }
      : null,
    assignments,
    bookingRequests,
  };
}

function sanitizeAdminHostApplication(application = {}, db) {
  const user = (db.users || []).find((item) => item.id === String(application?.userId || '').trim());
  return {
    id: String(application.id || '').trim(),
    userId: String(application.userId || '').trim(),
    name: String(application.name || '').trim(),
    playerId: String(application.playerId || '').trim(),
    nationality: String(application.nationality || '').trim(),
    district: String(application.district || '').trim(),
    subDistrict: String(application.subDistrict || '').trim(),
    mobileNumber: String(application.mobileNumber || '').trim(),
    paymentNumbers: Array.isArray(application.paymentNumbers) ? application.paymentNumbers : [],
    bkashNumber: String(application.bkashNumber || '').trim(),
    hostImageUrl: String(application.hostImageUrl || '').trim(),
    nidCardImageUrl: String(application.nidCardImageUrl || '').trim(),
    status: String(application.status || 'pending').trim().toLowerCase(),
    adminNote: String(application.adminNote || '').trim(),
    createdAt: application.createdAt || '',
    updatedAt: application.updatedAt || '',
    user: user ? sanitizeAdminUserListItem(user, db) : null,
  };
}

router.post('/login', async (req, res) => {
  try {
    const db = readDb();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const envAdmin = getEnvAdminCredentials();
    if (email === envAdmin.email && password === envAdmin.password) {
      const session = createSession(db, ENV_ADMIN_USER_ID);
      writeDb(db);
      return res.json({
        token: session.token,
        admin: sanitizeAdminSession({
          id: ENV_ADMIN_USER_ID,
          name: envAdmin.name,
          email: envAdmin.email,
          role: envAdmin.role,
        }),
      });
    }

    const user = (db.users || []).find((item) => normalizeEmail(item.email) === email);
    if (!user) {
      return res.status(401).json({ message: 'No admin account found for this email.' });
    }
    if (user.disabled) {
      return res.status(403).json({ message: 'This admin account is disabled.' });
    }

    const role = String(user.role || '').trim().toLowerCase();
    const permissions = Array.isArray(user.permissions)
      ? user.permissions.map((item) => String(item || '').trim().toLowerCase())
      : [];
    const isAdmin =
      user.isAdmin === true ||
      role === 'admin' ||
      role === 'super_admin' ||
      role === 'superadmin' ||
      role === 'moderator' ||
      permissions.includes('admin');
    if (!isAdmin) {
      return res.status(403).json({ message: 'This account does not have admin access.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash || '');
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid admin credentials.' });
    }

    const session = createSession(db, user.id);
    writeDb(db);
    return res.json({
      token: session.token,
      admin: sanitizeAdminSession({
        id: user.id,
        name: user.name || user.email,
        email: user.email,
        role: role === 'superadmin' ? 'super_admin' : role || 'moderator',
      }),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not sign in to admin panel.' });
  }
});

router.get('/session', requireAdmin, (req, res) => {
  return res.json({ admin: req.adminActor });
});

router.post('/logout', requireAdmin, (req, res) => {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const db = req.adminDb || readDb();
    removeSessionByToken(db, token);
    writeDb(db);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not log out admin session.' });
  }
});

router.get('/overview', requireAdmin, requirePermission('dashboard:read'), (_req, res) => {
  try {
    const db = readDb();
    const users = Array.isArray(db.users) ? db.users : [];
    const teams = Array.isArray(db.teams) ? db.teams : [];
    const tournaments = Array.isArray(db.tournaments) ? db.tournaments : [];
    const supportThreads = Array.isArray(db.supportThreads) ? db.supportThreads : [];
    const withdrawRequests = Array.isArray(db.withdrawRequests) ? db.withdrawRequests : [];
    const reports = Array.isArray(db.reports) ? db.reports : [];
    const totalCoins = users.reduce((sum, user) => sum + (Number(user?.coins) || 0), 0);
    const totalHostApplications = Array.isArray(db.hostApplications) ? db.hostApplications.length : 0;
    const pendingHostApplications = (db.hostApplications || []).filter((item) => String(item?.status || 'pending').trim().toLowerCase() === 'pending').length;
    const openMoments = (db.moments || []).filter((item) => Array.isArray(item?.reportEntries) && item.reportEntries.length > 0).length;
    const totalRewardsClaimed = users.reduce((sum, user) => {
      const claims = user?.missionRewardClaims || {};
      const missionClaims = Object.keys(claims.missions || {}).length;
      const dailyClaims = Object.keys(claims.daily || {}).length;
      return sum + missionClaims + dailyClaims;
    }, 0);

    return res.json({
      metrics: {
        totalUsers: users.length,
        verifiedUsers: users.filter((item) => item.verified).length,
        totalTeams: teams.length,
        verifiedTeams: teams.filter((item) => item.verified).length,
        totalPlayers: teams.reduce((total, team) => total + (Array.isArray(team.players) ? team.players.length : 0), 0),
        totalTournaments: tournaments.length,
        pendingSupport: supportThreads.filter((item) => String(item?.status || 'open').trim().toLowerCase() !== 'resolved').length,
        pendingWithdraws: withdrawRequests.filter((item) => String(item?.status || 'pending').trim().toLowerCase() === 'pending').length,
        openReports: reports.filter((item) => String(item?.status || 'open').trim().toLowerCase() !== 'resolved').length,
        totalCoins,
        totalHostApplications,
        pendingHostApplications,
        openMoments,
        totalRewardsClaimed,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin overview.' });
  }
});

router.get('/users', requireAdmin, requirePermission('dashboard:read'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const sort = normalizeText(req.query.sort) || 'newest';
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 12, 1), 50);

    let users = (db.users || []).map((user) => sanitizeAdminUserListItem(user, db));

    if (query) {
      users = users.filter((user) =>
        [user.name, user.email, user.id, user.appProfileId, user.gamePlayerId]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }

    if (status === 'reported') {
      users = users.filter((user) => user.reportsCount > 0);
    } else if (status === 'blocked') {
      users = users.filter((user) => user.blockedByUser > 0 || user.blockedByOthers > 0);
    } else if (status === 'suspended') {
      users = users.filter((user) => user.suspended);
    } else if (status === 'verified') {
      users = users.filter((user) => user.verified);
    }

    users.sort((left, right) => {
      if (sort === 'oldest') {
        return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
      }
      if (sort === 'name') {
        return String(left.name || '').localeCompare(String(right.name || ''));
      }
      if (sort === 'reports') {
        return (right.reportsCount || 0) - (left.reportsCount || 0);
      }
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
    });

    const total = users.length;
    const start = (page - 1) * limit;
    const items = users.slice(start, start + limit);

    return res.json({
      users: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin users.' });
  }
});

router.get('/users/:userId', requireAdmin, requirePermission('dashboard:read'), (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.params.userId || '').trim();
    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const targetReports = (db.reports || [])
      .filter((item) => String(item?.targetUserId || '').trim() === userId)
      .map((item) => sanitizeAdminReport(item, db));
    const filedReports = (db.reports || [])
      .filter((item) => String(item?.userId || '').trim() === userId)
      .map((item) => sanitizeAdminReport(item, db));
    const blockedUsers = (db.blocks || [])
      .filter((item) => String(item?.userId || '').trim() === userId)
      .map((item) => {
        const target = (db.users || []).find((userItem) => userItem.id === item.targetUserId);
        return target ? sanitizeAdminUserListItem(target, db) : null;
      })
      .filter(Boolean);

    return res.json({
      user: sanitizeAdminUserListItem(user, db),
      ownProfile: sanitizeOwnProfile(user, getPrivacySettings(db, userId)),
      publicProfile: sanitizePublicProfile(user, {
        viewerId: userId,
        privacySettings: getPrivacySettings(db, userId),
        relationship: buildRelationship(db, userId, userId),
        stats: buildProfileStats(db, userId),
        isOnline: false,
      }),
      profileStats: buildOwnProfileStats(db, userId),
      reportsAboutUser: targetReports,
      reportsFiledByUser: filedReports,
      blockedUsers,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin user detail.' });
  }
});

router.post('/users/:userId/block-toggle', requireAdmin, requirePermission('users:write'), (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.params.userId || '').trim();
    const actorUserId = String(req.body.actorUserId || '').trim();
    if (!targetUserId || !actorUserId || targetUserId === actorUserId) {
      return res.status(400).json({ message: 'Valid actor and target user ids are required.' });
    }

    const actor = (db.users || []).find((item) => item.id === actorUserId);
    const target = (db.users || []).find((item) => item.id === targetUserId);
    if (!actor || !target) {
      return res.status(404).json({ message: 'User not found.' });
    }

    db.blocks = db.blocks || [];
    const index = db.blocks.findIndex((item) => item.userId === actorUserId && item.targetUserId === targetUserId);
    let blocked = false;
    if (index >= 0) {
      db.blocks.splice(index, 1);
      blocked = false;
    } else {
      db.blocks.push({ userId: actorUserId, targetUserId, createdAt: new Date().toISOString() });
      blocked = true;
    }

    writeDb(db);
    appendAdminAuditLog(db, req.adminActor, 'report.moderate', 'report', report.id, {
      status,
      moderationAction: report.moderationAction,
    });
    writeDb(db);
    return res.json({
      message: blocked ? 'User blocked successfully.' : 'User unblocked successfully.',
      blocked,
      actor: sanitizeAdminUserListItem(actor, db),
      target: sanitizeAdminUserListItem(target, db),
      isBlockedBetweenUsers: isBlockedBetween(db, actorUserId, targetUserId),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update block state.' });
  }
});

router.post('/users/:userId/suspend', requireAdmin, requirePermission('users:write'), (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.params.userId || '').trim();
    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.suspended = req.body.suspended !== undefined ? Boolean(req.body.suspended) : !Boolean(user.suspended);
    user.suspendedAt = user.suspended ? new Date().toISOString() : '';
    writeDb(db);

    return res.json({
      message: user.suspended ? 'User suspended successfully.' : 'User suspension removed.',
      user: sanitizeAdminUserListItem(user, db),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update suspension status.' });
  }
});

router.post('/users/:userId/delete', requireAdmin, requirePermission('users:write'), (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.params.userId || '').trim();
    const userIndex = (db.users || []).findIndex((item) => item.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const profileRoutes = require('./profileRoutes');
    if (typeof profileRoutes.removeUserReferences === 'function') {
      db.users.splice(userIndex, 1);
      profileRoutes.removeUserReferences(db, userId);
    } else {
      db.users.splice(userIndex, 1);
      db.blocks = (db.blocks || []).filter((item) => item.userId !== userId && item.targetUserId !== userId);
      db.reports = (db.reports || []).filter((item) => item.userId !== userId && item.targetUserId !== userId);
      db.follows = (db.follows || []).filter((item) => item.userId !== userId && item.targetUserId !== userId);
    }

    writeDb(db);
    return res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not delete user.' });
  }
});

router.get('/reports', requireAdmin, requirePermission('dashboard:read'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const sort = normalizeText(req.query.sort) || 'newest';
    const reports = (db.reports || [])
      .map((item) => sanitizeAdminReport(item, db))
      .filter((item) => {
        if (status && status !== 'all' && normalizeText(item.status) !== status) {
          return false;
        }

        if (!query) {
          return true;
        }

        return [
          item.reason,
          item.details,
          item.reporter?.name,
          item.reporter?.email,
          item.target?.name,
          item.target?.email,
        ]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query));
      })
      .sort((left, right) => {
        if (sort === 'oldest') {
          return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
        }
        if (sort === 'status') {
          return String(left.status || '').localeCompare(String(right.status || ''));
        }
        return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
      });

    return res.json({ reports });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin reports.' });
  }
});

router.post('/reports/:reportId/moderate', requireAdmin, requirePermission('reports:write'), (req, res) => {
  try {
    const db = readDb();
    const reportId = String(req.params.reportId || '').trim();
    const status = normalizeText(req.body.status) || 'under_review';
    const moderationAction = normalizeText(req.body.moderationAction);
    const adminNote = String(req.body.adminNote || '').trim();
    const validStatuses = new Set(['under_review', 'resolved', 'dismissed']);
    const validActions = new Set(['', 'keep_under_review', 'resolve', 'dismiss']);

    if (!validStatuses.has(status)) {
      return res.status(400).json({ message: 'Invalid report status.' });
    }
    if (!validActions.has(moderationAction)) {
      return res.status(400).json({ message: 'Invalid moderation action.' });
    }

    const report = (db.reports || []).find((item) => String(item?.id || '').trim() === reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found.' });
    }

    const before = {
      status: report.status,
      moderationAction: report.moderationAction,
      adminNote: report.adminNote,
    };
    report.status = status;
    report.moderationAction = moderationAction || (status === 'under_review' ? 'keep_under_review' : status);
    report.adminNote = adminNote;
    report.reviewedAt = new Date().toISOString();
    report.reviewedByAdminId = String(req.adminActor?.id || '').trim();
    appendAdminAuditLog(db, req.adminActor, 'report.moderate', 'report', report.id, {
      before,
      after: {
        status: report.status,
        moderationAction: report.moderationAction,
        adminNote: report.adminNote,
      },
    });
    writeDb(db);

    return res.json({
      message: 'Report updated successfully.',
      report: sanitizeAdminReport(report, db),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not moderate report.' });
  }
});

router.get('/moments', requireAdmin, requirePermission('dashboard:read'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const sort = normalizeText(req.query.sort) || 'newest';
    const scope = normalizeText(req.query.scope) || 'reported';
    let moments = (db.moments || []).map((item) => sanitizeAdminMoment(item, db));

    if (scope === 'reported') {
      moments = moments.filter((item) => item.reportCount > 0);
    }

    if (status && status !== 'all') {
      moments = moments.filter((item) => normalizeText(item.status) === status);
    }

    if (query) {
      moments = moments.filter((item) =>
        [
          item.caption,
          item.location,
          item.owner?.name,
          item.owner?.email,
          item.media?.type,
          ...(item.reportEntries || []).map((entry) => `${entry.reason} ${entry.reporter?.name || ''}`),
        ]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }

    moments.sort((left, right) => {
      if (sort === 'reports') {
        return (right.reportCount || 0) - (left.reportCount || 0);
      }
      if (sort === 'oldest') {
        return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
      }
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
    });

    return res.json({ moments });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin moments.' });
  }
});

router.get('/moments/:momentId', requireAdmin, requirePermission('dashboard:read'), (req, res) => {
  try {
    const db = readDb();
    const momentId = String(req.params.momentId || '').trim();
    const moment = (db.moments || []).find((item) => String(item?.id || '').trim() === momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }
    return res.json({ moment: sanitizeAdminMoment(moment, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load moment detail.' });
  }
});

router.post('/moments/:momentId/moderate', requireAdmin, requirePermission('moments:write'), (req, res) => {
  try {
    const db = readDb();
    const momentId = String(req.params.momentId || '').trim();
    const action = normalizeText(req.body.action);
    const validActions = new Set(['remove', 'restore', 'clear']);
    if (!validActions.has(action)) {
      return res.status(400).json({ message: 'Invalid moment moderation action.' });
    }

    const moment = (db.moments || []).find((item) => String(item?.id || '').trim() === momentId);
    if (!moment) {
      return res.status(404).json({ message: 'Moment not found.' });
    }

    if (action === 'remove') {
      moment.status = 'removed';
      moment.removedAt = new Date().toISOString();
    } else if (action === 'restore') {
      moment.status = 'published';
      moment.removedAt = '';
    } else {
      moment.reportEntries = [];
      moment.reviewedAt = new Date().toISOString();
    }

    moment.updatedAt = new Date().toISOString();
    appendAdminAuditLog(db, req.adminActor, `moment.${action}`, 'moment', moment.id, {
      before,
      after: {
        status: moment.status,
        reportCount: Array.isArray(moment.reportEntries) ? moment.reportEntries.length : 0,
      },
    });
    writeDb(db);
    return res.json({
      message:
        action === 'remove'
          ? 'Moment removed from feed.'
          : action === 'restore'
            ? 'Moment restored successfully.'
            : 'Moment review queue cleared.',
      moment: sanitizeAdminMoment(moment, db),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not moderate moment.' });
  }
});

router.get('/support', requireAdmin, requirePermission('support:write'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    let threads = (db.supportThreads || []).map((item) => sanitizeSupportThread(item, db));

    if (status && status !== 'all') {
      threads = threads.filter((item) => normalizeText(item.status) === status);
    }

    if (query) {
      threads = threads.filter((item) =>
        [item.user?.name, item.user?.email, item.user?.id, item.lastMessage?.text]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }

    threads.sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
    return res.json({ threads });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load support inbox.' });
  }
});

router.get('/support/:threadId', requireAdmin, requirePermission('support:write'), (req, res) => {
  try {
    const db = readDb();
    const threadId = String(req.params.threadId || '').trim();
    const thread = (db.supportThreads || []).find((item) => String(item?.id || '').trim() === threadId);
    if (!thread) {
      return res.status(404).json({ message: 'Support thread not found.' });
    }
    return res.json({ thread: sanitizeSupportThread(thread, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load support thread.' });
  }
});

router.post('/support/:threadId/status', requireAdmin, requirePermission('support:write'), (req, res) => {
  try {
    const db = readDb();
    const threadId = String(req.params.threadId || '').trim();
    const status = normalizeText(req.body.status) || 'open';
    if (!['open', 'resolved'].includes(status)) {
      return res.status(400).json({ message: 'Invalid support status.' });
    }
    const thread = (db.supportThreads || []).find((item) => String(item?.id || '').trim() === threadId);
    if (!thread) {
      return res.status(404).json({ message: 'Support thread not found.' });
    }
    const before = { status: String(thread.status || 'open').trim().toLowerCase() };
    thread.status = status;
    thread.updatedAt = new Date().toISOString();
    thread.reviewedByAdminId = String(req.adminActor?.id || '').trim();
    appendAdminAuditLog(db, req.adminActor, `support.${status}`, 'support_thread', thread.id, {
      userId: thread.userId,
      before,
      after: { status },
    });
    writeDb(db);
    return res.json({
      message: status === 'resolved' ? 'Support thread resolved.' : 'Support thread reopened.',
      thread: sanitizeSupportThread(thread, db),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update support status.' });
  }
});

router.get('/chat/overview', requireAdmin, requirePermission('chat:read'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const users = (db.users || []).filter((user) => {
      if (!query) {
        return true;
      }
      return [user.name, user.email, user.id]
        .map((value) => normalizeText(value))
        .some((value) => value.includes(query));
    });

    const userMatches = users
      .map((user) => {
        const conversationIds = getConversationUserIds(db, user.id);
        const latestAt = conversationIds
          .map((otherId) => buildConversationPreview(db, user.id, otherId))
          .filter(Boolean)
          .sort((left, right) => new Date(right.lastMessageAt || 0).getTime() - new Date(left.lastMessageAt || 0).getTime())[0];
        return {
          user: sanitizeAdminUserListItem(user, db),
          conversationCount: conversationIds.length,
          latestConversationAt: latestAt?.lastMessageAt || '',
        };
      })
      .filter((item) => item.conversationCount > 0)
      .sort((left, right) => new Date(right.latestConversationAt || 0).getTime() - new Date(left.latestConversationAt || 0).getTime())
      .slice(0, query ? 30 : 12);

    const mediaMessages = (db.chatMessages || [])
      .filter((item) => normalizeText(item.type) !== 'text')
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
      .slice(0, 20)
      .map((item) => sanitizeAdminChatMessage(item, db));

    const uniqueConversationIds = new Set(
      (db.chatMessages || []).map((item) => [item.fromUserId, item.toUserId].sort().join('::'))
    );

    return res.json({
      metrics: {
        totalMessages: (db.chatMessages || []).length,
        mediaMessages: (db.chatMessages || []).filter((item) => normalizeText(item.type) !== 'text').length,
        unreadMessages: (db.chatMessages || []).filter((item) => item.toUserId && !item.readAt).length,
        activeConversations: uniqueConversationIds.size,
      },
      userMatches,
      flaggedMessages: mediaMessages,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load chat overview.' });
  }
});

router.get('/chat/conversations/:userId', requireAdmin, requirePermission('chat:read'), (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.params.userId || '').trim();
    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const conversations = getConversationUserIds(db, userId)
      .map((otherUserId) => ({
        otherUserId,
        conversation: buildConversationPreview(db, userId, otherUserId),
      }))
      .filter((item) => item.conversation)
      .sort((left, right) => new Date(right.conversation.lastMessageAt || 0).getTime() - new Date(left.conversation.lastMessageAt || 0).getTime());

    return res.json({
      user: sanitizeAdminUserListItem(user, db),
      conversations,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load chat conversations.' });
  }
});

router.get('/chat/messages/:userId/:otherUserId', requireAdmin, requirePermission('chat:read'), (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.params.userId || '').trim();
    const otherUserId = String(req.params.otherUserId || '').trim();
    const search = String(req.query.search || '').trim();
    const user = (db.users || []).find((item) => item.id === userId);
    const otherUser = (db.users || []).find((item) => item.id === otherUserId);
    if (!user || !otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const messages = (search ? searchConversationMessages(db, userId, otherUserId, search) : getConversationMessages(db, userId, otherUserId))
      .map((item) => sanitizeAdminChatMessage(item, db));

    return res.json({
      user: sanitizeAdminUserListItem(user, db),
      otherUser: sanitizeAdminUserListItem(otherUser, db),
      conversation: buildConversationPreview(db, userId, otherUserId),
      messages,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load chat messages.' });
  }
});

router.get('/teams', requireAdmin, requirePermission('teams:write'), (_req, res) => {
  try {
    const db = readDb();
    const teams = (db.teams || []).map(sanitizeTeam);
    return res.json({ teams });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin teams.' });
  }
});

router.get('/players', requireAdmin, requirePermission('players:write'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    let players = (db.teams || []).flatMap((team) =>
      (team.players || []).map((player, index) => sanitizeAdminPlayer(team, player, index, db))
    );

    players = players.filter((item) => item.name || item.playerId || item.connectedUserId || item.teamId);

    if (query) {
      players = players.filter((item) =>
        [item.name, item.playerId, item.realName, item.teamName, item.connectedUser?.email, item.connectedProfileValue]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }

    if (status === 'verified') {
      players = players.filter((item) => item.verified);
    } else if (status === 'connected') {
      players = players.filter((item) => item.connectedProfile || item.connectedUser);
    } else if (status === 'unverified') {
      players = players.filter((item) => !item.verified);
    }

    players.sort((left, right) => String(left.teamName || '').localeCompare(String(right.teamName || '')));
    return res.json({ players });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin players.' });
  }
});

router.get('/teams/:teamId', requireAdmin, requirePermission('teams:write'), (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const team = (db.teams || []).find((item) => item.id === teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    return res.json({ team: sanitizeTeam(team) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load team.' });
  }
});

router.get('/search/team/:publicTeamId', requireAdmin, requirePermission('teams:write'), (req, res) => {
  try {
    const db = readDb();
    const publicTeamId = String(req.params.publicTeamId || '').trim().toUpperCase();
    const team = (db.teams || []).find((item) => String(item.publicTeamId || '').trim().toUpperCase() === publicTeamId);
    if (!team) {
      return res.status(404).json({ message: 'No team found for this team ID.' });
    }

    return res.json({ team: sanitizeTeam(team) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not search team.' });
  }
});

router.get('/search/player/:playerId', requireAdmin, requirePermission('players:write'), (req, res) => {
  try {
    const db = readDb();
    const playerId = String(req.params.playerId || '').trim().toUpperCase();
    let match = null;

    (db.teams || []).some((team) =>
      (team.players || []).some((player, index) => {
        if (String(player?.playerId || '').trim().toUpperCase() !== playerId) {
          return false;
        }

        match = buildPlayerLookup(team, player, index);
        return true;
      })
    );

    if (!match) {
      return res.status(404).json({ message: 'No player found for this UID.' });
    }

    return res.json(match);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not search player.' });
  }
});

router.post('/teams/:teamId', requireAdmin, requirePermission('teams:write'), (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const team = (db.teams || []).find((item) => item.id === teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'teamName')) {
      team.teamName = String(req.body.teamName || '').trim().slice(0, 60);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'tagline')) {
      team.tagline = String(req.body.tagline || '').trim().slice(0, 140);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'bio')) {
      team.bio = String(req.body.bio || '').trim().slice(0, 240);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'facebook')) {
      team.facebook = String(req.body.facebook || '').trim().slice(0, 160);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'youtube')) {
      team.youtube = String(req.body.youtube || '').trim().slice(0, 160);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'verified')) {
      team.verified = Boolean(req.body.verified);
    }

    team.updatedAt = new Date().toISOString();
    writeDb(db);
    appendAdminAuditLog(db, req.adminActor, 'team.update', 'team', team.id, {
      before: {
        teamName: before.teamName,
        verified: before.verified,
      },
      after: {
        teamName: team.teamName,
        verified: team.verified,
      },
    });
    writeDb(db);

    return res.json({ message: 'Team updated successfully.', team: sanitizeTeam(team) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update team.' });
  }
});

router.post('/teams/:teamId/player/:slot', requireAdmin, requirePermission('players:write'), (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const slotIndex = Number(req.params.slot);
    const team = (db.teams || []).find((item) => item.id === teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
      return res.status(400).json({ message: 'Invalid player slot.' });
    }

    const current = team.players[slotIndex] || {};
    const before = sanitizePlayer(current, slotIndex);
    team.players[slotIndex] = sanitizePlayer(
      {
        ...current,
        ...req.body,
        verified: Object.prototype.hasOwnProperty.call(req.body, 'verified') ? Boolean(req.body.verified) : current.verified,
      },
      slotIndex
    );
    team.updatedAt = new Date().toISOString();
    writeDb(db);
    appendAdminAuditLog(db, req.adminActor, 'player.update', 'player', `${team.id}:${slotIndex}`, {
      teamId: team.id,
      teamName: team.teamName,
      before: {
        playerId: before.playerId,
        verified: before.verified,
      },
      after: {
        playerId: team.players[slotIndex]?.playerId,
        verified: team.players[slotIndex]?.verified,
      },
    });
    writeDb(db);

    return res.json({
      message: 'Player updated successfully.',
      team: sanitizeTeam(team),
      player: sanitizePlayer(team.players[slotIndex], slotIndex),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update player.' });
  }
});

router.get('/tournaments', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    let tournaments = (db.tournaments || []).map((item) => sanitizeAdminTournament(item, db));

    if (status && status !== 'all') {
      tournaments = tournaments.filter((item) => normalizeText(item.status) === status);
    }

    if (query) {
      tournaments = tournaments.filter((item) =>
        [item.title, item.roomCode, item.owner?.name, item.owner?.email, item.badge]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }

    tournaments.sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime());
    return res.json({ tournaments });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load tournaments.' });
  }
});

router.get('/tournaments/:tournamentId', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }
    return res.json({ tournament: sanitizeAdminTournament(tournament, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load tournament detail.' });
  }
});

router.post('/tournaments', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const timestamp = new Date().toISOString();
    const tournament = {
      id: crypto.randomUUID(),
      ownerUserId: String(req.body.ownerUserId || '').trim(),
      creationMode: 'admin',
      createdByRole: 'admin',
      createdBySource: 'admin',
      title: String(req.body.title || '').trim().slice(0, 80),
      badge: String(req.body.badge || '').trim().slice(0, 24),
      status: String(req.body.status || 'Open now').trim().slice(0, 40),
      stage: String(req.body.stage || 'Custom room').trim().slice(0, 40),
      description: String(req.body.description || '').trim().slice(0, 220),
      prizePool: String(req.body.prizePool || '').trim().slice(0, 40),
      entryFee: String(req.body.entryFee || '').trim().slice(0, 40),
      teamLimit: Math.max(1, Math.min(99, Number(req.body.teamLimit) || 12)),
      startsAt: String(req.body.startsAt || '').trim().slice(0, 40),
      format: String(req.body.format || '').trim().slice(0, 40),
      stream: String(req.body.stream || '').trim().slice(0, 40),
      roomCode: String(req.body.roomCode || '').trim().slice(0, 40),
      boardTitle: String(req.body.boardTitle || '').trim().slice(0, 50),
      primaryAction: String(req.body.primaryAction || 'Open room board').trim().slice(0, 32),
      secondaryAction: String(req.body.secondaryAction || 'Host deck').trim().slice(0, 32),
      footerTitle: String(req.body.footerTitle || '').trim().slice(0, 50),
      footerText: String(req.body.footerText || '').trim().slice(0, 180),
      roomStatus: String(req.body.roomStatus || '').trim().slice(0, 60),
      boardText: String(req.body.boardText || '').trim().slice(0, 180),
      note: String(req.body.note || '').trim().slice(0, 180),
      observerSeats: String(req.body.observerSeats || '').trim().slice(0, 20),
      broadcastLane: String(req.body.broadcastLane || '').trim().slice(0, 30),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.tournaments = db.tournaments || [];
    db.tournaments.unshift(tournament);
    appendAdminAuditLog(db, req.adminActor, 'tournament.create', 'tournament', tournament.id, {
      title: tournament.title,
      teamLimit: tournament.teamLimit,
    });
    writeDb(db);
    return res.json({ message: 'Tournament created successfully.', tournament: sanitizeAdminTournament(tournament, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not create tournament.' });
  }
});

router.post('/tournaments/:tournamentId', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }
    const before = {
      title: tournament.title,
      status: tournament.status,
      teamLimit: tournament.teamLimit,
    };
    const fields = ['title', 'badge', 'status', 'stage', 'description', 'prizePool', 'entryFee', 'startsAt', 'format', 'stream', 'roomCode', 'boardTitle', 'primaryAction', 'secondaryAction', 'footerTitle', 'footerText', 'roomStatus', 'boardText', 'note', 'observerSeats', 'broadcastLane', 'ownerUserId'];
    fields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        tournament[field] = String(req.body[field] || '').trim();
      }
    });
    if (Object.prototype.hasOwnProperty.call(req.body, 'teamLimit')) {
      tournament.teamLimit = Math.max(1, Math.min(99, Number(req.body.teamLimit) || 12));
    }
    tournament.updatedAt = new Date().toISOString();
    appendAdminAuditLog(db, req.adminActor, 'tournament.update', 'tournament', tournament.id, {
      before,
      after: {
        title: tournament.title,
        status: tournament.status,
        teamLimit: tournament.teamLimit,
      },
    });
    writeDb(db);
    return res.json({ message: 'Tournament updated successfully.', tournament: sanitizeAdminTournament(tournament, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update tournament.' });
  }
});

router.post('/tournaments/:tournamentId/teams', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const teamId = String(req.body.teamId || '').trim();
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    const team = (db.teams || []).find((item) => String(item?.id || '').trim() === teamId);
    if (!tournament || !team) {
      return res.status(404).json({ message: 'Tournament or team not found.' });
    }
    db.tournamentRoomAssignments = db.tournamentRoomAssignments || [];
    const existing = db.tournamentRoomAssignments.find((item) => String(item?.tournamentId || '').trim() === tournamentId && String(item?.teamId || '').trim() === teamId);
    if (existing) {
      return res.status(409).json({ message: 'Team already assigned to this tournament.' });
    }
    const usedSlots = new Set(
      db.tournamentRoomAssignments
        .filter((item) => String(item?.tournamentId || '').trim() === tournamentId)
        .map((item) => String(item?.slot || '').trim())
    );
    let slot = '01';
    for (let index = 1; index <= (Number(tournament.teamLimit) || 12); index += 1) {
      const next = String(index).padStart(2, '0');
      if (!usedSlots.has(next)) {
        slot = next;
        break;
      }
    }
    const timestamp = new Date().toISOString();
    const assignment = {
      id: crypto.randomUUID(),
      roomCode: String(tournament.roomCode || '').trim(),
      tournamentId,
      slot,
      userId: String(team.ownerUserId || '').trim(),
      teamId: String(team.id || '').trim(),
      teamName: String(team.teamName || '').trim(),
      eventKey: 'free-fire',
      publicTeamId: String(team.publicTeamId || '').trim(),
      playerNames: (team.players || []).slice(0, 5).map((player) => String(player?.name || player?.playerId || '').trim()),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.tournamentRoomAssignments.push(assignment);
    tournament.confirmedTeams = db.tournamentRoomAssignments.filter((item) => String(item?.tournamentId || '').trim() === tournamentId).length;
    tournament.updatedAt = timestamp;
    appendAdminAuditLog(db, req.adminActor, 'tournament.team_add', 'tournament', tournament.id, {
      teamId: team.id,
      teamName: team.teamName,
    });
    writeDb(db);
    return res.json({ message: 'Team added to tournament.', tournament: sanitizeAdminTournament(tournament, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not add team to tournament.' });
  }
});

router.post('/tournaments/:tournamentId/teams/:teamId/remove', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const teamId = String(req.params.teamId || '').trim();
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }
    db.tournamentRoomAssignments = (db.tournamentRoomAssignments || []).filter(
      (item) => !(String(item?.tournamentId || '').trim() === tournamentId && String(item?.teamId || '').trim() === teamId)
    );
    tournament.confirmedTeams = db.tournamentRoomAssignments.filter((item) => String(item?.tournamentId || '').trim() === tournamentId).length;
    tournament.updatedAt = new Date().toISOString();
    appendAdminAuditLog(db, req.adminActor, 'tournament.team_remove', 'tournament', tournament.id, {
      teamId,
    });
    writeDb(db);
    return res.json({ message: 'Team removed from tournament.', tournament: sanitizeAdminTournament(tournament, db) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not remove team from tournament.' });
  }
});

router.post('/tournaments/:tournamentId/bookings/:bookingId', requireAdmin, requirePermission('tournaments:write'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const bookingId = String(req.params.bookingId || '').trim();
    const action = normalizeText(req.body.action);
    const note = String(req.body.note || '').trim();
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid booking action.' });
    }
    db.tournamentBookingRequests = db.tournamentBookingRequests || [];
    const booking = db.tournamentBookingRequests.find((item) => String(item?.id || '').trim() === bookingId && String(item?.tournamentId || '').trim() === tournamentId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking request not found.' });
    }
    booking.status = action === 'approve' ? 'approved' : 'rejected';
    booking.adminNote = note;
    booking.updatedAt = new Date().toISOString();

    if (action === 'approve') {
      const alreadyAssigned = (db.tournamentRoomAssignments || []).some(
        (item) => String(item?.tournamentId || '').trim() === tournamentId && String(item?.teamId || '').trim() === String(booking.teamId || '').trim()
      );
      if (!alreadyAssigned) {
        const team = (db.teams || []).find((item) => String(item?.id || '').trim() === String(booking.teamId || '').trim());
        const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
        if (team && tournament) {
          db.tournamentRoomAssignments = db.tournamentRoomAssignments || [];
          const usedSlots = new Set(
            db.tournamentRoomAssignments
              .filter((item) => String(item?.tournamentId || '').trim() === tournamentId)
              .map((item) => String(item?.slot || '').trim())
          );
          let slot = '01';
          for (let index = 1; index <= (Number(tournament.teamLimit) || 12); index += 1) {
            const next = String(index).padStart(2, '0');
            if (!usedSlots.has(next)) {
              slot = next;
              break;
            }
          }
          db.tournamentRoomAssignments.push({
            id: crypto.randomUUID(),
            roomCode: String(tournament.roomCode || booking.roomCode || '').trim(),
            tournamentId,
            slot,
            userId: String(booking.userId || team.ownerUserId || '').trim(),
            teamId: String(team.id || '').trim(),
            teamName: String(booking.teamName || team.teamName || '').trim(),
            eventKey: 'free-fire',
            publicTeamId: String(booking.publicTeamId || team.publicTeamId || '').trim(),
            playerNames: (team.players || []).slice(0, 5).map((player) => String(player?.name || player?.playerId || '').trim()),
            bookingStatus: 'confirmed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    appendAdminAuditLog(db, req.adminActor, `booking.${action}`, 'booking_request', booking.id, {
      tournamentId,
      teamId: booking.teamId,
      note,
    });
    writeDb(db);
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    return res.json({
      message: action === 'approve' ? 'Booking approved.' : 'Booking rejected.',
      tournament: tournament ? sanitizeAdminTournament(tournament, db) : null,
      booking: sanitizeTournamentBookingRequest(booking),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update booking request.' });
  }
});

router.get('/host-applications', requireAdmin, requirePermission('hosts:write'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    let applications = (db.hostApplications || []).map((item) => sanitizeAdminHostApplication(item, db));
    if (status && status !== 'all') {
      applications = applications.filter((item) => normalizeText(item.status) === status);
    }
    if (query) {
      applications = applications.filter((item) =>
        [item.name, item.playerId, item.mobileNumber, item.user?.email, item.user?.name]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }
    applications.sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime());
    return res.json({ applications });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load host applications.' });
  }
});

router.post('/host-applications/:applicationId/moderate', requireAdmin, requirePermission('hosts:write'), (req, res) => {
  try {
    const db = readDb();
    const applicationId = String(req.params.applicationId || '').trim();
    const status = normalizeText(req.body.status);
    const adminNote = String(req.body.adminNote || '').trim();
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid host application status.' });
    }
    const application = (db.hostApplications || []).find((item) => String(item?.id || '').trim() === applicationId);
    if (!application) {
      return res.status(404).json({ message: 'Host application not found.' });
    }
    const before = {
      status: application.status,
      adminNote: application.adminNote || '',
    };
    application.status = status;
    application.adminNote = adminNote;
    application.updatedAt = new Date().toISOString();
    appendAdminAuditLog(db, req.adminActor, `host_application.${status}`, 'host_application', application.id, {
      userId: application.userId,
      before,
      after: {
        status,
        adminNote,
      },
    });
    writeDb(db);
    return res.json({
      message: 'Host application updated successfully.',
      application: sanitizeAdminHostApplication(application, db),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not moderate host application.' });
  }
});

router.get('/finance', requireAdmin, requirePermission('finance:write'), (_req, res) => {
  try {
    const db = readDb();
    const users = Array.isArray(db.users) ? db.users : [];
    const withdrawRequests = Array.isArray(db.withdrawRequests) ? db.withdrawRequests : [];
    const totalCoins = users.reduce((sum, user) => sum + (Number(user?.coins) || 0), 0);
    const totalMissionClaims = users.reduce((sum, user) => {
      const claims = user?.missionRewardClaims || {};
      return sum + Object.keys(claims.missions || {}).length + Object.keys(claims.daily || {}).length;
    }, 0);
    const totalWithdrawApproved = withdrawRequests
      .filter((item) => String(item?.status || '').trim().toLowerCase() === 'approved')
      .reduce((sum, item) => sum + (Number(item?.amount) || 0), 0);
    const recentEvents = [
      ...withdrawRequests.map((item) => ({
        id: `withdraw-${item.id}`,
        type: 'withdraw_request',
        userId: String(item.userId || '').trim(),
        amount: Number(item.amount) || 0,
        gold: Number(item.gold) || 0,
        status: String(item.status || 'pending').trim().toLowerCase(),
        createdAt: item.reviewedAt || item.createdAt || '',
        label: `Withdraw ${item.status || 'pending'}`,
      })),
      ...users.flatMap((user) => {
        const claims = user?.missionRewardClaims || {};
        return [
          ...Object.keys(claims.missions || {}).map((key) => ({
            id: `mission-${user.id}-${key}`,
            type: 'mission_claim',
            userId: user.id,
            amount: 0,
            gold: 0,
            status: 'claimed',
            createdAt: user.createdAt || '',
            label: `Mission claim: ${key}`,
          })),
          ...Object.keys(claims.daily || {}).map((key) => ({
            id: `daily-${user.id}-${key}`,
            type: 'daily_claim',
            userId: user.id,
            amount: 0,
            gold: 0,
            status: 'claimed',
            createdAt: user.createdAt || '',
            label: `Daily claim: ${key}`,
          })),
        ];
      }),
    ]
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
      .slice(0, 20)
      .map((item) => ({
        ...item,
        user: sanitizeAdminUserListItem((db.users || []).find((user) => user.id === item.userId) || {}, db),
      }));
    return res.json({
      summary: {
        totalCoins,
        totalMissionClaims,
        totalWithdrawApproved,
        pendingWithdraws: withdrawRequests.filter((item) => String(item?.status || 'pending').trim().toLowerCase() === 'pending').length,
      },
      topCoinUsers: users
        .map((user) => sanitizeAdminUserListItem(user, db))
        .sort((left, right) => (right.coins || 0) - (left.coins || 0))
        .slice(0, 8),
      withdrawRequests: withdrawRequests
        .slice()
        .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
        .map((item) => ({
          ...item,
          user: sanitizeAdminUserListItem((db.users || []).find((user) => user.id === item.userId) || {}, db),
        })),
      recentEvents,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load finance summary.' });
  }
});

router.get('/withdraw-requests', requireAdmin, requirePermission('finance:write'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    let requests = (db.withdrawRequests || []).map((item) => ({
      id: String(item.id || '').trim(),
      userId: String(item.userId || '').trim(),
      packageId: String(item.packageId || '').trim(),
      gold: Number(item.gold) || 0,
      amount: Number(item.amount) || 0,
      paymentMethod: String(item.paymentMethod || '').trim(),
      paymentNumber: String(item.paymentNumber || '').trim(),
      status: String(item.status || 'pending').trim().toLowerCase(),
      adminNote: String(item.adminNote || '').trim(),
      createdAt: item.createdAt || '',
      reviewedAt: item.reviewedAt || '',
      user: sanitizeAdminUserListItem((db.users || []).find((user) => user.id === item.userId) || {}, db),
    }));
    if (status && status !== 'all') {
      requests = requests.filter((item) => normalizeText(item.status) === status);
    }
    if (query) {
      requests = requests.filter((item) =>
        [item.user?.name, item.user?.email, item.paymentMethod, item.paymentNumber, item.packageId]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }
    requests.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
    return res.json({ requests });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load withdraw requests.' });
  }
});

router.post('/withdraw-requests/:requestId/moderate', requireAdmin, requirePermission('finance:write'), (req, res) => {
  try {
    const db = readDb();
    const requestId = String(req.params.requestId || '').trim();
    const status = normalizeText(req.body.status);
    const adminNote = String(req.body.adminNote || '').trim();
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid withdraw status.' });
    }
    const request = (db.withdrawRequests || []).find((item) => String(item?.id || '').trim() === requestId);
    if (!request) {
      return res.status(404).json({ message: 'Withdraw request not found.' });
    }
    const before = {
      status: request.status,
      adminNote: request.adminNote || '',
      reviewedAt: request.reviewedAt || '',
    };
    request.status = status;
    request.adminNote = adminNote;
    request.reviewedAt = new Date().toISOString();
    request.reviewedByAdminId = String(req.adminActor?.id || '').trim();
    appendAdminAuditLog(db, req.adminActor, `withdraw.${status}`, 'withdraw_request', request.id, {
      userId: request.userId,
      amount: request.amount,
      before,
      after: {
        status,
        adminNote,
        reviewedAt: request.reviewedAt,
      },
    });
    writeDb(db);
    return res.json({
      message: 'Withdraw request updated successfully.',
      request,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update withdraw request.' });
  }
});

router.get('/audit-logs', requireAdmin, requirePermission('settings:read'), (req, res) => {
  try {
    const db = readDb();
    const query = normalizeText(req.query.q);
    let logs = (db.adminAuditLogs || []).slice();
    if (query) {
      logs = logs.filter((item) =>
        [item.action, item.targetType, item.targetId, item.actorName]
          .map((value) => normalizeText(value))
          .some((value) => value.includes(query))
      );
    }
    logs.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
    return res.json({ logs });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load audit logs.' });
  }
});

router.get('/admins', requireAdmin, requirePermission('admins:write'), (req, res) => {
  try {
    const db = readDb();
    const admins = (db.users || [])
      .filter((user) => {
        const role = String(user.role || '').trim().toLowerCase();
        const permissions = Array.isArray(user.permissions) ? user.permissions : [];
        return user.isAdmin === true || ['admin', 'super_admin', 'superadmin', 'moderator', 'support', 'finance'].includes(role) || permissions.includes('admin');
      })
      .map((user) => ({
        ...sanitizeAdminUserListItem(user, db),
        role: String(user.role || 'moderator').trim().toLowerCase(),
        permissions: Array.isArray(user.permissions) ? user.permissions : getAdminPermissions(String(user.role || 'moderator').trim().toLowerCase()),
        disabled: Boolean(user.disabled),
      }));
    return res.json({ admins });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not load admin accounts.' });
  }
});

router.post('/admins', requireAdmin, requirePermission('admins:write'), async (req, res) => {
  try {
    const db = readDb();
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name || '').trim();
    const role = String(req.body.role || 'moderator').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    if (!email || !name || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    }
    if (!ROLE_PERMISSIONS[role]) {
      return res.status(400).json({ message: 'Invalid admin role.' });
    }
    if ((db.users || []).some((user) => normalizeEmail(user.email) === email)) {
      return res.status(409).json({ message: 'A user already exists with this email.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const adminUser = {
      id: crypto.randomUUID(),
      email,
      name,
      passwordHash,
      role,
      permissions: getAdminPermissions(role),
      isAdmin: true,
      verified: true,
      gender: 'other',
      createdAt: new Date().toISOString(),
      disabled: false,
      status: 'Admin account',
    };
    db.users = db.users || [];
    db.users.unshift(adminUser);
    appendAdminAuditLog(db, req.adminActor, 'admin.create', 'admin_user', adminUser.id, { email, role });
    writeDb(db);
    return res.json({
      message: 'Admin account created successfully.',
      adminUser: {
        ...sanitizeAdminUserListItem(adminUser, db),
        role,
        permissions: adminUser.permissions,
        disabled: false,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not create admin account.' });
  }
});

router.post('/admins/:adminUserId', requireAdmin, requirePermission('admins:write'), (req, res) => {
  try {
    const db = readDb();
    const adminUserId = String(req.params.adminUserId || '').trim();
    const adminUser = (db.users || []).find((user) => String(user.id || '').trim() === adminUserId);
    if (!adminUser) {
      return res.status(404).json({ message: 'Admin account not found.' });
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'role')) {
      const role = String(req.body.role || '').trim().toLowerCase();
      if (!ROLE_PERMISSIONS[role]) {
        return res.status(400).json({ message: 'Invalid admin role.' });
      }
      adminUser.role = role;
      adminUser.permissions = getAdminPermissions(role);
      adminUser.isAdmin = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'disabled')) {
      adminUser.disabled = Boolean(req.body.disabled);
    }
    adminUser.updatedAt = new Date().toISOString();
    appendAdminAuditLog(db, req.adminActor, 'admin.update', 'admin_user', adminUser.id, {
      role: adminUser.role,
      disabled: adminUser.disabled,
    });
    writeDb(db);
    return res.json({
      message: 'Admin account updated successfully.',
      adminUser: {
        ...sanitizeAdminUserListItem(adminUser, db),
        role: String(adminUser.role || '').trim().toLowerCase(),
        permissions: Array.isArray(adminUser.permissions) ? adminUser.permissions : [],
        disabled: Boolean(adminUser.disabled),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Could not update admin account.' });
  }
});

module.exports = router;
