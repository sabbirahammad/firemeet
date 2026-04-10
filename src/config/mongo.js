const mongoose = require('mongoose');

const mongoState = {
  ready: false,
  uri: '',
};

async function connectMongo() {
  const mongoUri = String(process.env.MONGODB_URI || '').trim();

  if (!mongoUri) {
    console.warn('MongoDB URI not configured. Continuing with JSON storage only.');
    return false;
  }

  if (mongoose.connection.readyState === 1) {
    mongoState.ready = true;
    mongoState.uri = mongoUri;
    return true;
  }

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });

  mongoState.ready = true;
  mongoState.uri = mongoUri;
  console.log(`MongoDB connected: ${mongoose.connection.name || 'default'}`);
  return true;
}

function isMongoReady() {
  return mongoState.ready && mongoose.connection.readyState === 1;
}

module.exports = {
  connectMongo,
  isMongoReady,
};
