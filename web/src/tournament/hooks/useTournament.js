// src/tournament/hooks/useTournament.js
import { useEffect, useMemo, useState } from "react";
import { getStatsProvider } from "../services/statsProvider";
import { computeRoundResults } from "../logic/roundEngine";

/**
 * Base starter template (positions are what scoring expects: GK/DEF/MID/FWD)
 * IDs here are just "base" IDs — we’ll suffix them per user so each user’s stats are unique.
 */
const BASE_STARTERS = [
  { id: "p1", name: "GK One", position: "GK" },
  { id: "p2", name: "DEF A", position: "DEF" },
  { id: "p3", name: "DEF B", position: "DEF" },
  { id: "p4", name: "DEF C", position: "DEF" },
  { id: "p5", name: "DEF D", position: "DEF" },
  { id: "p6", name: "MID A", position: "MID" },
  { id: "p7", name: "MID B", position: "MID" },
  { id: "p8", name: "MID C", position: "MID" },
  { id: "p9", name: "FWD A", position: "FWD" },
  { id: "p10", name: "FWD B", position: "FWD" },
  { id: "p11", name: "FWD C", position: "FWD" },
];

function withSuffix(players, suffix) {
  return players.map((p) => ({
    ...p,
    id: `${p.id}_${suffix}`,
  }));
}

/**
 * Step-3 demo users. Replace later with real Firestore room members + rosters.
 */
function buildDemoUsers() {
  return [
    { userId: "u1", name: "Mando", starters: withSuffix(BASE_STARTERS, "u1") },
    { userId: "u2", name: "Nick", starters: withSuffix(BASE_STARTERS, "u2") },
    { userId: "u3", name: "Ana", starters: withSuffix(BASE_STARTERS, "u3") },
    { userId: "u4", name: "Jose", starters: withSuffix(BASE_STARTERS, "u4") },
  ];
}

export function useTournament(roomId) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // What TournamentPage will consume
  const [data, setData] = useState(null);

  // For now, round is fixed (later: comes from room state)
  const roundId = 1;

  const users = useMemo(() => buildDemoUsers(), []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const provider = getStatsProvider();

        // Fetch stats per user (keeps it simple and clear)
        const statsByPlayerIdByUserId = {};

        for (const u of users) {
          const statsByPlayerId = await provider.getRoundStats({
            roomId,
            roundId,
            players: u.starters,
          });

          statsByPlayerIdByUserId[u.userId] = statsByPlayerId;
        }

        const results = computeRoundResults({
          roomId,
          roundId,
          users,
          statsByPlayerIdByUserId,
        });

        if (!cancelled) {
          setData({
            roomId,
            roundId,
            users,
            statsByPlayerIdByUserId,
            results,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (roomId) run();
    else {
      // still let TournamentPage show the "join/create room" UI when no roomId
      setLoading(false);
      setData(null);
    }

    return () => {
      cancelled = true;
    };
  }, [roomId, roundId, users]);

  return { loading, error, data };
}

