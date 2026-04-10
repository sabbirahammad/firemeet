const dotenv = require('dotenv');
const http = require('http');

dotenv.config();

const { PORT } = require('./src/config/constants');
const { connectMongo } = require('./src/config/mongo');
const { ensureDb, hydrateDbFromMongo } = require('./src/data/db');
const { createApp } = require('./src/app');
const { initSocket } = require('./src/socket');

const app = createApp();
const server = http.createServer(app);

initSocket(server);

async function startServer() {
  ensureDb();

  server.listen(PORT, () => {
    console.log(`FireMeet backend running on port ${PORT}`);
  });

  try {
    await connectMongo();
  } catch (error) {
    console.error('MongoDB connection failed. Server will continue with JSON storage only.');
    console.error(error instanceof Error ? error.message : error);
  }

  try {
    await hydrateDbFromMongo();
  } catch (error) {
    console.error('MongoDB hydration failed. Server will continue with current JSON storage.');
    console.error(error instanceof Error ? error.message : error);
  }
}

startServer();
