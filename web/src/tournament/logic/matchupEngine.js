// src/tournament/logic/matchupEngine.js

export function resolveMatchup({ roundId, homeUser, awayUser, homeTotal, awayTotal }) {
  let homeResult = "L";
  let awayResult = "W";
  let winnerUserId = awayUser.userId;

  if (homeTotal > awayTotal) {
    homeResult = "W";
    awayResult = "L";
    winnerUserId = homeUser.userId;
  } else if (homeTotal === awayTotal) {
    homeResult = "D";
    awayResult = "D";
    winnerUserId = null;
  }

  return {
    roundId,
    homeUserId: homeUser.userId,
    awayUserId: awayUser.userId,
    homeTotal,
    awayTotal,
    homeResult,
    awayResult,
    winnerUserId,
    status: "FINAL", // later can be LIVE
  };
}
