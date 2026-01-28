const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();
const db = admin.firestore();

//API
const { defineSecret } = require("firebase-functions/params");
const APIFOOTBALL_KEY = defineSecret("APIFOOTBALL_KEY");

async function apiFootballGet(path, params, apiKey) {
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API-Football ${res.status}: ${text}`);
  }

  return res.json();
}

function isHost(room, uid) {
  return !!room?.hostUid && room.hostUid === uid;
}

//Tournament 
function toPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p.includes("GOALKEEP") || p === "GK" || p === "GKP") return "GK";
  if (p.includes("DEFEND") || p.includes("BACK") || p === "DEF") return "DEF";
  if (p.includes("MID") || p === "MID") return "MID";
  if (p.includes("ATTACK") || p.includes("FORW") || p.includes("STRIK") || p === "FWD") return "FWD";
  return "MID";
}

function normalizePlayer(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { id: raw, name: "Unknown", position: "MID" };

  const id = raw.id || raw.playerId || raw.pid;
  if (!id) return null;

  return {
    id: String(id),
    name: raw.name || raw.fullName || raw.displayName || "Unknown",
    position: toPos(raw.position || raw.pos || raw.role),
  };
}

exports.seedPlayersFromCompetition = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    const league = Number(request.data?.league ?? 2); // default UCL
    const season = Number(request.data?.season ?? 2025);

    // Optional: limit the pool to teams playing on a specific day (ex: UCL Wednesday slate).
    // Expected format: "YYYY-MM-DD" in the given timezone.
    const fixtureDate = request.data?.fixtureDate ? String(request.data.fixtureDate) : null;
    const timezone = String(request.data?.timezone ?? "America/Los_Angeles");

    // Safety caps
    const maxPages = Math.max(1, Math.min(50, Number(request.data?.maxPages ?? 5))); // league paging mode
    const maxPagesPerTeam = Math.max(1, Math.min(10, Number(request.data?.maxPagesPerTeam ?? 4))); // fixture-date mode

    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");
    if (!Number.isFinite(league) || !Number.isFinite(season)) {
      throw new HttpsError("invalid-argument", "league and season are required.");
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Host only.");

    const apiKey = APIFOOTBALL_KEY.value();

    // If fixtureDate is provided, fetch the fixtures for that day and build the allowed team set.
    // We'll then pull players by TEAM to avoid missing Wednesday teams due to league pagination limits.
    const teamMeta = new Map(); // teamId -> { id, name, logo }
    if (fixtureDate) {
      const fx = await apiFootballGet(
        "fixtures",
        { league, season, date: fixtureDate, timezone },
        apiKey
      );

      const fixtures = Array.isArray(fx?.response) ? fx.response : [];
      for (const f of fixtures) {
        const home = f?.teams?.home;
        const away = f?.teams?.away;

        if (home?.id) teamMeta.set(String(home.id), { id: String(home.id), name: home?.name || "", logo: home?.logo || "" });
        if (away?.id) teamMeta.set(String(away.id), { id: String(away.id), name: away?.name || "", logo: away?.logo || "" });
      }

      if (teamMeta.size === 0) {
        throw new HttpsError(
          "failed-precondition",
          `No fixtures found for ${fixtureDate} (league=${league}, season=${season}, timezone=${timezone}).`
        );
      }
    }

    let written = 0;
    let pagesFetched = 0;

    // Firestore batch limit is 500 ops; stay under it comfortably
    let batch = db.batch();
    let ops = 0;

    function commitIfNeeded(force = false) {
      if (ops >= 450 || force) {
        const b = batch;
        batch = db.batch();
        ops = 0;
        return b.commit();
      }
      return Promise.resolve();
    }

    const seen = new Set();

    function pickBestStats(statsArr, preferredTeamId) {
      const arr = Array.isArray(statsArr) ? statsArr : [];
      if (!preferredTeamId) return arr[0] || null;
      const teamIdStr = String(preferredTeamId);

      return (
        arr.find((s) => String(s?.team?.id || "") === teamIdStr && String(s?.league?.id || "") === String(league)) ||
        arr.find((s) => String(s?.team?.id || "") === teamIdStr) ||
        arr[0] ||
        null
      );
    }

    async function upsertPlayerFromApiItem(it, preferredTeamId) {
      const p = it?.player;
      const playerId = p?.id;
      if (!playerId) return;

      const pid = String(playerId);
      if (seen.has(pid)) return;
      seen.add(pid);

      const st0 = pickBestStats(it?.statistics, preferredTeamId);

      const positionRaw = st0?.games?.position || st0?.games?.pos || "";
      const position = toPos(positionRaw);

      const teamId = st0?.team?.id ?? preferredTeamId ?? null;
      const teamIdStr = teamId ? String(teamId) : null;

      // If we're in fixture-date mode, only keep players whose club is in the slate.
      if (fixtureDate && teamIdStr && !teamMeta.has(teamIdStr)) return;

      const teamName = st0?.team?.name || (teamIdStr ? teamMeta.get(teamIdStr)?.name : "") || "";
      const teamLogo = st0?.team?.logo || (teamIdStr ? teamMeta.get(teamIdStr)?.logo : "") || "";

      const full = `${p?.firstname || ""} ${p?.lastname || ""}`.trim();
      const displayName = full || p?.name || "Unknown";

      const docRef = db.doc(`rooms/${roomId}/players/${pid}`);
      batch.set(
        docRef,
        {
          id: pid,
          name: displayName,
          position,
          teamId: teamIdStr,
          teamName,
          teamLogo,
          nationality: p?.nationality || "",

          provider: "api-football",
          league: String(league),
          season: String(season),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      ops += 1;
      written += 1;

      if (ops >= 450) await commitIfNeeded(true);
    }

    if (!fixtureDate) {
      // --- Original mode: pull players by league/season (paged) ---
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages && page <= maxPages) {
        const res = await apiFootballGet("players", { league, season, page }, apiKey);
        totalPages = Number(res?.paging?.total ?? 1) || 1;
        pagesFetched += 1;

        const items = Array.isArray(res?.response) ? res.response : [];
        for (const it of items) {
          await upsertPlayerFromApiItem(it, null);
        }

        page += 1;
      }
    } else {
      // --- Fixture-date mode: pull players only for the clubs playing that day ---
      for (const teamIdStr of teamMeta.keys()) {
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages && page <= maxPagesPerTeam) {
          const res = await apiFootballGet("players", { team: teamIdStr, season, page }, apiKey);
          totalPages = Number(res?.paging?.total ?? 1) || 1;
          pagesFetched += 1;

          const items = Array.isArray(res?.response) ? res.response : [];
          for (const it of items) {
            await upsertPlayerFromApiItem(it, teamIdStr);
          }

          page += 1;
        }
      }
    }

    await commitIfNeeded(true);

    // Store competition choice + seeding filter on room
    await roomRef.set(
      {
        competition: {
          provider: "api-football",
          league,
          season,
          timezone,
        },
        seedFilter: fixtureDate ? { fixtureDate } : admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      ok: true,
      league,
      season,
      fixtureDate,
      timezone,
      pagesFetched,
      written,
      teamCount: fixtureDate ? teamMeta.size : null,
    };
  }
);


function extractStarters(lineupData) {
  if (!lineupData) return [];

  const candidates = [
    lineupData.starters,
    lineupData.startingXI,
    lineupData.starting11,
    lineupData.starterIds,
    lineupData.startingIds,
    lineupData.lineup?.starters,
    lineupData.lineup?.startingXI,
    lineupData.lineup?.starting11,
  ];

  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;

    if (typeof c[0] === "string") {
      return c.map((id) => ({ id: String(id), name: "Unknown", position: "MID" }));
    }

    const inline = c.map(normalizePlayer).filter(Boolean);
    if (inline.length) return inline;
  }

  return [];
}

// --- scoring (reuse same config logic as web; keep it simple for now) ---
const SCORING = {
  appearance: { anyMinutes: 1, sixtyPlus: 1 },
  assists: 3,
  goals: { GK: 6, DEF: 6, MID: 5, FWD: 4 },
  passesCompleted: { enabled: true, perByPos: { GK: 25, DEF: 20, MID: 20, FWD: 15 }, pointsPerChunk: 1 },
};

function scorePlayer(stats, pos) {
  const s = {
    minutes: Number(stats?.minutes ?? 0),
    goals: Number(stats?.goals ?? 0),
    assists: Number(stats?.assists ?? 0),
    passesCompleted: Number(stats?.passesCompleted ?? 0),
  };

  if (s.minutes <= 0) return { points: 0 };

  let points = 0;

  // appearance
  points += SCORING.appearance.anyMinutes;
  if (s.minutes >= 60) points += SCORING.appearance.sixtyPlus;

  // goals/assists
  points += s.goals * (SCORING.goals[pos] ?? 0);
  points += s.assists * SCORING.assists;

  // passes
  const per = SCORING.passesCompleted.perByPos[pos] ?? 999999;
  points += Math.floor(s.passesCompleted / per) * (SCORING.passesCompleted.pointsPerChunk ?? 1);

  return { points };
}

function scoreTeam(starters, statsByPlayerId) {
  let total = 0;
  const perPlayer = {};

  for (const p of starters) {
    const st = statsByPlayerId[p.id];
    const r = scorePlayer(st, p.position);
    perPlayer[p.id] = r.points;
    total += r.points;
  }

  return { total, perPlayer };
}

// deterministic mock stats (same idea as your client mock)
function hashToUint32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function genMockStats(roundId, player) {
  const rng = mulberry32(hashToUint32(`${roundId}:${player.id}`));
  const roll = rng();
  const minutes = roll < 0.08 ? 0 : roll < 0.15 ? randInt(rng, 1, 30) : randInt(rng, 60, 90);

  const passBase = player.position === "MID" ? [35, 120]
    : player.position === "DEF" ? [25, 95]
    : player.position === "GK" ? [10, 45]
    : [10, 70];

  const passesCompleted = minutes === 0 ? 0 : randInt(rng, passBase[0], passBase[1]);

  const goalsChance = player.position === "FWD" ? 0.12 : player.position === "MID" ? 0.07 : player.position === "DEF" ? 0.03 : 0.002;
  const assistsChance = player.position === "MID" ? 0.10 : player.position === "FWD" ? 0.08 : player.position === "DEF" ? 0.04 : 0.005;

  const goals = minutes === 0 ? 0 : (rng() < goalsChance ? 1 : 0);
  const assists = minutes === 0 ? 0 : (rng() < assistsChance ? 1 : 0);

  return { minutes, passesCompleted, goals, assists };
}

function pairMatchups(users, totalsByUid, roundId) {
  const matchups = [];
  for (let i = 0; i < users.length; i += 2) {
    const a = users[i];
    const b = users[i + 1];
    if (!b) break;

    const aTotal = totalsByUid[a.userId] ?? 0;
    const bTotal = totalsByUid[b.userId] ?? 0;

    let aRes = "L", bRes = "W", winnerUserId = b.userId;
    if (aTotal > bTotal) { aRes = "W"; bRes = "L"; winnerUserId = a.userId; }
    else if (aTotal === bTotal) { aRes = "D"; bRes = "D"; winnerUserId = null; }

    matchups.push({
      roundId,
      homeUserId: a.userId,
      awayUserId: b.userId,
      homeTotal: aTotal,
      awayTotal: bTotal,
      homeResult: aRes,
      awayResult: bRes,
      winnerUserId,
      status: "FINAL",
    });
  }
  return matchups;
}

function buildLeaderboard(users, matchups, totalsByUid) {
  const tablePts = (r) => (r === "W" ? 3 : r === "D" ? 1 : 0);

  const rows = users.map((u) => {
    const m = matchups.find((x) => x.homeUserId === u.userId || x.awayUserId === u.userId);
    const res = !m ? "-" : (m.homeUserId === u.userId ? m.homeResult : m.awayResult);
    return {
      userId: u.userId,
      name: u.name,
      result: res,
      matchPoints: res === "-" ? 0 : tablePts(res),
      fantasyPoints: totalsByUid[u.userId] ?? 0,
    };
  });

  rows.sort((a, b) => (b.matchPoints - a.matchPoints) || (b.fantasyPoints - a.fantasyPoints));
  return rows;
}

exports.computeRoundResults = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = request.data?.roomId;
  const roundId = Number(request.data?.roundId ?? 1);

  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data();
  if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

  // members
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id);

  if (memberUids.length < 2) {
    // still write results, but no matchups
    // (or you can throw)
  }

  // build users + starters
  const users = [];
  for (const mUid of memberUids) {
    const userSnap = await db.doc(`users/${mUid}`).get();
    const profile = userSnap.exists ? userSnap.data() : {};
    const display = (profile.displayName || profile.name || mUid).trim();

    const tnSnap = await db.doc(`rooms/${roomId}/teamNames/${mUid}`).get();
    const tn = tnSnap.exists ? (tnSnap.data().teamName || "") : "";
    const name = tn ? `${display} — ${tn}` : display;

    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${mUid}`).get();
    const lineup = lineupSnap.exists ? lineupSnap.data() : null;

    const starters = extractStarters(lineup);
    users.push({ userId: mUid, name, starters });
  }

  // generate stats + score
  const totalsByUid = {};
  const breakdownByUserId = {};
  const statsByPlayerIdByUserId = {};

  for (const u of users) {
    const statsByPlayerId = {};
    for (const p of u.starters) {
      statsByPlayerId[p.id] = genMockStats(roundId, p);
    }
    statsByPlayerIdByUserId[u.userId] = statsByPlayerId;

    const scored = scoreTeam(u.starters, statsByPlayerId);
    totalsByUid[u.userId] = scored.total;
    breakdownByUserId[u.userId] = scored;
  }

  const matchups = pairMatchups(users, totalsByUid, roundId);
  const leaderboard = buildLeaderboard(users, matchups, totalsByUid);

  const resultsDoc = {
    roomId,
    roundId,
    teamScoresByUserId: totalsByUid,
    breakdownByUserId,
    matchups,
    leaderboard,
    computedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/roundResults/${String(roundId)}`).set(resultsDoc, { merge: true });

  return { ok: true, roundId };
});

//Demo Opponenets for testing
function buildBotLineup(botId, botNum) {
  // 4-4-2 starters + 4 bench
  const starters = [
    { id: `${botId}_gk1`, name: `Bot ${botNum} GK`, position: "GK" },

    { id: `${botId}_def1`, name: `Bot ${botNum} DEF 1`, position: "DEF" },
    { id: `${botId}_def2`, name: `Bot ${botNum} DEF 2`, position: "DEF" },
    { id: `${botId}_def3`, name: `Bot ${botNum} DEF 3`, position: "DEF" },
    { id: `${botId}_def4`, name: `Bot ${botNum} DEF 4`, position: "DEF" },

    { id: `${botId}_mid1`, name: `Bot ${botNum} MID 1`, position: "MID" },
    { id: `${botId}_mid2`, name: `Bot ${botNum} MID 2`, position: "MID" },
    { id: `${botId}_mid3`, name: `Bot ${botNum} MID 3`, position: "MID" },
    { id: `${botId}_mid4`, name: `Bot ${botNum} MID 4`, position: "MID" },

    { id: `${botId}_fwd1`, name: `Bot ${botNum} FWD 1`, position: "FWD" },
    { id: `${botId}_fwd2`, name: `Bot ${botNum} FWD 2`, position: "FWD" },
  ].map((p) => ({ ...p, position: toPos(p.position) }));

  const bench = [
    { id: `${botId}_bgk`, name: `Bot ${botNum} Bench GK`, position: "GK" },
    { id: `${botId}_bdef`, name: `Bot ${botNum} Bench DEF`, position: "DEF" },
    { id: `${botId}_bmid`, name: `Bot ${botNum} Bench MID`, position: "MID" },
    { id: `${botId}_bfwd`, name: `Bot ${botNum} Bench FWD`, position: "FWD" },
  ].map((p) => ({ ...p, position: toPos(p.position) }));

  return { starters, bench };
}

function safeId(str) {
  return String(str || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40);
}


exports.seedDemoOpponents = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = request.data?.roomId;
  const countRaw = Number(request.data?.count ?? 3);
  const count = Math.max(1, Math.min(7, isFinite(countRaw) ? countRaw : 3));

  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Host only.");

  const roomTag = safeId(roomId);

  const batch = db.batch();

  for (let i = 1; i <= count; i++) {
    const botUid = `bot_${roomTag}_${i}`;

    // users/{botUid}
    batch.set(
      db.doc(`users/${botUid}`),
      { displayName: `Bot ${i}`, isBot: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // rooms/{roomId}/members/{botUid}
    batch.set(
      db.doc(`rooms/${roomId}/members/${botUid}`),
      { isBot: true, joinedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // rooms/{roomId}/teamNames/{botUid}
    batch.set(
      db.doc(`rooms/${roomId}/teamNames/${botUid}`),
      { teamName: `Bot Squad ${i}`, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // rooms/{roomId}/lineups/{botUid}
    const lineup = buildBotLineup(botUid, i);
    batch.set(
      db.doc(`rooms/${roomId}/lineups/${botUid}`),
      { ...lineup, isBot: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  await batch.commit();

  return { ok: true, created: count };
});

// ---------------- Subs Lock (mock now, API later) ----------------

function extractBench(lineupData) {
  if (!lineupData) return [];

  const candidates = [
    lineupData.bench,
    lineupData.subs,
    lineupData.substitutes,
    lineupData.benchIds,
    lineupData.subIds,
    lineupData.lineup?.bench,
    lineupData.lineup?.subs,
    lineupData.currentLineup?.bench,
    lineupData.currentLineup?.subs,
  ];

  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;

    if (typeof c[0] === "string") {
      return c.map((id) => ({ id: String(id), name: "Unknown", position: "MID" }));
    }

    const inline = c.map(normalizePlayer).filter(Boolean);
    if (inline.length) return inline;
  }

  return [];
}

function extractRoster(lineupData) {
  const starters = extractStarters(lineupData);
  const bench = extractBench(lineupData);
  const byId = new Map();

  for (const p of [...starters, ...bench]) {
    if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
  }

  return Array.from(byId.values());
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// deterministic mock fixtures around "now" (later replaced by API fixtures)
// creates fixtures for days [now-2 .. now+2] with random kickoff times per day
function genMockFixturesAroundNow(playerId, nowMs) {
  const rng = mulberry32(hashToUint32(`${playerId}:lock-fixtures`));
  const day0 = startOfUtcDay(nowMs) - 2 * 24 * 60 * 60 * 1000;

  const fixtures = [];
  for (let i = 0; i < 5; i++) {
    // ~55% chance this player plays that day (for testing variety)
    if (rng() < 0.55) {
      const hour = randInt(rng, 12, 22);
      const minute = randInt(rng, 0, 59);
      const kickoffMs = day0 + i * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000 + minute * 60 * 1000;

      fixtures.push({
        fixtureId: `${playerId}_lock_${kickoffMs}`,
        kickoffMs,
      });
    }
  }
  fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);
  return fixtures;
}

function isLive(nowMs, kickoffMs) {
  const DURATION_MS = 2 * 60 * 60 * 1000; // ~2 hours
  return nowMs >= kickoffMs && nowMs <= kickoffMs + DURATION_MS;


// --- Real stats helpers (API-Football) --------------------------------------
function toNum(v) {
  const n = Number(String(v ?? "").replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

// Convert API-Football fixtures/players entry -> our scoring shape
function extractFixturePlayerStat(playerEntry) {
  const s0 = Array.isArray(playerEntry?.statistics) ? playerEntry.statistics[0] : null;

  const minutes = toNum(s0?.games?.minutes);
  const goals = toNum(s0?.goals?.total);
  const assists = toNum(s0?.goals?.assists);

  const passesTotal = toNum(s0?.passes?.total);
  const passAcc = toNum(s0?.passes?.accuracy); // often "85"
  const passesCompleted =
    passesTotal > 0 && passAcc > 0 ? Math.round((passesTotal * passAcc) / 100) : passesTotal;

  return { minutes, goals, assists, passesCompleted };
}

async function fetchFixturePlayersStatsMap(fixtureId, apiKey) {
  const json = await apiFootballGet("fixtures/players", { fixture: fixtureId }, apiKey);
  const resp = Array.isArray(json?.response) ? json.response : [];

  const map = {}; // playerId -> {minutes, goals, assists, passesCompleted}
  for (const teamBlock of resp) {
    const players = Array.isArray(teamBlock?.players) ? teamBlock.players : [];
    for (const pl of players) {
      const pid = pl?.player?.id;
      if (!pid) continue;
      map[String(pid)] = extractFixturePlayerStat(pl);
    }
  }
  return map;
}

// Cache per fixture so multiple rooms share the same API call
async function getFixturePlayersStatsCached({ fixtureId, kickoffMs, nowMs, apiKey }) {
  const cacheRef = db.doc(`apiCache/fixturePlayers_${fixtureId}`);
  const snap = await cacheRef.get();

  const updatedAtMs = snap.exists ? Number(snap.data()?.updatedAtMs || 0) : 0;
  const hasCached = snap.exists && !!snap.data()?.statsByPlayerId;

  // TTL: during/near match = ~90s; long after kickoff = 10min
  const ageMs = nowMs - updatedAtMs;
  const afterGame =
    Number.isFinite(kickoffMs) && Number.isFinite(nowMs) && nowMs - kickoffMs > 3 * 60 * 60 * 1000;

  const TTL_MS = afterGame ? 10 * 60 * 1000 : 90 * 1000;

  if (hasCached && ageMs >= 0 && ageMs < TTL_MS) {
    return { cached: true, statsByPlayerId: snap.data().statsByPlayerId || {} };
  }

  const statsByPlayerId = await fetchFixturePlayersStatsMap(fixtureId, apiKey);

  await cacheRef.set(
    { updatedAtMs: nowMs, kickoffMs: kickoffMs ?? null, statsByPlayerId },
    { merge: true }
  );

  return { cached: false, statsByPlayerId };
}
// ---------------------------------------------------------------------------
}

exports.getUserLockStatus = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const nowMs = Number(request.data?.nowMs ?? Date.now());

    // 1) Room + competition (fallback to UCL test)
    const roomSnap = await db.doc(`rooms/${roomId}`).get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
    const room = roomSnap.data() || {};

    const competition = room.competition || {
      provider: "api-football",
      league: 2,
      season: 2025,
      timezone: "America/Los_Angeles",
    };

    const league = Number(competition.league ?? 2);
    const season = Number(competition.season ?? 2025);
    const timezone = String(competition.timezone || "America/Los_Angeles");

    // 2) Get THIS user's STARTING XI (lock only if starters are live)
    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${uid}`).get();
    const lineup = lineupSnap.exists ? (lineupSnap.data() || null) : null;

    // uses your helper above
    const starters = extractStarters(lineup);

    // collect starter teamIds (prefer apiTeamId/teamId)
    const myTeamIds = new Set(
      starters
        .map((p) => p.apiTeamId ?? p.teamId ?? null)
        .filter((x) => x != null)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n))
    );

    if (myTeamIds.size === 0) {
      return {
        ok: true,
        locked: false,
        nowMs,
        livePlayers: [],
        checkedPlayers: starters.length,
        provider: "api-football",
        note: "No starter teamIds found yet (startingXI missing teamId/apiTeamId).",
      };
    }

    // 3) Cached live fixtures for competition
    async function getLiveFixturesCached() {
      const cacheId = `${league}_${season}`;
      const cacheRef = db.doc(`apiCache/liveFixtures_${cacheId}`);
      const cacheSnap = await cacheRef.get();

      const TTL_MS = 30 * 1000; // 30s cache
      if (cacheSnap.exists) {
        const c = cacheSnap.data() || {};
        if (c.updatedAtMs && nowMs - Number(c.updatedAtMs) < TTL_MS && c.data) {
          return { cached: true, data: c.data };
        }
      }

      const apiKey = APIFOOTBALL_KEY.value();
      const data = await apiFootballGet(
        "fixtures",
        { live: "all", league, season, timezone },
        apiKey
      );

      await cacheRef.set(
        { updatedAtMs: nowMs, data },
        { merge: true }
      );

      return { cached: false, data };
    }

    const liveFxRes = await getLiveFixturesCached();
    const fxList = Array.isArray(liveFxRes?.data?.response) ? liveFxRes.data.response : [];

    // 4) Match live fixtures to user's teamIds
    const matchedFixtures = [];
    const liveTeamIds = new Set();

    for (const m of fxList) {
      const homeId = Number(m?.teams?.home?.id);
      const awayId = Number(m?.teams?.away?.id);

      const matchHasMyTeam = (myTeamIds.has(homeId) || myTeamIds.has(awayId));
      if (!matchHasMyTeam) continue;

      matchedFixtures.push({
        fixtureId: m?.fixture?.id ?? null,
        kickoff: m?.fixture?.date ?? null,
        status: m?.fixture?.status?.short ?? null,
        homeTeamId: homeId,
        awayTeamId: awayId,
        home: m?.teams?.home?.name ?? "",
        away: m?.teams?.away?.name ?? "",
      });

      if (myTeamIds.has(homeId)) liveTeamIds.add(homeId);
      if (myTeamIds.has(awayId)) liveTeamIds.add(awayId);
    }

    // 5) Build a "livePlayers" list for UI (players whose team is currently live)
    const livePlayers = starters
      .filter((p) => {
        const tid = Number(p.apiTeamId ?? p.teamId ?? NaN);
        return Number.isFinite(tid) && liveTeamIds.has(tid);
      })
      .map((p) => ({
        playerId: String(p.id || ""),
        name: p.name || "Unknown",
        position: p.position || "MID",
        teamId: Number(p.apiTeamId ?? p.teamId ?? NaN),
    }));

    return {
      ok: true,
      locked: matchedFixtures.length > 0,
      nowMs,
      provider: "api-football",
      cached: liveFxRes.cached,
      checkedPlayers: starters.length,
      livePlayers,          // for your UI “Subs locked: names…”
      matchedFixtures,      // useful for debugging
      competition: { league, season, timezone },
    };
  }
);


// ---------------- Weeks (mock for now, API later) ----------------

// mock fixture generator (later replaced by API fixtures)
function genMockUpcomingFixtures(afterMs, playerId, count = 6) {
  const rng = mulberry32(hashToUint32(`${playerId}:fixtures`));
  let t = Number(afterMs) + randInt(rng, 6, 20) * 60 * 60 * 1000; // 6–20 hours after

  const fixtures = [];
  for (let md = 1; md <= count; md++) {
    t += randInt(rng, 20, 60) * 60 * 60 * 1000; // 20–60h gaps
    fixtures.push({
      fixtureId: `${playerId}_fx_${md}_${t}`,
      kickoffMs: t,
      roundLabel: `MD${md}`, // stand-in for API matchday/round label
    });
  }
  return fixtures;
}

// prefer roundLabel grouping; fallback to time-gap clustering
function buildWeekWindowFromFixtures(fixtures, gapHours = 36) {
  if (!fixtures.length) return null;

  fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);
  const earliest = fixtures[0];

  // Prefer matchday/round grouping if available
  if (earliest.roundLabel) {
    const sameRound = fixtures.filter((f) => f.roundLabel === earliest.roundLabel);
    const startAtMs = Math.min(...sameRound.map((f) => f.kickoffMs));
    const endAtMs = Math.max(...sameRound.map((f) => f.kickoffMs));
    return { startAtMs, endAtMs, roundLabel: earliest.roundLabel, fixtureIds: sameRound.map((f) => f.fixtureId) };
  }

  // Fallback: gap clustering
  const gapMs = gapHours * 60 * 60 * 1000;
  let endIdx = 0;
  for (let i = 1; i < fixtures.length; i++) {
    const prev = fixtures[i - 1].kickoffMs;
    const cur = fixtures[i].kickoffMs;
    if (cur - prev > gapMs) break;
    endIdx = i;
  }
  const cluster = fixtures.slice(0, endIdx + 1);
  return {
    startAtMs: cluster[0].kickoffMs,
    endAtMs: cluster[cluster.length - 1].kickoffMs,
    roundLabel: null,
    fixtureIds: cluster.map((f) => f.fixtureId),
  };
}

// round-robin pairing (circle method)
// weekIndex starts at 1
function roundRobinPairings(teamIds, weekIndex) {
  const ids = [...teamIds].sort(); // stable
  const n = ids.length;
  if (n % 2 !== 0) throw new Error("Round-robin requires an even number of managers.");

  const rounds = n - 1;
  const r = (Number(weekIndex) - 1) % rounds;

  const fixed = ids[0];
  let rot = ids.slice(1);

  // rotate r times
  for (let i = 0; i < r; i++) {
    rot = [rot[rot.length - 1], ...rot.slice(0, rot.length - 1)];
  }

  const list = [fixed, ...rot];
  const pairs = [];

  for (let i = 0; i < n / 2; i++) {
    let home = list[i];
    let away = list[n - 1 - i];

    // alternate home/away by round to balance
    if ((r % 2) === 1) [home, away] = [away, home];

    pairs.push({ homeUserId: home, awayUserId: away });
  }

  return pairs;
}

// combine stats across multiple fixtures in the same week window (mock)
function genMockFixtureStats(weekIndex, player, kickoffMs) {
  const rng = mulberry32(hashToUint32(`${weekIndex}:${player.id}:${kickoffMs}`));
  const roll = rng();
  const minutes = roll < 0.08 ? 0 : roll < 0.15 ? randInt(rng, 1, 30) : randInt(rng, 60, 90);

  const passBase = player.position === "MID" ? [35, 120]
    : player.position === "DEF" ? [25, 95]
    : player.position === "GK" ? [10, 45]
    : [10, 70];

  const passesCompleted = minutes === 0 ? 0 : randInt(rng, passBase[0], passBase[1]);

  const goalsChance = player.position === "FWD" ? 0.12 : player.position === "MID" ? 0.07 : player.position === "DEF" ? 0.03 : 0.002;
  const assistsChance = player.position === "MID" ? 0.10 : player.position === "FWD" ? 0.08 : player.position === "DEF" ? 0.04 : 0.005;

  const goals = minutes === 0 ? 0 : (rng() < goalsChance ? 1 : 0);
  const assists = minutes === 0 ? 0 : (rng() < assistsChance ? 1 : 0);

  return { minutes, passesCompleted, goals, assists };
}

function sumStats(a, b) {
  return {
    minutes: (a.minutes || 0) + (b.minutes || 0),
    passesCompleted: (a.passesCompleted || 0) + (b.passesCompleted || 0),
    goals: (a.goals || 0) + (b.goals || 0),
    assists: (a.assists || 0) + (b.assists || 0),
  };
}

async function fetchNextRoundWindow({ league, season, timezone }) {
  const apiKey = APIFOOTBALL_KEY.value();

  // Get next batch of fixtures and use the earliest fixture's "round" as the week grouping
  const fx = await apiFootballGet(
    "fixtures",
    { league, season, next: 100, timezone },
    apiKey
  );

  const list = Array.isArray(fx?.response) ? fx.response : [];
  if (!list.length) return null;

  const roundLabel = list[0]?.league?.round || null;
  const sameRound = roundLabel
    ? list.filter((m) => m?.league?.round === roundLabel)
    : list;

  const fixtures = sameRound
    .map((m) => ({
      id: String(m?.fixture?.id),
      kickoffMs: Date.parse(m?.fixture?.date),
      round: m?.league?.round || null,
    }))
    .filter((f) => f.id && Number.isFinite(f.kickoffMs))
    .sort((a, b) => a.kickoffMs - b.kickoffMs);

  if (!fixtures.length) return null;

  return {
    roundLabel: fixtures[0].round,
    startAtMs: fixtures[0].kickoffMs,
    endAtMs: fixtures[fixtures.length - 1].kickoffMs,
    fixtures,
  };
}

exports.createNextWeek = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    // require even managers
    const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
    const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
    if (memberUids.length < 2) throw new HttpsError("failed-precondition", "Need at least 2 managers.");
    if (memberUids.length % 2 !== 0) throw new HttpsError("failed-precondition", "Managers must be an even number.");

    // determine next weekIndex
    const weeksSnap = await db.collection(`rooms/${roomId}/weeks`).get();
    let maxIdx = 0;
    for (const d of weeksSnap.docs) {
      const idx = Number(d.data()?.index ?? d.id);
      if (Number.isFinite(idx)) maxIdx = Math.max(maxIdx, idx);
    }
    const weekIndex = maxIdx + 1;

    // Competition config (default to UCL for your test)
    const competition = room.competition || {
      provider: "api-football",
      league: 2,          // UCL
      season: 2025,       // from the API-Football table you showed
      timezone: "America/Los_Angeles",
    };

    const window = await fetchNextRoundWindow(competition);
    if (!window) throw new HttpsError("failed-precondition", "No upcoming fixtures found for this competition.");

    // Round-robin matchups
    const pairs = roundRobinPairings(memberUids, weekIndex);

    const weekDoc = {
      index: weekIndex,
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      roundLabel: window.roundLabel || null,

      // store fixtures so compute can seed stats per fixture
      fixtures: window.fixtures,
      fixtureIds: window.fixtures.map((f) => f.id),

      competition,
      matchups: pairs,
      status: "scheduled",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).set(weekDoc, { merge: true });
    await roomRef.set({ currentWeekIndex: weekIndex, competition }, { merge: true });

    return { ok: true, weekIndex, ...window };
  }
);


// --- Week results computation (REAL stats, cached) ---------------------------
async function computeWeekResultsInternal({ roomId, weekIndex, nowMs, apiKey, computedByUid }) {
  const roomSnap = await db.doc(`rooms/${roomId}`).get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
  const room = roomSnap.data() || {};

  if (computedByUid && !isHost(room, computedByUid)) {
    throw new HttpsError("permission-denied", "Host only.");
  }

  const weekRef = db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`);
  const weekSnap = await weekRef.get();
  if (!weekSnap.exists) {
    throw new HttpsError("failed-precondition", "Week doc not found. Create week first.");
  }
  const week = weekSnap.data() || {};
  const startAtMs = Number(week.startAtMs || 0);
  const endAtMs = Number(week.endAtMs || 0);
  if (!startAtMs || !endAtMs) {
    throw new HttpsError("failed-precondition", "Week is missing startAtMs/endAtMs.");
  }

  // members
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean).sort();
  if (memberUids.length < 2) {
    return { ok: true, skipped: true, reason: "Need at least 2 managers." };
  }

  // build users + starters (starters only score)
  const users = [];
  for (const mUid of memberUids) {
    const userSnap = await db.doc(`users/${mUid}`).get();
    const profile = userSnap.exists ? (userSnap.data() || {}) : {};
    const display = String(profile.displayName || profile.name || mUid).trim();

    const tnSnap = await db.doc(`rooms/${roomId}/teamNames/${mUid}`).get();
    const tn = tnSnap.exists ? String(tnSnap.data()?.teamName || "") : "";
    const name = tn ? `${display} — ${tn}` : display;

    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${mUid}`).get();
    const lineup = lineupSnap.exists ? lineupSnap.data() : null;

    const starters = extractStarters(lineup);
    users.push({ userId: mUid, name, starters });
  }

  // matchups from week doc, else generate
  const matchupPairs =
    Array.isArray(week.matchups) && week.matchups.length
      ? week.matchups
      : roundRobinPairings(memberUids, weekIndex);

  // fixtures in week window
  const weekFixtures = Array.isArray(week.fixtures) ? week.fixtures : [];
  const inWindow = weekFixtures
    .map((f) => ({ id: String(f.id), kickoffMs: Number(f.kickoffMs) }))
    .filter((f) => f.id && Number.isFinite(f.kickoffMs))
    .filter((f) => f.kickoffMs >= startAtMs && f.kickoffMs <= endAtMs);

  // Only fetch fixtures that have started (reduces API calls)
  const started = inWindow.filter((f) => f.kickoffMs <= nowMs);

  // Load fixture stats maps (cached, shared across rooms)
  const fixtureStatsMaps = new Map(); // fixtureId -> statsByPlayerId map
  for (const fx of started) {
    try {
      const got = await getFixturePlayersStatsCached({
        fixtureId: fx.id,
        kickoffMs: fx.kickoffMs,
        nowMs,
        apiKey,
      });
      fixtureStatsMaps.set(fx.id, got.statsByPlayerId || {});
    } catch (e) {
      console.error(`[computeWeekResultsInternal] fixture=${fx.id} fetch failed`, e);
      fixtureStatsMaps.set(fx.id, {});
    }
  }

  // score
  const totalsByUid = {};
  const breakdownByUserId = {};

  for (const u of users) {
    const statsByPlayerId = {};

    for (const p of u.starters) {
      let agg = { minutes: 0, passesCompleted: 0, goals: 0, assists: 0 };

      for (const fx of started) {
        const map = fixtureStatsMaps.get(fx.id);
        const st = map ? map[String(p.id)] : null;
        if (st) agg = sumStats(agg, st);
      }

      statsByPlayerId[p.id] = agg;
    }

    const scored = scoreTeam(u.starters, statsByPlayerId);
    totalsByUid[u.userId] = scored.total;
    breakdownByUserId[u.userId] = scored;
  }

  const isFinal = nowMs > endAtMs + 3 * 60 * 60 * 1000; // 3h after last kickoff
  const matchupStatus = isFinal ? "FINAL" : "LIVE";

  // build matchups results
  const matchups = matchupPairs.map((pair) => {
    const homeTotal = totalsByUid[pair.homeUserId] ?? 0;
    const awayTotal = totalsByUid[pair.awayUserId] ?? 0;

    let homeResult = "L",
      awayResult = "W",
      winnerUserId = pair.awayUserId;
    if (homeTotal > awayTotal) {
      homeResult = "W";
      awayResult = "L";
      winnerUserId = pair.homeUserId;
    } else if (homeTotal === awayTotal) {
      homeResult = "D";
      awayResult = "D";
      winnerUserId = null;
    }

    return {
      weekIndex,
      homeUserId: pair.homeUserId,
      awayUserId: pair.awayUserId,
      homeTotal,
      awayTotal,
      homeResult,
      awayResult,
      winnerUserId,
      status: matchupStatus,
    };
  });

  // week leaderboard (not season standings)
  const weekLeaderboard = buildLeaderboard(users, matchups, totalsByUid);

  // recompute cumulative standings from all weekResults (idempotent)
  const resultsSnap = await db.collection(`rooms/${roomId}/weekResults`).get();
  const agg = {}; // uid -> { played,w,d,l,tablePoints,totalFantasyPoints,name }
  function ensure(uid, name) {
    if (!agg[uid])
      agg[uid] = {
        userId: uid,
        name,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        tablePoints: 0,
        totalFantasyPoints: 0,
      };
    if (name) agg[uid].name = name;
    return agg[uid];
  }

  // include this computed week (even if not written yet)
  const allWeeks = resultsSnap.docs
    .map((d) => d.data())
    .filter(Boolean)
    .filter((d) => Number(d.weekIndex) !== weekIndex);

  allWeeks.push({
    weekIndex,
    matchups,
    teamScoresByUserId: totalsByUid,
  });

  for (const w of allWeeks) {
    const ms = Array.isArray(w.matchups) ? w.matchups : [];
    for (const m of ms) {
      const home = ensure(m.homeUserId);
      const away = ensure(m.awayUserId);

      home.played += 1;
      away.played += 1;

      const homePts = m.homeResult === "W" ? 3 : m.homeResult === "D" ? 1 : 0;
      const awayPts = m.awayResult === "W" ? 3 : m.awayResult === "D" ? 1 : 0;

      home.tablePoints += homePts;
      away.tablePoints += awayPts;

      if (m.homeResult === "W") home.wins += 1;
      else if (m.homeResult === "D") home.draws += 1;
      else home.losses += 1;

      if (m.awayResult === "W") away.wins += 1;
      else if (m.awayResult === "D") away.draws += 1;
      else away.losses += 1;
    }

    const scores = w.teamScoresByUserId || {};
    for (const uid2 of Object.keys(scores)) {
      const row = ensure(uid2);
      row.totalFantasyPoints += Number(scores[uid2] || 0);
    }
  }

  // attach names from current users array
  for (const u of users) ensure(u.userId, u.name);

  const standings = Object.values(agg).sort(
    (a, b) => b.tablePoints - a.tablePoints || b.totalFantasyPoints - a.totalFantasyPoints
  );

  // write weekResults + standings/current
  await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
    {
      roomId,
      weekIndex,
      startAtMs,
      endAtMs,
      roundLabel: week.roundLabel || null,
      teamScoresByUserId: totalsByUid,
      breakdownByUserId,
      matchups,
      weekLeaderboard,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: matchupStatus,
    },
    { merge: true }
  );

  await db.doc(`rooms/${roomId}/standings/current`).set(
    {
      roomId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      standings,
    },
    { merge: true }
  );

  // update week status (don't finalize until window is safely over)
  await weekRef.set(
    isFinal
      ? { status: "final", finalizedAt: admin.firestore.FieldValue.serverTimestamp() }
      : { status: "live", lastComputedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { ok: true, weekIndex, status: matchupStatus, isFinal };
}

exports.computeWeekResults = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    const weekIndex = Number(request.data?.weekIndex);
    if (!roomId || !Number.isFinite(weekIndex)) {
      throw new HttpsError("invalid-argument", "roomId and weekIndex are required.");
    }

    const nowMs = Number(request.data?.nowMs ?? Date.now());
    const apiKey = APIFOOTBALL_KEY.value();

    // enforce host for the callable
    return computeWeekResultsInternal({ roomId, weekIndex, nowMs, apiKey, computedByUid: uid });
  }
);

/**
 * Auto recompute live weeks every minute (shared cache means low API usage).
 * This is what makes points update "live" without pressing buttons.
 */
exports.pollLiveWeeks = onSchedule(
  {
    schedule: "*/1 * * * *",
    timeZone: "America/Los_Angeles",
    region: "us-west2",
    secrets: [APIFOOTBALL_KEY],
  },
  async () => {
    const nowMs = Date.now();
    const apiKey = APIFOOTBALL_KEY.value();

    const roomsSnap = await db
      .collection("rooms")
      .where("currentWeekIndex", ">", 0)
      .limit(50)
      .get();

    if (roomsSnap.empty) return;

    for (const roomDoc of roomsSnap.docs) {
      const roomId = roomDoc.id;
      const room = roomDoc.data() || {};
      const weekIndex = Number(room.currentWeekIndex || 0);
      if (!Number.isFinite(weekIndex) || weekIndex <= 0) continue;

      const last = Number(room.lastAutoComputeAtMs || 0);
      if (nowMs - last < 55 * 1000) continue;

      const weekRef = db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`);
      const weekSnap = await weekRef.get();
      if (!weekSnap.exists) continue;

      const week = weekSnap.data() || {};
      if (week.status === "final") continue;

      const startAtMs = Number(week.startAtMs || 0);
      const endAtMs = Number(week.endAtMs || 0);
      if (!startAtMs || !endAtMs) continue;

      // Only compute near / during the window (start-2h .. end+6h)
      if (nowMs < startAtMs - 2 * 60 * 60 * 1000) continue;
      if (nowMs > endAtMs + 6 * 60 * 60 * 1000 && week.status === "final") continue;

      // throttle marker
      await db.doc(`rooms/${roomId}`).set({ lastAutoComputeAtMs: nowMs }, { merge: true });

      try {
        await computeWeekResultsInternal({ roomId, weekIndex, nowMs, apiKey });
      } catch (e) {
        console.error(`[pollLiveWeeks] room=${roomId} week=${weekIndex} failed`, e);
      }
    }
  }
);
// ---------------------------------------------------------------------------


//Emails , timers, Market Opens 
function formatWhen(ms) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

async function getEmailsForUids(uids) {
  const chunks = [];
  for (let i = 0; i < uids.length; i += 100) chunks.push(uids.slice(i, i + 100));

  const out = [];
  for (const chunk of chunks) {
    const res = await admin.auth().getUsers(chunk.map((uid) => ({ uid })));
    for (const u of res.users) {
      if (u.email) out.push({ uid: u.uid, email: u.email, name: u.displayName || "" });
    }
  }
  return out;
}

async function queueEmails(recipients, subject, html, text, meta) {
  const batch = db.batch();
  for (const r of recipients) {
    const ref = db.collection("mail").doc();
    batch.set(ref, {
      to: r.email,
      message: { subject, html, text },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: meta || {},
    });
  }
  await batch.commit();
  return recipients.length;
}

/**
 * Draft scheduling: sets startAt + creates reminder doc + queues "Draft Scheduled" email now
 */
exports.scheduleDraft = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { roomId, startAtMs } = request.data || {};
  if (!roomId || !startAtMs) {
    throw new HttpsError("invalid-argument", "Missing roomId/startAtMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data();
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  const members = Array.isArray(room.members) ? room.members : [];
  const memberUids = members
    .map((m) => (typeof m === "string" ? m : m?.uid))
    .filter(Boolean);

  if (memberUids.length === 0) return { ok: true, emailsQueued: 0 };

  const whenStr = formatWhen(Number(startAtMs));
  const reminderSendAtMs = Number(startAtMs) - 10 * 60 * 1000;

  const oldReminderId = room.draftReminderId || null;
  const newReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  if (oldReminderId) batch.delete(db.doc(`reminders/${oldReminderId}`));

  batch.set(newReminderRef, {
    type: "draft_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    startAtMs: Number(startAtMs),
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.update(roomRef, {
    startAt: Number(startAtMs),
    draftReminderId: newReminderRef.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  const recipients = await getEmailsForUids(memberUids);
  const subject = "FIFA Fantasy — Draft Scheduled";
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2>Draft Scheduled</h2>
      <p><b>Host</b> has scheduled the draft for:</p>
      <p style="font-size:16px;"><b>${whenStr}</b></p>
      <p>Room: <b>${roomId}</b></p>
      <p>You’ll get a reminder 10 minutes before it starts.</p>
    </div>
  `;
  const text = `Draft Scheduled\nHost has scheduled the draft for: ${whenStr}\nRoom: ${roomId}\nReminder: 10 minutes before.`;

  const emailsQueued = await queueEmails(recipients, subject, html, text, {
    type: "draft_scheduled",
    roomId,
    startAtMs: Number(startAtMs),
  });

  return { ok: true, emailsQueued };
});

/**
 * Market scheduling: writes schedule to rooms/{roomId}/market/current
 * + NEW: creates a "market_10min" reminder doc
 */
exports.scheduleMarket = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { roomId, scheduledAtMs, durationMs } = request.data || {};
  if (!roomId || !scheduledAtMs || durationMs == null) {
    throw new HttpsError("invalid-argument", "Missing roomId/scheduledAtMs/durationMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data();
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  const members = Array.isArray(room.members) ? room.members : [];
  const memberUids = members
    .map((m) => (typeof m === "string" ? m : m?.uid))
    .filter(Boolean);

  const openStr = formatWhen(Number(scheduledAtMs));
  const durStr = formatDuration(Number(durationMs));

  const marketRef = db.doc(`rooms/${roomId}/market/current`);
  const marketSnap = await marketRef.get();
  const prevMarket = marketSnap.exists ? (marketSnap.data() || {}) : {};

  // NEW: create/replace market reminder
  const reminderSendAtMs = Number(scheduledAtMs) - 10 * 60 * 1000;
  const oldMarketReminderId = prevMarket.marketReminderId || null;
  const newMarketReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  if (oldMarketReminderId) batch.delete(db.doc(`reminders/${oldMarketReminderId}`));

  batch.set(newMarketReminderRef, {
    type: "market_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.set(
    marketRef,
    {
      status: "scheduled",
      scheduledAt: Number(scheduledAtMs),
      durationMs: Number(durationMs),

      openedAt: null,
      closesAt: null,
      resolvedAt: null,

      // NEW: link reminder so reschedules replace it
      marketReminderId: newMarketReminderRef.id,

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();

  // Email: "Market Scheduled" (immediate)
  const recipients = await getEmailsForUids(memberUids);
  const subject = "FIFA Fantasy — Market Scheduled";
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2>Market Scheduled</h2>
      <p><b>Host</b> has scheduled the market to open at:</p>
      <p style="font-size:16px;"><b>${openStr}</b></p>
      <p>It will stay open for: <b>${durStr}</b></p>
      <p>Room: <b>${roomId}</b></p>
      <p>You’ll get a reminder 10 minutes before it opens.</p>
    </div>
  `;
  const text = `Market Scheduled\nHost scheduled market open at: ${openStr}\nOpen duration: ${durStr}\nRoom: ${roomId}\nReminder: 10 minutes before.`;

  const emailsQueued = await queueEmails(recipients, subject, html, text, {
    type: "market_scheduled",
    roomId,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
  });

  return { ok: true, emailsQueued };
});

/**
 * Runs every minute to send reminder emails that are due
 * (Draft 10-min reminders + Market 10-min reminders)
 */
exports.processReminders = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();

    const snap = await db
      .collection("reminders")
      .where("sentAt", "==", null)
      .where("sendAtMs", "<=", now)
      .limit(50)
      .get();

    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      const r = docSnap.data();

      const uidsRaw = Array.isArray(r.recipientUids) ? r.recipientUids : [];
      const uids = uidsRaw.map((m) => (typeof m === "string" ? m : m?.uid)).filter(Boolean);
      const recipients = await getEmailsForUids(uids);

      // --- Draft reminder ---
      if (r.type === "draft_10min") {
        const whenStr = formatWhen(r.startAtMs);

        const subject = "FIFA Fantasy — Draft starts in 10 minutes";
        const html = `
          <div style="font-family:Arial,sans-serif;">
            <h2>Draft Reminder</h2>
            <p>The draft begins in <b>10 minutes</b>.</p>
            <p><b>Start time:</b> ${whenStr}</p>
            <p>Room: <b>${r.roomId}</b></p>
          </div>
        `;
        const text = `Draft Reminder\nThe draft begins in 10 minutes.\nStart time: ${whenStr}\nRoom: ${r.roomId}`;

        await queueEmails(recipients, subject, html, text, {
          type: "draft_10min_reminder",
          roomId: r.roomId,
          startAtMs: r.startAtMs,
        });

        await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      // --- NEW: Market reminder ---
      if (r.type === "market_10min") {
        const openStr = formatWhen(r.scheduledAtMs);
        const durStr = formatDuration(Number(r.durationMs || 0));

        const subject = "FIFA Fantasy — Market opens in 10 minutes";
        const html = `
          <div style="font-family:Arial,sans-serif;">
            <h2>Market Reminder</h2>
            <p>The market opens in <b>10 minutes</b>.</p>
            <p><b>Opens at:</b> ${openStr}</p>
            <p><b>Duration:</b> ${durStr}</p>
            <p>Room: <b>${r.roomId}</b></p>
          </div>
        `;
        const text = `Market Reminder\nThe market opens in 10 minutes.\nOpens at: ${openStr}\nDuration: ${durStr}\nRoom: ${r.roomId}`;

        await queueEmails(recipients, subject, html, text, {
          type: "market_10min_reminder",
          roomId: r.roomId,
          scheduledAtMs: r.scheduledAtMs,
          durationMs: r.durationMs,
        });

        await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      // Unknown reminder type: mark as sent so it doesn't loop forever
      await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
);

/**
 * Market scheduler (auto open/close)
 */
exports.processMarketSchedule = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();
    const roomsSnap = await db.collection("rooms").get();

    for (const roomDoc of roomsSnap.docs) {
      const roomId = roomDoc.id;
      const marketRef = db.doc(`rooms/${roomId}/market/current`);
      const marketSnap = await marketRef.get();
      if (!marketSnap.exists) continue;

      const m = marketSnap.data() || {};
      const scheduledAt = Number(m.scheduledAt);
      const durationMs = Number(m.durationMs || 0);

      if (m.status === "scheduled" && Number.isFinite(scheduledAt) && scheduledAt <= now) {
        const closesAt = durationMs ? now + durationMs : null;

        await marketRef.set(
          {
            status: "open",
            openedAt: now,
            closesAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      if (m.status === "open" && Number.isFinite(m.closesAt) && m.closesAt <= now) {
        await marketRef.set(
          {
            status: "closed",
            resolvedAt: now,
            scheduledAt: null, // prevent reopening
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }
    }
  }
);

exports.getLiveFixturesCached = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const league = Number(request.data?.league);
    const season = Number(request.data?.season);
    if (!Number.isFinite(league) || !Number.isFinite(season)) {
      throw new HttpsError("invalid-argument", "league and season are required.");
    }

    // Cache doc per competition
    const cacheId = `${league}_${season}`;
    const cacheRef = db.doc(`apiCache/liveFixtures_${cacheId}`);
    const cacheSnap = await cacheRef.get();

    const now = Date.now();
    const TTL_MS = 30 * 1000; // 30s cache during live windows

    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      if (c?.updatedAtMs && now - c.updatedAtMs < TTL_MS) {
        return { ok: true, cached: true, data: c.data };
      }
    }

    const apiKey = APIFOOTBALL_KEY.value();
    // API-Football exposes livescore/live fixtures endpoints in docs/plans
    const data = await apiFootballGet("fixtures", { live: "all", league, season }, apiKey);

    await cacheRef.set(
      { updatedAtMs: now, data },
      { merge: true }
    );

    return { ok: true, cached: false, data };
  }
);
