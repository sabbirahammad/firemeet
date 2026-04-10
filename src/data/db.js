const fs = require('fs');
const {
  DB_FILE,
  UPLOADS_DIR,
  CHAT_UPLOADS_DIR,
  SUPPORT_UPLOADS_DIR,
  MOMENT_UPLOADS_DIR,
  PROFILE_VOICE_UPLOADS_DIR,
  CHAT_GIFT_CATALOG,
} = require('../config/constants');
const { isMongoReady } = require('../config/mongo');
const AppState = require('../models/AppState');
const { ensureUserProfileData } = require('../utils/profile');
const { buildPlayerProfile, buildTeamProfile } = require('../utils/eventProfiles');

const APP_STATE_KEY = 'primary';

let cachedDb = null;
let persistQueue = Promise.resolve();

function cloneDb(data) {
  return JSON.parse(JSON.stringify(data));
}

function readDbFile() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function queueMongoPersist(data) {
  if (!isMongoReady()) {
    return;
  }

  const snapshot = cloneDb(data);
  persistQueue = persistQueue
    .then(async () => {
      await AppState.updateOne(
        { key: APP_STATE_KEY },
        {
          $set: {
            key: APP_STATE_KEY,
            data: snapshot,
          },
        },
        {
          upsert: true,
        }
      );
    })
    .catch((error) => {
      console.error('MongoDB state sync failed. Local JSON copy is still available.');
      console.error(error instanceof Error ? error.message : error);
    });
}

async function hydrateDbFromMongo() {
  ensureDb();

  if (!isMongoReady()) {
    cachedDb = readDbFile();
    return cloneDb(cachedDb);
  }

  const snapshot = await AppState.findOne({ key: APP_STATE_KEY }).lean();
  if (snapshot?.data && typeof snapshot.data === 'object') {
    cachedDb = cloneDb(snapshot.data);
    fs.writeFileSync(DB_FILE, JSON.stringify(cachedDb, null, 2));
    return cloneDb(cachedDb);
  }

  const localDb = readDbFile();
  cachedDb = cloneDb(localDb);
  await AppState.updateOne(
    { key: APP_STATE_KEY },
    {
      $set: {
        key: APP_STATE_KEY,
        data: cachedDb,
      },
    },
    {
      upsert: true,
    }
  );
  return cloneDb(cachedDb);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeGamePlayerId(value) {
  return String(value || '').trim().slice(0, 40);
}

function getSnapshotGamePlayerId(user = {}) {
  return normalizeGamePlayerId(user?.gamePlayerSnapshot?.player?.playerId || user?.gamePlayerSnapshot?.profileData?.header?.uid);
}

function getStoredUserGamePlayerId(user = {}) {
  return normalizeGamePlayerId(user?.gamePlayerId) || getSnapshotGamePlayerId(user);
}

function buildPublicTeamId(team = {}, usedIds = new Set()) {
  const ownerSeed = String(team.ownerUserId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || 'TEAM';
  let candidate = String(team.publicTeamId || '').trim().toUpperCase();
  if (candidate && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }

  let attempts = 0;
  do {
    const randomBlock = Math.floor(100000 + Math.random() * 900000);
    candidate = `TM-${ownerSeed}-${randomBlock}`;
    attempts += 1;
  } while (usedIds.has(candidate) && attempts < 50);

  usedIds.add(candidate);
  return candidate;
}

function ensureTeamProfileData(team, usedIds = new Set(), users = []) {
  const nextTeam = {
    ...team,
  };
  let changed = false;

  const publicTeamId = buildPublicTeamId(team, usedIds);
  if (publicTeamId !== team.publicTeamId) {
    nextTeam.publicTeamId = publicTeamId;
    changed = true;
  }
  if (typeof team.verified !== 'boolean') {
    nextTeam.verified = false;
    changed = true;
  }
  if (typeof team.tagline !== 'string') {
    nextTeam.tagline = '';
    changed = true;
  }
  if (typeof team.bio !== 'string') {
    nextTeam.bio = '';
    changed = true;
  }
  if (typeof team.facebook !== 'string') {
    nextTeam.facebook = '';
    changed = true;
  }
  if (typeof team.youtube !== 'string') {
    nextTeam.youtube = '';
    changed = true;
  }
  const players = Array.isArray(team.players) ? team.players : [];
  const hydratedPlayers = players.map((player, index) => {
    const nextPlayer = {
      ...player,
    };
    let playerChanged = false;
    const defaults = {
      realName: '',
      countryFlag: 'BD',
      region: 'South Asia',
      roleTag: index === 0 ? 'IGL' : 'Rusher',
      statusBadge: 'Active',
      kdRatio: '',
      headshotPct: '',
      mvpCount: '',
      trend: 'Stable',
      verified: false,
      bio: '',
    };

    Object.entries(defaults).forEach(([key, value]) => {
      if (typeof value === 'boolean') {
        if (typeof player?.[key] !== 'boolean') {
          nextPlayer[key] = value;
          playerChanged = true;
        }
        return;
      }

      if (typeof player?.[key] !== 'string') {
        nextPlayer[key] = value;
        playerChanged = true;
      }
    });

    const nextProfileData = buildPlayerProfile(
      {
        ...nextTeam,
        players,
      },
      nextPlayer,
      index,
      users
    );
    if (!sameJson(nextPlayer.profileData, nextProfileData)) {
      nextPlayer.profileData = nextProfileData;
      playerChanged = true;
    }

    return playerChanged ? nextPlayer : player;
  });

  if (hydratedPlayers.some((player, index) => player !== players[index])) {
    nextTeam.players = hydratedPlayers;
    changed = true;
  }

  const teamWithPlayers = {
    ...nextTeam,
    players: hydratedPlayers,
  };
  const nextPageData = buildTeamProfile(teamWithPlayers, users);
  if (!sameJson(nextTeam.pageData, nextPageData)) {
    nextTeam.pageData = nextPageData;
    changed = true;
  }

  return changed ? nextTeam : team;
}

function ensureDb() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(CHAT_UPLOADS_DIR)) {
    fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SUPPORT_UPLOADS_DIR)) {
    fs.mkdirSync(SUPPORT_UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(MOMENT_UPLOADS_DIR)) {
    fs.mkdirSync(MOMENT_UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(PROFILE_VOICE_UPLOADS_DIR)) {
    fs.mkdirSync(PROFILE_VOICE_UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], pendingSignups: [] }, null, 2));
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  cachedDb = cloneDb(data);
  queueMongoPersist(cachedDb);
}

function readDb() {
  ensureDb();

  const db = cloneDb(cachedDb || readDbFile());
  let changed = false;
  const usedProfileIds = new Set();
  const usedTeamIds = new Set();

  db.users = (db.users || []).map((user, index) => {
    const hydrated = ensureUserProfileData(user, index, usedProfileIds);
    changed = changed || hydrated !== user;
    return hydrated;
  });
  db.pendingSignups = db.pendingSignups || [];
  db.follows = db.follows || [];
  db.hiMessages = db.hiMessages || [];
  db.chatMessages = db.chatMessages || [];
  db.blocks = db.blocks || [];
  db.reports = db.reports || [];
  db.privacySettings = db.privacySettings || [];
  db.notificationSettings = db.notificationSettings || [];
  db.uiState = db.uiState || [];
  db.sessions = db.sessions || [];
  db.giftTransactions = db.giftTransactions || [];
  db.chatDrafts = db.chatDrafts || [];
  db.chatGiftCatalog = db.chatGiftCatalog || CHAT_GIFT_CATALOG;
  db.callLogs = db.callLogs || [];
  db.tournamentPointsEntries = db.tournamentPointsEntries || [];
  db.teams = (db.teams || []).map((team) => {
    const hydrated = ensureTeamProfileData(team, usedTeamIds, db.users || []);
    changed = changed || hydrated !== team;
    return hydrated;
  });
  db.tournaments = db.tournaments || [];
  db.tournamentRoomAssignments = db.tournamentRoomAssignments || [];
  db.tournamentRoomBoards = db.tournamentRoomBoards || [];
  db.tournamentRoomBoardMeta = db.tournamentRoomBoardMeta || [];
  db.tournamentGroupDrops = db.tournamentGroupDrops || [];
  db.moments = db.moments || [];
  db.momentNotifications = db.momentNotifications || [];
  db.momentRateLimits = db.momentRateLimits || [];
  db.interactionNotifications = db.interactionNotifications || [];
  db.withdrawRequests = db.withdrawRequests || [];
  db.supportThreads = db.supportThreads || [];
  db.hostApplications = db.hostApplications || [];

  db.users = db.users.map((user) => {
    if (normalizeGamePlayerId(user.gamePlayerId) || !getSnapshotGamePlayerId(user)) {
      return user;
    }

    changed = true;
    return {
      ...user,
      gamePlayerId: getSnapshotGamePlayerId(user),
    };
  });

  (db.teams || []).forEach((team) => {
    (team?.players || []).forEach((player) => {
      let connectedUserId = String(player?.connectedUserId || '').trim();
      const connectedProfileValue = String(player?.connectedProfileValue || '').trim();
      const playerId = String(player?.playerId || '').trim().slice(0, 40);
      if (!connectedUserId && connectedProfileValue) {
        const linkedUser = (db.users || []).find((item) => String(item?.appProfileId || '').trim() === connectedProfileValue);
        if (linkedUser) {
          player.connectedUserId = linkedUser.id;
          player.connectedProfile = true;
          connectedUserId = linkedUser.id;
          changed = true;
        }
      }

      if (!connectedUserId && playerId) {
        const linkedUser = (db.users || []).find(
          (item) => getStoredUserGamePlayerId(item).toUpperCase() === playerId.toUpperCase()
        );
        if (linkedUser) {
          player.connectedUserId = linkedUser.id;
          player.connectedProfile = true;
          player.connectedProfileValue = String(linkedUser.appProfileId || '').trim().slice(0, 80);
          connectedUserId = linkedUser.id;
          changed = true;
        }
      }

      if (!connectedUserId || !playerId) {
        return;
      }

      const user = (db.users || []).find((item) => item.id === connectedUserId);
      if (!user || String(user.gamePlayerId || '').trim()) {
        return;
      }

      user.gamePlayerId = playerId;
      changed = true;
    });
  });

  db.users = db.users.map((user) => {
    if (typeof user.coins === 'number') {
      return user;
    }

    changed = true;
    return {
      ...user,
      coins: 120,
    };
  });

  if (changed) {
    writeDb(db);
  }

  return db;
}

module.exports = {
  ensureDb,
  hydrateDbFromMongo,
  readDb,
  writeDb,
};
