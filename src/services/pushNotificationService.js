function normalizeExpoPushToken(value) {
  return String(value || '').trim();
}

function ensureExpoPushTokens(user) {
  if (!Array.isArray(user.expoPushTokens)) {
    user.expoPushTokens = [];
  }
  return user.expoPushTokens;
}

function registerUserExpoPushToken(user, payload = {}) {
  const token = normalizeExpoPushToken(payload.expoPushToken);
  if (!token) {
    return false;
  }

  const tokens = ensureExpoPushTokens(user);
  const now = new Date().toISOString();
  const existingIndex = tokens.findIndex((entry) => normalizeExpoPushToken(entry?.token) === token);
  const nextEntry = {
    token,
    platform: String(payload.platform || '').trim(),
    deviceName: String(payload.deviceName || '').trim(),
    appVersion: String(payload.appVersion || '').trim(),
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    tokens[existingIndex] = {
      ...tokens[existingIndex],
      ...nextEntry,
      createdAt: tokens[existingIndex]?.createdAt || now,
    };
    return false;
  }

  tokens.push({
    ...nextEntry,
    createdAt: now,
  });
  return true;
}

function removeUserExpoPushToken(user, expoPushToken) {
  const token = normalizeExpoPushToken(expoPushToken);
  if (!token || !Array.isArray(user?.expoPushTokens) || !user.expoPushTokens.length) {
    return false;
  }

  const nextTokens = user.expoPushTokens.filter((entry) => normalizeExpoPushToken(entry?.token) !== token);
  if (nextTokens.length === user.expoPushTokens.length) {
    return false;
  }

  user.expoPushTokens = nextTokens;
  return true;
}

function collectExpoPushTokensForUsers(users = []) {
  const dedupe = new Set();
  return users
    .flatMap((user) => (Array.isArray(user?.expoPushTokens) ? user.expoPushTokens : []))
    .map((entry) => normalizeExpoPushToken(entry?.token))
    .filter((token) => token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['))
    .filter((token) => {
      if (dedupe.has(token)) {
        return false;
      }
      dedupe.add(token);
      return true;
    });
}

async function sendExpoPushMessages(messages = []) {
  if (!Array.isArray(messages) || !messages.length) {
    return [];
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Could not send push notification.');
  }

  const result = await response.json();
  return Array.isArray(result?.data) ? result.data : [];
}

async function sendPushNotificationToUsers(users = [], payload = {}) {
  const tokens = collectExpoPushTokensForUsers(users);
  if (!tokens.length) {
    return { delivered: 0, tokens: [] };
  }

  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (!title || !body) {
    throw new Error('Push notification title and body are required.');
  }

  const messages = tokens.map((token) => ({
    to: token,
    sound: payload.sound === false ? undefined : 'default',
    title,
    body,
    data: payload.data && typeof payload.data === 'object' ? payload.data : {},
  }));

  await sendExpoPushMessages(messages);
  return {
    delivered: messages.length,
    tokens,
  };
}

module.exports = {
  registerUserExpoPushToken,
  removeUserExpoPushToken,
  collectExpoPushTokensForUsers,
  sendPushNotificationToUsers,
};
