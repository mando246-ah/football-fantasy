// src/tournament/hooks/useTournament.js
/*import { useEffect, useMemo, useState } from "react";
import { onTournamentSnapshot, onRoundSnapshot, onMarketSnapshot, onUserSquadSnapshot, onUserLineupSnapshot, saveUserLineup, submitTransfer } from "../services/tournamentApi";
import { auth } from "../../firebase";

export function useTournament(roomId) {
  const uid = auth.currentUser?.uid;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [tournament, setTournament] = useState(null);
  const [round, setRound] = useState(null);
  const [market, setMarket] = useState(null);
  const [userSquad, setUserSquad] = useState(null);
  const [userLineup, setUserLineup] = useState(null);

  useEffect(() => {
    if (!roomId || !uid) return;

    setLoading(true);
    setError(null);

    const unsubs = [];

    unsubs.push(onTournamentSnapshot(roomId, setTournament, setError));
    unsubs.push(onRoundSnapshot(roomId, setRound, setError));
    unsubs.push(onMarketSnapshot(roomId, setMarket, setError));
    unsubs.push(onUserSquadSnapshot(roomId, uid, setUserSquad, setError));
    unsubs.push(onUserLineupSnapshot(roomId, uid, setUserLineup, setError));

    setLoading(false);

    return () => unsubs.forEach((fn) => fn && fn());
  }, [roomId, uid]);

  const actions = useMemo(() => {
    return {
      saveLineup: async (nextLineup) => saveUserLineup(roomId, uid, nextLineup),
      submitTransfer: async (payload) => submitTransfer(roomId, uid, payload),
    };
  }, [roomId, uid]);

  return { loading, error, tournament, round, market, userSquad, userLineup, actions };
}*/

// src/tournament/hooks/useTournament.js
import { useEffect, useMemo, useState } from "react";
import { getStatsProvider } from "../services/statsProvider";
import { scoreTeam } from "../logic/scoring";

// Demo roster for now (replace later with Firestore room roster)
const DEMO_STARTERS = [
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

export function useTournament(roomId) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const roundId = 1; // for now; later comes from room/round state

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const provider = getStatsProvider();

        const statsByPlayerId = await provider.getRoundStats({
          roomId,
          roundId,
          players: DEMO_STARTERS,
        });

        const scored = scoreTeam({
          starters: DEMO_STARTERS,
          statsByPlayerId,
        });

        if (!cancelled) {
          setData({
            roomId,
            roundId,
            starters: DEMO_STARTERS,
            statsByPlayerId,
            scored,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return { loading, error, data };
}
