const crypto = require('crypto');

const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.JWT_SECRET || 'firemeet-dev-secret').trim();
const TOKEN_VERSION = 'v1';

function buildLegacyToken() {
  return crypto.randomBytes(24).toString('hex');
}

function buildSignedToken(userId) {
  const payload = {
    userId: String(userId || '').trim(),
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
    version: TOKEN_VERSION,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encodedPayload).digest('base64url');
  return `fm.${encodedPayload}.${signature}`;
}

function parseSignedToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken.startsWith('fm.')) {
    return null;
  }

  const [, encodedPayload = '', signature = ''] = normalizedToken.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(encodedPayload).digest('base64url');
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload?.userId) {
      return null;
    }
    return {
      token: normalizedToken,
      userId: String(payload.userId).trim(),
      createdAt: payload.issuedAt ? new Date(payload.issuedAt).toISOString() : '',
      lastUsedAt: new Date().toISOString(),
      stateless: true,
    };
  } catch (_error) {
    return null;
  }
}

function ensureSessions(db) {
  db.sessions = db.sessions || [];
  return db.sessions;
}

function createSession(db, userId) {
  const statelessSession = {
    token: buildSignedToken(userId),
    userId: String(userId || '').trim(),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    stateless: true,
  };

  if (!db) {
    return statelessSession;
  }

  const sessions = ensureSessions(db);
  const token = buildLegacyToken();
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

  const signedSession = parseSignedToken(normalizedToken);
  if (signedSession) {
    return signedSession;
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

  if (normalizedToken.startsWith('fm.')) {
    return true;
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
