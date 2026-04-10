const { ALLOWED_AVATAR_KEYS, MAX_IMAGE_DATA_LENGTH } = require('../config/constants');

function isPresetMediaKey(value) {
  return ALLOWED_AVATAR_KEYS.includes(value);
}

function isDataImageUri(value) {
  return typeof value === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

function isAllowedMediaValue(value) {
  if (value === null) {
    return true;
  }

  if (isPresetMediaKey(value)) {
    return true;
  }

  if (isDataImageUri(value) && value.length <= MAX_IMAGE_DATA_LENGTH) {
    return true;
  }

  return false;
}

module.exports = {
  isPresetMediaKey,
  isDataImageUri,
  isAllowedMediaValue,
};
