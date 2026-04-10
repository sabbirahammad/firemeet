const { getSoulLinkConversationState } = require('./chat');

function getCoinBalance(user) {
  return Math.max(Math.floor(Number(user?.coins) || 0), 0);
}

function setCoinBalance(user, nextValue) {
  user.coins = Math.max(Math.floor(Number(nextValue) || 0), 0);
}

function ensureInteractionLedger(user) {
  if (!user || typeof user !== 'object') {
    return {};
  }

  if (!user.interactionCoinLedger || typeof user.interactionCoinLedger !== 'object') {
    user.interactionCoinLedger = {};
  }

  const defaults = {
    textMessagesToWomen: 0,
    textMessagesFromMen: 0,
    videoCallMsToWomen: 0,
    videoCallMsFromMen: 0,
    audioCallMsToWomen: 0,
    audioCallMsFromMen: 0,
  };

  Object.entries(defaults).forEach(([key, value]) => {
    if (!Number.isFinite(Number(user.interactionCoinLedger[key]))) {
      user.interactionCoinLedger[key] = value;
    }
  });

  return user.interactionCoinLedger;
}

function getUsersByIds(db, leftUserId, rightUserId) {
  const users = Array.isArray(db?.users) ? db.users : [];
  const leftUser = users.find((item) => item.id === leftUserId);
  const rightUser = users.find((item) => item.id === rightUserId);
  return { leftUser, rightUser };
}

function getSenderManReceiverWoman(db, fromUserId, toUserId) {
  const { leftUser, rightUser } = getUsersByIds(db, fromUserId, toUserId);
  if (!leftUser || !rightUser) {
    return null;
  }

  if (leftUser.gender !== 'man' || rightUser.gender !== 'woman') {
    return null;
  }

  return {
    manUser: leftUser,
    womanUser: rightUser,
    manLedger: ensureInteractionLedger(leftUser),
    womanLedger: ensureInteractionLedger(rightUser),
  };
}

function getCrossGenderPair(db, leftUserId, rightUserId) {
  const { leftUser, rightUser } = getUsersByIds(db, leftUserId, rightUserId);
  if (!leftUser || !rightUser) {
    return null;
  }

  if (leftUser.gender === 'man' && rightUser.gender === 'woman') {
    return {
      manUser: leftUser,
      womanUser: rightUser,
      manLedger: ensureInteractionLedger(leftUser),
      womanLedger: ensureInteractionLedger(rightUser),
    };
  }

  if (leftUser.gender === 'woman' && rightUser.gender === 'man') {
    return {
      manUser: rightUser,
      womanUser: leftUser,
      manLedger: ensureInteractionLedger(rightUser),
      womanLedger: ensureInteractionLedger(leftUser),
    };
  }

  return null;
}

function applyStepCounter(ledger, key, increment, divisor) {
  const previous = Math.max(Math.floor(Number(ledger[key]) || 0), 0);
  const next = previous + increment;
  ledger[key] = next;
  return Math.floor(next / divisor) - Math.floor(previous / divisor);
}

function applyDurationCounter(ledger, key, durationMs, divisorMs) {
  const previous = Math.max(Math.floor(Number(ledger[key]) || 0), 0);
  const next = previous + Math.max(Math.floor(Number(durationMs) || 0), 0);
  ledger[key] = next;
  return Math.floor(next / divisorMs) - Math.floor(previous / divisorMs);
}

function getCeilBucketCount(durationMs, bucketMs, minimumMs = 1) {
  const duration = Math.max(Math.floor(Number(durationMs) || 0), 0);
  if (duration < minimumMs) {
    return 0;
  }

  return Math.ceil(duration / bucketMs);
}

function pushAffected(affectedUserIds, userId) {
  if (userId && !affectedUserIds.includes(userId)) {
    affectedUserIds.push(userId);
  }
}

function isLockedSoulLinkConversation(db, leftUserId, rightUserId) {
  const state = getSoulLinkConversationState(db, leftUserId, rightUserId);
  return !!state?.soulLinkLocked;
}

function applyManToWomanTextCoins(db, fromUserId, toUserId) {
  if (isLockedSoulLinkConversation(db, fromUserId, toUserId)) {
    return [];
  }

  const relation = getSenderManReceiverWoman(db, fromUserId, toUserId);
  if (!relation) {
    return [];
  }

  const affectedUserIds = [];
  const senderCharge = applyStepCounter(relation.manLedger, 'textMessagesToWomen', 1, 5);
  if (senderCharge > 0) {
    setCoinBalance(relation.manUser, getCoinBalance(relation.manUser) - senderCharge);
    pushAffected(affectedUserIds, relation.manUser.id);
  }

  const womanReward = applyStepCounter(relation.womanLedger, 'textMessagesFromMen', 1, 10);
  if (womanReward > 0) {
    setCoinBalance(relation.womanUser, getCoinBalance(relation.womanUser) + womanReward);
    pushAffected(affectedUserIds, relation.womanUser.id);
  }

  return affectedUserIds;
}

function applyManToWomanVoiceCoins(db, fromUserId, toUserId) {
  if (isLockedSoulLinkConversation(db, fromUserId, toUserId)) {
    return [];
  }

  const relation = getSenderManReceiverWoman(db, fromUserId, toUserId);
  if (!relation) {
    return [];
  }

  setCoinBalance(relation.manUser, getCoinBalance(relation.manUser) - 1);
  setCoinBalance(relation.womanUser, getCoinBalance(relation.womanUser) + 1);
  return [relation.manUser.id, relation.womanUser.id];
}

function applyGiftCoinsToWoman(db, fromUserId, toUserId, giftCoins) {
  if (isLockedSoulLinkConversation(db, fromUserId, toUserId)) {
    return [];
  }

  const relation = getSenderManReceiverWoman(db, fromUserId, toUserId);
  if (!relation) {
    return [];
  }

  const bonus = Math.floor((Number(giftCoins) || 0) / 2);
  if (bonus <= 0) {
    return [];
  }

  setCoinBalance(relation.womanUser, getCoinBalance(relation.womanUser) + bonus);
  return [relation.womanUser.id];
}

function applyCallCoins(db, leftUserId, rightUserId, mediaType, durationMs) {
  if (isLockedSoulLinkConversation(db, leftUserId, rightUserId)) {
    return [];
  }

  const relation = getCrossGenderPair(db, leftUserId, rightUserId);
  const duration = Math.max(Math.floor(Number(durationMs) || 0), 0);
  if (!relation || duration <= 0) {
    return [];
  }

  const affectedUserIds = [];
  if (mediaType === 'video') {
    const senderCharge = getCeilBucketCount(duration, 60 * 1000, 1);
    if (senderCharge > 0) {
      setCoinBalance(relation.manUser, getCoinBalance(relation.manUser) - senderCharge);
      pushAffected(affectedUserIds, relation.manUser.id);
    }

    const womanReward = getCeilBucketCount(duration, 2 * 60 * 1000, 30 * 1000);
    if (womanReward > 0) {
      setCoinBalance(relation.womanUser, getCoinBalance(relation.womanUser) + womanReward);
      pushAffected(affectedUserIds, relation.womanUser.id);
    }
    return affectedUserIds;
  }

  const senderCharge = applyDurationCounter(relation.manLedger, 'audioCallMsToWomen', duration, 2 * 60 * 1000);
  if (senderCharge > 0) {
    setCoinBalance(relation.manUser, getCoinBalance(relation.manUser) - senderCharge);
    pushAffected(affectedUserIds, relation.manUser.id);
  }

  const womanReward = applyDurationCounter(relation.womanLedger, 'audioCallMsFromMen', duration, 4 * 60 * 1000);
  if (womanReward > 0) {
    setCoinBalance(relation.womanUser, getCoinBalance(relation.womanUser) + womanReward);
    pushAffected(affectedUserIds, relation.womanUser.id);
  }

  return affectedUserIds;
}

module.exports = {
  applyCallCoins,
  applyGiftCoinsToWoman,
  applyManToWomanTextCoins,
  applyManToWomanVoiceCoins,
};
