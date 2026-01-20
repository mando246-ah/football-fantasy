// src/tournament/logic/scoring.js
import { SCORING_V1 } from "./scoringConfig";

/**
 * Normalize missing stats safely.
 * stats can be null/undefined; this returns a stable object.
 */
export function normalizeStats(stats) {
  return {
    minutes: Number(stats?.minutes ?? 0),
    goals: Number(stats?.goals ?? 0),
    assists: Number(stats?.assists ?? 0),
    cleanSheet: Boolean(stats?.cleanSheet ?? false),
    goalsConceded: Number(stats?.goalsConceded ?? 0),
    saves: Number(stats?.saves ?? 0),
    pensSaved: Number(stats?.pensSaved ?? 0),
    pensMissed: Number(stats?.pensMissed ?? 0),
    yellow: Number(stats?.yellow ?? 0),
    red: Number(stats?.red ?? 0),
    ownGoals: Number(stats?.ownGoals ?? 0),
    bonus: Number(stats?.bonus ?? 0),
    passesCompleted: Number(stats?.passesCompleted ?? 0),
  };
}

/**
 * Score a single player given raw stats + position.
 * position should be one of: "GK" | "DEF" | "MID" | "FWD"
 */
export function scorePlayer(rawStats, position, config = SCORING_V1) {
  const s = normalizeStats(rawStats);
  const pos = position || "MID";
  
  // Rule: non-playing = 0 (your chosen tournament rule)
  if (s.minutes <= 0) {
    return { points: 0, breakdown: { reason: "DNP" } };
  }

  const breakdown = {};
  let points = 0;

    // Passes completed (position-based: 1 point per X passes)
    const pc = config.passesCompleted;

    if (pc?.enabled) {
    const passes = s.passesCompleted;
    const per = pc.perByPos?.[pos] ?? 999999; // avoid divide by 0
    const chunks = Math.floor(passes / per);
    const v = chunks * (pc.pointsPerChunk ?? 1);

    if (v !== 0) {
        points += v;
        breakdown.passesCompleted = v;
    }
    }

  // Appearance points
  if (s.minutes > 0) {
    points += config.appearance.anyMinutes;
    breakdown.appearance = config.appearance.anyMinutes;
  }
  if (s.minutes >= 60) {
    points += config.appearance.sixtyPlus;
    breakdown.sixtyPlus = config.appearance.sixtyPlus;
  }

  // Goals
  if (s.goals) {
    const perGoal = config.goals[pos] ?? 0;
    const v = s.goals * perGoal;
    points += v;
    breakdown.goals = v;
  }

  // Assists
  if (s.assists) {
    const v = s.assists * config.assists;
    points += v;
    breakdown.assists = v;
  }

  // Clean sheet (>= min minutes)
  if (s.cleanSheet && s.minutes >= config.cleanSheet.minMinutes) {
    const v = config.cleanSheet[pos] ?? 0;
    points += v;
    breakdown.cleanSheet = v;
  }

  // Goals conceded penalty (GK/DEF only)
  const gcPenaltyPer = config.goalsConceded.per;
  const gcPenalty = config.goalsConceded[pos];
  if (gcPenalty && s.goalsConceded > 0) {
    const chunks = Math.floor(s.goalsConceded / gcPenaltyPer);
    const v = chunks * gcPenalty;
    points += v;
    breakdown.goalsConceded = v;
  }

  // Saves (GK only)
  const savesPer = config.saves.per;
  const savesPoint = config.saves[pos];
  if (savesPoint && s.saves > 0) {
    const chunks = Math.floor(s.saves / savesPer);
    const v = chunks * savesPoint;
    points += v;
    breakdown.saves = v;
  }

  // Pens
  if (s.pensSaved) {
    const v = s.pensSaved * config.pens.saved;
    points += v;
    breakdown.pensSaved = v;
  }
  if (s.pensMissed) {
    const v = s.pensMissed * config.pens.missed;
    points += v;
    breakdown.pensMissed = v;
  }

  // Cards
  if (s.yellow) {
    const v = s.yellow * config.cards.yellow;
    points += v;
    breakdown.yellow = v;
  }
  if (s.red) {
    const v = s.red * config.cards.red;
    points += v;
    breakdown.red = v;
  }

  // Own goals
  if (s.ownGoals) {
    const v = s.ownGoals * config.ownGoal;
    points += v;
    breakdown.ownGoals = v;
  }

  // Bonus
  if (s.bonus) {
    const v = s.bonus * config.bonus.perPoint;
    points += v;
    breakdown.bonus = v;
  }

  return { points, breakdown };
}

/**
 * Score a team’s starters only.
 * starters can be:
 *  - array of player objects: { id, position }
 *  - OR array of ids, if you also provide a playerById map (optional)
 */
export function scoreTeam({ starters, statsByPlayerId, playerById }, config = SCORING_V1) {
  let total = 0;
  const perPlayer = {};

  for (const item of starters || []) {
    const player = typeof item === "string" ? playerById?.[item] : item;
    if (!player?.id) continue;

    const stats = statsByPlayerId?.[player.id];
    const { points, breakdown } = scorePlayer(stats, player.position, config);

    perPlayer[player.id] = { points, breakdown, name: player.name, position: player.position };
    total += points;
  }

  return { total, perPlayer };
}
