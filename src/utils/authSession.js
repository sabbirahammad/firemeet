const crypto = require('crypto');

function buildToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureSessions(db) {
  db.sessions = db.sessions || [];
  return db.sessions;
}

function createSession(db, userId) {
  const sessions = ensureSessions(db);
  const token = buildToken();
  const session = {
    token,
    userId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  sessions.push(session);
  return session;
}

function getSessionFromRequest(db, req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  return getSessionByToken(db, token);
}

function getSessionByToken(db, token) {
  const normalizedToken = String(token || '').trim();

  if (!normalizedToken) {
    return null;
  }

  const session = ensureSessions(db).find((item) => item.token === normalizedToken);
  if (session) {
    session.lastUsedAt = new Date().toISOString();
  }
  return session || null;
}

function removeSessionByToken(db, token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return false;
  }

  const sessions = ensureSessions(db);
  const nextSessions = sessions.filter((item) => item.token !== normalizedToken);
  if (nextSessions.length === sessions.length) {
    return false;
  }

  db.sessions = nextSessions;
  return true;
}

function getSessionFromSocket(db, socket) {
  const token = String(socket?.handshake?.auth?.token || '');
  return getSessionByToken(db, token);
}

function getAuthenticatedUserIdFromSocket(db, socket) {
  const session = getSessionFromSocket(db, socket);
  return session ? session.userId : '';
}

function getAuthenticatedUserId(db, req) {
  const session = getSessionFromRequest(db, req);
  return session ? session.userId : '';
}

function assertAuthorizedUser(db, req, targetUserId) {
  const authenticatedUserId = getAuthenticatedUserId(db, req);

  if (!authenticatedUserId) {
    return { error: 'Authentication required.' };
  }

  if (targetUserId && authenticatedUserId !== targetUserId) {
    return { error: 'You are not allowed to act for this user.' };
  }

  return { userId: authenticatedUserId };
}

function requireAuthorizedUser(db, req, targetUserId) {
  const authorization = assertAuthorizedUser(db, req, targetUserId);
  if (authorization.error) {
    return {
      errorResponse: {
        status: 401,
        message: authorization.error,
      },
    };
  }

  return { userId: authorization.userId };
}

module.exports = {
  createSession,
  getSessionByToken,
  getSessionFromRequest,
  getSessionFromSocket,
  getAuthenticatedUserId,
  getAuthenticatedUserIdFromSocket,
  assertAuthorizedUser,
  requireAuthorizedUser,
  removeSessionByToken,
};
