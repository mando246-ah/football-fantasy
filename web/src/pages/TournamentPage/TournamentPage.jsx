// src/pages/TournamentPage/TournamentPage.jsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { doc, onSnapshot } from "firebase/firestore";

import { useTournament } from "../../tournament/hooks/useTournament";
import { functions, auth, db } from "../../firebase";

import "./TournamentPage.css";

function fmtDT(ms) {
  if (!Number.isFinite(Number(ms))) return "—";
  return new Date(Number(ms)).toLocaleString();
}

export default function TournamentPage() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId);

  const myUid = auth.currentUser?.uid;
  const isHost = data?.room?.hostUid === myUid;

  // Firestore live docs for the new "Weeks" system
  const [currentWeekIndex, setCurrentWeekIndex] = useState(null);
  const [weekDoc, setWeekDoc] = useState(null);
  const [weekResults, setWeekResults] = useState(null);
  const [standingsDoc, setStandingsDoc] = useState(null);

  // Always run hooks (no conditional hooks)
  useEffect(() => {
    if (!roomId) {
      setCurrentWeekIndex(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "rooms", roomId),
      (snap) => {
        const r = snap.exists() ? snap.data() : null;
        const idx = Number(r?.currentWeekIndex);
        setCurrentWeekIndex(Number.isFinite(idx) ? idx : null);
      },
      () => setCurrentWeekIndex(null)
    );
    return unsub;
  }, [roomId]);

  useEffect(() => {
    if (!roomId || currentWeekIndex == null) {
      setWeekDoc(null);
      setWeekResults(null);
      setStandingsDoc(null);
      return;
    }

    const u1 = onSnapshot(
      doc(db, "rooms", roomId, "weeks", String(currentWeekIndex)),
      (s) => setWeekDoc(s.exists() ? s.data() : null),
      () => setWeekDoc(null)
    );

    const u2 = onSnapshot(
      doc(db, "rooms", roomId, "weekResults", String(currentWeekIndex)),
      (s) => setWeekResults(s.exists() ? s.data() : null),
      () => setWeekResults(null)
    );

    const u3 = onSnapshot(
      doc(db, "rooms", roomId, "standings", "current"),
      (s) => setStandingsDoc(s.exists() ? s.data() : null),
      () => setStandingsDoc(null)
    );

    return () => {
      u1();
      u2();
      u3();
    };
  }, [roomId, currentWeekIndex]);

  // Actions
  async function onSeedBots() {
    const fn = httpsCallable(functions, "seedDemoOpponents");
    await fn({ roomId, count: 3 });
    window.location.reload(); // fine for testing
  }

  async function onCreateWeek() {
    const fn = httpsCallable(functions, "createNextWeek");
    await fn({ roomId });
  }

  async function onComputeWeek() {
    const idx = currentWeekIndex;
    if (idx == null) {
      alert("No current week yet. Click 'Create Next Week' first.");
      return;
    }
    const fn = httpsCallable(functions, "computeWeekResults");
    await fn({ roomId, weekIndex: idx });
  }

  // ---------- UI guards (after hooks) ----------
  if (!roomId) {
    return (
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">Join or create a room to get started.</p>
        <div className="tpLinks">
          <Link to="/draft">Create / Join Room</Link>
          <Link to="/">Go Home</Link>
        </div>
      </div>
    );
  }

  if (loading) return <div className="tpWrap">Loading tournament…</div>;

  if (error) {
    return (
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">Something went wrong: {String(error.message || error)}</p>
      </div>
    );
  }

  const users = data?.users || [];

  // Prefer week results if present; fallback to old results (Option A)
  const activeResults = weekResults || data?.results || null;

  if (!activeResults) {
    return (
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">No results yet.</p>

        {isHost && (
          <div className="tpLinks">
            <button type="button" className="tpBtn" onClick={onSeedBots}>
              Seed Bots
            </button>
            <button type="button" className="tpBtn" onClick={onCreateWeek}>
              Create Next Week
            </button>
            <button type="button" className="tpBtn" onClick={onComputeWeek}>
              Compute Week
            </button>
          </div>
        )}
      </div>
    );
  }

  const me = users.find((u) => u.userId === myUid) || users[0];
  const myTotal = activeResults.teamScoresByUserId?.[me?.userId] ?? 0;

  // No useMemo (avoids hook-order problems)
  const nameById = Object.fromEntries(users.map((u) => [u.userId, u.name]));

  const myMatchup =
    activeResults.matchups?.find(
      (m) => m.homeUserId === me?.userId || m.awayUserId === me?.userId
    ) || null;

  const myBreakdown = activeResults.breakdownByUserId?.[me?.userId];

  const opponentUid = myMatchup
    ? myMatchup.homeUserId === me?.userId
      ? myMatchup.awayUserId
      : myMatchup.homeUserId
    : null;

  const opponent = opponentUid ? users.find((u) => u.userId === opponentUid) : null;
  const oppTotal = opponentUid ? activeResults.teamScoresByUserId?.[opponentUid] ?? 0 : 0;
  const oppBreakdown = opponentUid ? activeResults.breakdownByUserId?.[opponentUid] : null;

  const otherMatchups =
    activeResults.matchups?.filter(
      (m) => m.homeUserId !== me?.userId && m.awayUserId !== me?.userId
    ) || [];

  const standingsRows = standingsDoc?.standings || [];

  // Use cumulative standings for the TOP leaderboard.
  // Fallback to week leaderboard if standings aren’t generated yet.
  const boardRows = standingsRows.length
    ? standingsRows.map((r) => ({
        userId: r.userId,
        name: r.name || nameById[r.userId] || r.userId,
        result: `${r.wins ?? 0}/${r.draws ?? 0}/${r.losses ?? 0}`, // W/D/L counts
        matchPoints: r.tablePoints ?? 0,                          // season table pts
        fantasyPoints: r.totalFantasyPoints ?? 0,                // ✅ cumulative fantasy pts
      }))
    : (activeResults.weekLeaderboard || activeResults.leaderboard || []);


  return (
    <div className="tpWrap">
      <div className="tpHeaderRow">
        <div>
          <h2 className="tpTitle">Tournament</h2>
          <p className="tpText">
            Room: <b>{roomId}</b>
            {currentWeekIndex != null ? (
              <>
                {" "}
                • Week: <b>{currentWeekIndex}</b>
              </>
            ) : null}
            {" "}
            • Your Total: <b>{myTotal}</b>
          </p>

          {weekDoc && (
            <p className="tpText">
              Window: <b>{fmtDT(weekDoc.startAtMs)}</b> → <b>{fmtDT(weekDoc.endAtMs)}</b>
              {weekDoc.roundLabel ? (
                <>
                  {" "}
                  • Round: <b>{weekDoc.roundLabel}</b>
                </>
              ) : null}
            </p>
          )}
        </div>

        {isHost && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="tpBtn" onClick={onSeedBots}>
              Seed Bots
            </button>
            <button type="button" className="tpBtn" onClick={onCreateWeek}>
              Create Next Week
            </button>
            <button type="button" className="tpBtn" onClick={onComputeWeek}>
              Compute Week
            </button>
          </div>
        )}
      </div>

      <div className="tpGrid">
<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Leaderboard</h3>
  <div className="tpBoard">
    <div className="tpBoardHead">
      <span>#</span>
      <span>Name</span>
      <span>W/D/L</span>
      <span>Match Pts</span>
      <span>Fantasy Pts</span>
    </div>

    {boardRows.map((row, idx) => (
      <div key={row.userId} className="tpBoardRow">
        <span>{idx + 1}</span>
        <span>{row.name}</span>
        <span>{row.result}</span>
        <span>{row.matchPoints}</span>
        <span>{row.fantasyPoints}</span>
      </div>
    ))}
  </div>
</div>

<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Your Matchup</h3>
  {!myMatchup ? (
    <p className="tpText">No matchup yet.</p>
  ) : (
    <>
      <div className="tpMatchup">
        <div className="tpMatchRow">
          <span>
            <b>{nameById[myMatchup.homeUserId] || myMatchup.homeUserId}</b>
          </span>
          <span>{myMatchup.homeTotal}</span>
        </div>
        <div className="tpMatchRow">
          <span>
            <b>{nameById[myMatchup.awayUserId] || myMatchup.awayUserId}</b>
          </span>
          <span>{myMatchup.awayTotal}</span>
        </div>
        <div className="tpMatchFooter">
          Result:{" "}
          <b>{myMatchup.homeUserId === me?.userId ? myMatchup.homeResult : myMatchup.awayResult}</b>
        </div>
      </div>

      <div className="tpLineups">
        <div>
          <div className="tpLineupHead">
            <span className="tpLineupName">
              <b>{nameById[me?.userId] || me?.userId}</b>
            </span>
            <span className="tpLineupTotal">{myTotal} pts</span>
          </div>

          <ul className="tpList">
            {(me?.starters || []).map((p) => {
              const entry = myBreakdown?.perPlayer?.[p.id];
              const pts = typeof entry === "number" ? entry : entry?.points ?? 0;
              return (
                <li key={p.id} className="tpRow">
                  <span className="tpName">{p.name}</span>
                  <span className="tpMeta">{p.position}</span>
                  <span className="tpPts">{pts} pts</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <div className="tpLineupHead">
            <span className="tpLineupName">
              <b>{nameById[opponentUid] || opponentUid || "—"}</b>
            </span>
            <span className="tpLineupTotal">{oppTotal} pts</span>
          </div>

          <ul className="tpList">
            {(opponent?.starters || []).map((p) => {
              const entry = oppBreakdown?.perPlayer?.[p.id];
              const pts = typeof entry === "number" ? entry : entry?.points ?? 0;
              return (
                <li key={p.id} className="tpRow">
                  <span className="tpName">{p.name}</span>
                  <span className="tpMeta">{p.position}</span>
                  <span className="tpPts">{pts} pts</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  )}
</div>

<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Other Matchups</h3>
  {!otherMatchups.length ? (
    <p className="tpText">No other matchups.</p>
  ) : (
    <div className="tpMatchup">
      {otherMatchups.map((m) => (
        <div key={`${m.homeUserId}-${m.awayUserId}`} className="tpMatchRow">
          <span>
            <b>{nameById[m.homeUserId] || m.homeUserId}</b> vs{" "}
            <b>{nameById[m.awayUserId] || m.awayUserId}</b>
          </span>
          <span>
            {m.homeTotal} — {m.awayTotal}
          </span>
        </div>
      ))}
    </div>
  )}
</div>

<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Season Standings</h3>
  {!standingsRows.length ? (
    <p className="tpText">No standings yet (compute a week to generate standings).</p>
  ) : (
    <div className="tpBoard">
      <div className="tpBoardHead tpStandingsHead">
        <span>#</span>
        <span>Name</span>
        <span>W</span>
        <span>D</span>
        <span>L</span>
        <span>Table Pts</span>
        <span>Total Fantasy</span>
      </div>

      {standingsRows.map((r, idx) => (
        <div key={r.userId || idx} className="tpBoardRow tpStandingsRow">
          <span>{idx + 1}</span>
          <span>{r.name || nameById[r.userId] || r.userId}</span>
          <span>{r.wins ?? 0}</span>
          <span>{r.draws ?? 0}</span>
          <span>{r.losses ?? 0}</span>
          <span>{r.tablePoints ?? 0}</span>
          <span>{r.totalFantasyPoints ?? 0}</span>
        </div>
      ))}
    </div>
  )}
</div>

<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Debug</h3>
  <pre className="tpPre">
    {JSON.stringify({ currentWeekIndex, weekDoc, weekResults, standingsDoc }, null, 2)}
  </pre>
</div>

      </div>
    </div>
  );
}