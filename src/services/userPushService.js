const { getNotificationSettings } = require('../utils/profile');
const { sendPushNotificationToUsers } = require('./pushNotificationService');

function buildDisplayName(user = {}) {
  return String(user.name || user.fullName || user.username || user.email || 'Someone').trim() || 'Someone';
}

function shouldSendPush(db, userId, settingKey) {
  if (!userId) {
    return false;
  }

  if (!settingKey) {
    return true;
  }

  const settings = getNotificationSettings(db, userId);
  return !!settings?.[settingKey];
}

async function notifyUserById(db, userId, payload = {}, options = {}) {
  const user = (db.users || []).find((item) => item.id === userId);
  if (!user) {
    return { delivered: 0, skipped: true, reason: 'user-not-found' };
  }

  if (!shouldSendPush(db, userId, options.settingKey)) {
    return { delivered: 0, skipped: true, reason: 'disabled-by-settings' };
  }

  return sendPushNotificationToUsers([user], payload);
}

module.exports = {
  buildDisplayName,
  notifyUserById,
};
