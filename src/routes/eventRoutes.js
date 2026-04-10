const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { readDb, writeDb } = require('../data/db');
const { CHAT_UPLOADS_DIR } = require('../config/constants');
const { emitToUser, isUserOnline } = require('../socket');
const { requireAuthorizedUser } = require('../utils/authSession');
const { sendServerError, findById } = require('../utils/common');
const { buildPlayerProfile, buildTeamProfile } = require('../utils/eventProfiles');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const tournamentChatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CHAT_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '') || '';
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});
const tournamentChatUpload = multer({
  storage: tournamentChatStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

function findUserById(db = {}, userId = '') {
  return findById(db.users, userId);
}

function findTeamById(db = {}, teamId = '') {
  return findById(db.teams, teamId);
}

function findTournamentById(db = {}, tournamentId = '') {
  return findById(db.tournaments, tournamentId);
}

function sanitizePlayerBase(player = {}) {
  return {
    name: String(player.name || '').trim().slice(0, 40),
    playerId: String(player.playerId || '').trim().slice(0, 40),
    realName: String(player.realName || '').trim().slice(0, 60),
    countryFlag: String(player.countryFlag || 'BD').trim().slice(0, 4).toUpperCase(),
    region: String(player.region || 'South Asia').trim().slice(0, 40),
    roleTag: String(player.roleTag || '').trim().slice(0, 24),
    statusBadge: String(player.statusBadge || 'Active').trim().slice(0, 24),
    kdRatio: String(player.kdRatio || '').trim().slice(0, 12),
    headshotPct: String(player.headshotPct || '').trim().slice(0, 12),
    mvpCount: String(player.mvpCount || '').trim().slice(0, 12),
    trend: String(player.trend || 'Stable').trim().slice(0, 24),
    verified: Boolean(player.verified),
    bio: String(player.bio || '').trim().slice(0, 240),
    connectedProfile: Boolean(player.connectedProfile),
    connectedProfileValue: String(player.connectedProfileValue || '').trim().slice(0, 80),
    connectedUserId: String(player.connectedUserId || '').trim(),
  };
}

function sanitizeTeam(team, db = {}) {
  const rawPlayers = Array.isArray(team?.players) ? team.players : [];
  const players = rawPlayers.map(sanitizePlayerBase);
  const leaderIndex =
    Number.isInteger(team.leaderIndex) && team.leaderIndex >= 0 && team.leaderIndex < players.length
      ? team.leaderIndex
      : 0;

  return {
    id: team.id,
    ownerUserId: team.ownerUserId,
    eventKey: team.eventKey,
    teamName: team.teamName,
    publicTeamId: team.publicTeamId || '',
    verified: Boolean(team.verified),
    tagline: String(team.tagline || ''),
    bio: String(team.bio || ''),
    facebook: String(team.facebook || ''),
    youtube: String(team.youtube || ''),
    logoUrl: team.logoUrl || '',
    coverUrl: team.coverUrl || '',
    players: players.map((player, index) => ({
      ...player,
      playerProfile: buildPlayerProfile(team, rawPlayers[index] || {}, index, db.users || []),
    })),
    leaderIndex,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    teamProfile: buildTeamProfile(team, db.users || []),
  };
}

function refreshTeamStoredProfiles(team, db = {}) {
  const users = db.users || [];
  const players = (team.players || []).map((player, index) => ({
    ...player,
    profileData: buildPlayerProfile(team, player, index, users),
  }));
  const nextTeam = {
    ...team,
    players,
  };

  return {
    ...nextTeam,
    pageData: buildTeamProfile(nextTeam, users),
  };
}

function getTeamIdentityTokens(team = {}) {
  return Array.from(
    new Set(
      [
        String(team?.id || '').trim() ? `id:${String(team.id).trim()}` : '',
        String(team?.publicTeamId || '').trim() ? `public:${String(team.publicTeamId).trim().toLowerCase()}` : '',
        String(team?.teamName || '').trim() ? `name:${String(team.teamName).trim().toLowerCase()}` : '',
      ].filter(Boolean)
    )
  );
}

function matchesTeamIdentity(left = {}, right = {}) {
  const leftTokens = getTeamIdentityTokens(left);
  const rightTokenSet = new Set(getTeamIdentityTokens(right));
  return leftTokens.some((token) => rightTokenSet.has(token));
}

function formatPlacementLabel(rank) {
  if (rank === 1) {
    return 'Champion';
  }
  if (rank === 2) {
    return 'Runner-up';
  }
  if (rank === 3) {
    return '3rd Place';
  }
  if (rank > 0) {
    return `#${rank}`;
  }
  return 'Unranked';
}

function buildTeamMatchScore(teamEntry = {}) {
  const kills =
    Number.parseInt(
      String(teamEntry?.kills || teamEntry?.teamKills || teamEntry?.totalKills || teamEntry?.killPoints || '0').trim(),
      10
    ) || 0;
  const placement = Number.parseInt(String(teamEntry?.placement || '0').trim(), 10) || 0;
  const placementPoints = Number.parseInt(String(teamEntry?.placementPoints || '0').trim(), 10) || 0;
  const totalPoints = Number.parseInt(String(teamEntry?.totalPoints || teamEntry?.points || '0').trim(), 10) || 0;
  return {
    effectiveKills: kills,
    placement,
    placementPoints: placementPoints || Math.max(0, totalPoints - kills),
    totalPoints: totalPoints || kills + placementPoints,
  };
}

function getPlayerIdentityTokens(player = {}, slotIndex = -1) {
  return Array.from(
    new Set(
      [
        String(player?.connectedUserId || '').trim() ? `user:${String(player.connectedUserId).trim()}` : '',
        String(player?.connectedProfileValue || '').trim()
          ? `profile:${String(player.connectedProfileValue).trim().toLowerCase()}`
          : '',
        String(player?.playerId || '').trim() ? `uid:${String(player.playerId).trim().toLowerCase()}` : '',
        String(player?.name || '').trim() ? `name:${String(player.name).trim().toLowerCase()}` : '',
        Number.isInteger(slotIndex) && slotIndex >= 0 ? `slot:${slotIndex}` : '',
      ].filter(Boolean)
    )
  );
}

function findPlayerMatchStats(memberStats = [], player = {}, slotIndex = -1) {
  const normalizedStats = Array.isArray(memberStats) ? memberStats : [];
  const playerTokens = new Set(getPlayerIdentityTokens(player, slotIndex));
  const matchedStats = normalizedStats.find((entry, entryIndex) => {
    const entryTokens = getPlayerIdentityTokens(
      {
        connectedUserId: entry?.connectedUserId,
        connectedProfileValue: entry?.connectedProfileValue,
        playerId: entry?.playerId,
        name: entry?.name || entry?.playerName,
      },
      entryIndex
    );
    return entryTokens.some((token) => playerTokens.has(token));
  });

  if (matchedStats) {
    return matchedStats;
  }

  return Number.isInteger(slotIndex) && slotIndex >= 0 ? normalizedStats[slotIndex] || null : null;
}

function buildPlayerProfileDataFromPointsEntry(player = {}, slotIndex = 0, context = {}) {
  const {
    historyKey = '',
    tournamentName = 'Tournament',
    metaName = '',
    metaDate = 'TBA',
    historyEntry = null,
    relevantMatches = [],
    baseProfileData = {},
  } = context;
  const currentProfileData = baseProfileData && typeof baseProfileData === 'object' ? baseProfileData : {};
  const currentTournaments =
    currentProfileData?.tournaments && typeof currentProfileData.tournaments === 'object' ? currentProfileData.tournaments : {};
  const currentPerformance =
    currentProfileData?.performance && typeof currentProfileData.performance === 'object' ? currentProfileData.performance : {};
  const currentMatches = Array.isArray(currentProfileData?.matches) ? currentProfileData.matches : [];
  const currentHistory = Array.isArray(currentTournaments?.recentHistory) ? currentTournaments.recentHistory : [];
  const currentUpcoming = Array.isArray(currentTournaments?.upcoming) ? currentTournaments.upcoming : [];

  const playerMatches = relevantMatches
    .map((match, matchIndex) => {
      const stats = findPlayerMatchStats(match?.memberStats, player, slotIndex);
      if (!stats) {
        return null;
      }

      const kills = Number.parseInt(String(stats?.kills || '0').trim(), 10) || 0;
      const damage = parseStatValue(stats?.damage || stats?.dmg || 0);
      const assists = parseStatValue(stats?.assists || stats?.ast || 0);
      const headshots = parseStatValue(stats?.headshots || stats?.hs || 0);
      return {
        id: `${historyKey}::player-${slotIndex + 1}-match-${matchIndex + 1}`,
        type: String(match?.type || `Match ${matchIndex + 1}`).trim() || `Match ${matchIndex + 1}`,
        datetime: String(match?.date || metaDate).trim() || 'TBA',
        result: String(match?.result || '').trim() || '-',
        placement: String(match?.placement || '').trim() || '-',
        kills,
        damage,
        headshots,
        assists,
        survival: String(match?.survival || match?.placementPoints || '').trim() || '0',
        rating: kills || damage || assists ? `${Math.max(1, kills + assists)}` : '0',
      };
    })
    .filter(Boolean);

  const nextRecentHistory = historyEntry
    ? [
        {
          id: historyKey,
          name: metaName ? `${tournamentName} - ${metaName}` : tournamentName,
          badge: `${historyEntry.killPoints || 0} KP - ${historyEntry.placementPoints || 0} PP`,
          placement: historyEntry.placement,
          prize: historyEntry.prize,
        },
        ...currentHistory.filter((entry) => String(entry?.id || '').trim() !== historyKey),
      ].slice(0, 12)
    : currentHistory;

  const nextMatches = [
    ...playerMatches,
    ...currentMatches.filter((entry) => !String(entry?.id || '').trim().startsWith(`${historyKey}::player-${slotIndex + 1}-match-`)),
  ].slice(0, 24);

  const totalPlayed = nextRecentHistory.length;
  const wins = nextRecentHistory.filter((entry) => String(entry?.placement || '').trim() === 'Champion').length;
  const runnerUp = nextRecentHistory.filter((entry) => String(entry?.placement || '').trim() === 'Runner-up').length;
  const top4 = nextRecentHistory.filter((entry) => {
    const placement = String(entry?.placement || '').trim();
    return placement === 'Champion' || placement === 'Runner-up' || placement === '3rd Place' || placement === '#4';
  }).length;
  const top8 = nextRecentHistory.filter((entry) => {
    const placement = String(entry?.placement || '').trim();
    if (placement === 'Champion' || placement === 'Runner-up' || placement === '3rd Place') {
      return true;
    }
    const numericPlacement = Number.parseInt(placement.replace('#', ''), 10);
    return Number.isFinite(numericPlacement) && numericPlacement > 0 && numericPlacement <= 8;
  }).length;

  return {
    ...currentProfileData,
    tournaments: {
      ...currentTournaments,
      totalPlayed,
      wins,
      runnerUp,
      top4,
      top8,
      bestPerformance: nextRecentHistory[0]?.placement || currentTournaments.bestPerformance || '',
      mvpCount: Number(currentTournaments?.mvpCount || 0),
      earnings: String(currentTournaments?.earnings || '').trim(),
      recentHistory: nextRecentHistory,
      upcoming: currentUpcoming.filter((entry) => String(entry?.id || '').trim() !== historyKey),
    },
    matches: nextMatches,
    performance: {
      ...currentPerformance,
      killsTrend: nextMatches.slice(0, 8).map((entry, index) => ({ label: `M${index + 1}`, value: Number(entry?.kills || 0) })),
      winRateTrend: nextMatches.slice(0, 8).map((entry, index) => ({
        label: `M${index + 1}`,
        value: entry?.result === 'Champion' ? 100 : entry?.result === 'Runner-up' ? 75 : 0,
      })),
      headshotTrend: nextMatches.slice(0, 8).map((entry, index) => ({
        label: `M${index + 1}`,
        value: parseStatValue(entry?.headshots || 0),
      })),
      placements: nextRecentHistory.slice(0, 8).map((entry) => ({
        label: String(entry?.name || '').trim() || tournamentName,
        value: Math.max(0, 16 - (Number.parseInt(String(entry?.placement || '').replace('#', ''), 10) || 16)),
      })),
      rankProgression: nextRecentHistory.slice(0, 8).map((entry, index) => ({
        label: `T${index + 1}`,
        value: Number.parseInt(String(entry?.placement || '').replace('#', ''), 10) || 0,
      })),
      damageVsKills: nextMatches.slice(0, 8).map((entry, index) => ({
        label: `M${index + 1}`,
        damage: Number(entry?.damage || 0),
        kills: Number(entry?.kills || 0),
      })),
    },
  };
}

function syncConnectedSnapshotsForTeams(db = {}, teams = []) {
  (Array.isArray(teams) ? teams : []).forEach((team) => {
    (Array.isArray(team?.players) ? team.players : []).forEach((player, index) => {
      const connectedUserId = String(player?.connectedUserId || '').trim();
      if (!connectedUserId) {
        return;
      }

      const connectedUser = (db.users || []).find((item) => String(item?.id || '').trim() === connectedUserId);
      if (connectedUser) {
        persistUserGamePlayerSnapshot(db, connectedUser, team, player, index);
      }
    });
  });
}

function applyPointsEntryToTeam(team = {}, tournament = {}, meta = {}, matches = [], leaderboard = [], db = {}) {
  const leaderboardEntry = (Array.isArray(leaderboard) ? leaderboard : []).find((entry) => matchesTeamIdentity(team, entry));
  if (!leaderboardEntry) {
    return team;
  }

  const tournamentId = String(tournament?.id || '').trim();
  const metaId = String(meta?.id || '').trim();
  const historyKey = `${tournamentId}::${metaId}`;
  const existingPageData = team?.pageData && typeof team.pageData === 'object' ? team.pageData : {};
  const baseTournaments = existingPageData?.tournaments && typeof existingPageData.tournaments === 'object' ? existingPageData.tournaments : {};
  const baseTotals = baseTournaments?.totals && typeof baseTournaments.totals === 'object' ? baseTournaments.totals : {};
  const baseHistory = Array.isArray(baseTournaments.history) ? baseTournaments.history : [];
  const baseUpcoming = Array.isArray(baseTournaments.upcoming) ? baseTournaments.upcoming : [];
  const baseMatches = Array.isArray(existingPageData.matches) ? existingPageData.matches : [];
  const basePerformance = existingPageData?.performance && typeof existingPageData.performance === 'object' ? existingPageData.performance : {};
  const tournamentName = String(tournament?.title || tournament?.name || 'Tournament').trim() || 'Tournament';
  const metaName = [
    String(meta?.groupName || '').trim(),
    String(meta?.roundName || '').trim(),
    String(meta?.matchNumber || '').trim() ? `Match ${String(meta.matchNumber).trim()}` : '',
  ]
    .filter(Boolean)
    .join(' - ');

  const relevantMatches = (Array.isArray(matches) ? matches : [])
    .map((match, index) => {
      const teamMatch = (Array.isArray(match?.teams) ? match.teams : []).find((entry) => matchesTeamIdentity(team, entry));
      if (!teamMatch) {
        return null;
      }

      const score = buildTeamMatchScore(teamMatch);
      return {
        id: `${historyKey}::match-${index + 1}`,
        type: String(match?.title || `Match ${index + 1}`).trim() || `Match ${index + 1}`,
        date: String(meta?.matchDate || meta?.date || '').trim() || 'TBA',
        result: formatPlacementLabel(score.placement),
        placement: score.placement ? String(score.placement) : '-',
        kills: score.effectiveKills,
        damage: 0,
        assists: 0,
        survival: score.placementPoints,
        bestPlayer: '',
        score: score.totalPoints,
        memberStats: Array.isArray(teamMatch?.players)
          ? teamMatch.players.map((player) => ({
              name: String(player?.playerName || player?.name || '').trim() || 'Player',
              role: '',
              kills: Number.parseInt(String(player?.kills || '0').trim(), 10) || 0,
              damage: parseStatValue(player?.damage || player?.dmg || 0),
              headshots: parseStatValue(player?.headshots || player?.hs || 0),
              assists: parseStatValue(player?.assists || player?.ast || 0),
            }))
          : [],
      };
    })
    .filter(Boolean);

  const rank = Number.parseInt(String(leaderboardEntry?.rank || '0').trim(), 10) || 0;
  const historyEntry = {
    id: historyKey,
    name: metaName ? `${tournamentName} - ${metaName}` : tournamentName,
    date: String(meta?.matchDate || meta?.date || '').trim() || 'TBA',
    placement: formatPlacementLabel(rank),
    points: Number(leaderboardEntry?.grandTotal || 0),
    killPoints: Number(leaderboardEntry?.totalKills || 0),
    placementPoints: Number(leaderboardEntry?.placementPoints || 0),
    prize: rank === 1 ? 'Winner' : rank === 2 ? 'Runner-up' : '-',
    mvp: '',
  };

  const nextHistory = [historyEntry, ...baseHistory.filter((entry) => String(entry?.id || '').trim() !== historyKey)].slice(0, 12);
  const nextMatches = [
    ...relevantMatches,
    ...baseMatches.filter((entry) => !String(entry?.id || '').trim().startsWith(`${historyKey}::match-`)),
  ].slice(0, 24);

  const played = nextHistory.length;
  const wins = nextHistory.filter((entry) => String(entry?.placement || '').trim() === 'Champion').length;
  const runnerUp = nextHistory.filter((entry) => String(entry?.placement || '').trim() === 'Runner-up').length;
  const top4 = nextHistory.filter((entry) => {
    const placement = String(entry?.placement || '').trim();
    return placement === 'Champion' || placement === 'Runner-up' || placement === '3rd Place' || placement === '#4';
  }).length;
  const top8 = nextHistory.filter((entry) => {
    const placement = String(entry?.placement || '').trim();
    if (placement === 'Champion' || placement === 'Runner-up' || placement === '3rd Place') {
      return true;
    }
    const numericPlacement = Number.parseInt(placement.replace('#', ''), 10);
    return Number.isFinite(numericPlacement) && numericPlacement > 0 && numericPlacement <= 8;
  }).length;

  const nextTeam = {
    ...team,
    players: (Array.isArray(team?.players) ? team.players : []).map((player, slotIndex) => ({
      ...player,
      profileData: buildPlayerProfileDataFromPointsEntry(player, slotIndex, {
        historyKey,
        tournamentName,
        metaName,
        metaDate: String(meta?.matchDate || meta?.date || '').trim() || 'TBA',
        historyEntry,
        relevantMatches,
        baseProfileData: player?.profileData,
      }),
    })),
    pageData: {
      ...existingPageData,
      tournaments: {
        ...baseTournaments,
        totals: {
          ...baseTotals,
          played,
          wins,
          runnerUp,
          top4,
          top8,
          best: historyEntry.placement,
          mvpPlayer: String(baseTotals?.mvpPlayer || '').trim(),
          killPoints: nextHistory.reduce((sum, entry) => sum + Number(entry?.killPoints || 0), 0),
          placementPoints: nextHistory.reduce((sum, entry) => sum + Number(entry?.placementPoints || 0), 0),
          consistency: played
            ? Math.round((nextHistory.reduce((sum, entry) => sum + Number(entry?.points || 0), 0) / played) * 10) / 10
            : 0,
          earnings: String(baseTotals?.earnings || '').trim(),
        },
        history: nextHistory,
        upcoming: baseUpcoming.filter((entry) => String(entry?.id || '').trim() !== historyKey),
      },
      matches: nextMatches,
      performance: {
        ...basePerformance,
        killsTrend: relevantMatches.map((entry, index) => ({ label: `M${index + 1}`, value: Number(entry?.kills || 0) })),
        winRateTrend: relevantMatches.map((entry, index) => ({
          label: `M${index + 1}`,
          value: entry?.result === 'Champion' ? 100 : entry?.result === 'Runner-up' ? 75 : 0,
        })),
        results: played
          ? [
              { label: 'Wins', value: Math.round((wins / played) * 100), color: '#D9A441' },
              { label: 'Top 4', value: Math.round((top4 / played) * 100), color: '#67C587' },
              { label: 'Top 8', value: Math.round((top8 / played) * 100), color: '#5A8CFF' },
            ]
          : [],
      },
      highlights: Array.isArray(existingPageData?.highlights) ? existingPageData.highlights : [],
    },
    updatedAt: new Date().toISOString(),
  };

  return refreshTeamStoredProfiles(nextTeam, db);
}

function sanitizePublicTeamCard(team, db = {}) {
  const sanitized = sanitizeTeam(team, db);
  return {
    id: sanitized.id,
    teamName: sanitized.teamName,
    publicTeamId: sanitized.publicTeamId,
    verified: sanitized.verified,
    logoUrl: sanitized.logoUrl,
    coverUrl: sanitized.coverUrl,
    updatedAt: sanitized.updatedAt,
    rosterCount: Array.isArray(sanitized.players) ? sanitized.players.length : 0,
    players: Array.isArray(sanitized.players)
      ? sanitized.players.map((player) => ({
          name: String(player?.name || '').trim(),
          playerId: String(player?.playerId || '').trim(),
          roleTag: String(player?.roleTag || '').trim(),
        }))
      : [],
    header: {
      tagline: String(sanitized.teamProfile?.header?.tagline || ''),
      region: String(sanitized.teamProfile?.header?.region || ''),
      currentRank: String(sanitized.teamProfile?.header?.currentRank || ''),
      game: String(sanitized.teamProfile?.header?.game || ''),
    },
  };
}

function buildFreeAgentCards(db = {}) {
  const users = Array.isArray(db.users) ? db.users : [];
  const teams = Array.isArray(db.teams) ? db.teams : [];

  return users
    .filter((user) => !teams.some((team) => isTeamContributor(team, user?.id)))
    .map((user) => buildStandalonePlayerView(db, user))
    .filter(Boolean)
    .map((view) => {
      const player = view.player || {};
      const header = player?.profileData?.header || {};
        return {
          id: `free-agent-${player.connectedUserId || player.playerId || Math.random()}`,
          userId: String(player.connectedUserId || '').trim(),
          name: String(player.name || 'Player').trim(),
          playerId: String(player.playerId || '').trim(),
          roleTag: String(player.roleTag || 'Flex').trim() || 'Flex',
          region: String(player.region || header.region || 'South Asia').trim() || 'South Asia',
          verified: Boolean(player.verified),
          statusBadge: String(player.statusBadge || 'Available').trim() || 'Available',
          trend: String(player.trend || 'Stable').trim() || 'Stable',
          previousTeam: String(header.teamName || '').trim(),
          bio: String(player.bio || header.bio || '').trim(),
          updatedAt: view.team?.updatedAt || '',
        };
      })
    .filter((card) => card.name || card.playerId || card.userId)
    .sort((left, right) => Number(Boolean(right.verified)) - Number(Boolean(left.verified)));
}

function buildTransferUpdateCards(db = {}) {
  const cards = [];

  (db.teams || []).forEach((team) => {
    const sanitizedTeam = sanitizeTeam(team, db);
    (sanitizedTeam.players || []).forEach((player) => {
      const profileHeader = player?.playerProfile?.header || player?.profileData?.header || {};
      const connectedUser = String(player?.connectedUserId || '').trim()
        ? (db.users || []).find((item) => String(item?.id || '').trim() === String(player.connectedUserId).trim())
        : null;
      const snapshotTeamName = String(connectedUser?.gamePlayerSnapshot?.teamName || '').trim();
      const snapshotTeamLogoUrl = String(connectedUser?.gamePlayerSnapshot?.teamLogoUrl || '').trim();
      const snapshotTeamPublicId = String(
        (db.teams || []).find((entry) => String(entry?.teamName || '').trim().toLowerCase() === snapshotTeamName.toLowerCase())?.publicTeamId || ''
      ).trim().toUpperCase();
      const oldTeamName = String(profileHeader.teamName || snapshotTeamName || '').trim();
      const newTeamName = String(sanitizedTeam.teamName || '').trim();

      if (!String(player?.name || player?.playerId || '').trim() || !newTeamName) {
        return;
      }

      if (oldTeamName && oldTeamName !== newTeamName) {
        cards.push({
          id: `transfer-update-${sanitizedTeam.id}-${player.playerId || player.name}`,
          playerName: String(player.name || 'Player').trim(),
          playerId: String(player.playerId || '').trim(),
          roleTag: String(player.roleTag || 'Flex').trim() || 'Flex',
          oldTeamName,
          oldTeamPublicTeamId: snapshotTeamPublicId,
          oldTeamLogoUrl: snapshotTeamLogoUrl,
          newTeamName,
          newTeamPublicTeamId: String(sanitizedTeam.publicTeamId || '').trim().toUpperCase(),
          newTeamLogoUrl: String(sanitizedTeam.logoUrl || '').trim(),
          region: String(player.region || profileHeader.region || 'South Asia').trim() || 'South Asia',
          status: 'Confirmed move',
          updatedAt: sanitizedTeam.updatedAt || sanitizedTeam.createdAt || '',
        });
      }
    });
  });

  if (cards.length) {
    return cards;
  }

  return [];
}

function buildTournamentRoomAssignmentSnapshot(team = {}) {
  const players = Array.isArray(team?.players) ? team.players : [];
  return {
    teamName: String(team?.teamName || '').trim().slice(0, 60),
    eventKey: String(team?.eventKey || '').trim().slice(0, 40),
    publicTeamId: String(team?.publicTeamId || '').trim().toUpperCase().slice(0, 24),
    playerNames: players.slice(0, 5).map((player) => String(player?.name || player?.playerId || '').trim().slice(0, 40)),
  };
}

function buildManualTournamentRoomAssignmentSnapshot(input = {}) {
  return {
    teamName: String(input?.teamName || '').trim().slice(0, 60),
    eventKey: 'free-fire',
    publicTeamId: String(input?.publicTeamId || '').trim().toUpperCase().slice(0, 24),
    playerNames: [],
    logoUrl: '',
  };
}

function hydrateTournamentRoomAssignment(assignment = {}, db = {}) {
  const linkedTeam = (db.teams || []).find((team) => team.id === assignment.teamId);
  const snapshot = linkedTeam ? buildTournamentRoomAssignmentSnapshot(linkedTeam) : null;
  const storedPlayerNames = Array.isArray(assignment.playerNames)
    ? assignment.playerNames.map((value) => String(value || '').trim().slice(0, 40)).slice(0, 5)
    : [];

  return {
    id: assignment.id,
    roomCode: String(assignment.roomCode || '').trim().slice(0, 40),
    tournamentId: String(assignment.tournamentId || '').trim().slice(0, 40),
    slot: String(assignment.slot || '').trim().slice(0, 4),
    userId: String(assignment.userId || '').trim(),
    teamId: String(assignment.teamId || '').trim(),
    teamName: String(snapshot?.teamName || assignment.teamName || '').trim().slice(0, 60),
    eventKey: String(snapshot?.eventKey || assignment.eventKey || '').trim().slice(0, 40),
    publicTeamId: String(snapshot?.publicTeamId || assignment.publicTeamId || '').trim().toUpperCase().slice(0, 24),
    logoUrl: String(linkedTeam?.logoUrl || assignment.logoUrl || '').trim(),
    playerNames: (snapshot?.playerNames?.length ? snapshot.playerNames : storedPlayerNames).slice(0, 5),
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
  };
}

function buildTournamentRoomIdentity(tournament = {}) {
  const titleSlug = String(tournament?.title || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12);
  const fallbackCode = String(tournament?.id || '').trim().replace(/-/g, '').slice(0, 6).toUpperCase() || 'ROOM';
  const roomCode = String(tournament?.roomCode || '').trim().slice(0, 40) || `${titleSlug || 'ROOM'}-${fallbackCode}`;
  const boardTitle = String(tournament?.boardTitle || '').trim().slice(0, 50) || `${String(tournament?.title || 'Tournament').trim().slice(0, 32) || 'Tournament'} room`;

  return {
    roomCode,
    boardTitle,
  };
}

function getTournamentRoomAssignments(db = {}, roomCode = '', tournamentId = '') {
  const normalizedRoomCode = String(roomCode || '').trim();
  const normalizedTournamentId = String(tournamentId || '').trim();
  return (db.tournamentRoomAssignments || [])
    .filter((assignment) => {
      const assignmentRoomCode = String(assignment?.roomCode || '').trim();
      const assignmentTournamentId = String(assignment?.tournamentId || '').trim();
      if (normalizedTournamentId) {
        return assignmentRoomCode === normalizedRoomCode && assignmentTournamentId === normalizedTournamentId;
      }
      return assignmentRoomCode === normalizedRoomCode;
    })
    .map((assignment) => hydrateTournamentRoomAssignment(assignment, db))
    .sort((left, right) => Number(left.slot || 0) - Number(right.slot || 0));
}

function sanitizeTournamentBookingRequest(request = {}, db = {}) {
  const linkedTeam = (db.teams || []).find((team) => String(team?.id || '').trim() === String(request?.teamId || '').trim());
  const snapshot = linkedTeam ? buildTournamentRoomAssignmentSnapshot(linkedTeam) : null;

  return {
    id: String(request?.id || '').trim(),
    tournamentId: String(request?.tournamentId || '').trim(),
    roomCode: String(request?.roomCode || '').trim(),
    ownerUserId: String(request?.ownerUserId || '').trim(),
    requesterUserId: String(request?.requesterUserId || request?.userId || '').trim(),
    teamId: String(request?.teamId || '').trim(),
    teamName: String(snapshot?.teamName || request?.teamName || '').trim().slice(0, 60),
    publicTeamId: String(snapshot?.publicTeamId || request?.publicTeamId || '').trim().toUpperCase().slice(0, 24),
    logoUrl: String(linkedTeam?.logoUrl || request?.logoUrl || '').trim(),
    playerNames: Array.isArray(snapshot?.playerNames) && snapshot.playerNames.length
      ? snapshot.playerNames.slice(0, 5)
      : (Array.isArray(request?.playerNames) ? request.playerNames.map((value) => String(value || '').trim().slice(0, 40)).slice(0, 5) : []),
    requestedSlot: String(request?.requestedSlot || '').trim().slice(0, 4),
    referenceCode: String(request?.referenceCode || '').trim().slice(0, 40),
    amountLabel: String(request?.amountLabel || '').trim().slice(0, 40),
    status: String(request?.status || 'pending').trim().toLowerCase().slice(0, 20) || 'pending',
    createdAt: request?.createdAt,
    updatedAt: request?.updatedAt,
    approvedAt: request?.approvedAt || '',
  };
}

function getTournamentPendingBookingRequests(db = {}, tournamentId = '', options = {}) {
  const normalizedTournamentId = String(tournamentId || '').trim();
  const requestedStatus = String(options?.status || '').trim().toLowerCase();
  return (db.tournamentBookingRequests || [])
    .filter((request) => String(request?.tournamentId || '').trim() === normalizedTournamentId)
    .map((request) => sanitizeTournamentBookingRequest(request, db))
    .filter((request) => !requestedStatus || String(request?.status || '').trim() === requestedStatus)
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime());
}

function getTournamentRoomAssignmentsWithPending(db = {}, roomCode = '', tournamentId = '') {
  const confirmedAssignments = getTournamentRoomAssignments(db, roomCode, tournamentId).map((assignment) => ({
    ...assignment,
    bookingStatus: 'confirmed',
  }));
  const pendingAssignments = getTournamentPendingBookingRequests(db, tournamentId, { status: 'pending' }).map((request) => ({
    id: String(request?.id || '').trim(),
    roomCode: String(request?.roomCode || '').trim(),
    tournamentId: String(request?.tournamentId || '').trim(),
    slot: String(request?.requestedSlot || '').trim(),
    userId: String(request?.requesterUserId || '').trim(),
    teamId: String(request?.teamId || '').trim(),
    teamName: String(request?.teamName || '').trim(),
    eventKey: 'free-fire',
    publicTeamId: String(request?.publicTeamId || '').trim(),
    logoUrl: String(request?.logoUrl || '').trim(),
    playerNames: Array.isArray(request?.playerNames) ? request.playerNames : [],
    createdAt: request?.createdAt,
    updatedAt: request?.updatedAt,
    bookingStatus: 'pending',
    referenceCode: String(request?.referenceCode || '').trim(),
  }));

  return [...confirmedAssignments, ...pendingAssignments]
    .sort((left, right) => Number(left?.slot || 0) - Number(right?.slot || 0));
}

function isTournamentEntryFree(tournament = {}) {
  const normalizedEntryFee = String(tournament?.entryFee || '').trim().toLowerCase();
  if (!normalizedEntryFee) {
    return true;
  }

  if (['free', 'free entry', 'no fee', '0', '0 tk', '0৳', '0 bdt'].includes(normalizedEntryFee)) {
    return true;
  }

  const numericValue = Number.parseFloat(normalizedEntryFee.replace(/[^0-9.]/g, ''));
  return Number.isFinite(numericValue) ? numericValue <= 0 : false;
}

function getTournamentRoomBoardAssignments(db = {}, tournamentId = '') {
  const normalizedTournamentId = String(tournamentId || '').trim();
  return (db.tournamentRoomBoards || [])
    .filter((assignment) => String(assignment?.tournamentId || '').trim() === normalizedTournamentId)
    .sort((left, right) => Number(left?.slot || 0) - Number(right?.slot || 0));
}

function getTournamentGroupDropAssignments(db = {}, tournamentId = '', metaId = '') {
  const normalizedTournamentId = String(tournamentId || '').trim();
  const normalizedMetaId = String(metaId || '').trim();
  return (db.tournamentGroupDrops || [])
    .filter(
      (assignment) =>
        String(assignment?.tournamentId || '').trim() === normalizedTournamentId &&
        String(assignment?.metaId || '').trim() === normalizedMetaId
    )
    .sort((left, right) => Number(left?.slot || 0) - Number(right?.slot || 0));
}

function findGroupDropConflict(db = {}, options = {}) {
  const tournamentId = String(options?.tournamentId || '').trim();
  const metaId = String(options?.metaId || '').trim();
  const teamId = String(options?.teamId || '').trim();
  const teamName = String(options?.teamName || '').trim().toLowerCase();
  const matchDate = String(options?.matchDate || '').trim();
  const startTime = String(options?.startTime || '').trim();

  if ((!teamId && !teamName) || !matchDate || !startTime) {
    return null;
  }

  const metaMap = new Map(
    (db.tournamentRoomBoardMeta || []).map((item) => [String(item?.id || '').trim(), item])
  );

  const conflictAssignment = (db.tournamentGroupDrops || []).find((assignment) => {
    const assignmentMetaId = String(assignment?.metaId || '').trim();
    const assignmentTournamentId = String(assignment?.tournamentId || '').trim();
    if (!assignmentMetaId || assignmentMetaId === metaId) {
      return false;
    }

    const meta = metaMap.get(assignmentMetaId);
    if (!meta) {
      return false;
    }

    const sameSchedule =
      String(meta?.matchDate || '').trim() === matchDate &&
      String(meta?.startTime || '').trim() === startTime;
    if (!sameSchedule) {
      return false;
    }

    const sameTeamId = teamId && String(assignment?.teamId || '').trim() === teamId;
    const sameTeamName = teamName && String(assignment?.teamName || '').trim().toLowerCase() === teamName;
    return sameTeamId || sameTeamName;
  });

  if (!conflictAssignment) {
    return null;
  }

  const conflictMeta = metaMap.get(String(conflictAssignment?.metaId || '').trim()) || {};
  return {
    tournamentId: String(conflictAssignment?.tournamentId || '').trim() || tournamentId,
    metaId: String(conflictAssignment?.metaId || '').trim(),
    groupName: String(conflictMeta?.groupName || '').trim() || 'Another group',
    matchDate: String(conflictMeta?.matchDate || '').trim(),
    startTime: String(conflictMeta?.startTime || '').trim(),
  };
}

function getTournamentRoomBoardMeta(db = {}, tournamentId = '') {
  const normalizedTournamentId = String(tournamentId || '').trim();
  return (db.tournamentRoomBoardMeta || [])
    .filter((item) => String(item?.tournamentId || '').trim() === normalizedTournamentId)
    .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
}

function getPlacementPoints(rankValue = '') {
  const rank = Number.parseInt(String(rankValue || '').trim(), 10);
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }

  const placementMap = {
    1: 12,
    2: 9,
    3: 8,
    4: 7,
    5: 6,
    6: 5,
    7: 4,
    8: 3,
    9: 2,
    10: 1,
  };

  return placementMap[rank] || 0;
}

function parseKillValue(value = '') {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseStatValue(value = '') {
  const parsed = Number.parseInt(String(value || '').replace(/[^\d-]/g, '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizePointsEntryMatches(rawMatches = [], fallbackTeams = [], totalMatches = 1) {
  const safeMatchCount = Math.max(1, Number.parseInt(String(totalMatches || '1').trim(), 10) || 1);
  const sourceMatches = Array.isArray(rawMatches) && rawMatches.length
    ? rawMatches
    : Array.from({ length: safeMatchCount }, (_, matchIndex) => ({
        id: `match-${matchIndex + 1}`,
        title: `Match ${matchIndex + 1}`,
        teams: fallbackTeams,
      }));

  return sourceMatches.map((match, matchIndex) => ({
    id: String(match?.id || `match-${matchIndex + 1}`).trim() || `match-${matchIndex + 1}`,
    title: String(match?.title || `Match ${matchIndex + 1}`).trim() || `Match ${matchIndex + 1}`,
    teams: (Array.isArray(match?.teams) ? match.teams : fallbackTeams).map((team, teamIndex) => ({
      id: String(team?.id || `team-${teamIndex + 1}`).trim() || `team-${teamIndex + 1}`,
      teamName: String(team?.teamName || `Team ${teamIndex + 1}`).trim() || `Team ${teamIndex + 1}`,
      logoText: String(team?.logoText || team?.shortName || team?.teamName || `T${teamIndex + 1}`)
        .trim()
        .slice(0, 2)
        .toUpperCase(),
      placement: String(team?.placement || '').trim().slice(0, 3),
      teamKills: String(team?.teamKills || '').trim().slice(0, 4),
      players: Array.from({ length: 4 }, (_, playerIndex) => {
        const sourcePlayer = Array.isArray(team?.players) ? team.players[playerIndex] || {} : {};
        return {
          id: String(sourcePlayer?.id || `${String(team?.id || `team-${teamIndex + 1}`).trim() || `team-${teamIndex + 1}`}-p${playerIndex + 1}`).trim(),
          playerName: String(sourcePlayer?.playerName || sourcePlayer?.name || `Player ${playerIndex + 1}`).trim().slice(0, 40),
          kills: String(sourcePlayer?.kills || '').trim().slice(0, 4),
          damage: String(sourcePlayer?.damage || sourcePlayer?.dmg || '').trim().slice(0, 6),
          headshots: String(sourcePlayer?.headshots || sourcePlayer?.hs || '').trim().slice(0, 4),
          assists: String(sourcePlayer?.assists || sourcePlayer?.ast || '').trim().slice(0, 4),
        };
      }),
    })),
  }));
}

function buildPointsEntryLeaderboard(matches = []) {
  const leaderboardMap = new Map();

  (matches || []).forEach((match, matchIndex) => {
    (match?.teams || []).forEach((team) => {
      const playerKills = (team?.players || []).reduce((sum, player) => sum + parseKillValue(player?.kills), 0);
      const teamKills = parseKillValue(team?.teamKills);
      const effectiveKills = playerKills > 0 ? playerKills : teamKills;
      const placementPoints = getPlacementPoints(team?.placement);
      const totalPoints = effectiveKills + placementPoints;

      const existing = leaderboardMap.get(team.id) || {
        teamId: team.id,
        teamName: String(team?.teamName || 'Team').trim() || 'Team',
        logoText: String(team?.logoText || '').trim(),
        totalKills: 0,
        placementPoints: 0,
        grandTotal: 0,
        matchPoints: {},
        lastMatchPoints: 0,
      };

      existing.totalKills += effectiveKills;
      existing.placementPoints += placementPoints;
      existing.grandTotal += totalPoints;
      existing.matchPoints[`match-${matchIndex + 1}`] = totalPoints;
      existing.lastMatchPoints = totalPoints;
      leaderboardMap.set(team.id, existing);
    });
  });

  return Array.from(leaderboardMap.values())
    .sort((left, right) => {
      if (right.grandTotal !== left.grandTotal) {
        return right.grandTotal - left.grandTotal;
      }
      if (right.totalKills !== left.totalKills) {
        return right.totalKills - left.totalKills;
      }
      return right.lastMatchPoints - left.lastMatchPoints;
    })
    .map((team, index) => ({
      ...team,
      rank: index + 1,
    }));
}

function buildPointsEntryTeamSource(db = {}, tournamentId = '', metaId = '') {
  const assignments = getTournamentGroupDropAssignments(db, tournamentId, metaId);

  return assignments
    .filter((assignment) => String(assignment?.teamName || '').trim())
    .map((assignment, index) => {
      const linkedTeam = (db.teams || []).find((team) => String(team?.id || '').trim() === String(assignment?.teamId || '').trim());
      const players = Array.isArray(linkedTeam?.players) && linkedTeam.players.length
        ? linkedTeam.players.slice(0, 4).map((player, playerIndex) => ({
            id: String(player?.connectedUserId || player?.playerId || `${String(assignment?.teamId || `team-${index + 1}`).trim()}-p${playerIndex + 1}`).trim(),
            playerName: String(player?.name || player?.playerId || `Player ${playerIndex + 1}`).trim().slice(0, 40),
            kills: '',
          }))
        : Array.from({ length: 4 }, (_, playerIndex) => ({
            id: `${String(assignment?.teamId || assignment?.publicTeamId || `team-${index + 1}`).trim()}-p${playerIndex + 1}`,
            playerName: `Player ${playerIndex + 1}`,
            kills: '',
          }));

      return {
        id: String(assignment?.teamId || assignment?.publicTeamId || `team-${index + 1}`).trim() || `team-${index + 1}`,
        teamName: String(assignment?.teamName || `Team ${index + 1}`).trim() || `Team ${index + 1}`,
        logoText: String(assignment?.teamName || `T${index + 1}`).trim().slice(0, 2).toUpperCase(),
        placement: '',
        teamKills: '',
        players,
      };
    });
}

function getTournamentPointsEntry(db = {}, tournamentId = '', metaId = '') {
  return (db.tournamentPointsEntries || []).find(
    (item) =>
      String(item?.tournamentId || '').trim() === String(tournamentId || '').trim() &&
      String(item?.metaId || '').trim() === String(metaId || '').trim()
  ) || null;
}

function syncTournamentConfirmedTeams(db = {}, tournamentId = '') {
  const normalizedTournamentId = String(tournamentId || '').trim();
  if (!normalizedTournamentId) {
    return;
  }

  db.tournaments = db.tournaments || [];
  const tournament = findTournamentById(db, normalizedTournamentId);
  if (!tournament) {
    return;
  }

  const identity = buildTournamentRoomIdentity(tournament);
  const count = getTournamentRoomAssignments(db, identity.roomCode, normalizedTournamentId).length;
  tournament.confirmedTeams = Math.max(0, Math.min(Number(tournament.teamLimit) || 0, count));
  tournament.roomCode = identity.roomCode;
  tournament.boardTitle = tournament.boardTitle || identity.boardTitle;
  tournament.updatedAt = new Date().toISOString();
}

function getTournamentChatParticipants(db = {}, tournament = {}) {
  const identity = buildTournamentRoomIdentity(tournament);
  return getTournamentRoomAssignments(db, identity.roomCode, String(tournament?.id || '').trim());
}

function canAccessTournamentChat(db = {}, tournament = {}, userId = '') {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId || !tournament?.id) {
    return false;
  }

  if (String(tournament?.ownerUserId || '').trim() === normalizedUserId) {
    return true;
  }

  return getTournamentChatParticipants(db, tournament).some(
    (assignment) => String(assignment?.userId || '').trim() === normalizedUserId
  );
}

function getTournamentChatAuthorLabel(db = {}, tournament = {}, fromUserId = '') {
  const normalizedUserId = String(fromUserId || '').trim();
  if (!normalizedUserId) {
    return 'Member';
  }

  if (String(tournament?.ownerUserId || '').trim() === normalizedUserId) {
    return 'Host';
  }

  const assignment = getTournamentChatParticipants(db, tournament).find(
    (item) => String(item?.userId || '').trim() === normalizedUserId
  );
  return String(assignment?.teamName || 'Team').trim() || 'Team';
}

function buildTournamentChatMessage({
  db,
  tournament,
  fromUserId,
  text,
  type = 'text',
  fileUrl = null,
  fileName = null,
  mimeType = null,
  durationMs = null,
}) {
  return {
    id: crypto.randomUUID(),
    tournamentId: String(tournament?.id || '').trim(),
    fromUserId: String(fromUserId || '').trim(),
    text: String(text || '').trim(),
    type,
    fileUrl,
    fileName,
    mimeType,
    durationMs,
    authorLabel: getTournamentChatAuthorLabel(db, tournament, fromUserId),
    editedAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
}

function getTournamentChatMessages(db = {}, tournamentId = '') {
  return (db.tournamentChatMessages || [])
    .filter((item) => String(item?.tournamentId || '').trim() === String(tournamentId || '').trim())
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function emitTournamentChatMessage(db = {}, tournament = {}, message = {}) {
  const participantIds = new Set([
    String(tournament?.ownerUserId || '').trim(),
    ...getTournamentChatParticipants(db, tournament).map((item) => String(item?.userId || '').trim()),
  ]);

  Array.from(participantIds).filter(Boolean).forEach((userId) => {
    const deliveredAt = isUserOnline(userId) ? new Date().toISOString() : null;
    emitToUser(userId, 'tournament:chat:new', {
      tournamentId: String(tournament?.id || '').trim(),
      message: deliveredAt ? { ...message, deliveredAt } : message,
    });
  });
}

function isTeamContributor(team = {}, userId = '') {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return false;
  }

  if (String(team?.ownerUserId || '').trim() === normalizedUserId) {
    return true;
  }

  return (team?.players || []).some((player) => String(player?.connectedUserId || '').trim() === normalizedUserId);
}

function isTeamOwner(team = {}, userId = '') {
  const normalizedUserId = String(userId || '').trim();
  return Boolean(normalizedUserId && String(team?.ownerUserId || '').trim() === normalizedUserId);
}

function normalizeGamePlayerId(value) {
  return String(value || '').trim().slice(0, 40);
}

function getUserGamePlayerId(user = {}) {
  return normalizeGamePlayerId(user?.gamePlayerId);
}

function getUserSnapshotGamePlayerId(user = {}) {
  return normalizeGamePlayerId(user?.gamePlayerSnapshot?.player?.playerId || user?.gamePlayerSnapshot?.profileData?.header?.uid);
}

function getStoredUserGamePlayerId(user = {}) {
  return getUserGamePlayerId(user) || getUserSnapshotGamePlayerId(user);
}

function findUserByGamePlayerId(db = {}, gamePlayerId = '', excludeUserId = '') {
  const normalizedGamePlayerId = normalizeGamePlayerId(gamePlayerId).toUpperCase();
  if (!normalizedGamePlayerId) {
    return null;
  }

  const directUser = (db.users || []).find(
    (item) =>
      item.id !== excludeUserId &&
      getStoredUserGamePlayerId(item).toUpperCase() === normalizedGamePlayerId
  );
  if (directUser) {
    return directUser;
  }

  for (const team of db.teams || []) {
    for (const player of team.players || []) {
      if (normalizeGamePlayerId(player?.playerId).toUpperCase() !== normalizedGamePlayerId) {
        continue;
      }

      const connectedUserId = String(player?.connectedUserId || '').trim();
      if (connectedUserId && connectedUserId !== excludeUserId) {
        const connectedUser = (db.users || []).find((item) => item.id === connectedUserId);
        if (connectedUser) {
          return connectedUser;
        }
      }

      const connectedProfileValue = String(player?.connectedProfileValue || '').trim();
      if (connectedProfileValue) {
        const linkedUser = (db.users || []).find(
          (item) => item.id !== excludeUserId && String(item?.appProfileId || '').trim() === connectedProfileValue
        );
        if (linkedUser) {
          return linkedUser;
        }
      }
    }
  }

  return null;
}

function findUserByAppProfileId(db = {}, appProfileId = '') {
  const normalizedAppProfileId = String(appProfileId || '').trim();
  if (!normalizedAppProfileId) {
    return null;
  }

  return (db.users || []).find((item) => String(item?.appProfileId || '').trim() === normalizedAppProfileId);
}

function findUserByProfileValue(db = {}, profileValue = '', excludeUserId = '') {
  const normalizedProfileValue = String(profileValue || '').trim();
  if (!normalizedProfileValue) {
    return null;
  }

  return (
    findUserByAppProfileId(db, normalizedProfileValue) ||
    findUserByGamePlayerId(db, normalizedProfileValue, excludeUserId)
  );
}

function getPreferredPlayerName(user = {}) {
  const snapshotName = String(user?.gamePlayerSnapshot?.player?.name || '').trim();
  const fallbackName = String(user?.name || '').trim();
  return (snapshotName || fallbackName).slice(0, 40);
}

function clonePlainValue(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function getUserSnapshotPlayer(user = {}) {
  return sanitizePlayerBase(user?.gamePlayerSnapshot?.player || {});
}

function getUserSnapshotProfileData(user = {}) {
  if (!user?.gamePlayerSnapshot?.profileData || typeof user.gamePlayerSnapshot.profileData !== 'object') {
    return {};
  }

  return clonePlainValue(user.gamePlayerSnapshot.profileData);
}

function buildConnectedPlayerSlotFromUser(basePlayer = {}, user = null, options = {}) {
  const snapshotPlayer = getUserSnapshotPlayer(user);
  const snapshotProfileData = getUserSnapshotProfileData(user);
  const preferredUid = getStoredUserGamePlayerId(user) || normalizeGamePlayerId(basePlayer.playerId);
  const preferredName =
    options?.preserveName && String(basePlayer?.name || '').trim()
      ? String(basePlayer.name).trim().slice(0, 40)
      : snapshotPlayer.name || getPreferredPlayerName(user) || String(basePlayer?.name || '').trim().slice(0, 40);

  return {
    ...sanitizePlayerBase(basePlayer),
    ...snapshotPlayer,
    name: preferredName,
    playerId: preferredUid,
    realName: snapshotPlayer.realName || String(basePlayer?.realName || '').trim().slice(0, 60),
    countryFlag: snapshotPlayer.countryFlag || String(basePlayer?.countryFlag || 'BD').trim().slice(0, 4).toUpperCase(),
    region: snapshotPlayer.region || String(basePlayer?.region || 'South Asia').trim().slice(0, 40),
    roleTag: snapshotPlayer.roleTag || String(basePlayer?.roleTag || '').trim().slice(0, 24),
    statusBadge: snapshotPlayer.statusBadge || String(basePlayer?.statusBadge || 'Active').trim().slice(0, 24),
    trend: snapshotPlayer.trend || String(basePlayer?.trend || 'Stable').trim().slice(0, 24),
    bio: snapshotPlayer.bio || String(basePlayer?.bio || '').trim().slice(0, 240),
    connectedProfile: true,
    connectedProfileValue: String(user?.appProfileId || '').trim().slice(0, 80),
    connectedUserId: String(user?.id || '').trim(),
    profileData: snapshotProfileData,
  };
}

function findPlayerSlotByGamePlayerId(db = {}, gamePlayerId = '', options = {}) {
  const normalizedGamePlayerId = normalizeGamePlayerId(gamePlayerId).toUpperCase();
  if (!normalizedGamePlayerId) {
    return null;
  }

  const excludeTeamId = String(options?.excludeTeamId || '').trim();
  const excludeSlotIndex = Number.isInteger(options?.excludeSlotIndex) ? options.excludeSlotIndex : -1;

  for (const team of db.teams || []) {
    for (let index = 0; index < (team.players || []).length; index += 1) {
      if (excludeTeamId && team.id === excludeTeamId && index === excludeSlotIndex) {
        continue;
      }

      const player = team.players[index];
      if (normalizeGamePlayerId(player?.playerId).toUpperCase() !== normalizedGamePlayerId) {
        continue;
      }

      return {
        team,
        slotIndex: index,
        player,
      };
    }
  }

  return null;
}

function ensureGamePlayerIdSlotAvailability(db = {}, gamePlayerId = '', options = {}) {
  const normalizedGamePlayerId = normalizeGamePlayerId(gamePlayerId);
  if (!normalizedGamePlayerId) {
    return { value: '' };
  }

  const conflict = findPlayerSlotByGamePlayerId(db, normalizedGamePlayerId, options);
  if (!conflict) {
    return { value: normalizedGamePlayerId };
  }

  return {
    error: `This GameID is already active in team ${String(conflict.team?.teamName || 'unknown').trim() || 'unknown'}.`,
  };
}

function syncUserGamePlayerId(db = {}, user = null, nextGamePlayerId = '', options = {}) {
  const preserveExisting = options?.preserveExisting !== false;
  if (!user) {
    return { value: normalizeGamePlayerId(nextGamePlayerId) };
  }

  const currentGamePlayerId = getUserGamePlayerId(user);
  const normalizedNextGamePlayerId = normalizeGamePlayerId(nextGamePlayerId);
  const resolvedGamePlayerId = preserveExisting && currentGamePlayerId ? currentGamePlayerId : normalizedNextGamePlayerId || currentGamePlayerId;

  if (!resolvedGamePlayerId) {
    return { value: currentGamePlayerId };
  }

  const slotAvailabilityResult = ensureGamePlayerIdSlotAvailability(db, resolvedGamePlayerId, {
    excludeTeamId: options?.excludeTeamId,
    excludeSlotIndex: options?.excludeSlotIndex,
  });
  if (slotAvailabilityResult.error) {
    return { error: slotAvailabilityResult.error };
  }

  if (preserveExisting && currentGamePlayerId) {
    return { value: currentGamePlayerId };
  }

  if (currentGamePlayerId && normalizedNextGamePlayerId.toUpperCase() === currentGamePlayerId.toUpperCase()) {
    return { value: currentGamePlayerId };
  }

  const existingOwner = findUserByGamePlayerId(db, normalizedNextGamePlayerId, user.id);
  if (existingOwner) {
    return { error: 'This GameID already belongs to another account.' };
  }

  user.gamePlayerId = normalizedNextGamePlayerId;
  return { value: normalizedNextGamePlayerId };
}

function buildUserGamePlayerSnapshot(db = {}, user = null, team = {}, player = {}, slotIndex = 0) {
  if (!user) {
    return null;
  }

  const normalizedPlayer = sanitizePlayerBase(player);
  const normalizedGamePlayerId = getUserGamePlayerId(user) || normalizeGamePlayerId(normalizedPlayer.playerId);
  const snapshotPlayer = {
    ...normalizedPlayer,
    playerId: normalizedGamePlayerId,
    connectedProfile: true,
    connectedProfileValue: String(user.appProfileId || normalizedPlayer.connectedProfileValue || '').trim().slice(0, 80),
    connectedUserId: String(user.id || normalizedPlayer.connectedUserId || '').trim(),
  };
  const snapshotProfile = buildPlayerProfile(
    {
      ...team,
      teamName: String(team?.teamName || '').trim(),
      logoUrl: String(team?.logoUrl || '').trim(),
    },
    {
      ...snapshotPlayer,
      profileData: player?.profileData,
    },
    slotIndex,
    db.users || []
  );

  return {
    eventKey: String(team?.eventKey || 'free-fire').trim() || 'free-fire',
    teamName: String(team?.teamName || '').trim(),
    teamLogoUrl: String(team?.logoUrl || '').trim(),
    player: snapshotPlayer,
    profileData: snapshotProfile,
    updatedAt: new Date().toISOString(),
  };
}

function persistUserGamePlayerSnapshot(db = {}, user = null, team = {}, player = {}, slotIndex = 0) {
  if (!user) {
    return null;
  }

  const snapshot = buildUserGamePlayerSnapshot(db, user, team, player, slotIndex);
  if (snapshot) {
    user.gamePlayerSnapshot = snapshot;
  }
  return snapshot;
}

function buildStandalonePlayerView(db = {}, user = null) {
  if (!user || (!getUserGamePlayerId(user) && !user?.gamePlayerSnapshot?.profileData)) {
    return null;
  }

  const snapshot = user.gamePlayerSnapshot && typeof user.gamePlayerSnapshot === 'object' ? user.gamePlayerSnapshot : {};
  const snapshotPlayer = sanitizePlayerBase(snapshot.player || {});
  const standaloneTeam = {
    id: `standalone-${user.id}`,
    ownerUserId: user.id,
    eventKey: String(snapshot.eventKey || 'free-fire').trim() || 'free-fire',
    teamName: String(snapshot.teamName || 'Free Agent').trim() || 'Free Agent',
    publicTeamId: '',
    verified: false,
    tagline: '',
    bio: '',
    facebook: '',
    youtube: '',
    logoUrl: String(snapshot.teamLogoUrl || '').trim(),
    coverUrl: '',
    players: [
      {
        ...snapshotPlayer,
        name: String(snapshotPlayer.name || user.name || 'Player').trim().slice(0, 40),
        playerId: getUserGamePlayerId(user) || snapshotPlayer.playerId || String(user.appProfileId || '').trim().slice(0, 40),
        realName: String(snapshotPlayer.realName || user.name || '').trim().slice(0, 60),
        countryFlag: String(snapshotPlayer.countryFlag || 'BD').trim().slice(0, 4).toUpperCase(),
        region: String(snapshotPlayer.region || 'South Asia').trim().slice(0, 40),
        roleTag: String(snapshotPlayer.roleTag || '').trim().slice(0, 24),
        statusBadge: String(snapshotPlayer.statusBadge || 'Active').trim().slice(0, 24),
        trend: String(snapshotPlayer.trend || 'Stable').trim().slice(0, 24),
        verified: Boolean(snapshotPlayer.verified || user.verified),
        bio: String(snapshotPlayer.bio || '').trim().slice(0, 240),
        connectedProfile: true,
        connectedProfileValue: String(user.appProfileId || '').trim().slice(0, 80),
        connectedUserId: String(user.id || '').trim(),
        profileData: snapshot.profileData && typeof snapshot.profileData === 'object' ? snapshot.profileData : {},
      },
    ],
    leaderIndex: 0,
    createdAt: snapshot.updatedAt || user.createdAt,
    updatedAt: snapshot.updatedAt || user.createdAt,
  };
  const sanitizedTeam = sanitizeTeam(standaloneTeam, db);

  return {
    team: sanitizedTeam,
    playerIndex: 0,
    player: sanitizedTeam.players[0],
    standalone: true,
  };
}

function canEditPlayerProfile(team = {}, slotIndex = -1, userId = '') {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return false;
  }

  if (String(team?.ownerUserId || '').trim() === normalizedUserId) {
    return true;
  }

  const player = Array.isArray(team?.players) ? team.players[slotIndex] : null;
  return String(player?.connectedUserId || '').trim() === normalizedUserId;
}

function applyPlayerProfilePayload(db = {}, team = {}, slotIndex = -1, payload = {}) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
    return { error: 'Invalid player slot.' };
  }

  const currentPlayer = team.players[slotIndex] || {};
  const currentProfileData =
    currentPlayer.profileData && typeof currentPlayer.profileData === 'object' ? currentPlayer.profileData : {};
  const currentHeader =
    currentProfileData.header && typeof currentProfileData.header === 'object' ? currentProfileData.header : {};
  const currentInsights =
    currentProfileData.insights && typeof currentProfileData.insights === 'object' ? currentProfileData.insights : {};
  const connectedUser = currentPlayer.connectedUserId
    ? (db.users || []).find((item) => item.id === currentPlayer.connectedUserId)
    : null;
  const requestedUid = Object.prototype.hasOwnProperty.call(payload, 'uid')
    ? String(payload.uid || '').trim().slice(0, 40)
    : '';
  const nextUidCandidate = requestedUid || sanitizePlayerBase(currentPlayer).playerId;
  const slotAvailabilityResult = ensureGamePlayerIdSlotAvailability(db, nextUidCandidate, {
    excludeTeamId: team?.id,
    excludeSlotIndex: slotIndex,
  });
  if (slotAvailabilityResult.error) {
    return { error: slotAvailabilityResult.error };
  }
  const gamePlayerResult = connectedUser
    ? syncUserGamePlayerId(db, connectedUser, requestedUid, {
        preserveExisting: !requestedUid,
        excludeTeamId: team?.id,
        excludeSlotIndex: slotIndex,
      })
    : { value: requestedUid };

  if (gamePlayerResult.error) {
    return { error: gamePlayerResult.error };
  }

  const nextRoleTag = Object.prototype.hasOwnProperty.call(payload, 'roleTag')
    ? String(payload.roleTag || '').trim().slice(0, 24)
    : sanitizePlayerBase(currentPlayer).roleTag;

  team.players[slotIndex] = {
    ...sanitizePlayerBase(currentPlayer),
    profileData: {
      ...currentProfileData,
      header: {
        ...currentHeader,
        currentRank: Object.prototype.hasOwnProperty.call(payload, 'currentRank')
          ? String(payload.currentRank || '').trim().slice(0, 40)
          : currentHeader.currentRank,
        highestRank: Object.prototype.hasOwnProperty.call(payload, 'highestRank')
          ? String(payload.highestRank || '').trim().slice(0, 40)
          : currentHeader.highestRank,
      },
      insights: {
        ...currentInsights,
        bestRole: nextRoleTag || currentInsights.bestRole || '',
        bestWeapon: Object.prototype.hasOwnProperty.call(payload, 'bestWeapon')
          ? String(payload.bestWeapon || '').trim().slice(0, 40)
          : currentInsights.bestWeapon,
        bestMap: Object.prototype.hasOwnProperty.call(payload, 'bestMap')
          ? String(payload.bestMap || '').trim().slice(0, 40)
          : currentInsights.bestMap,
        activeWindow: Object.prototype.hasOwnProperty.call(payload, 'activeWindow')
          ? String(payload.activeWindow || '').trim().slice(0, 40)
          : currentInsights.activeWindow,
        archetype: Object.prototype.hasOwnProperty.call(payload, 'archetype')
          ? String(payload.archetype || '').trim().slice(0, 40)
          : currentInsights.archetype,
      },
    },
    name: Object.prototype.hasOwnProperty.call(payload, 'ign')
      ? String(payload.ign || '').trim().slice(0, 40)
      : sanitizePlayerBase(currentPlayer).name,
    playerId: Object.prototype.hasOwnProperty.call(payload, 'uid')
      ? gamePlayerResult.value || sanitizePlayerBase(currentPlayer).playerId
      : connectedUser
        ? getUserGamePlayerId(connectedUser) || sanitizePlayerBase(currentPlayer).playerId
        : sanitizePlayerBase(currentPlayer).playerId,
    realName: Object.prototype.hasOwnProperty.call(payload, 'realName')
      ? String(payload.realName || '').trim().slice(0, 60)
      : sanitizePlayerBase(currentPlayer).realName,
    countryFlag: Object.prototype.hasOwnProperty.call(payload, 'countryFlag')
      ? String(payload.countryFlag || '').trim().slice(0, 4).toUpperCase()
      : sanitizePlayerBase(currentPlayer).countryFlag,
    region: Object.prototype.hasOwnProperty.call(payload, 'region')
      ? String(payload.region || '').trim().slice(0, 40)
      : sanitizePlayerBase(currentPlayer).region,
    roleTag: nextRoleTag,
    kdRatio: Object.prototype.hasOwnProperty.call(payload, 'kdRatio')
      ? String(payload.kdRatio || '').trim().slice(0, 12)
      : sanitizePlayerBase(currentPlayer).kdRatio,
    headshotPct: Object.prototype.hasOwnProperty.call(payload, 'headshotPct')
      ? String(payload.headshotPct || '').trim().slice(0, 12)
      : sanitizePlayerBase(currentPlayer).headshotPct,
    mvpCount: Object.prototype.hasOwnProperty.call(payload, 'mvpCount')
      ? String(payload.mvpCount || '').trim().slice(0, 12)
      : sanitizePlayerBase(currentPlayer).mvpCount,
    bio: Object.prototype.hasOwnProperty.call(payload, 'bio')
      ? String(payload.bio || '').trim().slice(0, 240)
      : sanitizePlayerBase(currentPlayer).bio,
  };

  Object.assign(
    team,
    refreshTeamStoredProfiles(
      {
        ...team,
        updatedAt: new Date().toISOString(),
      },
      db
    )
  );

  if (connectedUser) {
    persistUserGamePlayerSnapshot(db, connectedUser, team, team.players[slotIndex], slotIndex);
  }

  return {
    team,
    playerIndex: slotIndex,
    player: team.players[slotIndex],
    connectedUser,
  };
}

function parseObjectPayload(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
}

function toDataUrl(file) {
  if (!file?.buffer?.length) {
    return '';
  }

  return `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}`;
}

function sanitizeHostApplication(application = {}) {
  const paymentNumbers = Array.isArray(application.paymentNumbers)
    ? application.paymentNumbers
        .map((value) => String(value || '').trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return {
    id: String(application.id || '').trim(),
    userId: String(application.userId || '').trim(),
    name: String(application.name || '').trim().slice(0, 60),
    playerId: String(application.playerId || '').trim().slice(0, 40),
    nationality: String(application.nationality || '').trim().slice(0, 40),
    district: String(application.district || '').trim().slice(0, 60),
    subDistrict: String(application.subDistrict || '').trim().slice(0, 60),
    mobileNumber: String(application.mobileNumber || '').trim().slice(0, 20),
    paymentNumbers,
    bkashNumber: String(application.bkashNumber || paymentNumbers[0] || '').trim().slice(0, 20),
    hostImageUrl: String(application.hostImageUrl || '').trim(),
    nidCardImageUrl: String(application.nidCardImageUrl || '').trim(),
    status: String(application.status || 'pending').trim().slice(0, 20),
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
  };
}

function sanitizeTournament(tournament = {}, db = null) {
  const teamLimit = Math.max(1, Math.min(99, Number(tournament.teamLimit) || 12));
  const identity = buildTournamentRoomIdentity(tournament);
  const normalizedOwnerUserId = String(tournament?.ownerUserId || '').trim();
  const hostApplication = db
    ? (db.hostApplications || []).find(
        (entry) => String(entry?.userId || '').trim() === normalizedOwnerUserId
      ) || null
    : null;
  const hostImageUrl = String(hostApplication?.hostImageUrl || '').trim();
  const hostName = String(
    hostApplication?.name ||
      hostApplication?.fullName ||
      tournament?.room?.hostName ||
      tournament?.footerTitle ||
      ''
  )
    .trim()
    .slice(0, 60);
  const creationMode = ['host', 'admin'].includes(String(tournament?.creationMode || '').trim().toLowerCase())
    ? String(tournament.creationMode).trim().toLowerCase()
    : 'host';
  const createdByRole = ['host', 'admin'].includes(String(tournament?.createdByRole || '').trim().toLowerCase())
    ? String(tournament.createdByRole).trim().toLowerCase()
    : creationMode;
  const liveConfirmedTeams =
    db && tournament?.id ? getTournamentRoomAssignments(db, identity.roomCode, String(tournament.id || '').trim()).length : Number(tournament.confirmedTeams) || 0;
  const confirmedTeams = Math.max(0, Math.min(teamLimit, liveConfirmedTeams));
  const progressValue = Math.max(0, Math.min(100, Math.round((confirmedTeams / teamLimit) * 100) || 0));
  const roomSlots = Array.from({ length: teamLimit }, (_, index) => ({
    slot: String(index + 1).padStart(2, '0'),
    accent: ['#F59E0B', '#F9A8D4', '#A5F3FC', '#C4B5FD', '#86EFAC', '#FCA5A5', '#93C5FD', '#FDBA74'][index % 8],
  }));

  return {
    id: String(tournament.id || '').trim(),
    ownerUserId: normalizedOwnerUserId,
    creationMode,
    createdByRole,
    createdBySource: String(tournament.createdBySource || createdByRole).trim().slice(0, 20) || createdByRole,
    hostName,
    hostImageUrl,
    prizePool: String(tournament.prizePool || '').trim().slice(0, 40),
    entryFee: String(tournament.entryFee || '').trim().slice(0, 40),
    teamLimit,
    badge: String(tournament.badge || 'Open').trim().slice(0, 24),
    status: String(tournament.status || 'Open now').trim().slice(0, 40),
    stage: String(tournament.stage || 'Custom room').trim().slice(0, 40),
    title: String(tournament.title || '').trim().slice(0, 80),
    description: String(tournament.description || '').trim().slice(0, 220),
    meta: [
      { label: 'Starts', value: String(tournament.startsAt || '').trim().slice(0, 40) || 'TBD' },
      { label: 'Format', value: String(tournament.format || '').trim().slice(0, 40) || 'Custom room' },
      { label: 'Stream', value: String(tournament.stream || '').trim().slice(0, 40) || 'Host feed' },
    ],
    metrics: [
      { label: 'Prize pool', value: String(tournament.prizePool || '').trim().slice(0, 40) || 'TBD' },
      { label: 'Entry fee', value: String(tournament.entryFee || '').trim().slice(0, 40) || 'Free' },
      { label: 'Teams', value: String(teamLimit) },
      { label: 'Feature match', value: String(tournament.featureMatch || '').trim().slice(0, 40) || 'Top teams' },
    ],
    progressLabel: `${confirmedTeams} of ${teamLimit} teams confirmed`,
    progressValue,
    footerTitle: String(tournament.footerTitle || '').trim().slice(0, 50) || 'Host note',
    footerText: String(tournament.footerText || '').trim().slice(0, 180) || 'Tournament room access and ops details will appear here.',
    primaryAction: String(tournament.primaryAction || 'Open room board').trim().slice(0, 32) || 'Open room board',
    secondaryAction: String(tournament.secondaryAction || 'Host deck').trim().slice(0, 32) || 'Host deck',
    palette: {
      background: '#251432',
      border: 'rgba(255, 163, 212, 0.18)',
      glow: 'rgba(255, 133, 194, 0.22)',
      accent: '#FFB86D',
      accentSoft: 'rgba(255, 184, 109, 0.16)',
      statusBg: 'rgba(255,255,255,0.08)',
    },
    room: {
      roomCode: identity.roomCode,
      hostName,
      hostImageUrl,
      roomStatus: String(tournament.roomStatus || '').trim().slice(0, 60) || 'Room setup pending',
      boardTitle: identity.boardTitle,
      boardText: String(tournament.boardText || '').trim().slice(0, 180) || 'Manage your room slots and lineup lock from this board.',
      note: String(tournament.note || '').trim().slice(0, 180) || 'Keep room credentials secure until roster lock closes.',
      stats: [
        { label: 'Confirmed teams', value: `${confirmedTeams}/${teamLimit}` },
        { label: 'Observer seats', value: String(tournament.observerSeats || '').trim().slice(0, 20) || '02' },
        { label: 'Broadcast lane', value: String(tournament.broadcastLane || '').trim().slice(0, 30) || 'Main room' },
      ],
      sidecards: [
        {
          title: String(tournament.sidecardOneTitle || '').trim().slice(0, 40) || 'Ops stack',
          text: String(tournament.sidecardOneText || '').trim().slice(0, 140) || 'Team check-in, room confirmation, and observer coordination live here.',
        },
        {
          title: String(tournament.sidecardTwoTitle || '').trim().slice(0, 40) || 'Room policy',
          text: String(tournament.sidecardTwoText || '').trim().slice(0, 140) || 'Late swaps and emergency changes must be approved by the host team.',
        },
      ],
      slots: Array.isArray(tournament.room?.slots) && tournament.room.slots.length ? tournament.room.slots : roomSlots,
    },
    createdAt: tournament.createdAt,
    updatedAt: tournament.updatedAt,
  };
}

router.get('/public/teams', (_req, res) => {
  try {
    const db = readDb();
    const teams = (db.teams || [])
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())
      .map((team) => sanitizePublicTeamCard(team, db));

    return res.json({ teams });
  } catch (error) {
    return sendServerError(res, error, 'Could not load public teams.');
  }
});

router.get('/public/transfer-center', (_req, res) => {
  try {
    const db = readDb();
    const freeAgents = buildFreeAgentCards(db);
    const transferUpdates = buildTransferUpdateCards(db);

    return res.json({
      summary: {
        freeAgents: freeAgents.length,
        transferUpdates: transferUpdates.length,
      },
      freeAgents,
      transferUpdates,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load transfer center.');
  }
});

router.get('/tournaments', (_req, res) => {
  try {
    const db = readDb();
    const tournaments = (db.tournaments || [])
      .slice()
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())
      .map((item) => sanitizeTournament(item, db));

    return res.json({ tournaments });
  } catch (error) {
    return sendServerError(res, error, 'Could not load tournaments.');
  }
});

router.get('/tournaments/:tournamentId/host-profile', (req, res) => {
  try {
    const tournamentId = String(req.params.tournamentId || '').trim();
    if (!tournamentId) {
      return res.status(400).json({ message: 'Tournament ID is required.' });
    }

    const db = readDb();
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const ownerUserId = String(tournament?.ownerUserId || '').trim();
    const application = (db.hostApplications || []).find(
      (item) => String(item?.userId || '').trim() === ownerUserId
    );

    if (!application) {
      return res.status(404).json({ message: 'Host profile not found.' });
    }

    return res.json({
      profile: sanitizeHostApplication(application),
      tournament: {
        id: String(tournament?.id || '').trim(),
        title: String(tournament?.title || '').trim().slice(0, 80),
        roomCode: buildTournamentRoomIdentity(tournament).roomCode,
      },
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load host profile.');
  }
});

router.get('/public/linked-player/:userId', (req, res) => {
  try {
    const db = readDb();
    const requestedUserId = String(req.params.userId || '').trim();

    if (!requestedUserId) {
      return res.status(400).json({ message: 'User ID is required.' });
    }

    const team = (db.teams || [])
      .slice()
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())
      .find((item) =>
        Array.isArray(item?.players) &&
        item.players.some((player) => String(player?.connectedUserId || '').trim() === requestedUserId)
    );

    if (team) {
      const sanitizedTeam = sanitizeTeam(team, db);
      const playerIndex = (sanitizedTeam.players || []).findIndex(
        (player) => String(player?.connectedUserId || '').trim() === requestedUserId
      );

      if (playerIndex >= 0) {
        return res.json({
          team: sanitizedTeam,
          playerIndex,
          player: sanitizedTeam.players[playerIndex],
          standalone: false,
        });
      }
    }

    const user = (db.users || []).find((item) => String(item.id || '').trim() === requestedUserId);
    const standaloneView = buildStandalonePlayerView(db, user);
    if (!standaloneView) {
      return res.status(404).json({ message: 'Linked player not found.' });
    }

    return res.json(standaloneView);
  } catch (error) {
    return sendServerError(res, error, 'Could not load linked player.');
  }
});

router.get('/teams/:userId', (req, res) => {
  try {
    const requestedUserId = String(req.params.userId || '').trim();
    const db = readDb();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const teams = (db.teams || [])
      .filter((team) => isTeamContributor(team, userId))
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())
      .map((team) => sanitizeTeam(team, db));

    return res.json({ teams });
  } catch (error) {
    return sendServerError(res, error, 'Could not load teams.');
  }
});

router.post(
  '/teams/create',
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const owner = (db.users || []).find((item) => item.id === userId);
    if (!owner) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const existingContributorTeam = (db.teams || []).find((team) => isTeamContributor(team, userId));
    if (existingContributorTeam) {
      return res.status(409).json({
        message: 'You are already linked to a team. Leave your current team before creating a new one.',
      });
    }

    const eventKey = String(req.body.eventKey || 'free-fire').trim() || 'free-fire';
    const teamName = String(req.body.teamName || '').trim().slice(0, 60);
    const seenGamePlayerIds = new Set();
    const players = [];
    let playerValidationError = '';

    for (let index = 0; index < 5; index += 1) {
      const basePlayer = sanitizePlayerBase({
        name: req.body[`playerName${index + 1}`],
        playerId: req.body[`playerId${index + 1}`],
        roleTag: index === 0 ? 'IGL' : 'Rusher',
      });
      const normalizedPlayerId = normalizeGamePlayerId(basePlayer.playerId);
      const normalizedPlayerIdKey = normalizedPlayerId.toUpperCase();

      if (normalizedPlayerId) {
        if (seenGamePlayerIds.has(normalizedPlayerIdKey)) {
          playerValidationError = `Duplicate GameID found in player slot ${index + 1}.`;
          break;
        }
        seenGamePlayerIds.add(normalizedPlayerIdKey);
      }

      if (!normalizedPlayerId) {
        players.push(basePlayer);
        continue;
      }

      const matchedUser = findUserByGamePlayerId(db, normalizedPlayerId);
      const gamePlayerResult = matchedUser
        ? syncUserGamePlayerId(db, matchedUser, normalizedPlayerId, { preserveExisting: true })
        : ensureGamePlayerIdSlotAvailability(db, normalizedPlayerId);

      if (gamePlayerResult.error) {
        playerValidationError = gamePlayerResult.error;
        break;
      }

      if (!matchedUser) {
        players.push({
          ...basePlayer,
          playerId: gamePlayerResult.value || normalizedPlayerId,
        });
        continue;
      }

      players.push(
        buildConnectedPlayerSlotFromUser(
          {
            ...basePlayer,
            playerId: gamePlayerResult.value || normalizedPlayerId,
          },
          matchedUser
        )
      );
    }

    if (playerValidationError) {
      return res.status(400).json({ message: playerValidationError });
    }

    if (!teamName) {
      return res.status(400).json({ message: 'Team name is required.' });
    }

    const hasAnyPlayer = players.some((player) => player.name || player.playerId);
    if (!hasAnyPlayer) {
      return res.status(400).json({ message: 'Add at least one player to create a team.' });
    }

    const logoUrl = toDataUrl(req.files?.logo?.[0]);
    const coverUrl = toDataUrl(req.files?.cover?.[0]);

    const timestamp = new Date().toISOString();
    const team = {
      id: crypto.randomUUID(),
      ownerUserId: userId,
      eventKey,
      teamName,
      publicTeamId: '',
      verified: false,
      tagline: '',
      bio: '',
      facebook: '',
      youtube: '',
      logoUrl,
      coverUrl,
      players,
      leaderIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const hydratedTeam = refreshTeamStoredProfiles(team, db);

    db.teams = db.teams || [];
    db.teams.push(hydratedTeam);
    (hydratedTeam.players || []).forEach((player, index) => {
      const connectedUser = String(player?.connectedUserId || '').trim()
        ? (db.users || []).find((item) => item.id === String(player.connectedUserId).trim())
        : null;
      if (connectedUser) {
        persistUserGamePlayerSnapshot(db, connectedUser, hydratedTeam, player, index);
      }
    });
    writeDb(db);

    return res.json({
      message: 'Team created successfully.',
      team: sanitizeTeam(hydratedTeam, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not create team.');
  }
});

router.post('/teams/:teamId/cover', upload.single('cover'), (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    const coverUrl = toDataUrl(req.file);
    if (!coverUrl) {
      return res.status(400).json({ message: 'Cover photo is required.' });
    }

    const refreshedTeam = refreshTeamStoredProfiles(
      {
        ...team,
        coverUrl,
        updatedAt: new Date().toISOString(),
      },
      db
    );
    Object.assign(team, refreshedTeam);
    writeDb(db);

    return res.json({
      message: 'Cover updated successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update cover.');
  }
});

router.post('/teams/:teamId/logo', upload.single('logo'), (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    const logoUrl = toDataUrl(req.file);
    if (!logoUrl) {
      return res.status(400).json({ message: 'Team logo is required.' });
    }

    const refreshedTeam = refreshTeamStoredProfiles(
      {
        ...team,
        logoUrl,
        updatedAt: new Date().toISOString(),
      },
      db
    );
    Object.assign(team, refreshedTeam);
    writeDb(db);

    return res.json({
      message: 'Logo updated successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update logo.');
  }
});

router.post('/teams/:teamId/player/:slot/update', (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const slotIndex = Number(req.params.slot);
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
      return res.status(400).json({ message: 'Invalid player slot.' });
    }

    const currentPlayer = sanitizePlayerBase(team.players[slotIndex]);
    const connectedUser = currentPlayer.connectedUserId
      ? (db.users || []).find((item) => item.id === currentPlayer.connectedUserId)
      : null;
    const requestedName = String(req.body.name || '').trim().slice(0, 40);
    const requestedPlayerId = normalizeGamePlayerId(req.body.playerId);
    const preferredPlayerId = requestedPlayerId || currentPlayer.playerId;
    const matchedUser = requestedPlayerId ? findUserByGamePlayerId(db, requestedPlayerId) : null;
    const slotAvailabilityResult = ensureGamePlayerIdSlotAvailability(db, preferredPlayerId, {
      excludeTeamId: team.id,
      excludeSlotIndex: slotIndex,
    });
    if (slotAvailabilityResult.error) {
      return res.status(400).json({ message: slotAvailabilityResult.error });
    }
    const resolvedConnectedUser = matchedUser || connectedUser || null;
    const gamePlayerResult = resolvedConnectedUser
      ? syncUserGamePlayerId(db, resolvedConnectedUser, preferredPlayerId, {
          preserveExisting: true,
          excludeTeamId: team.id,
          excludeSlotIndex: slotIndex,
        })
      : { value: preferredPlayerId };

    if (gamePlayerResult.error) {
      return res.status(400).json({ message: gamePlayerResult.error });
    }

    const nextPlayerId = gamePlayerResult.value || preferredPlayerId;
    const autoConnected = Boolean(
      matchedUser && (!connectedUser || connectedUser.id !== matchedUser.id || !currentPlayer.connectedProfile)
    );

    team.players[slotIndex] = autoConnected
      ? buildConnectedPlayerSlotFromUser(
          {
            ...currentPlayer,
            name: requestedName || currentPlayer.name,
            playerId: nextPlayerId,
          },
          matchedUser,
          { preserveName: false }
        )
      : {
          ...currentPlayer,
          profileData: team.players[slotIndex]?.profileData,
          name: requestedName || currentPlayer.name || '',
          playerId: nextPlayerId,
          connectedProfile: Boolean(resolvedConnectedUser),
          connectedProfileValue: resolvedConnectedUser
            ? String(resolvedConnectedUser.appProfileId || currentPlayer.connectedProfileValue || '').trim().slice(0, 80)
            : '',
          connectedUserId: resolvedConnectedUser ? String(resolvedConnectedUser.id || '').trim() : '',
        };
    Object.assign(
      team,
      refreshTeamStoredProfiles(
        {
          ...team,
          updatedAt: new Date().toISOString(),
        },
        db
      )
    );
    if (resolvedConnectedUser) {
      persistUserGamePlayerSnapshot(db, resolvedConnectedUser, team, team.players[slotIndex], slotIndex);
    }
    writeDb(db);

    return res.json({
      message: autoConnected
        ? 'Player updated and profile connected automatically.'
        : 'Player updated successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update player.');
  }
});

router.post('/teams/:teamId/player/:slot/connect', (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const slotIndex = Number(req.params.slot);
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
      return res.status(400).json({ message: 'Invalid player slot.' });
    }

    const profileValue = String(req.body.profileValue || '').trim();
    const targetUser = profileValue ? findUserByProfileValue(db, profileValue) : null;

    if (!targetUser) {
      return res.status(404).json({ message: 'No profile found for this unique ID or GameID.' });
    }

    const currentPlayer = sanitizePlayerBase(team.players[slotIndex]);
    const gamePlayerResult = syncUserGamePlayerId(db, targetUser, currentPlayer.playerId, {
      preserveExisting: true,
      excludeTeamId: team.id,
      excludeSlotIndex: slotIndex,
    });
    if (gamePlayerResult.error) {
      return res.status(400).json({ message: gamePlayerResult.error });
    }

    team.players[slotIndex] = {
      ...buildConnectedPlayerSlotFromUser(
        {
          ...currentPlayer,
          playerId: gamePlayerResult.value || currentPlayer.playerId,
        },
        targetUser
      ),
      connectedProfileValue: String(targetUser.appProfileId || profileValue || '').trim().slice(0, 80),
    };
    Object.assign(
      team,
      refreshTeamStoredProfiles(
        {
          ...team,
          updatedAt: new Date().toISOString(),
        },
        db
      )
    );
    persistUserGamePlayerSnapshot(db, targetUser, team, team.players[slotIndex], slotIndex);
    writeDb(db);

    return res.json({
      message: 'Profile connected.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not connect profile.');
  }
});

router.post('/teams/:teamId/player/:slot/remove', (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const slotIndex = Number(req.params.slot);
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamOwner(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
      return res.status(400).json({ message: 'Invalid player slot.' });
    }

    const currentPlayer = sanitizePlayerBase(team.players[slotIndex]);
    const connectedUser = currentPlayer.connectedUserId
      ? (db.users || []).find((item) => item.id === currentPlayer.connectedUserId)
      : null;
    if (connectedUser) {
      const seededGamePlayerId =
        getUserGamePlayerId(connectedUser) ||
        normalizeGamePlayerId(currentPlayer.playerId) ||
        normalizeGamePlayerId(currentPlayer.connectedProfileValue);
      if (seededGamePlayerId && !getUserGamePlayerId(connectedUser)) {
        const seededResult = syncUserGamePlayerId(db, connectedUser, seededGamePlayerId, {
          preserveExisting: false,
          excludeTeamId: team.id,
          excludeSlotIndex: slotIndex,
        });
        if (seededResult.error) {
          return res.status(400).json({ message: seededResult.error });
        }
      }
      persistUserGamePlayerSnapshot(db, connectedUser, team, team.players[slotIndex], slotIndex);
    }

    team.players[slotIndex] = {
      name: '',
      playerId: '',
      realName: '',
      countryFlag: '',
      region: '',
      roleTag: '',
      statusBadge: '',
      kdRatio: '',
      headshotPct: '',
      mvpCount: '',
      trend: '',
      verified: false,
      bio: '',
      connectedProfile: false,
      connectedProfileValue: '',
      connectedUserId: '',
      profileData: {},
    };

    const remainingPlayerIndex = (team.players || []).findIndex((player, index) =>
      index !== slotIndex &&
      (String(player?.name || '').trim() ||
        String(player?.playerId || '').trim() ||
        String(player?.connectedUserId || '').trim() ||
        String(player?.connectedProfileValue || '').trim())
    );

    Object.assign(
      team,
      refreshTeamStoredProfiles(
        {
          ...team,
          leaderIndex:
            slotIndex === team.leaderIndex
              ? remainingPlayerIndex >= 0
                ? remainingPlayerIndex
                : 0
              : team.leaderIndex,
          updatedAt: new Date().toISOString(),
        },
        db
      )
    );
    writeDb(db);

    return res.json({
      message: 'Player removed successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not remove player.');
  }
});

router.post('/teams/:teamId/player/:slot/profile', (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const slotIndex = Number(req.params.slot);
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && canEditPlayerProfile(item, slotIndex, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
      return res.status(400).json({ message: 'Invalid player slot.' });
    }

    const payload = parseObjectPayload(req.body.profile);
    const updateResult = applyPlayerProfilePayload(db, team, slotIndex, payload);
    if (updateResult.error) {
      return res.status(400).json({ message: updateResult.error });
    }
    writeDb(db);

    return res.json({
      message: 'Player profile updated successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update player profile.');
  }
});

router.post('/players/me/profile', (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const payload = parseObjectPayload(req.body.profile);
    const linkedTeam = (db.teams || [])
      .slice()
      .sort((left, right) => new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime())
      .find(
        (item) =>
          Array.isArray(item?.players) &&
          item.players.some((player) => String(player?.connectedUserId || '').trim() === userId)
      );

    if (linkedTeam) {
      const playerIndex = (linkedTeam.players || []).findIndex(
        (player) => String(player?.connectedUserId || '').trim() === userId
      );
      const updateResult = applyPlayerProfilePayload(db, linkedTeam, playerIndex, payload);
      if (updateResult.error) {
        return res.status(400).json({ message: updateResult.error });
      }

      writeDb(db);
      const sanitizedTeam = sanitizeTeam(linkedTeam, db);
      return res.json({
        message: 'Player profile updated successfully.',
        team: sanitizedTeam,
        playerIndex,
        player: sanitizedTeam.players[playerIndex],
        standalone: false,
      });
    }

    const standaloneView = buildStandalonePlayerView(db, user);
    if (!standaloneView?.team || !standaloneView?.player) {
      return res.status(404).json({ message: 'Player profile not found.' });
    }

    const standaloneTeam = {
      ...standaloneView.team,
      players: Array.isArray(standaloneView.team?.players) ? standaloneView.team.players.map((item) => ({ ...item })) : [],
    };
    const updateResult = applyPlayerProfilePayload(db, standaloneTeam, standaloneView.playerIndex, payload);
    if (updateResult.error) {
      return res.status(400).json({ message: updateResult.error });
    }

    persistUserGamePlayerSnapshot(db, user, standaloneTeam, standaloneTeam.players[standaloneView.playerIndex], standaloneView.playerIndex);
    writeDb(db);

    const nextStandaloneView = buildStandalonePlayerView(db, user);
    return res.json({
      message: 'Player profile updated successfully.',
      ...nextStandaloneView,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update player profile.');
  }
});

router.post('/teams/:teamId/leader', (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const slotIndex = Number(req.body.slotIndex);
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (team.players || []).length) {
      return res.status(400).json({ message: 'Invalid player slot.' });
    }

    Object.assign(
      team,
      refreshTeamStoredProfiles(
        {
          ...team,
          leaderIndex: slotIndex,
          updatedAt: new Date().toISOString(),
        },
        db
      )
    );
    writeDb(db);

    return res.json({
      message: 'Leader updated successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update leader.');
  }
});

router.post('/teams/:teamId/profile', (req, res) => {
  try {
    const db = readDb();
    const teamId = String(req.params.teamId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    const sponsors = parseObjectPayload(req.body.sponsors);
    const nextPageData = team.pageData && typeof team.pageData === 'object' ? { ...team.pageData } : {};
    const nextSponsors =
      nextPageData.sponsors && typeof nextPageData.sponsors === 'object' ? { ...nextPageData.sponsors } : {};

    if (Object.prototype.hasOwnProperty.call(req.body, 'teamName')) {
      team.teamName = String(req.body.teamName || '').trim().slice(0, 60) || team.teamName;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'tagline')) {
      team.tagline = String(req.body.tagline || '').trim().slice(0, 140);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'bio')) {
      team.bio = String(req.body.bio || '').trim().slice(0, 240);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'facebook')) {
      team.facebook = String(req.body.facebook || '').trim().slice(0, 160);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'youtube')) {
      team.youtube = String(req.body.youtube || '').trim().slice(0, 160);
    }

    ['owner', 'manager', 'coach', 'analyst', 'creator', 'bio'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(sponsors, key)) {
        nextSponsors[key] = String(sponsors[key] || '').trim().slice(0, key === 'bio' ? 240 : 80);
      }
    });
    if (Object.prototype.hasOwnProperty.call(sponsors, 'partners')) {
      nextSponsors.partners = Array.isArray(sponsors.partners)
        ? sponsors.partners
            .map((item) => String(item || '').trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 12)
        : [];
    }

    nextPageData.sponsors = nextSponsors;

    Object.assign(
      team,
      refreshTeamStoredProfiles(
        {
          ...team,
          pageData: nextPageData,
          updatedAt: new Date().toISOString(),
        },
        db
      )
    );
    writeDb(db);

    return res.json({
      message: 'Team profile updated successfully.',
      team: sanitizeTeam(team, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update team profile.');
  }
});

router.get('/teams/public/:publicTeamId', (req, res) => {
  try {
    const db = readDb();
    const publicTeamId = String(req.params.publicTeamId || '').trim().toUpperCase();
    const team = (db.teams || []).find((item) => String(item.publicTeamId || '').trim().toUpperCase() === publicTeamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    return res.json({ team: sanitizeTeam(team, db) });
  } catch (error) {
    return sendServerError(res, error, 'Could not load team.');
  }
});

router.get('/tournament-rooms/:roomCode/assignments/:userId', (req, res) => {
  try {
    const db = readDb();
    const roomCode = String(req.params.roomCode || '').trim().slice(0, 40);
    const tournamentId = String(req.query.tournamentId || '').trim().slice(0, 40);
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    if (!roomCode) {
      return res.status(400).json({ message: 'Room code is required.' });
    }

    const assignments = getTournamentRoomAssignmentsWithPending(db, roomCode, tournamentId);
    return res.json({
      roomCode,
      tournamentId,
      assignments,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load room assignments.');
  }
});

router.post('/tournament-rooms/:roomCode/assignments', (req, res) => {
  try {
    const db = readDb();
    const roomCode = String(req.params.roomCode || '').trim().slice(0, 40);
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    if (!roomCode) {
      return res.status(400).json({ message: 'Room code is required.' });
    }

    const userId = authorization.userId;
    const slotNumber = Number(req.body.slot);
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 99) {
      return res.status(400).json({ message: 'Invalid room slot.' });
    }

    const normalizedSlot = String(slotNumber).padStart(2, '0');
    const tournamentId = String(req.body.tournamentId || '').trim().slice(0, 40);
    if (!tournamentId) {
      return res.status(400).json({ message: 'Tournament ID is required.' });
    }

    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const teamId = String(req.body.teamId || '').trim();
    const team = (db.teams || []).find((item) => item.id === teamId && isTeamContributor(item, userId));
    if (!team) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    if (String(team.eventKey || '').trim() !== 'free-fire') {
      return res.status(400).json({ message: 'Only event teams can book tournament slots.' });
    }

    db.tournamentRoomAssignments = db.tournamentRoomAssignments || [];
    db.tournamentBookingRequests = db.tournamentBookingRequests || [];
    const pendingRequests = getTournamentPendingBookingRequests(db, tournamentId, { status: 'pending' });
    const conflictingAssignment = db.tournamentRoomAssignments.find(
      (assignment) =>
        String(assignment?.roomCode || '').trim() === identity.roomCode &&
        String(assignment?.tournamentId || '').trim() === tournamentId &&
        String(assignment?.slot || '').trim() === normalizedSlot &&
        String(assignment?.teamId || '').trim() !== team.id
    );
    if (conflictingAssignment) {
      return res.status(409).json({ message: 'This slot is already taken.' });
    }

    const conflictingPendingRequest = pendingRequests.find(
      (request) =>
        String(request?.requestedSlot || '').trim() === normalizedSlot &&
        String(request?.teamId || '').trim() !== String(team.id || '').trim()
    );
    if (conflictingPendingRequest) {
      return res.status(409).json({ message: 'This slot already has a pending booking request.' });
    }

    const previousAssignment = db.tournamentRoomAssignments.find(
      (assignment) =>
        String(assignment?.roomCode || '').trim() === identity.roomCode &&
        String(assignment?.tournamentId || '').trim() === tournamentId &&
        (String(assignment?.teamId || '').trim() === team.id || String(assignment?.userId || '').trim() === userId)
    );

    const previousPendingRequest = pendingRequests.find(
      (request) =>
        String(request?.teamId || '').trim() === String(team.id || '').trim() ||
        String(request?.requesterUserId || '').trim() === userId
    );

    const isOwner = String(tournament?.ownerUserId || '').trim() === userId;
    const entryFree = isTournamentEntryFree(tournament);
    const referenceCode = String(req.body.referenceCode || '').trim().slice(0, 40);
    const timestamp = new Date().toISOString();
    const snapshot = buildTournamentRoomAssignmentSnapshot(team);

    if (!isOwner && !entryFree) {
      db.tournamentBookingRequests = db.tournamentBookingRequests.filter(
        (request) =>
          !(
            String(request?.tournamentId || '').trim() === tournamentId &&
            (String(request?.teamId || '').trim() === String(team.id || '').trim() ||
              String(request?.requesterUserId || '').trim() === userId)
          )
      );

      db.tournamentBookingRequests.push({
        id: previousPendingRequest?.id || crypto.randomUUID(),
        tournamentId,
        roomCode: identity.roomCode,
        ownerUserId: String(tournament?.ownerUserId || '').trim(),
        requesterUserId: userId,
        teamId: team.id,
        teamName: snapshot.teamName,
        publicTeamId: snapshot.publicTeamId,
        logoUrl: snapshot.logoUrl,
        playerNames: snapshot.playerNames,
        requestedSlot: normalizedSlot,
        referenceCode,
        amountLabel: String(tournament?.entryFee || '').trim().slice(0, 40),
        status: 'pending',
        createdAt: previousPendingRequest?.createdAt || timestamp,
        updatedAt: timestamp,
      });

      writeDb(db);

      return res.json({
        message:
          previousPendingRequest && String(previousPendingRequest?.requestedSlot || '').trim() !== normalizedSlot
            ? 'Booking request moved to the new slot and is pending host approval.'
            : 'Booking request sent and is pending host approval.',
        pending: true,
        request: getTournamentPendingBookingRequests(db, tournamentId, { status: 'pending' }).find(
          (request) => String(request?.teamId || '').trim() === String(team.id || '').trim()
        ) || null,
        assignments: getTournamentRoomAssignmentsWithPending(db, identity.roomCode, tournamentId),
      });
    }

    db.tournamentRoomAssignments = db.tournamentRoomAssignments.filter(
      (assignment) =>
        !(
          String(assignment?.roomCode || '').trim() === identity.roomCode &&
          String(assignment?.tournamentId || '').trim() === tournamentId &&
          (String(assignment?.teamId || '').trim() === team.id || String(assignment?.userId || '').trim() === userId)
        )
    );

    db.tournamentRoomAssignments.push({
      id: previousAssignment?.id || crypto.randomUUID(),
      roomCode: identity.roomCode,
      tournamentId,
      slot: normalizedSlot,
      userId,
      teamId: team.id,
      teamName: snapshot.teamName,
      eventKey: snapshot.eventKey,
      publicTeamId: snapshot.publicTeamId,
      playerNames: snapshot.playerNames,
      createdAt: previousAssignment?.createdAt || timestamp,
      updatedAt: timestamp,
    });

    syncTournamentConfirmedTeams(db, tournamentId);

    writeDb(db);

    const assignments = getTournamentRoomAssignments(db, identity.roomCode, tournamentId);
    return res.json({
      message:
        previousAssignment && String(previousAssignment.slot || '').trim() !== normalizedSlot
          ? 'Team moved to the new room slot.'
          : 'Team confirmed successfully.',
      assignment: assignments.find((assignment) => assignment.teamId === team.id) || null,
      assignments,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not confirm room slot.');
  }
});

router.post('/host-applications/create', upload.fields([{ name: 'nidCard', maxCount: 1 }, { name: 'hostImage', maxCount: 1 }]), (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const rawPaymentNumbers = Array.isArray(req.body.paymentNumbers)
      ? req.body.paymentNumbers
      : typeof req.body.paymentNumbers === 'string'
        ? [req.body.paymentNumbers]
        : [];
    const paymentNumbers = rawPaymentNumbers
      .map((value) => String(value || '').trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 3);

    const payload = {
      name: String(req.body.name || '').trim().slice(0, 60),
      playerId: String(req.body.playerId || '').trim().slice(0, 40),
      nationality: String(req.body.nationality || '').trim().slice(0, 40),
      district: String(req.body.district || '').trim().slice(0, 60),
      subDistrict: String(req.body.subDistrict || '').trim().slice(0, 60),
      mobileNumber: String(req.body.mobileNumber || '').trim().slice(0, 20),
      paymentNumbers,
    };

    const requiredFields = [
      ['name', 'Name is required.'],
      ['nationality', 'Nationality is required.'],
      ['district', 'District is required.'],
      ['subDistrict', 'Sub-district is required.'],
      ['mobileNumber', 'Mobile number is required.'],
    ];

    for (const [field, message] of requiredFields) {
      if (!String(payload[field] || '').trim()) {
        return res.status(400).json({ message });
      }
    }

    if (!payload.paymentNumbers.length) {
      return res.status(400).json({ message: 'At least one bkash/nagad number is required.' });
    }

    const nidCardFile = req.files?.nidCard?.[0] || null;
    const hostImageFile = req.files?.hostImage?.[0] || null;

    if (!nidCardFile) {
      return res.status(400).json({ message: 'NID card image is required.' });
    }

    if (!String(nidCardFile?.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ message: 'NID card must be an image.' });
    }
    if (hostImageFile && !String(hostImageFile?.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ message: 'Your image must be an image.' });
    }

    db.hostApplications = db.hostApplications || [];
    const existingApplication = db.hostApplications.find((entry) => String(entry?.userId || '').trim() === userId);
    const timestamp = new Date().toISOString();
    const nextApplication = sanitizeHostApplication({
      ...existingApplication,
      id: existingApplication?.id || crypto.randomUUID(),
      userId,
      ...payload,
      hostImageUrl: hostImageFile ? toDataUrl(hostImageFile) : existingApplication?.hostImageUrl || '',
      nidCardImageUrl: toDataUrl(nidCardFile),
      status: 'pending',
      createdAt: existingApplication?.createdAt || timestamp,
      updatedAt: timestamp,
    });

    db.hostApplications = [
      nextApplication,
      ...db.hostApplications.filter((entry) => String(entry?.userId || '').trim() !== userId),
    ];
    writeDb(db);

    return res.json({
      message: existingApplication ? 'Host application updated successfully.' : 'Host application submitted successfully.',
      application: nextApplication,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not submit host application.');
  }
});

router.get('/host-applications/:userId', (req, res) => {
  try {
    const db = readDb();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    db.hostApplications = db.hostApplications || [];
    const application = db.hostApplications.find((entry) => String(entry?.userId || '').trim() === userId) || null;

    return res.json({
      application: application ? sanitizeHostApplication(application) : null,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load host application.');
  }
});

router.post('/host-applications/update', upload.fields([{ name: 'nidCard', maxCount: 1 }, { name: 'hostImage', maxCount: 1 }]), (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    db.hostApplications = db.hostApplications || [];
    const existingApplication = db.hostApplications.find((entry) => String(entry?.userId || '').trim() === userId);
    if (!existingApplication) {
      return res.status(404).json({ message: 'Host application not found.' });
    }

    const rawPaymentNumbers = Array.isArray(req.body.paymentNumbers)
      ? req.body.paymentNumbers
      : typeof req.body.paymentNumbers === 'string'
        ? [req.body.paymentNumbers]
        : [];
    const paymentNumbers = rawPaymentNumbers
      .map((value) => String(value || '').trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 3);

    const payload = {
      name: String(req.body.name || '').trim().slice(0, 60),
      playerId: String(req.body.playerId || '').trim().slice(0, 40),
      nationality: String(req.body.nationality || '').trim().slice(0, 40),
      district: String(req.body.district || '').trim().slice(0, 60),
      subDistrict: String(req.body.subDistrict || '').trim().slice(0, 60),
      mobileNumber: String(req.body.mobileNumber || '').trim().slice(0, 20),
      paymentNumbers,
    };

    const requiredFields = [
      ['name', 'Name is required.'],
      ['nationality', 'Nationality is required.'],
      ['district', 'District is required.'],
      ['subDistrict', 'Sub-district is required.'],
      ['mobileNumber', 'Mobile number is required.'],
    ];

    for (const [field, message] of requiredFields) {
      if (!String(payload[field] || '').trim()) {
        return res.status(400).json({ message });
      }
    }

    if (!payload.paymentNumbers.length) {
      return res.status(400).json({ message: 'At least one bkash/nagad number is required.' });
    }

    const nidCardFile = req.files?.nidCard?.[0] || null;
    const hostImageFile = req.files?.hostImage?.[0] || null;

    if (nidCardFile && !String(nidCardFile?.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ message: 'NID card must be an image.' });
    }
    if (hostImageFile && !String(hostImageFile?.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ message: 'Your image must be an image.' });
    }

    const nextApplication = sanitizeHostApplication({
      ...existingApplication,
      ...payload,
      hostImageUrl: hostImageFile ? toDataUrl(hostImageFile) : existingApplication.hostImageUrl,
      nidCardImageUrl: nidCardFile ? toDataUrl(nidCardFile) : existingApplication.nidCardImageUrl,
      updatedAt: new Date().toISOString(),
    });

    db.hostApplications = [
      nextApplication,
      ...db.hostApplications.filter((entry) => String(entry?.userId || '').trim() !== userId),
    ];
    writeDb(db);

    return res.json({
      message: 'Host application updated successfully.',
      application: nextApplication,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update host application.');
  }
});

router.post('/tournaments/create', (req, res) => {
  try {
    const db = readDb();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const requestedCreationMode = String(req.body.creationMode || req.body.createdByRole || 'host').trim().toLowerCase();
    const creationMode = requestedCreationMode === 'admin' ? 'admin' : 'host';

    db.hostApplications = db.hostApplications || [];
    const hostApplication = db.hostApplications.find((entry) => String(entry?.userId || '').trim() === userId);
    if (creationMode === 'host' && !hostApplication) {
      return res.status(403).json({ message: 'Host access required before creating a tournament.' });
    }

    const payload = {
      title: String(req.body.title || '').trim().slice(0, 80),
      badge: String(req.body.badge || '').trim().slice(0, 24),
      status: String(req.body.status || '').trim().slice(0, 40),
      description: String(req.body.description || '').trim().slice(0, 220),
      stream: String(req.body.stream || '').trim().slice(0, 40),
      prizePool: String(req.body.prizePool || '').trim().slice(0, 40),
      entryFee: String(req.body.entryFee || '').trim().slice(0, 40),
      teamLimit: Math.max(1, Math.min(99, Number(req.body.teamLimit) || 12)),
      footerTitle: String(req.body.footerTitle || '').trim().slice(0, 50),
      footerText: String(req.body.footerText || '').trim().slice(0, 180),
      roomStatus: String(req.body.roomStatus || '').trim().slice(0, 60),
      boardText: String(req.body.boardText || '').trim().slice(0, 180),
      note: String(req.body.note || '').trim().slice(0, 180),
      broadcastLane: String(req.body.broadcastLane || '').trim().slice(0, 30),
      sidecardOneTitle: String(req.body.sidecardOneTitle || '').trim().slice(0, 40),
      sidecardOneText: String(req.body.sidecardOneText || '').trim().slice(0, 140),
      sidecardTwoTitle: String(req.body.sidecardTwoTitle || '').trim().slice(0, 40),
      sidecardTwoText: String(req.body.sidecardTwoText || '').trim().slice(0, 140),
    };

    const requiredFields = [
      ['title', 'Tournament title is required.'],
      ['prizePool', 'Prize pool is required.'],
      ['teamLimit', 'Teams is required.'],
    ];

    for (const [field, message] of requiredFields) {
      if (!String(payload[field] || '').trim()) {
        return res.status(400).json({ message });
      }
    }

    db.tournaments = db.tournaments || [];
    const timestamp = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      ownerUserId: userId,
      creationMode,
      createdByRole: creationMode,
      createdBySource: creationMode,
      ...payload,
      confirmedTeams: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const identity = buildTournamentRoomIdentity(record);
    record.roomCode = identity.roomCode;
    record.boardTitle = record.boardTitle || identity.boardTitle;

    db.tournaments.unshift(record);
    writeDb(db);

    return res.json({
      message: 'Tournament created successfully.',
      tournament: sanitizeTournament(record, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not create tournament.');
  }
});

router.post('/tournaments/:tournamentId/update', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const payload = {
      title: String(req.body.title || '').trim().slice(0, 80),
      badge: String(req.body.badge || '').trim().slice(0, 24),
      status: String(req.body.status || '').trim().slice(0, 40),
      description: String(req.body.description || '').trim().slice(0, 220),
      stream: String(req.body.stream || '').trim().slice(0, 40),
      prizePool: String(req.body.prizePool || '').trim().slice(0, 40),
      entryFee: String(req.body.entryFee || '').trim().slice(0, 40),
      teamLimit: Math.max(1, Math.min(99, Number(req.body.teamLimit) || 12)),
      footerTitle: String(req.body.footerTitle || '').trim().slice(0, 50),
      footerText: String(req.body.footerText || '').trim().slice(0, 180),
      roomStatus: String(req.body.roomStatus || '').trim().slice(0, 60),
      boardText: String(req.body.boardText || '').trim().slice(0, 180),
      note: String(req.body.note || '').trim().slice(0, 180),
      broadcastLane: String(req.body.broadcastLane || '').trim().slice(0, 30),
      sidecardOneTitle: String(req.body.sidecardOneTitle || '').trim().slice(0, 40),
      sidecardOneText: String(req.body.sidecardOneText || '').trim().slice(0, 140),
      sidecardTwoTitle: String(req.body.sidecardTwoTitle || '').trim().slice(0, 40),
      sidecardTwoText: String(req.body.sidecardTwoText || '').trim().slice(0, 140),
    };

    const requiredFields = [
      ['title', 'Tournament title is required.'],
      ['prizePool', 'Prize pool is required.'],
      ['teamLimit', 'Teams is required.'],
    ];

    for (const [field, message] of requiredFields) {
      if (!String(payload[field] || '').trim()) {
        return res.status(400).json({ message });
      }
    }

    Object.assign(tournament, payload, {
      confirmedTeams: Math.min(Number(tournament.confirmedTeams) || 0, payload.teamLimit),
      updatedAt: new Date().toISOString(),
    });
    const identity = buildTournamentRoomIdentity(tournament);
    tournament.roomCode = identity.roomCode;
    tournament.boardTitle = tournament.boardTitle || identity.boardTitle;
    syncTournamentConfirmedTeams(db, tournamentId);
    writeDb(db);

    return res.json({
      message: 'Tournament updated successfully.',
      tournament: sanitizeTournament(tournament, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update tournament.');
  }
});

router.post('/tournaments/:tournamentId/add-team', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const lookup = String(req.body.teamLookup || '').trim();
    const publicTeamId = String(req.body.publicTeamId || '').trim().toUpperCase();
    const normalizedLookup = lookup.toLowerCase();
    const team =
      (db.teams || []).find((item) => String(item?.publicTeamId || '').trim().toUpperCase() === publicTeamId) ||
      (db.teams || []).find((item) => String(item?.teamName || '').trim().toLowerCase() === normalizedLookup);
    const manualTeamName = String(req.body.teamLookup || '').trim().slice(0, 60);

    if (!team && !manualTeamName) {
      return res.status(404).json({ message: 'Team not found.' });
    }

    if (team && String(team?.eventKey || '').trim() !== 'free-fire') {
      return res.status(400).json({ message: 'Only Free Fire teams can be added here.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const teamLimit = Math.max(1, Math.min(99, Number(tournament.teamLimit) || 12));
    const assignments = getTournamentRoomAssignments(db, identity.roomCode, tournamentId);
    const pendingRequests = getTournamentPendingBookingRequests(db, tournamentId, { status: 'pending' });
    const existingAssignment = team
      ? assignments.find((assignment) => String(assignment?.teamId || '').trim() === String(team.id || '').trim())
      : assignments.find((assignment) => !String(assignment?.teamId || '').trim() && String(assignment?.teamName || '').trim().toLowerCase() === manualTeamName.toLowerCase());
    if (existingAssignment) {
      return res.status(409).json({ message: 'This team is already added to the tournament.' });
    }

    const existingPendingRequest = team
      ? pendingRequests.find((request) => String(request?.teamId || '').trim() === String(team.id || '').trim())
      : pendingRequests.find((request) => !String(request?.teamId || '').trim() && String(request?.teamName || '').trim().toLowerCase() === manualTeamName.toLowerCase());
    if (existingPendingRequest) {
      return res.status(409).json({ message: 'This team already has a pending booking request.' });
    }

    if (assignments.length >= teamLimit) {
      return res.status(409).json({ message: 'All tournament slots are already filled.' });
    }

    const requestedSlotRaw = Number(req.body.slot);
    const requestedSlot =
      Number.isInteger(requestedSlotRaw) && requestedSlotRaw >= 1 && requestedSlotRaw <= teamLimit
        ? String(requestedSlotRaw).padStart(2, '0')
        : '';

    const occupiedSlots = new Set(assignments.map((assignment) => String(assignment?.slot || '').trim()));
    pendingRequests.forEach((request) => {
      const requestedSlot = String(request?.requestedSlot || '').trim();
      if (requestedSlot) {
        occupiedSlots.add(requestedSlot);
      }
    });
    const nextSlot = requestedSlot
      ? requestedSlot
      : Array.from({ length: teamLimit }, (_, index) => String(index + 1).padStart(2, '0')).find((slot) => !occupiedSlots.has(slot));

    if (!nextSlot) {
      return res.status(409).json({ message: 'No free slot available for this tournament.' });
    }

    if (requestedSlot && occupiedSlots.has(requestedSlot)) {
      return res.status(409).json({ message: 'This slot is already booked.' });
    }

    const snapshot = team ? buildTournamentRoomAssignmentSnapshot(team) : buildManualTournamentRoomAssignmentSnapshot({ teamName: manualTeamName });
    const timestamp = new Date().toISOString();
    const isOwner = String(tournament?.ownerUserId || '').trim() === userId;
    const entryFree = isTournamentEntryFree(tournament);
    const referenceCode = String(req.body.referenceCode || '').trim().slice(0, 40);

    if (!isOwner && !entryFree) {
      db.tournamentBookingRequests = db.tournamentBookingRequests || [];
      db.tournamentBookingRequests.push({
        id: crypto.randomUUID(),
        tournamentId,
        roomCode: identity.roomCode,
        ownerUserId: String(tournament?.ownerUserId || '').trim(),
        requesterUserId: team ? String(team?.ownerUserId || '').trim() : userId,
        teamId: team ? String(team.id || '').trim() : '',
        teamName: snapshot.teamName,
        publicTeamId: snapshot.publicTeamId,
        logoUrl: snapshot.logoUrl,
        playerNames: snapshot.playerNames,
        requestedSlot: nextSlot,
        referenceCode,
        amountLabel: String(tournament?.entryFee || '').trim().slice(0, 40),
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      writeDb(db);

      return res.json({
        message: `${snapshot.teamName || 'Team'} booking request is pending host approval.`,
        pending: true,
        request: getTournamentPendingBookingRequests(db, tournamentId, { status: 'pending' }).find(
          (request) =>
            team
              ? String(request?.teamId || '').trim() === String(team.id || '').trim()
              : !String(request?.teamId || '').trim() && String(request?.teamName || '').trim().toLowerCase() === manualTeamName.toLowerCase()
        ) || null,
      });
    }

    db.tournamentRoomAssignments = db.tournamentRoomAssignments || [];

    db.tournamentRoomAssignments.push({
      id: crypto.randomUUID(),
      roomCode: identity.roomCode,
      tournamentId,
      slot: nextSlot,
      userId: team ? String(team?.ownerUserId || '').trim() : userId,
      teamId: team ? team.id : '',
      teamName: snapshot.teamName,
      eventKey: snapshot.eventKey,
      publicTeamId: snapshot.publicTeamId,
      logoUrl: snapshot.logoUrl,
      playerNames: snapshot.playerNames,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    syncTournamentConfirmedTeams(db, tournamentId);
    writeDb(db);

    const nextTournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId) || tournament;
    return res.json({
      message: `${snapshot.teamName || 'Team'} added successfully.`,
      tournament: sanitizeTournament(nextTournament, db),
      assignment: getTournamentRoomAssignments(db, identity.roomCode, tournamentId).find(
        (assignment) =>
          team
            ? String(assignment?.teamId || '').trim() === String(team.id || '').trim()
            : !String(assignment?.teamId || '').trim() && String(assignment?.teamName || '').trim().toLowerCase() === manualTeamName.toLowerCase()
      ) || null,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not add team.');
  }
});

router.post('/tournaments/:tournamentId/remove-team', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const slot = String(req.body.slot || '').trim().slice(0, 4);
    if (!slot) {
      return res.status(400).json({ message: 'Slot is required.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const existingAssignment = (db.tournamentRoomAssignments || []).find(
      (assignment) =>
        String(assignment?.roomCode || '').trim() === identity.roomCode &&
        String(assignment?.tournamentId || '').trim() === tournamentId &&
        String(assignment?.slot || '').trim() === slot
    );

    if (!existingAssignment) {
      return res.status(404).json({ message: 'No team booked in this slot.' });
    }

    db.tournamentRoomAssignments = (db.tournamentRoomAssignments || []).filter(
      (assignment) =>
        !(
          String(assignment?.roomCode || '').trim() === identity.roomCode &&
          String(assignment?.tournamentId || '').trim() === tournamentId &&
          String(assignment?.slot || '').trim() === slot
        )
    );

    syncTournamentConfirmedTeams(db, tournamentId);
    writeDb(db);

    const nextTournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId) || tournament;
    return res.json({
      message: 'Team removed from slot successfully.',
      tournament: sanitizeTournament(nextTournament, db),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not remove team.');
  }
});

router.get('/tournaments/:tournamentId/teams/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const teams = getTournamentRoomAssignments(db, identity.roomCode, tournamentId).map((assignment) => ({
      slot: String(assignment?.slot || '').trim(),
      userId: String(assignment?.userId || '').trim(),
      teamId: String(assignment?.teamId || '').trim(),
      teamName: String(assignment?.teamName || '').trim(),
      publicTeamId: String(assignment?.publicTeamId || '').trim(),
      logoUrl: String(assignment?.logoUrl || '').trim(),
      bookingStatus: 'confirmed',
    }));
    const pendingRequests = getTournamentPendingBookingRequests(db, tournamentId, { status: 'pending' }).map((request) => ({
      slot: String(request?.requestedSlot || '').trim(),
      userId: String(request?.requesterUserId || '').trim(),
      teamId: String(request?.teamId || '').trim(),
      teamName: String(request?.teamName || '').trim(),
      publicTeamId: String(request?.publicTeamId || '').trim(),
      logoUrl: String(request?.logoUrl || '').trim(),
      bookingStatus: 'pending',
      referenceCode: String(request?.referenceCode || '').trim(),
      requestId: String(request?.id || '').trim(),
    }));

    return res.json({
      tournamentId,
      roomCode: identity.roomCode,
      teams: [...teams, ...pendingRequests].sort((left, right) => Number(left.slot || 0) - Number(right.slot || 0)),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load tournament teams.');
  }
});

router.get('/tournaments/booking-requests/:userId', (req, res) => {
  try {
    const db = readDb();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const requests = (db.tournamentBookingRequests || [])
      .filter((request) => String(request?.ownerUserId || '').trim() === userId && String(request?.status || '').trim().toLowerCase() === 'pending')
      .map((request) => {
        const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === String(request?.tournamentId || '').trim());
        const sanitized = sanitizeTournamentBookingRequest(request, db);
        return {
          ...sanitized,
          tournamentTitle: String(tournament?.title || '').trim().slice(0, 80),
        };
      })
      .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime());

    return res.json({ requests });
  } catch (error) {
    return sendServerError(res, error, 'Could not load booking requests.');
  }
});

router.post('/tournaments/:tournamentId/booking-requests/:requestId/approve', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestId = String(req.params.requestId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    db.tournamentBookingRequests = db.tournamentBookingRequests || [];
    const requestIndex = db.tournamentBookingRequests.findIndex(
      (item) => String(item?.id || '').trim() === requestId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (requestIndex < 0) {
      return res.status(404).json({ message: 'Booking request not found.' });
    }

    const request = sanitizeTournamentBookingRequest(db.tournamentBookingRequests[requestIndex], db);
    if (String(request?.status || '').trim() !== 'pending') {
      return res.status(409).json({ message: 'This request is no longer pending.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const currentAssignments = getTournamentRoomAssignments(db, identity.roomCode, tournamentId);
    const occupiedByOtherTeam = currentAssignments.find(
      (assignment) =>
        String(assignment?.slot || '').trim() === String(request?.requestedSlot || '').trim() &&
        String(assignment?.teamId || '').trim() !== String(request?.teamId || '').trim()
    );
    if (occupiedByOtherTeam) {
      return res.status(409).json({ message: 'This slot is already confirmed by another team.' });
    }

    db.tournamentRoomAssignments = (db.tournamentRoomAssignments || []).filter(
      (assignment) =>
        !(
          String(assignment?.tournamentId || '').trim() === tournamentId &&
          (String(assignment?.teamId || '').trim() === String(request?.teamId || '').trim() ||
            String(assignment?.userId || '').trim() === String(request?.requesterUserId || '').trim())
        )
    );

    const timestamp = new Date().toISOString();
    db.tournamentRoomAssignments.push({
      id: crypto.randomUUID(),
      roomCode: identity.roomCode,
      tournamentId,
      slot: String(request?.requestedSlot || '').trim(),
      userId: String(request?.requesterUserId || '').trim(),
      teamId: String(request?.teamId || '').trim(),
      teamName: String(request?.teamName || '').trim(),
      eventKey: 'free-fire',
      publicTeamId: String(request?.publicTeamId || '').trim(),
      logoUrl: String(request?.logoUrl || '').trim(),
      playerNames: Array.isArray(request?.playerNames) ? request.playerNames : [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    db.tournamentBookingRequests[requestIndex] = {
      ...db.tournamentBookingRequests[requestIndex],
      status: 'approved',
      approvedAt: timestamp,
      updatedAt: timestamp,
    };

    syncTournamentConfirmedTeams(db, tournamentId);
    writeDb(db);

    return res.json({
      message: 'Booking request approved successfully.',
      assignment: getTournamentRoomAssignments(db, identity.roomCode, tournamentId).find(
        (assignment) => String(assignment?.teamId || '').trim() === String(request?.teamId || '').trim()
      ) || null,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not approve booking request.');
  }
});

router.post('/tournaments/:tournamentId/booking-requests/:requestId/reject', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestId = String(req.params.requestId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    db.tournamentBookingRequests = db.tournamentBookingRequests || [];
    const requestIndex = db.tournamentBookingRequests.findIndex(
      (item) => String(item?.id || '').trim() === requestId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (requestIndex < 0) {
      return res.status(404).json({ message: 'Booking request not found.' });
    }

    const request = db.tournamentBookingRequests[requestIndex];
    if (String(request?.status || '').trim() !== 'pending') {
      return res.status(409).json({ message: 'This request is no longer pending.' });
    }

    const timestamp = new Date().toISOString();
    db.tournamentBookingRequests[requestIndex] = {
      ...db.tournamentBookingRequests[requestIndex],
      status: 'rejected',
      rejectedAt: timestamp,
      updatedAt: timestamp,
    };

    writeDb(db);

    return res.json({
      message: 'Booking request rejected successfully.',
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not reject booking request.');
  }
});

router.get('/tournaments/:tournamentId/my-groups/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const contributorTeams = (db.teams || []).filter((team) => isTeamContributor(team, userId));
    const contributorTeamIds = new Set(
      contributorTeams.map((team) => String(team?.id || '').trim()).filter(Boolean)
    );
    const contributorPublicIds = new Set(
      contributorTeams.map((team) => String(team?.publicTeamId || '').trim().toLowerCase()).filter(Boolean)
    );
    const contributorNames = new Set(
      contributorTeams.map((team) => String(team?.teamName || '').trim().toLowerCase()).filter(Boolean)
    );

    const linkedGroupIds = new Set(
      (db.tournamentGroupDrops || [])
        .filter((assignment) => String(assignment?.tournamentId || '').trim() === tournamentId)
        .filter((assignment) => {
          const assignmentTeamId = String(assignment?.teamId || '').trim();
          const assignmentPublicId = String(assignment?.publicTeamId || '').trim().toLowerCase();
          const assignmentTeamName = String(assignment?.teamName || '').trim().toLowerCase();
          return (
            (assignmentTeamId && contributorTeamIds.has(assignmentTeamId)) ||
            (assignmentPublicId && contributorPublicIds.has(assignmentPublicId)) ||
            (assignmentTeamName && contributorNames.has(assignmentTeamName))
          );
        })
        .map((assignment) => String(assignment?.metaId || '').trim())
        .filter(Boolean)
    );

    const metas = (db.tournamentRoomBoardMeta || [])
      .filter(
        (item) =>
          String(item?.tournamentId || '').trim() === tournamentId &&
          linkedGroupIds.has(String(item?.id || '').trim())
      )
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());

    return res.json({
      tournamentId,
      metas,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load my group schedules.');
  }
});

router.get('/tournaments/:tournamentId/my-points-table/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const contributorTeams = (db.teams || []).filter((team) => isTeamContributor(team, userId));
    const contributorTeamIds = new Set(
      contributorTeams.map((team) => String(team?.id || '').trim()).filter(Boolean)
    );
    const contributorPublicIds = new Set(
      contributorTeams.map((team) => String(team?.publicTeamId || '').trim().toLowerCase()).filter(Boolean)
    );
    const contributorNames = new Set(
      contributorTeams.map((team) => String(team?.teamName || '').trim().toLowerCase()).filter(Boolean)
    );

    const linkedGroupIds = new Set(
      (db.tournamentGroupDrops || [])
        .filter((assignment) => String(assignment?.tournamentId || '').trim() === tournamentId)
        .filter((assignment) => {
          const assignmentTeamId = String(assignment?.teamId || '').trim();
          const assignmentPublicId = String(assignment?.publicTeamId || '').trim().toLowerCase();
          const assignmentTeamName = String(assignment?.teamName || '').trim().toLowerCase();
          return (
            (assignmentTeamId && contributorTeamIds.has(assignmentTeamId)) ||
            (assignmentPublicId && contributorPublicIds.has(assignmentPublicId)) ||
            (assignmentTeamName && contributorNames.has(assignmentTeamName))
          );
        })
        .map((assignment) => String(assignment?.metaId || '').trim())
        .filter(Boolean)
    );

    const sections = (db.tournamentRoomBoardMeta || [])
      .filter(
        (item) =>
          String(item?.tournamentId || '').trim() === tournamentId &&
          linkedGroupIds.has(String(item?.id || '').trim())
      )
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
      .map((meta) => {
        const metaId = String(meta?.id || '').trim();
        const entry = getTournamentPointsEntry(db, tournamentId, metaId);
        const sourceTeams = buildPointsEntryTeamSource(db, tournamentId, metaId);
        const matches = normalizePointsEntryMatches(entry?.matches || [], sourceTeams, meta?.totalMatches || 1);
        const leaderboard = buildPointsEntryLeaderboard(matches);
        return {
          meta,
          status: String(entry?.status || '').trim() || 'draft',
          leaderboard,
          totalMatches: matches.length,
        };
      });

    return res.json({
      tournamentId,
      sections,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load points table.');
  }
});

router.get('/tournaments/:tournamentId/points-entry/:metaId/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.params.metaId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const meta = (db.tournamentRoomBoardMeta || []).find(
      (item) => String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (!meta) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    const sourceTeams = buildPointsEntryTeamSource(db, tournamentId, metaId);
    const totalMatches = Math.max(1, Number.parseInt(String(meta?.totalMatches || '1').trim(), 10) || 1);
    const existingEntry = getTournamentPointsEntry(db, tournamentId, metaId);
    const matches = normalizePointsEntryMatches(existingEntry?.matches || [], sourceTeams, totalMatches);
    const leaderboard = buildPointsEntryLeaderboard(matches);

    return res.json({
      tournamentId,
      metaId,
      meta,
      entry: existingEntry
        ? {
            ...existingEntry,
            matches,
            leaderboard,
          }
        : null,
      groupData: {
        totalMatches,
        teams: sourceTeams,
      },
      matches,
      leaderboard,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load points entry.');
  }
});

router.post('/tournaments/:tournamentId/points-entry/:metaId/save', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.params.metaId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const meta = (db.tournamentRoomBoardMeta || []).find(
      (item) => String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (!meta) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    const sourceTeams = buildPointsEntryTeamSource(db, tournamentId, metaId);
    const matches = normalizePointsEntryMatches(req.body.matches || [], sourceTeams, meta?.totalMatches || 1);
    const leaderboard = buildPointsEntryLeaderboard(matches);
    const now = new Date().toISOString();

    db.tournamentPointsEntries = db.tournamentPointsEntries || [];
    const existingIndex = db.tournamentPointsEntries.findIndex(
      (item) =>
        String(item?.tournamentId || '').trim() === tournamentId &&
        String(item?.metaId || '').trim() === metaId
    );

    const nextEntry = {
      id: existingIndex >= 0 ? db.tournamentPointsEntries[existingIndex].id : crypto.randomUUID(),
      tournamentId,
      metaId,
      ownerUserId: userId,
      status: 'draft',
      matches,
      leaderboard,
      updatedAt: now,
      createdAt: existingIndex >= 0 ? db.tournamentPointsEntries[existingIndex].createdAt : now,
      publishedAt: existingIndex >= 0 ? db.tournamentPointsEntries[existingIndex].publishedAt || '' : '',
    };

    if (existingIndex >= 0) {
      db.tournamentPointsEntries[existingIndex] = {
        ...db.tournamentPointsEntries[existingIndex],
        ...nextEntry,
      };
    } else {
      db.tournamentPointsEntries.push(nextEntry);
    }

    db.teams = (db.teams || []).map((team) => applyPointsEntryToTeam(team, tournament, meta, matches, leaderboard, db));
    syncConnectedSnapshotsForTeams(db, db.teams);

    writeDb(db);
    return res.json({
      message: 'Points draft saved successfully.',
      entry: nextEntry,
      leaderboard,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not save points draft.');
  }
});

router.post('/tournaments/:tournamentId/points-entry/:metaId/publish', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.params.metaId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const meta = (db.tournamentRoomBoardMeta || []).find(
      (item) => String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (!meta) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    const sourceTeams = buildPointsEntryTeamSource(db, tournamentId, metaId);
    const matches = normalizePointsEntryMatches(req.body.matches || [], sourceTeams, meta?.totalMatches || 1);
    const leaderboard = buildPointsEntryLeaderboard(matches);
    const now = new Date().toISOString();

    db.tournamentPointsEntries = db.tournamentPointsEntries || [];
    const existingIndex = db.tournamentPointsEntries.findIndex(
      (item) =>
        String(item?.tournamentId || '').trim() === tournamentId &&
        String(item?.metaId || '').trim() === metaId
    );

    const nextEntry = {
      id: existingIndex >= 0 ? db.tournamentPointsEntries[existingIndex].id : crypto.randomUUID(),
      tournamentId,
      metaId,
      ownerUserId: userId,
      status: 'published',
      matches,
      leaderboard,
      updatedAt: now,
      createdAt: existingIndex >= 0 ? db.tournamentPointsEntries[existingIndex].createdAt : now,
      publishedAt: now,
    };

    if (existingIndex >= 0) {
      db.tournamentPointsEntries[existingIndex] = {
        ...db.tournamentPointsEntries[existingIndex],
        ...nextEntry,
      };
    } else {
      db.tournamentPointsEntries.push(nextEntry);
    }

    db.teams = (db.teams || []).map((team) => applyPointsEntryToTeam(team, tournament, meta, matches, leaderboard, db));
    syncConnectedSnapshotsForTeams(db, db.teams);

    writeDb(db);
    return res.json({
      message: 'Points published successfully.',
      entry: nextEntry,
      leaderboard,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not publish points.');
  }
});

router.get('/tournaments/:tournamentId/room-board/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const bookedTeams = getTournamentRoomAssignments(db, identity.roomCode, tournamentId).map((assignment) => ({
      slot: String(assignment?.slot || '').trim(),
      userId: String(assignment?.userId || '').trim(),
      teamId: String(assignment?.teamId || '').trim(),
      teamName: String(assignment?.teamName || '').trim(),
      publicTeamId: String(assignment?.publicTeamId || '').trim(),
      logoUrl: String(assignment?.logoUrl || '').trim(),
    }));
    const boardAssignments = getTournamentRoomBoardAssignments(db, tournamentId);
    const boardMap = new Map(
      boardAssignments.map((assignment) => [String(assignment?.slot || '').trim().padStart(2, '0'), assignment])
    );
    const slots = Array.from({ length: 12 }, (_, index) => {
      const slot = String(index + 1).padStart(2, '0');
      const assignment = boardMap.get(slot);
      return assignment
        ? {
            slot,
            teamId: String(assignment?.teamId || '').trim(),
            teamName: String(assignment?.teamName || '').trim(),
            publicTeamId: String(assignment?.publicTeamId || '').trim(),
            logoUrl: String(assignment?.logoUrl || '').trim(),
            sourceSlot: String(assignment?.sourceSlot || '').trim(),
          }
        : {
            slot,
            teamId: '',
            teamName: '',
            publicTeamId: '',
            logoUrl: '',
            sourceSlot: '',
          };
    });

    return res.json({
      tournamentId,
      slots,
      bookedTeams,
      metas: getTournamentRoomBoardMeta(db, tournamentId),
      meta: getTournamentRoomBoardMeta(db, tournamentId)[0] || {},
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load room board.');
  }
});

router.get('/tournaments/:tournamentId/chat/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    if (!canAccessTournamentChat(db, tournament, userId)) {
      return res.status(403).json({ message: 'You do not have access to this tournament chat.' });
    }

    const bookedTeams = getTournamentChatParticipants(db, tournament).map((assignment) => ({
      slot: String(assignment?.slot || '').trim(),
      userId: String(assignment?.userId || '').trim(),
      teamId: String(assignment?.teamId || '').trim(),
      teamName: String(assignment?.teamName || '').trim(),
      publicTeamId: String(assignment?.publicTeamId || '').trim(),
      logoUrl: String(assignment?.logoUrl || '').trim(),
    }));

    return res.json({
      tournamentId,
      connectedCount: bookedTeams.length,
      bookedTeams,
      messages: getTournamentChatMessages(db, tournamentId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load tournament chat.');
  }
});

router.post('/tournaments/:tournamentId/chat/send', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    if (!canAccessTournamentChat(db, tournament, userId)) {
      return res.status(403).json({ message: 'You do not have access to this tournament chat.' });
    }

    const text = String(req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ message: 'Message text is required.' });
    }

    db.tournamentChatMessages = db.tournamentChatMessages || [];
    const message = buildTournamentChatMessage({
      db,
      tournament,
      fromUserId: userId,
      text,
      type: 'text',
    });
    db.tournamentChatMessages.push(message);
    writeDb(db);
    emitTournamentChatMessage(db, tournament, message);

    return res.status(201).json({
      message: 'Tournament message sent successfully.',
      chatMessage: message,
      connectedCount: getTournamentChatParticipants(db, tournament).length,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send tournament message.');
  }
});

router.post('/tournaments/:tournamentId/chat/send-image', tournamentChatUpload.single('image'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    if (!canAccessTournamentChat(db, tournament, userId)) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(403).json({ message: 'You do not have access to this tournament chat.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required.' });
    }

    db.tournamentChatMessages = db.tournamentChatMessages || [];
    const message = buildTournamentChatMessage({
      db,
      tournament,
      fromUserId: userId,
      text: 'Image',
      type: 'image',
      fileUrl: `/uploads/chat/${path.basename(req.file.path)}`,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    db.tournamentChatMessages.push(message);
    writeDb(db);
    emitTournamentChatMessage(db, tournament, message);

    return res.status(201).json({
      message: 'Tournament image sent successfully.',
      chatMessage: message,
      connectedCount: getTournamentChatParticipants(db, tournament).length,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send tournament image.');
  }
});

router.post('/tournaments/:tournamentId/chat/send-voice', tournamentChatUpload.single('audio'), (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const requestedUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find((item) => String(item?.id || '').trim() === tournamentId);
    if (!tournament) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    if (!canAccessTournamentChat(db, tournament, userId)) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(403).json({ message: 'You do not have access to this tournament chat.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Audio file is required.' });
    }

    db.tournamentChatMessages = db.tournamentChatMessages || [];
    const message = buildTournamentChatMessage({
      db,
      tournament,
      fromUserId: userId,
      text: 'Voice message',
      type: 'voice',
      fileUrl: `/uploads/chat/${path.basename(req.file.path)}`,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      durationMs: Number(req.body.durationMs) || null,
    });
    db.tournamentChatMessages.push(message);
    writeDb(db);
    emitTournamentChatMessage(db, tournament, message);

    return res.status(201).json({
      message: 'Tournament voice sent successfully.',
      chatMessage: message,
      connectedCount: getTournamentChatParticipants(db, tournament).length,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not send tournament voice.');
  }
});

router.post('/tournaments/:tournamentId/room-board/meta', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const payload = {
      id: crypto.randomUUID(),
      tournamentId,
      groupName: String(req.body.groupName || '').trim().slice(0, 30),
      roundName: String(req.body.roundName || '').trim().slice(0, 40),
      matchNumber: String(req.body.matchNumber || '').trim().slice(0, 20),
      matchDate: String(req.body.matchDate || '').trim().slice(0, 30),
      startTime: String(req.body.startTime || '').trim().slice(0, 20),
      endTime: String(req.body.endTime || '').trim().slice(0, 20),
      totalMatches: String(req.body.totalMatches || '').trim().slice(0, 20),
      roomPass: String(req.body.roomPass || '').trim().slice(0, 40),
      description: String(req.body.description || '').trim().slice(0, 220),
      liveLink: String(req.body.liveLink || '').trim().slice(0, 220),
      matchType: String(req.body.matchType || '').trim().slice(0, 20),
      status: String(req.body.status || '').trim().slice(0, 20),
      updatedAt: new Date().toISOString(),
    };

    db.tournamentRoomBoardMeta = db.tournamentRoomBoardMeta || [];
    db.tournamentRoomBoardMeta.push(payload);

    writeDb(db);
    return res.json({
      message: 'Room setup saved successfully.',
      meta: payload,
      metas: getTournamentRoomBoardMeta(db, tournamentId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not save room setup.');
  }
});

router.post('/tournaments/:tournamentId/room-board/meta/:metaId/update', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.params.metaId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    db.tournamentRoomBoardMeta = db.tournamentRoomBoardMeta || [];
    const index = db.tournamentRoomBoardMeta.findIndex(
      (item) => String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (index < 0) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    db.tournamentRoomBoardMeta[index] = {
      ...db.tournamentRoomBoardMeta[index],
      groupName: String(req.body.groupName || '').trim().slice(0, 30),
      roundName: String(req.body.roundName || '').trim().slice(0, 40),
      matchNumber: String(req.body.matchNumber || '').trim().slice(0, 20),
      matchDate: String(req.body.matchDate || '').trim().slice(0, 30),
      startTime: String(req.body.startTime || '').trim().slice(0, 20),
      endTime: String(req.body.endTime || '').trim().slice(0, 20),
      totalMatches: String(req.body.totalMatches || '').trim().slice(0, 20),
      roomPass: String(req.body.roomPass || '').trim().slice(0, 40),
      description: String(req.body.description || '').trim().slice(0, 220),
      liveLink: String(req.body.liveLink || '').trim().slice(0, 220),
      matchType: String(req.body.matchType || '').trim().slice(0, 20),
      status: String(req.body.status || '').trim().slice(0, 20),
      updatedAt: new Date().toISOString(),
    };

    writeDb(db);
    return res.json({
      message: 'Team group setup updated successfully.',
      meta: db.tournamentRoomBoardMeta[index],
      metas: getTournamentRoomBoardMeta(db, tournamentId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update team group setup.');
  }
});

router.post('/tournaments/:tournamentId/room-board/meta/:metaId/delete', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.params.metaId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const previousLength = (db.tournamentRoomBoardMeta || []).length;
    db.tournamentRoomBoardMeta = (db.tournamentRoomBoardMeta || []).filter(
      (item) => !(String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId)
    );
    if (db.tournamentRoomBoardMeta.length === previousLength) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    writeDb(db);
    return res.json({
      message: 'Team group setup deleted successfully.',
      metas: getTournamentRoomBoardMeta(db, tournamentId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not delete team group setup.');
  }
});

router.post('/tournaments/:tournamentId/room-board/add', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const roomSlot = String(req.body.slot || '').trim().padStart(2, '0');
    const sourceSlot = String(req.body.sourceSlot || '').trim().padStart(2, '0');
    if (!roomSlot || !sourceSlot) {
      return res.status(400).json({ message: 'Room slot and booked slot are required.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const bookedAssignment = getTournamentRoomAssignments(db, identity.roomCode, tournamentId).find(
      (assignment) => String(assignment?.slot || '').trim() === sourceSlot
    );
    if (!bookedAssignment) {
      return res.status(404).json({ message: 'Booked team not found for this tournament.' });
    }

    db.tournamentRoomBoards = db.tournamentRoomBoards || [];
    const alreadyUsed = db.tournamentRoomBoards.find(
      (assignment) =>
        String(assignment?.tournamentId || '').trim() === tournamentId &&
        String(assignment?.sourceSlot || '').trim() === sourceSlot &&
        String(assignment?.slot || '').trim() !== roomSlot
    );
    if (alreadyUsed) {
      return res.status(409).json({ message: 'This booked team is already added to another room slot.' });
    }

    db.tournamentRoomBoards = db.tournamentRoomBoards.filter(
      (assignment) => !(String(assignment?.tournamentId || '').trim() === tournamentId && String(assignment?.slot || '').trim() === roomSlot)
    );

    db.tournamentRoomBoards.push({
      id: crypto.randomUUID(),
      tournamentId,
      slot: roomSlot,
      sourceSlot,
      teamId: String(bookedAssignment?.teamId || '').trim(),
      teamName: String(bookedAssignment?.teamName || '').trim(),
      publicTeamId: String(bookedAssignment?.publicTeamId || '').trim(),
      logoUrl: String(bookedAssignment?.logoUrl || '').trim(),
      updatedAt: new Date().toISOString(),
    });

    writeDb(db);
    return res.json({
      message: 'Room slot updated successfully.',
      slots: getTournamentRoomBoardAssignments(db, tournamentId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update room slot.');
  }
});

router.post('/tournaments/:tournamentId/room-board/remove', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const roomSlot = String(req.body.slot || '').trim().padStart(2, '0');
    if (!roomSlot) {
      return res.status(400).json({ message: 'Room slot is required.' });
    }

    const previousLength = (db.tournamentRoomBoards || []).length;
    db.tournamentRoomBoards = (db.tournamentRoomBoards || []).filter(
      (assignment) => !(String(assignment?.tournamentId || '').trim() === tournamentId && String(assignment?.slot || '').trim() === roomSlot)
    );

    if (db.tournamentRoomBoards.length === previousLength) {
      return res.status(404).json({ message: 'No room slot booking found.' });
    }

    writeDb(db);
    return res.json({
      message: 'Room slot cleared successfully.',
      slots: getTournamentRoomBoardAssignments(db, tournamentId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not clear room slot.');
  }
});

router.get('/tournaments/:tournamentId/group-drop/:metaId/:userId', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.params.metaId || '').trim();
    const requestedUserId = String(req.params.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, requestedUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const groupMeta = (db.tournamentRoomBoardMeta || []).find(
      (item) => String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (!groupMeta) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const bookedTeams = getTournamentRoomAssignments(db, identity.roomCode, tournamentId).map((assignment) => {
      const teamId = String(assignment?.teamId || '').trim();
      const teamName = String(assignment?.teamName || '').trim();
      const conflict = findGroupDropConflict(db, {
        tournamentId,
        metaId,
        teamId,
        teamName,
        matchDate: String(groupMeta?.matchDate || '').trim(),
        startTime: String(groupMeta?.startTime || '').trim(),
      });

      return {
        slot: String(assignment?.slot || '').trim(),
        teamId,
        teamName,
        publicTeamId: String(assignment?.publicTeamId || '').trim(),
        logoUrl: String(assignment?.logoUrl || '').trim(),
        isFree: !conflict,
        conflict,
      };
    });

    const groupAssignments = getTournamentGroupDropAssignments(db, tournamentId, metaId);
    const groupMap = new Map(
      groupAssignments.map((assignment) => [String(assignment?.slot || '').trim().padStart(2, '0'), assignment])
    );

    const slots = Array.from({ length: 12 }, (_, index) => {
      const slot = String(index + 1).padStart(2, '0');
      const assignment = groupMap.get(slot);
      return assignment
        ? {
            slot,
            teamId: String(assignment?.teamId || '').trim(),
            teamName: String(assignment?.teamName || '').trim(),
            publicTeamId: String(assignment?.publicTeamId || '').trim(),
            logoUrl: String(assignment?.logoUrl || '').trim(),
            sourceSlot: String(assignment?.sourceSlot || '').trim(),
          }
        : {
            slot,
            teamId: '',
            teamName: '',
            publicTeamId: '',
            logoUrl: '',
            sourceSlot: '',
          };
    });

    return res.json({
      tournamentId,
      metaId,
      group: groupMeta,
      slots,
      bookedTeams,
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not load drop teams.');
  }
});

router.post('/tournaments/:tournamentId/group-drop/add', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.body.metaId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const groupMeta = (db.tournamentRoomBoardMeta || []).find(
      (item) => String(item?.id || '').trim() === metaId && String(item?.tournamentId || '').trim() === tournamentId
    );
    if (!groupMeta) {
      return res.status(404).json({ message: 'Team group setup not found.' });
    }

    const roomSlot = String(req.body.slot || '').trim().padStart(2, '0');
    const sourceSlot = String(req.body.sourceSlot || '').trim().padStart(2, '0');
    if (!roomSlot || !sourceSlot) {
      return res.status(400).json({ message: 'Drop slot and booked slot are required.' });
    }

    const identity = buildTournamentRoomIdentity(tournament);
    const bookedAssignment = getTournamentRoomAssignments(db, identity.roomCode, tournamentId).find(
      (assignment) => String(assignment?.slot || '').trim() === sourceSlot
    );
    if (!bookedAssignment) {
      return res.status(404).json({ message: 'Booked team not found for this tournament.' });
    }

    const forceAdd = Boolean(req.body.force);
    const conflict = findGroupDropConflict(db, {
      tournamentId,
      metaId,
      teamId: String(bookedAssignment?.teamId || '').trim(),
      teamName: String(bookedAssignment?.teamName || '').trim(),
      matchDate: String(groupMeta?.matchDate || '').trim(),
      startTime: String(groupMeta?.startTime || '').trim(),
    });
    if (conflict && !forceAdd) {
      return res.status(409).json({
        message: 'This team is not free for the selected date and start time.',
        conflict,
      });
    }

    db.tournamentGroupDrops = db.tournamentGroupDrops || [];
    const alreadyUsed = db.tournamentGroupDrops.find(
      (assignment) =>
        String(assignment?.tournamentId || '').trim() === tournamentId &&
        String(assignment?.metaId || '').trim() === metaId &&
        String(assignment?.sourceSlot || '').trim() === sourceSlot &&
        String(assignment?.slot || '').trim() !== roomSlot
    );
    if (alreadyUsed) {
      return res.status(409).json({ message: 'This booked team is already added to another drop slot.' });
    }

    db.tournamentGroupDrops = db.tournamentGroupDrops.filter(
      (assignment) =>
        !(
          String(assignment?.tournamentId || '').trim() === tournamentId &&
          String(assignment?.metaId || '').trim() === metaId &&
          String(assignment?.slot || '').trim() === roomSlot
        )
    );

    db.tournamentGroupDrops.push({
      id: crypto.randomUUID(),
      tournamentId,
      metaId,
      slot: roomSlot,
      sourceSlot,
      teamId: String(bookedAssignment?.teamId || '').trim(),
      teamName: String(bookedAssignment?.teamName || '').trim(),
      publicTeamId: String(bookedAssignment?.publicTeamId || '').trim(),
      logoUrl: String(bookedAssignment?.logoUrl || '').trim(),
      updatedAt: new Date().toISOString(),
    });

    writeDb(db);
    return res.json({
      message: 'Drop team slot updated successfully.',
      slots: getTournamentGroupDropAssignments(db, tournamentId, metaId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not update drop team slot.');
  }
});

router.post('/tournaments/:tournamentId/group-drop/remove', (req, res) => {
  try {
    const db = readDb();
    const tournamentId = String(req.params.tournamentId || '').trim();
    const metaId = String(req.body.metaId || '').trim();
    const targetUserId = String(req.body.userId || '').trim();
    const authorization = requireAuthorizedUser(db, req, targetUserId);
    if (authorization.errorResponse) {
      return res.status(authorization.errorResponse.status).json({ message: authorization.errorResponse.message });
    }

    const userId = authorization.userId;
    const tournament = (db.tournaments || []).find(
      (item) => String(item?.id || '').trim() === tournamentId && String(item?.ownerUserId || '').trim() === userId
    );
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const roomSlot = String(req.body.slot || '').trim().padStart(2, '0');
    if (!roomSlot || !metaId) {
      return res.status(400).json({ message: 'Drop slot and group meta are required.' });
    }

    const previousLength = (db.tournamentGroupDrops || []).length;
    db.tournamentGroupDrops = (db.tournamentGroupDrops || []).filter(
      (assignment) =>
        !(
          String(assignment?.tournamentId || '').trim() === tournamentId &&
          String(assignment?.metaId || '').trim() === metaId &&
          String(assignment?.slot || '').trim() === roomSlot
        )
    );

    if (db.tournamentGroupDrops.length === previousLength) {
      return res.status(404).json({ message: 'No drop team found in this slot.' });
    }

    writeDb(db);
    return res.json({
      message: 'Drop team removed successfully.',
      slots: getTournamentGroupDropAssignments(db, tournamentId, metaId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not remove drop team.');
  }
});

// Tournament Share Post - creates a moment with tournament context
router.post('/tournaments/:tournamentId/share-post', upload.single('media'), (req, res) => {
  try {
    const tournamentId = String(req.params.tournamentId || '').trim();
    const userId = String(req.body.userId || '').trim();
    const caption = String(req.body.caption || '').trim();
    const tournamentTitle = String(req.body.tournamentTitle || '').trim();
    const tournamentBadge = String(req.body.tournamentBadge || '').trim();
    const tournamentStage = String(req.body.tournamentStage || '').trim();
    const tournamentDescription = String(req.body.tournamentDescription || '').trim();
    const tournamentMetaRaw = String(req.body.tournamentMeta || '').trim();
    const teamName = String(req.body.teamName || '').trim().slice(0, 80);
    const publicTeamId = String(req.body.publicTeamId || '').trim().toUpperCase().slice(0, 24);
    const shareMode = String(req.body.shareMode || 'text').trim().toLowerCase();

    // Parse tournament meta if provided
    let tournamentMeta = [];
    if (tournamentMetaRaw) {
      try {
        const parsed = JSON.parse(tournamentMetaRaw);
        if (Array.isArray(parsed)) {
          tournamentMeta = parsed.slice(0, 3);
        }
      } catch (_e) {
        // If not valid JSON, ignore
      }
    }

    const db = readDb();
    const auth = requireAuthorizedUser(db, req, userId);
    if (auth.errorResponse) {
      return res.status(auth.errorResponse.status).json({ message: auth.errorResponse.message });
    }

    const user = (db.users || []).find((item) => item.id === userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!caption && shareMode === 'text') {
      return res.status(400).json({ message: 'Post text is required.' });
    }

    if (shareMode !== 'text' && !req.file) {
      return res.status(400).json({ message: 'Media upload required for image/video posts.' });
    }

    // Build media object - for text shares, use null (tournament context shows as text below)
    let media = null;

    if (req.file && shareMode === 'image') {
      if (!String(req.file.mimetype || '').startsWith('image/')) {
        return res.status(400).json({ message: 'Uploaded file must be an image.' });
      }
      media = {
        type: 'image',
        uri: `/uploads/moments/${req.file.filename}`,
        mimeType: req.file.mimetype,
        aspectRatio: 1,
      };
    }

    if (req.file && shareMode === 'video') {
      if (!String(req.file.mimetype || '').startsWith('video/')) {
        return res.status(400).json({ message: 'Uploaded file must be a video.' });
      }
      media = {
        type: 'video',
        uri: `/uploads/moments/${req.file.filename}`,
        mimeType: req.file.mimetype,
        durationSec: Math.max(1, Math.min(Number(req.body.durationSec) || 0, 30)),
        aspectRatio: 0.82,
      };
    }

    // Create tournament share moment
    const moment = {
      id: crypto.randomUUID(),
      userId,
      caption,
      location: '',
      tags: [tournamentTitle, tournamentBadge].filter(Boolean),
      media,
      tournamentContext: {
        tournamentId,
        title: tournamentTitle,
        badge: tournamentBadge,
        stage: tournamentStage,
        description: tournamentDescription,
        meta: tournamentMeta,
        teamName,
        publicTeamId,
        sharedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      reactions: [],
      comments: [],
      shares: [],
      savedByUserIds: [],
      reportEntries: [],
      status: 'active',
    };

    db.moments = db.moments || [];
    db.moments.unshift(moment);
    writeDb(db);

    // Emit to online users (reuse moments emit logic)
    try {
      const { emitToUser, getOnlineUserIds } = require('../socket');
      const { buildMomentForViewer } = require('../utils/moments');
      getOnlineUserIds().forEach((onlineUserId) => {
        const payload = buildMomentForViewer(db, moment, onlineUserId);
        if (payload) {
          emitToUser(onlineUserId, 'moments:new', { moment: payload });
        }
      });
    } catch (_socketError) {
      // Socket not available, continue
    }

    const { buildMomentForViewer } = require('../utils/moments');
    return res.json({
      message: 'Tournament shared successfully.',
      moment: buildMomentForViewer(db, moment, userId),
    });
  } catch (error) {
    return sendServerError(res, error, 'Could not share tournament.');
  }
});

module.exports = router;
