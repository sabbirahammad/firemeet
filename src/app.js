const express = require('express');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const discoverRoutes = require('./routes/discoverRoutes');
const chatRoutes = require('./routes/chatRoutes');
const eventRoutes = require('./routes/eventRoutes');
const momentRoutes = require('./routes/momentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { UPLOADS_DIR } = require('./config/constants');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use('/uploads', express.static(path.resolve(UPLOADS_DIR)));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'mydating-auth-api' });
  });

  app.use('/auth', authRoutes);
  app.use('/profile', profileRoutes);
  app.use('/discover', discoverRoutes);
  app.use('/chat', chatRoutes);
  app.use('/events', eventRoutes);
  app.use('/moments', momentRoutes);
  app.use('/admin', adminRoutes);

  app.use((error, _req, res, next) => {
    if (!error) {
      return next();
    }

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        message: 'Selected image is too large. Please choose a smaller image.',
      });
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        message: 'Selected image is too large. Please choose an image under 10MB.',
      });
    }

    return res.status(500).json({
      message: error.message || 'Internal server error.',
    });
  });

  return app;
}

module.exports = {
  createApp,
};
