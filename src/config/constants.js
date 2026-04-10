const path = require('path');

const PORT = Number(process.env.PORT || 4000);
const OTP_TTL_MS = 10 * 60 * 1000;
const DB_FILE = path.join(__dirname, '..', '..', 'data.json');
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const CHAT_UPLOADS_DIR = path.join(UPLOADS_DIR, 'chat');
const SUPPORT_UPLOADS_DIR = path.join(UPLOADS_DIR, 'support');
const MOMENT_UPLOADS_DIR = path.join(UPLOADS_DIR, 'moments');
const PROFILE_VOICE_UPLOADS_DIR = path.join(UPLOADS_DIR, 'profile-voice');

const DEFAULT_CITIES = ['Dhaka', 'Chattogram', 'Sylhet', 'Rajshahi', 'Khulna', 'Barishal'];

const DEFAULT_INTERESTS = {
  woman: ['Coffee', 'Travel', 'Music', 'Late night talks', 'Books', 'Weekend plans'],
  man: ['Road trips', 'Football', 'Chai', 'Gym', 'Movies', 'Long drives'],
};

const REPORT_REASONS = ['Fake profile', 'Abusive behavior', 'Spam or scam', 'Harassment', 'Inappropriate content'];

const ALLOWED_AVATAR_KEYS = ['women', 'men', 'love'];
const MAX_IMAGE_DATA_LENGTH = 20 * 1024 * 1024;
const CHAT_GIFT_CATALOG = [
  { id: 'rose', name: 'Rose', coins: 10 },
  { id: 'ring', name: 'Ring', coins: 40 },
  { id: 'crown', name: 'Crown', coins: 75 },
];

module.exports = {
  PORT,
  OTP_TTL_MS,
  DB_FILE,
  UPLOADS_DIR,
  CHAT_UPLOADS_DIR,
  SUPPORT_UPLOADS_DIR,
  MOMENT_UPLOADS_DIR,
  PROFILE_VOICE_UPLOADS_DIR,
  DEFAULT_CITIES,
  DEFAULT_INTERESTS,
  REPORT_REASONS,
  ALLOWED_AVATAR_KEYS,
  MAX_IMAGE_DATA_LENGTH,
  CHAT_GIFT_CATALOG,
};
