const { ensureUserProfileData } = require('./profile');

const COUNTRY_NAMES = {
  BD: 'Bangladesh',
  BR: 'Brazil',
  ID: 'Indonesia',
  IN: 'India',
  PK: 'Pakistan',
  TH: 'Thailand',
};

const TEAM_CURRENT_RANKS = [
  '#4 South Asia Ladder',
  '#7 Weekly Power Rank',
  '#9 National Scrim Board',
  '#12 Open Circuit',
];
const TEAM_PEAK_RANKS = ['Top 3 South Asia', 'Top 4 National', 'Top 6 Pro League', 'Top 8 Circuit Finals'];
const PLAYER_CURRENT_RANKS = ['Heroic', 'Grandmaster', 'Master', 'Diamond IV'];
const PLAYER_PEAK_RANKS = ['Top 50 Heroic', 'Grandmaster I', 'Master I', 'Heroic'];
const TEAM_STYLES = ['Fast edge control', 'Zone-first patience', 'Aggressive entry pressure', 'Late-game discipline'];
const MAP_POOL = ['Bermuda', 'Purgatory', 'Kalahari', 'Alpine', 'Nexterra'];
const ACTIVE_WINDOWS = ['8 PM - 11 PM', '9 PM - 12 AM', '7 PM - 10 PM', 'Late night scrims'];
const ARCHETYPES = ['Clutch closer', 'High pressure fragger', 'Utility anchor', 'Tempo caller'];
const FORM_STATES = ['On fire', 'Stable', 'Climbing', 'Playoff form'];
const BEST_WEAPONS = ['SCAR', 'M1887', 'Woodpecker', 'MP40', 'AK47'];
const TEAM_EVENT_NAMES = ['Regional Clash', 'South Asia Cup', 'Flash Friday Series', 'Bermuda Masters'];
const PLAYER_EVENT_NAMES = ['Elite Clash', 'Headshot Masters', 'Frontline Cup', 'Open Championship'];
const MATCH_TYPES = ['Scrim Block', 'Qualifier Match', 'League Day', 'Community Cup'];
const RESULT_COLORS = ['#FF6FB7', '#7F6FFF', '#53C8FF', '#2B2A3F'];
const ORG_PARTNERS = ['Pulse Energy', 'Nova Gear', 'Rush Arena', 'Storm Labs'];
const PAST_TEAM_NAMES = ['Nova Orbit', 'Shadow Pulse', 'Core Delta', 'Rapid Axis'];
const ROLE_DEFAULTS = ['IGL', 'Rusher', 'Support', 'Anchor', 'Entry'];
const WEEK_LABELS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'];
const SPLIT_LABELS = ['S1', 'S2', 'S3', 'S4', 'S5'];
const MATCH_LABELS = ['M1', 'M2', 'M3', 'M4', 'M5'];
const RECENT_DATE_LABELS = ['Mar 12, 2026', 'Mar 9, 2026', 'Mar 5, 2026', 'Feb 28, 2026'];
const UPCOMING_DATE_LABELS = ['Mar 21, 2026', 'Mar 28, 2026', 'Apr 4, 2026'];

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const rawValue = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(rawValue) ? rawValue : fallback;
}

function hasFilledValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'number') {
    return value > 0;
  }
  if (typeof value === 'boolean') {
    return true;
  }
  return safeString(value).length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function mergeDeep(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? cloneValue(override) : cloneValue(base);
  }
  if (isPlainObject(base)) {
    const result = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(isPlainObject(override) ? override : {})]);
    keys.forEach((key) => {
      const hasOverride = isPlainObject(override) && Object.prototype.hasOwnProperty.call(override, key);
      const baseValue = base[key];
      const overrideValue = hasOverride ? override[key] : undefined;

      if (hasOverride && isPlainObject(baseValue) && isPlainObject(overrideValue)) {
        result[key] = mergeDeep(baseValue, overrideValue);
        return;
      }

      if (hasOverride && overrideValue !== undefined) {
        result[key] = cloneValue(overrideValue);
        return;
      }

      result[key] = cloneValue(baseValue);
    });
    return result;
  }

  return override !== undefined ? cloneValue(override) : cloneValue(base);
}

function buildSeed(...parts) {
  const source = parts.map((part) => String(part || '')).join('|');
  let seed = 0;
  for (let index = 0; index < source.length; index += 1) {
    seed = (seed * 31 + source.charCodeAt(index)) % 2147483647;
  }
  return seed || 1;
}

function seededNumber(seed, min, max, offset = 0) {
  if (max <= min) {
    return min;
  }
  const span = max - min + 1;
  return min + Math.abs((seed + offset * 131) % span);
}

function seededDecimal(seed, min, max, offset = 0) {
  const raw = seededNumber(seed, Math.round(min * 100), Math.round(max * 100), offset);
  return (raw / 100).toFixed(2);
}

function seededPercent(seed, min, max, offset = 0) {
  return `${seededNumber(seed, min, max, offset)}%`;
}

function seededMoney(seed, min, max, offset = 0) {
  return `$${seededNumber(seed, min, max, offset)}K`;
}

function pickItem(items, seed, offset = 0) {
  if (!Array.isArray(items) || !items.length) {
    return '';
  }
  return items[Math.abs((seed + offset * 131) % items.length)];
}

function pickWindow(items, count, seed, offset = 0) {
  const source = safeArray(items);
  if (!source.length || count <= 0) {
    return [];
  }
  const start = Math.abs((seed + offset * 131) % source.length);
  return Array.from({ length: Math.min(count, source.length) }, (_, index) => source[(start + index) % source.length]);
}

function toMonthYear(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

function titleCaseWords(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildGameLabel(eventKey) {
  const normalized = safeString(eventKey);
  if (!normalized) {
    return '';
  }
  if (normalized === 'free-fire') {
    return 'Free Fire';
  }

  return titleCaseWords(normalized);
}

function getLeaderIndex(team) {
  const players = safeArray(team?.players);
  const requested = Number.isInteger(team?.leaderIndex) ? team.leaderIndex : 0;
  return requested >= 0 && requested < players.length ? requested : 0;
}

function findConnectedUser(users, player) {
  const connectedUserId = safeString(player?.connectedUserId);
  if (!connectedUserId) {
    return null;
  }

  const found = safeArray(users).find((user) => user.id === connectedUserId);
  return found ? ensureUserProfileData(found) : null;
}

function hasPlayerIdentity(player = {}) {
  return Boolean(
    safeString(player?.name) ||
      safeString(player?.playerId) ||
      safeString(player?.connectedUserId) ||
      safeString(player?.connectedProfileValue)
  );
}

function buildRegionLabel(flag, region) {
  const parts = [];
  const upperFlag = safeString(flag).toUpperCase();
  const regionLabel = safeString(region);

  if (upperFlag && COUNTRY_NAMES[upperFlag]) {
    parts.push(COUNTRY_NAMES[upperFlag]);
  } else if (upperFlag) {
    parts.push(upperFlag);
  }

  if (regionLabel && !parts.includes(regionLabel)) {
    parts.push(regionLabel);
  }

  return parts.join(' - ');
}

function createEmptyTeamProfile() {
  return {
    header: {
      tagline: '',
      verified: false,
      region: '',
      teamId: '',
      founded: '',
      game: '',
      currentRank: '',
      highestRank: '',
      bio: '',
    },
    summary: [],
    performance: {
      killsTrend: [],
      winRateTrend: [],
      placementTrend: [],
      results: [],
      roleContribution: [],
      playerComparison: [],
      mapPerformance: [],
      heatmap: [],
      earningsGrowth: [],
      damageVsKills: [],
    },
    tournaments: {
      totals: {
        played: 0,
        wins: 0,
        runnerUp: 0,
        top4: 0,
        top8: 0,
        earnings: '',
        best: '',
        mvpPlayer: '',
        killPoints: 0,
        placementPoints: 0,
        consistency: 0,
      },
      history: [],
      upcoming: [],
    },
    matches: [],
    roster: [],
    badges: [],
    insights: [],
    highlights: [],
    sponsors: {
      owner: '',
      manager: '',
      coach: '',
      analyst: '',
      creator: '',
      partners: [],
      bio: '',
    },
    social: {
      followers: '',
      engagement: '',
      links: [],
    },
  };
}

function createEmptyPlayerProfile() {
  return {
    header: {
      ign: 'Player',
      realName: '',
      verified: false,
      flag: '',
      region: '',
      uid: '',
      teamName: '',
      teamLogoUrl: '',
      avatarUrl: '',
      role: '',
      currentRank: '',
      highestRank: '',
      bio: '',
    },
    quickStats: [],
    performance: {
      killsTrend: [],
      winRateTrend: [],
      headshotTrend: [],
      resultBreakdown: [],
      weaponUsage: [],
      placements: [],
      rankProgression: [],
      heatmap: [],
      damageVsKills: [],
    },
    tournaments: {
      totalPlayed: 0,
      wins: 0,
      runnerUp: 0,
      top4: 0,
      top8: 0,
      bestPerformance: '',
      mvpCount: 0,
      earnings: '',
      recentHistory: [],
      upcoming: [],
    },
    matches: [],
    achievements: [],
    highlights: [],
    social: {
      currentTeam: '',
      pastTeams: [],
      teammates: [],
      links: [],
    },
    insights: {
      strengthRating: 0,
      formStatus: '',
      bestWeapon: '',
      bestRole: '',
      activeWindow: '',
      bestMap: '',
      archetype: '',
    },
  };
}

function buildLabeledSeries(labels, seed, min, max, offset = 0) {
  return safeArray(labels).map((label, index) => ({
    label,
    value: seededNumber(seed, min, max, offset + index),
  }));
}

function buildNumericSeries(count, seed, min, max, offset = 0) {
  return Array.from({ length: count }, (_, index) => seededNumber(seed, min, max, offset + index));
}

function buildBreakdown(seed, definitions, offset = 0) {
  const items = [];
  let remaining = 100;

  definitions.forEach((definition, index) => {
    if (index === definitions.length - 1) {
      items.push({
        label: definition.label,
        value: remaining,
        color: definition.color,
      });
      return;
    }

    const left = definitions.length - index - 1;
    const maxAllowed = Math.min(definition.max, remaining - left * definition.min);
    const value = seededNumber(seed, definition.min, Math.max(definition.min, maxAllowed), offset + index);
    remaining -= value;
    items.push({
      label: definition.label,
      value,
      color: definition.color,
    });
  });

  return items;
}

function buildDamageVsKills(labels, seed, offset = 0) {
  return safeArray(labels).map((label, index) => ({
    label,
    damage: seededNumber(seed, 420, 980, offset + index),
    kills: seededNumber(seed, 6, 18, offset + index + 20),
  }));
}

function normalizeLinks(links, blockedLabels = []) {
  const blocked = new Set(blockedLabels.map((label) => label.toLowerCase()));
  return safeArray(links).reduce((items, entry) => {
    const label = safeString(entry?.label);
    const value = safeString(entry?.value);
    const key = label.toLowerCase();

    if (!label || !value || blocked.has(key) || items.some((item) => item.label.toLowerCase() === key)) {
      return items;
    }

    items.push({ label, value });
    return items;
  }, []);
}

function buildPlayerSocialLinks(team, extraLinks = []) {
  const facebook = safeString(team?.facebook);
  const youtube = safeString(team?.youtube);
  const links = normalizeLinks(extraLinks, [
    ...(facebook ? [] : ['team facebook']),
    ...(youtube ? [] : ['team youtube']),
  ]);

  if (facebook && !links.some((entry) => entry.label.toLowerCase() === 'team facebook')) {
    links.unshift({ label: 'Team Facebook', value: facebook });
  }
  if (youtube && !links.some((entry) => entry.label.toLowerCase() === 'team youtube')) {
    links.push({ label: 'Team YouTube', value: youtube });
  }

  return links;
}

function buildTeamRoster(team, users = []) {
  const players = safeArray(team?.players);
  const leaderIndex = getLeaderIndex(team);

  return players.map((player, index) => {
    const connectedUser = findConnectedUser(users, player);
    const ign = safeString(player?.name, `Player ${index + 1}`);
    const realName = safeString(player?.realName, safeString(connectedUser?.name, safeString(player?.playerId)));
    const roleFallback = ROLE_DEFAULTS[index] || (index === leaderIndex ? 'Leader' : 'Member');
    const seed = buildSeed(team?.id, ign, index);

    return {
      slot: index,
      ign,
      realName,
      flag: safeString(player?.countryFlag).toUpperCase(),
      role: safeString(player?.roleTag, roleFallback),
      status: safeString(
        player?.statusBadge,
        index === leaderIndex ? 'Leader' : hasPlayerIdentity(player) ? 'Active' : 'Open slot'
      ),
      kd: safeString(player?.kdRatio, seededDecimal(seed, 2.8, 5.9, 1)),
      hs: safeString(player?.headshotPct, seededPercent(seed, 28, 57, 2)),
      mvp: safeString(player?.mvpCount, String(seededNumber(seed, 2, 18, 3))),
      trend: safeString(player?.trend, pickItem(['Climbing', 'Stable', 'Hot', 'Ready'], seed, 4)),
      verified: Boolean(player?.verified),
      avatarKey: safeString(
        connectedUser?.avatarKey,
        safeString(player?.profileData?.header?.avatarUrl, safeString(player?.avatarKey, player?.gender === 'woman' ? 'women' : 'men'))
      ),
    };
  });
}

function buildTeamSummary(team, fallbackSummary = []) {
  const activePlayers = safeArray(team?.players).filter((player) => hasPlayerIdentity(player)).length;
  const existing = new Map(
    safeArray(fallbackSummary)
      .filter((entry) => safeString(entry?.label))
      .map((entry) => [safeString(entry.label).toLowerCase(), entry])
  );

  return [
    { label: 'Active roster', value: String(activePlayers), accent: 'accent' },
    {
      label: 'Win rate',
      value: safeString(existing.get('win rate')?.value, '63%'),
      accent: safeString(existing.get('win rate')?.accent, 'secondary'),
    },
    {
      label: 'Avg placement',
      value: safeString(existing.get('avg placement')?.value, '#4'),
      accent: safeString(existing.get('avg placement')?.accent, 'highlight'),
    },
    {
      label: 'Season earnings',
      value: safeString(existing.get('season earnings')?.value, '$28K'),
      accent: safeString(existing.get('season earnings')?.accent, 'gold'),
    },
  ];
}

function distributeTotal(total, count, seed, offset = 0, minPer = 0) {
  const size = Math.max(0, Number(count) || 0);
  if (!size) {
    return [];
  }

  const safeTotal = Math.max(safeNumber(total), size * minPer);
  const weights = Array.from({ length: size }, (_, index) => seededNumber(seed, 12, 36, offset + index));
  const weightSum = weights.reduce((sum, value) => sum + value, 0) || size;
  let remaining = safeTotal;

  return weights.map((weight, index) => {
    if (index === size - 1) {
      return remaining;
    }

    const minRemaining = (size - index - 1) * minPer;
    const projected = Math.round((safeTotal * weight) / weightSum);
    const nextValue = Math.max(minPer, Math.min(remaining - minRemaining, projected));
    remaining -= nextValue;
    return nextValue;
  });
}

function buildTeamMemberBreakdown(roster, seed, offset = 0, totals = {}, existingBreakdown = []) {
  const activeRoster = safeArray(roster).filter((entry) => safeString(entry?.ign));
  if (!activeRoster.length) {
    return [];
  }

  const normalizedExisting = safeArray(existingBreakdown)
    .map((entry, index) => {
      const fallbackEntry = activeRoster[index] || {};
      const name = safeString(entry?.name, safeString(fallbackEntry?.ign));
      if (!name) {
        return null;
      }

      return {
        name,
        role: safeString(entry?.role, safeString(fallbackEntry?.role)),
        kills: safeNumber(entry?.kills, 0),
        damage: safeNumber(entry?.damage, 0),
        assists: safeNumber(entry?.assists, 0),
      };
    })
    .filter(Boolean);

  if (normalizedExisting.length) {
    return normalizedExisting;
  }

  const killShares = distributeTotal(totals.kills, activeRoster.length, seed, offset + 1, 1);
  const damageShares = distributeTotal(totals.damage, activeRoster.length, seed, offset + 21, 180);
  const assistShares = distributeTotal(totals.assists, activeRoster.length, seed, offset + 41, 0);

  return activeRoster.map((entry, index) => ({
    name: safeString(entry?.ign, `Player ${index + 1}`),
    role: safeString(entry?.role),
    kills: killShares[index] || 0,
    damage: damageShares[index] || 0,
    assists: assistShares[index] || 0,
  }));
}

function enrichTeamTournamentEntry(entry = {}, roster, seed, offset = 0) {
  const points = safeNumber(entry?.points, seededNumber(seed, 68, 124, offset + 1));
  const killPoints = safeNumber(entry?.killPoints, seededNumber(seed, 32, 74, offset + 2));
  const placementPoints = safeNumber(entry?.placementPoints, Math.max(18, points - killPoints));
  const totalKills = safeNumber(entry?.totalKills, killPoints);
  const totalDamage = safeNumber(entry?.totalDamage, totalKills * seededNumber(seed, 118, 164, offset + 3));
  const totalAssists = safeNumber(entry?.totalAssists, Math.max(4, Math.round(totalKills * 0.56)));

  return {
    ...entry,
    format: safeString(entry?.format, pickItem(['Grand Finals', 'League Finals', 'Playoff Lobby', 'Main Event'], seed, offset + 4)),
    matchesPlayed: safeNumber(entry?.matchesPlayed, seededNumber(seed, 6, 10, offset + 5)),
    avgPlacement: safeString(entry?.avgPlacement, `#${seededNumber(seed, 2, 7, offset + 6)}`),
    lobbySize: safeString(entry?.lobbySize, `${seededNumber(seed, 12, 18, offset + 7)} teams`),
    totalKills,
    totalDamage,
    totalAssists,
    zoneWins: safeNumber(entry?.zoneWins, seededNumber(seed, 1, 4, offset + 8)),
    mapPool: safeString(entry?.mapPool, pickItem(['Bermuda / Alpine', 'Bermuda / Kalahari', 'Purgatory / Bermuda'], seed, offset + 9)),
    bestGame: safeString(entry?.bestGame, pickItem(MATCH_LABELS, seed, offset + 10)),
    memberStats: buildTeamMemberBreakdown(
      roster,
      seed,
      offset + 40,
      { kills: totalKills, damage: totalDamage, assists: totalAssists },
      entry?.memberStats || entry?.players
    ),
    points,
    killPoints,
    placementPoints,
  };
}

function enrichTeamMatchEntry(entry = {}, roster, seed, offset = 0) {
  const kills = safeNumber(entry?.kills, seededNumber(seed, 12, 28, offset + 1));
  const damage = safeNumber(entry?.damage, seededNumber(seed, 1800, 4200, offset + 2));
  const assists = safeNumber(entry?.assists, seededNumber(seed, 4, 13, offset + 3));
  const score = safeNumber(entry?.score, seededNumber(seed, 42, 86, offset + 4));

  return {
    ...entry,
    map: safeString(entry?.map, pickItem(MAP_POOL, seed, offset + 5)),
    zone: safeString(entry?.zone, pickItem(['Clock Tower finish', 'Factory circle', 'Mill close', 'Cape Town zone'], seed, offset + 6)),
    rounds: safeNumber(entry?.rounds, seededNumber(seed, 3, 6, offset + 7)),
    headshots: safeNumber(entry?.headshots, seededNumber(seed, 4, 15, offset + 8)),
    revives: safeNumber(entry?.revives, seededNumber(seed, 1, 5, offset + 9)),
    killPoints: safeNumber(entry?.killPoints, kills),
    placementPoints: safeNumber(entry?.placementPoints, Math.max(10, score - kills)),
    kills,
    damage,
    assists,
    score,
    memberStats: buildTeamMemberBreakdown(
      roster,
      seed,
      offset + 40,
      { kills, damage, assists },
      entry?.memberStats || entry?.players
    ),
  };
}

function buildTeamSocialLinks(team, extraLinks = []) {
  const facebook = safeString(team?.facebook);
  const youtube = safeString(team?.youtube);
  const links = normalizeLinks(extraLinks, [
    ...(facebook ? [] : ['facebook']),
    ...(youtube ? [] : ['youtube']),
  ]);

  if (facebook && !links.some((entry) => entry.label.toLowerCase() === 'facebook')) {
    links.unshift({ label: 'Facebook', value: facebook });
  }
  if (youtube && !links.some((entry) => entry.label.toLowerCase() === 'youtube')) {
    links.push({ label: 'YouTube', value: youtube });
  }

  return links;
}

function pickPrimaryPlayer(players, leaderIndex) {
  const leader = players[leaderIndex];
  if (leader && (safeString(leader?.countryFlag) || safeString(leader?.region))) {
    return leader;
  }

  return players.find((player) => safeString(player?.countryFlag) || safeString(player?.region)) || {};
}

function buildTeamProfile(team, users = []) {
  const players = safeArray(team?.players);
  const leaderIndex = getLeaderIndex(team);
  const primaryPlayer = pickPrimaryPlayer(players, leaderIndex);
  const roster = buildTeamRoster(team, users);
  const teamName = safeString(team?.teamName, 'Unnamed Team');
  const leaderName = safeString(roster[leaderIndex]?.ign, `Player ${leaderIndex + 1}`);
  const seed = buildSeed(team?.id, teamName, team?.publicTeamId);
  const stored = isPlainObject(team?.pageData) ? team.pageData : {};
  const storedHeader = isPlainObject(stored.header) ? stored.header : {};
  const storedPerformance = isPlainObject(stored.performance) ? stored.performance : {};
  const storedTournaments = isPlainObject(stored.tournaments) ? stored.tournaments : {};
  const storedTotals = isPlainObject(storedTournaments.totals) ? storedTournaments.totals : {};
  const storedSponsors = isPlainObject(stored.sponsors) ? stored.sponsors : {};
  const storedSocial = isPlainObject(stored.social) ? stored.social : {};
  const playerLabels = roster.length ? roster.map((entry, itemIndex) => safeString(entry.ign, `P${itemIndex + 1}`)) : MATCH_LABELS;
  const roleLabels = roster.length ? roster.map((entry, itemIndex) => safeString(entry.role, ROLE_DEFAULTS[itemIndex] || `P${itemIndex + 1}`)) : ROLE_DEFAULTS;
  const teamKey = teamName.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'team';

  return {
    ...createEmptyTeamProfile(),
    header: {
      tagline: safeString(team?.tagline, safeString(storedHeader.tagline, `${teamName} plays disciplined edge pressure and confident late-game calls.`)),
      verified: Boolean(team?.verified || storedHeader.verified),
      region: buildRegionLabel(primaryPlayer?.countryFlag, primaryPlayer?.region) || safeString(storedHeader.region, 'Bangladesh - South Asia'),
      teamId: safeString(team?.publicTeamId, safeString(storedHeader.teamId)),
      founded: toMonthYear(team?.createdAt) || safeString(storedHeader.founded, 'Mar 2026'),
      game: buildGameLabel(team?.eventKey) || safeString(storedHeader.game, 'Free Fire'),
      currentRank: safeString(storedHeader.currentRank, pickItem(TEAM_CURRENT_RANKS, seed, 1)),
      highestRank: safeString(storedHeader.highestRank, pickItem(TEAM_PEAK_RANKS, seed, 2)),
      bio: safeString(team?.bio, safeString(storedHeader.bio, `${teamName} is built around layered utility, fast zone reads, and stable late-circle execution.`)),
    },
    summary: buildTeamSummary(team, hasFilledValue(stored.summary) ? stored.summary : [
      { label: 'Win rate', value: seededPercent(seed, 52, 77, 3), accent: 'secondary' },
      { label: 'Avg placement', value: `#${seededNumber(seed, 2, 6, 4)}`, accent: 'highlight' },
      { label: 'Season earnings', value: seededMoney(seed, 12, 96, 5), accent: 'gold' },
    ]),
    performance: {
      killsTrend: hasFilledValue(storedPerformance.killsTrend) ? storedPerformance.killsTrend : [],
      winRateTrend: hasFilledValue(storedPerformance.winRateTrend) ? storedPerformance.winRateTrend : [],
      placementTrend: hasFilledValue(storedPerformance.placementTrend) ? storedPerformance.placementTrend : [],
      results: hasFilledValue(storedPerformance.results) ? storedPerformance.results : [],
      roleContribution: hasFilledValue(storedPerformance.roleContribution) ? storedPerformance.roleContribution : [],
      playerComparison: hasFilledValue(storedPerformance.playerComparison) ? storedPerformance.playerComparison : [],
      mapPerformance: hasFilledValue(storedPerformance.mapPerformance) ? storedPerformance.mapPerformance : [],
      heatmap: hasFilledValue(storedPerformance.heatmap) ? storedPerformance.heatmap : [],
      earningsGrowth: hasFilledValue(storedPerformance.earningsGrowth) ? storedPerformance.earningsGrowth : [],
      damageVsKills: hasFilledValue(storedPerformance.damageVsKills) ? storedPerformance.damageVsKills : [],
    },
    tournaments: {
      totals: {
        played: hasFilledValue(storedTotals.played) ? storedTotals.played : 0,
        wins: hasFilledValue(storedTotals.wins) ? storedTotals.wins : 0,
        runnerUp: hasFilledValue(storedTotals.runnerUp) ? storedTotals.runnerUp : 0,
        top4: hasFilledValue(storedTotals.top4) ? storedTotals.top4 : 0,
        top8: hasFilledValue(storedTotals.top8) ? storedTotals.top8 : 0,
        earnings: safeString(storedTotals.earnings, ''),
        best: safeString(storedTotals.best, ''),
        mvpPlayer: safeString(storedTotals.mvpPlayer, ''),
        killPoints: hasFilledValue(storedTotals.killPoints) ? storedTotals.killPoints : 0,
        placementPoints: hasFilledValue(storedTotals.placementPoints) ? storedTotals.placementPoints : 0,
        consistency: hasFilledValue(storedTotals.consistency) ? storedTotals.consistency : 0,
      },
      history: hasFilledValue(storedTournaments.history)
        ? storedTournaments.history.map((entry, itemIndex) => enrichTeamTournamentEntry(entry, roster, seed, 320 + itemIndex * 30))
        : [],
      upcoming: hasFilledValue(storedTournaments.upcoming)
        ? storedTournaments.upcoming
        : [],
    },
    matches: hasFilledValue(stored.matches)
      ? stored.matches.map((entry, itemIndex) => enrichTeamMatchEntry(entry, roster, seed, 400 + itemIndex * 30))
      : [],
    roster,
    badges: hasFilledValue(stored.badges)
      ? stored.badges
      : [
          pickItem(['Scrim grinders', 'Late-circle specialists', 'High consistency', 'Clean comms'], seed, 500),
          pickItem(['Top fragging core', 'Map-flex roster', 'Objective-focused', 'Fast entry pack'], seed, 501),
          pickItem(['Reliable support line', 'Playoff-ready', 'Pressure team', 'Clutch unit'], seed, 502),
        ],
    insights: hasFilledValue(stored.insights)
      ? stored.insights
      : [
          ['Primary style', pickItem(TEAM_STYLES, seed, 520)],
          ['Shot caller', leaderName],
          ['Best map', pickItem(MAP_POOL, seed, 521)],
          ['Clutch rating', `${seededNumber(seed, 78, 96, 522)}/100`],
          ['Peak window', pickItem(ACTIVE_WINDOWS, seed, 523)],
          ['Conversion rate', seededPercent(seed, 48, 74, 524)],
        ],
    highlights: hasFilledValue(stored.highlights)
      ? stored.highlights
      : [
          { title: `${teamName} 4v4 closeout`, type: 'Clip', duration: `0:${seededNumber(seed, 24, 58, 540)}` },
          { title: `${leaderName} end-zone call`, type: 'Voice cut', duration: `0:${seededNumber(seed, 18, 46, 541)}` },
          { title: `${teamName} weekly montage`, type: 'Highlight pack', duration: `1:${seededNumber(seed, 5, 49, 542)}` },
        ],
    sponsors: {
      owner: safeString(storedSponsors.owner, `${teamName} Esports`),
      manager: safeString(storedSponsors.manager, pickItem(['Rahim Khan', 'Nabil Hossain', 'Fahim Noor', 'T. Mahmud'], seed, 560)),
      coach: safeString(storedSponsors.coach, pickItem(['Coach Ray', 'Coach Delta', 'Coach Viper', 'Coach Storm'], seed, 561)),
      analyst: safeString(storedSponsors.analyst, pickItem(['Data Fox', 'Map Sense', 'Zone Lab', 'Heat Check'], seed, 562)),
      creator: safeString(storedSponsors.creator, pickItem(['Pixel Cut', 'Clip Room', 'Lobby Lens', 'Media Rush'], seed, 563)),
      partners: hasFilledValue(storedSponsors.partners) ? storedSponsors.partners : pickWindow(ORG_PARTNERS, 3, seed, 564),
      bio: safeString(storedSponsors.bio, `${teamName} works with a lean support staff focused on scrim review, weekly content, and sponsor visibility.`),
    },
    social: {
      followers: safeString(storedSocial.followers, `${seededNumber(seed, 18, 220, 580)}K`),
      engagement: safeString(storedSocial.engagement, `${seededNumber(seed, 4, 18, 581)}.${seededNumber(seed, 0, 9, 582)}%`),
      links: buildTeamSocialLinks(
        team,
        hasFilledValue(storedSocial.links)
          ? storedSocial.links
          : [
              { label: 'Discord', value: `${teamKey}-hq` },
              { label: 'Instagram', value: `@${teamKey}ff` },
            ]
      ),
    },
  };
}

function buildPlayerQuickStats(player, fallbackStats = []) {
  const existing = new Map(
    safeArray(fallbackStats)
      .filter((entry) => safeString(entry?.label))
      .map((entry) => [safeString(entry.label).toLowerCase(), entry])
  );

  return [
    {
      label: 'K/D ratio',
      value: safeString(player?.kdRatio, safeString(existing.get('k/d ratio')?.value, '4.82')),
      accent: safeString(existing.get('k/d ratio')?.accent, 'primary'),
    },
    {
      label: 'Headshot %',
      value: safeString(player?.headshotPct, safeString(existing.get('headshot %')?.value, '41%')),
      accent: safeString(existing.get('headshot %')?.accent, 'highlight'),
    },
    {
      label: 'MVP count',
      value: safeString(player?.mvpCount, safeString(existing.get('mvp count')?.value, '12')),
      accent: safeString(existing.get('mvp count')?.accent, 'accent'),
    },
    {
      label: 'Main role',
      value: safeString(player?.roleTag, safeString(existing.get('main role')?.value, 'Entry')),
      accent: safeString(existing.get('main role')?.accent, 'secondary'),
    },
  ];
}

function buildPlayerAchievements(player, connectedUser, fallbackAchievements = []) {
  const achievements = [];
  const isVerified = Boolean(player?.verified);

  safeArray(fallbackAchievements).forEach((item) => {
    const label = safeString(item);
    if (!isVerified && label.toLowerCase() === 'verified player') {
      return;
    }
    if (label && !achievements.includes(label)) {
      achievements.push(label);
    }
  });
  if (isVerified && !achievements.includes('Verified player')) {
    achievements.unshift('Verified player');
  }
  if (player?.connectedProfile && !achievements.includes('Connected profile')) {
    achievements.push('Connected profile');
  }

  return achievements.slice(0, 6);
}

function buildPlayerTeammates(team, fallbackTeammates = []) {
  const players = safeArray(team?.players);
  const leaderIndex = getLeaderIndex(team);

  const liveTeammates = players
    .map((entry, teammateIndex) => {
      const name = safeString(entry?.name);
      const role = safeString(entry?.roleTag, ROLE_DEFAULTS[teammateIndex] || '');
      if (!name && !role) {
        return null;
      }

      return {
        name: name || `Player ${teammateIndex + 1}`,
        role: role || (teammateIndex === leaderIndex ? 'Leader' : 'Member'),
      };
    })
    .filter(Boolean);

  if (liveTeammates.length) {
    return liveTeammates;
  }

  return safeArray(fallbackTeammates)
    .map((entry) => {
      const name = safeString(entry?.name);
      const role = safeString(entry?.role);
      return name || role ? { name: name || 'Teammate', role } : null;
    })
    .filter(Boolean);
}

function buildPlayerProfile(team, player, index = 0, users = []) {
  const connectedUser = findConnectedUser(users, player);
  const avatarKey = safeString(connectedUser?.avatarKey);
  const seed = buildSeed(team?.id, player?.name, player?.playerId, index);
  const roleFallback = ROLE_DEFAULTS[index] || (index === getLeaderIndex(team) ? 'Leader' : 'Member');
  const ign = safeString(player?.name, `Player ${Math.max(index, 0) + 1}`);
  const teamName = safeString(team?.teamName, 'Unnamed Team');
  const stored = isPlainObject(player?.profileData) ? player.profileData : {};
  const storedHeader = isPlainObject(stored.header) ? stored.header : {};
  const storedPerformance = isPlainObject(stored.performance) ? stored.performance : {};
  const storedTournaments = isPlainObject(stored.tournaments) ? stored.tournaments : {};
  const storedSocial = isPlainObject(stored.social) ? stored.social : {};
  const storedInsights = isPlainObject(stored.insights) ? stored.insights : {};
  const playerKey = ign.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || `player${index + 1}`;

  return {
    ...createEmptyPlayerProfile(),
    header: {
      ign,
      realName: safeString(player?.realName, safeString(connectedUser?.name, safeString(storedHeader.realName))),
      verified: Boolean(player?.verified),
      flag: safeString(player?.countryFlag, safeString(storedHeader.flag)).toUpperCase(),
      region: safeString(player?.region, safeString(storedHeader.region, 'South Asia')),
      uid: safeString(
        player?.playerId,
        safeString(connectedUser?.gamePlayerId, safeString(connectedUser?.appProfileId, safeString(storedHeader.uid)))
      ),
      teamName,
      teamLogoUrl: safeString(team?.logoUrl, safeString(storedHeader.teamLogoUrl)),
      avatarUrl: avatarKey.startsWith('data:') ? avatarKey : safeString(storedHeader.avatarUrl),
      role: safeString(player?.roleTag, safeString(storedHeader.role, roleFallback)),
      currentRank: safeString(storedHeader.currentRank, pickItem(PLAYER_CURRENT_RANKS, seed, 1)),
      highestRank: safeString(storedHeader.highestRank, pickItem(PLAYER_PEAK_RANKS, seed, 2)),
      bio: safeString(
        player?.bio,
        safeString(connectedUser?.about, safeString(storedHeader.bio, `${ign} plays ${roleFallback.toLowerCase()} for ${teamName} and leans on calm mechanics, quick reads, and reliable trading.`))
      ),
    },
    quickStats: buildPlayerQuickStats(player, hasFilledValue(stored.quickStats) ? stored.quickStats : [
      { label: 'K/D ratio', value: seededDecimal(seed, 3.1, 6.4, 10), accent: 'primary' },
      { label: 'Headshot %', value: seededPercent(seed, 28, 56, 11), accent: 'highlight' },
      { label: 'MVP count', value: String(seededNumber(seed, 4, 22, 12)), accent: 'accent' },
      { label: 'Main role', value: roleFallback, accent: 'secondary' },
    ]),
    performance: {
      killsTrend: hasFilledValue(storedPerformance.killsTrend) ? storedPerformance.killsTrend : [],
      winRateTrend: hasFilledValue(storedPerformance.winRateTrend) ? storedPerformance.winRateTrend : [],
      headshotTrend: hasFilledValue(storedPerformance.headshotTrend) ? storedPerformance.headshotTrend : [],
      resultBreakdown: hasFilledValue(storedPerformance.resultBreakdown) ? storedPerformance.resultBreakdown : [],
      weaponUsage: hasFilledValue(storedPerformance.weaponUsage) ? storedPerformance.weaponUsage : [],
      placements: hasFilledValue(storedPerformance.placements) ? storedPerformance.placements : [],
      rankProgression: hasFilledValue(storedPerformance.rankProgression) ? storedPerformance.rankProgression : [],
      heatmap: hasFilledValue(storedPerformance.heatmap) ? storedPerformance.heatmap : [],
      damageVsKills: hasFilledValue(storedPerformance.damageVsKills) ? storedPerformance.damageVsKills : [],
    },
    tournaments: {
      totalPlayed: hasFilledValue(storedTournaments.totalPlayed) ? storedTournaments.totalPlayed : 0,
      wins: hasFilledValue(storedTournaments.wins) ? storedTournaments.wins : 0,
      runnerUp: hasFilledValue(storedTournaments.runnerUp) ? storedTournaments.runnerUp : 0,
      top4: hasFilledValue(storedTournaments.top4) ? storedTournaments.top4 : 0,
      top8: hasFilledValue(storedTournaments.top8) ? storedTournaments.top8 : 0,
      bestPerformance: safeString(storedTournaments.bestPerformance, ''),
      mvpCount: hasFilledValue(storedTournaments.mvpCount) ? storedTournaments.mvpCount : 0,
      earnings: safeString(storedTournaments.earnings, ''),
      recentHistory: hasFilledValue(storedTournaments.recentHistory)
        ? storedTournaments.recentHistory
        : [],
      upcoming: hasFilledValue(storedTournaments.upcoming)
        ? storedTournaments.upcoming
        : [],
    },
    matches: hasFilledValue(stored.matches)
      ? stored.matches
      : [],
    achievements: buildPlayerAchievements(player, connectedUser, hasFilledValue(stored.achievements) ? stored.achievements : [
      pickItem(['Scrim MVP', 'Top fragger', 'Final-circle closer', 'Reliable entry'], seed, 420),
      pickItem(['High headshot rate', 'Consistent finisher', 'Clutch specialist', 'Late-game control'], seed, 421),
    ]),
    highlights: hasFilledValue(stored.highlights)
      ? stored.highlights
      : [
          { title: `${ign} triple entry`, type: 'Clip', duration: `0:${seededNumber(seed, 18, 49, 430)}` },
          { title: `${ign} end-zone cleanup`, type: 'Highlight', duration: `0:${seededNumber(seed, 22, 58, 431)}` },
          { title: `${ign} weekly montage`, type: 'Pack', duration: `1:${seededNumber(seed, 5, 35, 432)}` },
        ],
    social: {
      currentTeam: teamName,
      pastTeams: hasFilledValue(storedSocial.pastTeams) ? storedSocial.pastTeams : pickWindow(PAST_TEAM_NAMES, 2, seed, 450),
      teammates: buildPlayerTeammates(team, storedSocial.teammates),
      links: buildPlayerSocialLinks(
        team,
        hasFilledValue(storedSocial.links)
          ? storedSocial.links
          : [
              { label: 'Discord', value: `${playerKey}-clips` },
              { label: 'Instagram', value: `@${playerKey}` },
            ]
      ),
    },
    insights: {
      strengthRating: Number.isFinite(storedInsights.strengthRating) && storedInsights.strengthRating > 0 ? storedInsights.strengthRating : seededNumber(seed, 78, 97, 470),
      formStatus: safeString(storedInsights.formStatus, pickItem(FORM_STATES, seed, 471)),
      bestWeapon: safeString(storedInsights.bestWeapon, pickItem(BEST_WEAPONS, seed, 472)),
      bestRole: safeString(player?.roleTag, safeString(storedInsights.bestRole, roleFallback)),
      activeWindow: safeString(storedInsights.activeWindow, pickItem(ACTIVE_WINDOWS, seed, 473)),
      bestMap: safeString(storedInsights.bestMap, pickItem(MAP_POOL, seed, 474)),
      archetype: safeString(storedInsights.archetype, pickItem(ARCHETYPES, seed, 475)),
    },
  };
}

module.exports = {
  buildPlayerProfile,
  buildTeamProfile,
};
