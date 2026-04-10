const { isAllowedMediaValue } = require('./media');

function validateGallerySlotInput(body = {}, options = {}) {
  const userId = String(body.userId || '').trim();
  const slotIndex = Number(body.slotIndex);
  const mediaKey = body.mediaKey === null || body.mediaKey === undefined ? null : String(body.mediaKey || '').trim();
  const { allowEmpty = false } = options;

  if (!userId) {
    return { error: 'User id is required.' };
  }

  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 5) {
    return { error: 'Slot index must be between 0 and 5.' };
  }

  if (!allowEmpty && !isAllowedMediaValue(mediaKey)) {
    return { error: 'Invalid media key.' };
  }

  if (allowEmpty && mediaKey !== null && !isAllowedMediaValue(mediaKey)) {
    return { error: 'Invalid media key.' };
  }

  return {
    value: {
      userId,
      slotIndex,
      mediaKey,
    },
  };
}

module.exports = {
  validateGallerySlotInput,
};
