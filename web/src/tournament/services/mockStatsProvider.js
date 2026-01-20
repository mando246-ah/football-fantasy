// src/tournament/services/mockStatsProvider.js

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

function pickByPos(pos, rng) {
  // Typical pass ranges by position
  if (pos === "GK") return randInt(rng, 10, 45);
  if (pos === "DEF") return randInt(rng, 25, 95);
  if (pos === "MID") return randInt(rng, 35, 120);
  return randInt(rng, 10, 70); // FWD
}

function goalChance(pos) {
  if (pos === "GK") return 0.002;
  if (pos === "DEF") return 0.03;
  if (pos === "MID") return 0.07;
  return 0.12; // FWD
}

function assistChance(pos) {
  if (pos === "GK") return 0.005;
  if (pos === "DEF") return 0.04;
  if (pos === "MID") return 0.10;
  return 0.08;
}

export const mockStatsProvider = {
  async getRoundStats({ roundId, players }) {
    const seed = hashToUint32(`round:${roundId}`);
    const rng = mulberry32(seed);

    const statsByPlayerId = {};

    for (const p of players || []) {
      const prng = mulberry32(hashToUint32(`${roundId}:${p.id}`));

      // minutes (some DNP)
      const dnpRoll = prng();
      const minutes =
        dnpRoll < 0.06 ? 0 : dnpRoll < 0.12 ? randInt(prng, 1, 30) : randInt(prng, 60, 90);

      const passesCompleted = minutes === 0 ? 0 : pickByPos(p.position, prng);

      // events
      const goals = minutes === 0 ? 0 : (prng() < goalChance(p.position) ? 1 : 0);
      const assists = minutes === 0 ? 0 : (prng() < assistChance(p.position) ? 1 : 0);

      // cards small chance
      const yellow = minutes === 0 ? 0 : (prng() < 0.06 ? 1 : 0);
      const red = minutes === 0 ? 0 : (prng() < 0.01 ? 1 : 0);

      // GK-ish stats (simple)
      const saves = p.position === "GK" && minutes > 0 ? randInt(prng, 0, 8) : 0;

      // clean sheet chance: higher for GK/DEF
      const csChance = p.position === "GK" ? 0.35 : p.position === "DEF" ? 0.28 : p.position === "MID" ? 0.12 : 0.05;
      const cleanSheet = minutes >= 60 ? prng() < csChance : false;

      const goalsConceded =
        (p.position === "GK" || p.position === "DEF") && minutes > 0
          ? (cleanSheet ? 0 : randInt(prng, 1, 4))
          : 0;

      statsByPlayerId[p.id] = {
        minutes,
        passesCompleted,
        goals,
        assists,
        cleanSheet,
        goalsConceded,
        saves,
        yellow,
        red,
      };
    }

    // mimic async
    await new Promise((r) => setTimeout(r, 150));
    return statsByPlayerId;
  },
};
