function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function limitString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function sendServerError(res, error, fallbackMessage) {
  return res.status(500).json({
    message: error?.message || fallbackMessage,
  });
}

function findById(records = [], id) {
  const normalizedId = String(id || '').trim();
  return (
    (Array.isArray(records) ? records : []).find(
      (item) => String(item?.id || '').trim() === normalizedId
    ) || null
  );
}

function findByField(records = [], field, value) {
  const normalizedValue = String(value || '').trim();
  return (
    (Array.isArray(records) ? records : []).find(
      (item) => String(item?.[field] || '').trim() === normalizedValue
    ) || null
  );
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  generateOtp,
  limitString,
  sendServerError,
  findById,
  findByField,
};
