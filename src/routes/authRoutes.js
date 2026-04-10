const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OTP_TTL_MS } = require('../config/constants');
const { readDb, writeDb } = require('../data/db');
const { sendOtpMail } = require('../services/mailService');
const { normalizeEmail, isValidEmail, generateOtp, sendServerError, findByField, findById } = require('../utils/common');
const { buildAppProfileId, sanitizeUser } = require('../utils/profile');
const { createSession, getSessionFromRequest, removeSessionByToken, requireAuthorizedUser } = require('../utils/authSession');
const { markDailyLogin, syncMissionSections } = require('../utils/missions');
const {
  registerUserExpoPushToken,
  removeUserExpoPushToken,
  sendPushNotificationToUsers,
} = require('../services/pushNotificationService');

const router = express.Router();

router.get('/session', (req, res) => {
  try {
    const db = readDb();
    const session = getSessionFromRequest(db, req);
    if (!session?.userId) {
      return res.status(401).json({ message: 'Session not found.' });
    }

    const user = findById(db.users, session.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    writeDb(db);
    return res.json({
      message: 'Session restored.',
      token: session.token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not restore session.');
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!isValidEmail(email) || password.length < 6) {
      return res.status(400).json({ message: 'Valid email and password are required.' });
    }

    const db = readDb();
    const user = findByField(db.users, 'email', email);

    if (!user) {
      return res.status(401).json({ message: 'No account found for this email.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      return res.status(401).json({ message: 'Incorrect password.' });
    }

    markDailyLogin(user);
    const missionResult = syncMissionSections(db, user.id, { skipConversationScan: true });
    const session = createSession(db, user.id);
    writeDb(db);

    return res.json({
      message: 'Login successful.',
      token: session.token,
      user: sanitizeUser(missionResult.user || user),
      missionRewards: missionResult.newlyClaimedMissions || [],
    });
  } catch (error) {
    return sendServerError(res, error, 'Login failed.');
  }
});

router.post('/logout', (req, res) => {
  try {
    const db = readDb();
    const session = getSessionFromRequest(db, req);
    if (!session?.token) {
      return res.status(401).json({ message: 'Session not found.' });
    }

    removeSessionByToken(db, session.token);
    writeDb(db);
    return res.json({ message: 'Logout successful.' });
  } catch (error) {
    return sendServerError(res, error, 'Logout failed.');
  }
});

router.post('/push-token', (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, userId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const user = findById(db.users, userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const expoPushToken = String(req.body.expoPushToken || '').trim();
    if (!expoPushToken) {
      return res.status(400).json({ message: 'Expo push token is required.' });
    }

    const created = registerUserExpoPushToken(user, {
      expoPushToken,
      platform: req.body.platform,
      deviceName: req.body.deviceName,
      appVersion: req.body.appVersion,
    });

    writeDb(db);
    return res.json({
      message: created ? 'Push token registered.' : 'Push token updated.',
      registered: true,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not register push token.');
  }
});

router.post('/push-token/remove', (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, userId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const user = findById(db.users, userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const removed = removeUserExpoPushToken(user, req.body.expoPushToken);
    if (removed) {
      writeDb(db);
    }

    return res.json({
      message: removed ? 'Push token removed.' : 'Push token was already removed.',
      removed,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not remove push token.');
  }
});

router.post('/push-token/test', async (req, res) => {
  try {
    const db = readDb();
    const userId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, userId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const user = findById(db.users, userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const result = await sendPushNotificationToUsers([user], {
      title: String(req.body.title || 'Notifications ready').trim(),
      body: String(req.body.body || 'Expo push notification is working on this device.').trim(),
      data: req.body.data,
    });

    return res.json({
      message: result.delivered ? 'Test notification sent.' : 'No registered push token found for this account.',
      delivered: result.delivered,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send test notification.');
  }
});

router.post('/send-signup-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const db = readDb();

    if (db.users.some((item) => item.email === email)) {
      return res.status(409).json({ message: 'This email is already registered.' });
    }

    const code = generateOtp();
    const passwordHash = await bcrypt.hash(password, 10);
    const expiresAt = Date.now() + OTP_TTL_MS;
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    db.pendingSignups = db.pendingSignups.filter((item) => item.email !== email);
    db.pendingSignups.push({
      email,
      passwordHash,
      codeHash,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    writeDb(db);

    await sendOtpMail(email, code);

    return res.json({ message: 'Verification code sent to your email.' });
  } catch (error) {
    return sendServerError(res, error, 'Could not send code.');
  }
});

router.post('/verify-signup-code', (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();

    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'Valid email and 6 digit code are required.' });
    }

    const db = readDb();
    const usedProfileIds = new Set((db.users || []).map((item) => String(item.appProfileId || '').trim()).filter(Boolean));
    const pending = db.pendingSignups.find((item) => item.email === email);

    if (!pending) {
      return res.status(404).json({ message: 'No pending signup found for this email.' });
    }

    if (pending.expiresAt < Date.now()) {
      db.pendingSignups = db.pendingSignups.filter((item) => item.email !== email);
      writeDb(db);
      return res.status(410).json({ message: 'Code expired. Request a new code.' });
    }

    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    if (pending.codeHash !== codeHash) {
      return res.status(401).json({ message: 'Incorrect verification code.' });
    }

    const createdAt = new Date().toISOString();
    const userId = crypto.randomUUID();
    const user = {
      id: userId,
      appProfileId: buildAppProfileId(
        {
          id: userId,
          email,
          createdAt,
        },
        usedProfileIds
      ),
      email,
      passwordHash: pending.passwordHash,
      gender: null,
      createdAt,
    };

    db.users.push(user);
    db.pendingSignups = db.pendingSignups.filter((item) => item.email !== email);
    writeDb(db);

    return res.status(201).json({
      message: 'Signup completed successfully.',
      user: sanitizeUser(user),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not verify code.');
  }
});

module.exports = router;
