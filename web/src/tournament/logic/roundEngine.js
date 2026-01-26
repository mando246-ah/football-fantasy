// src/tournament/logic/roundEngine.js
import { scoreTeam } from "./scoring";
import { resolveMatchup } from "./matchupEngine";

// simple points table
function resultToTablePoints(result) {
  if (result === "W") return 3;
  if (result === "D") return 1;
  return 0;
}

export function computeRoundResults({ roomId, roundId, users, statsByPlayerIdByUserId }) {
  // 1) score each user
  const teamScoresByUserId = {};
  const breakdownByUserId = {};

  for (const u of users) {
    const statsByPlayerId = statsByPlayerIdByUserId[u.userId] || {};
    const scored = scoreTeam({ starters: u.starters, statsByPlayerId });
    teamScoresByUserId[u.userId] = scored.total;
    breakdownByUserId[u.userId] = scored;
  }

  // 2) build matchups (for now: pair users in order)
  const matchups = [];
  for (let i = 0; i < users.length; i += 2) {
    const homeUser = users[i];
    const awayUser = users[i + 1];
    if (!awayUser) break;

    const homeTotal = teamScoresByUserId[homeUser.userId] ?? 0;
    const awayTotal = teamScoresByUserId[awayUser.userId] ?? 0;

    matchups.push(resolveMatchup({ roundId, homeUser, awayUser, homeTotal, awayTotal }));
  }

  // 3) leaderboard
  const leaderboard = users.map((u) => {
    // find this user’s matchup result
    const m =
      matchups.find((x) => x.homeUserId === u.userId || x.awayUserId === u.userId) || null;

    const result = !m
      ? null
      : m.homeUserId === u.userId
      ? m.homeResult
      : m.awayResult;

    const matchPoints = result ? resultToTablePoints(result) : 0;
    const fantasyPoints = teamScoresByUserId[u.userId] ?? 0;

    return {
      userId: u.userId,
      name: u.name,
      matchPoints,
      fantasyPoints,
      result: result || "-",
    };
  });

  // sort: matchPoints desc, then fantasyPoints desc
  leaderboard.sort((a, b) => {
    if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
    return b.fantasyPoints - a.fantasyPoints;
  });

  return {
    roomId,
    roundId,
    teamScoresByUserId,
    breakdownByUserId,
    matchups,
    leaderboard,
  };
}
