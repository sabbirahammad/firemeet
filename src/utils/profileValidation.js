const { ALLOWED_AVATAR_KEYS, REPORT_REASONS } = require('../config/constants');
const { limitString } = require('./common');

function validateProfileUpdateInput(body = {}) {
  const updates = {};

  if (body.name !== undefined) {
    const name = limitString(body.name, 40);
    updates.name = name;
  }

  if (body.age !== undefined) {
    if (body.age === '' || body.age === null) {
      updates.age = null;
    } else {
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 18 || age > 80) {
      return { error: 'Age must be a number between 18 and 80.' };
    }
    updates.age = age;
    }
  }

  if (body.city !== undefined) {
    const city = limitString(body.city, 30);
    updates.city = city;
  }

  if (body.status !== undefined) {
    const status = limitString(body.status, 120);
    updates.status = status;
  }

  if (body.about !== undefined) {
    const about = limitString(body.about, 400);
    updates.about = about;
  }

  if (body.voiceIntroText !== undefined) {
    const voiceIntroText = limitString(body.voiceIntroText, 140);
    updates.voiceIntroText = voiceIntroText;
  }

  if (body.interests !== undefined) {
    if (!Array.isArray(body.interests)) {
      return { error: 'Interests must be an array.' };
    }

    const interests = body.interests
      .map((item) => limitString(item, 24))
      .filter(Boolean)
      .slice(0, 8);

    updates.interests = interests;
  }

  if (body.avatarKey !== undefined) {
    if (!ALLOWED_AVATAR_KEYS.includes(body.avatarKey)) {
      return { error: 'Invalid avatar key.' };
    }
    updates.avatarKey = body.avatarKey;
  }

  if (body.galleryKeys !== undefined) {
    if (!Array.isArray(body.galleryKeys)) {
      return { error: 'Gallery keys must be an array.' };
    }

    const galleryKeys = body.galleryKeys.filter((item) => ALLOWED_AVATAR_KEYS.includes(item)).slice(0, 6);
    if (galleryKeys.length < 3) {
      return { error: 'Gallery must include at least 3 valid items.' };
    }
    updates.galleryKeys = galleryKeys;
  }

  return { updates };
}

function validateReportInput(reason, details) {
  if (!REPORT_REASONS.includes(reason)) {
    return { error: 'Invalid report reason.' };
  }

  const normalizedDetails = limitString(details, 280);
  return {
    report: {
      reason,
      details: normalizedDetails,
    },
  };
}

module.exports = {
  validateProfileUpdateInput,
  validateReportInput,
};
