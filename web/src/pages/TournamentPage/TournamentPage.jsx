// src/pages/TournamentPage/TournamentPage.jsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";

import { useTournament } from "../../tournament/hooks/useTournament";
import { auth, db } from "../../firebase";

import "./TournamentPage.css";
import { Avatar, AvatarImage, AvatarFallback } from "../../components/ui/avatar";
import { httpsCallable } from "firebase/functions"; 
import { functions } from "../../firebase";

function fmtDT(v) {
  if (!v) return "—";

  // Firestore Timestamp support
  if (typeof v === "object") {
    if (typeof v.toMillis === "function") return new Date(v.toMillis()).toLocaleString();
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toLocaleString();
  }

  // Milliseconds support
  const ms = Number(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}

function initials(s) {
  const t = String(s || "").trim();
  if (!t) return "U";
  const parts = t.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase()).join("") || "U";
}

function UserChip({ user }) {
  const displayName = user?.displayName || user?.name || user?.userId || "Unknown";
  const teamName = user?.teamName || "";
  const photoURL = user?.photoURL || "";

  return (
    <div className="tpUserChip">
      <Avatar className="tpAvatar">
        <AvatarImage src={photoURL || undefined} alt={displayName} />
        <AvatarFallback>{initials(displayName)}</AvatarFallback>
      </Avatar>

      <div className="tpUserText">
        <div className="tpUserName">{displayName}</div>
        {teamName ? <div className="tpUserTeam">{teamName}</div> : null}
      </div>
    </div>
  );
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
  const [bootingWeek, setBootingWeek] = useState(false);
  const [bootWeekErr, setBootWeekErr] = useState(null);
  const [bootAttempted, setBootAttempted] = useState(false);

  const createNextWeekFn = httpsCallable(functions, "createNextWeek");


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

    useEffect(() => {
    if (!roomId) return;
    if (loading) return;
    if (!isHost) return;

    // already have a week → nothing to do
    if (currentWeekIndex) return;

    // prevent retry loop
    if (bootAttempted) return;

    setBootAttempted(true);
    setBootingWeek(true);
    setBootWeekErr(null);

    createNextWeekFn({ roomId })
      .catch((e) => {
        setBootWeekErr(e);
      })
      .finally(() => setBootingWeek(false));
  }, [roomId, loading, isHost, currentWeekIndex, bootAttempted]);


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
  const userById = Object.fromEntries(users.map((u) => [u.userId, u]));


  // Prefer week results if present; fallback to old results (Option A)
  const activeResults = weekResults || null;

  if (!activeResults) {
    const baseRows = (data?.users || []).map((u) => ({
      userId: u.userId,
      name: u.name,
      wins: 0,
      draws: 0,
      losses: 0,
      tablePoints: 0,
      totalFantasyPoints: 0,
    }));

    return (
      <div className="tpWrap">
        <div className="tpHeaderRow">
          <div>
            <h2 className="tpTitle">Tournament</h2>
            <p className="tpText">
              Room: <b>{roomId}</b> • Your Total: <b>0</b>
            </p>
            {!currentWeekIndex ? (
              <p className="tpText">
                {bootingWeek
                  ? "Setting up Week 1…"
                  : "Week hasn’t started yet — waiting for Week 1 to be created/computed."}
              </p>
            ) : null}

            {bootWeekErr ? (
              <p className="tpText" style={{ color: "crimson" }}>
                Couldn’t create Week 1: {String(bootWeekErr.message || bootWeekErr)}
              </p>
            ) : null}

            {bootWeekErr && isHost ? (
              <button
                type="button"
                className="tpBtn"
                onClick={() => {
                  setBootAttempted(false);
                  setBootWeekErr(null);
                }}
              >
                Retry Week Setup
              </button>
            ) : null}
          </div>
        </div>

        <div className="tpCard tpFull">
          <h3 className="tpCardTitle">Leaderboard</h3>
          <div className="tpBoard">
            <div className="tpBoardHead">
              <span>#</span><span>Name</span><span>W/D/L</span><span>Match Pts</span><span>Total Fantasy</span>
            </div>
            {baseRows.map((row, idx) => (
              <div key={row.userId} className="tpBoardRow">
                <span>{idx + 1}</span>
                <span className="tpBoardName">
                  <UserChip
                    user={
                      userById[row.userId] || {
                        userId: row.userId,
                        name: row.name,       // already includes "Display — Team" in your baseRows
                        photoURL: "",         // fallback will show initials if empty
                      }
                    }
                  />
                </span>

                <span>0/0/0</span>
                <span>0</span>
                <span>0</span>
              </div>
            ))}
          </div>
        </div>
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

  const boardRows = activeResults.weekLeaderboard || activeResults.leaderboard || [];
  const standingsRows = standingsDoc?.standings || [];

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
      <span>Total Fantasy</span>
    </div>

    {(standingsRows.length ? standingsRows : boardRows).map((row, idx) => {
      const isStand = !!row?.tablePoints || row?.wins !== undefined;
      const name = row.name || nameById[row.userId] || row.userId;
      const wdl = isStand ? `${row.wins ?? 0}/${row.draws ?? 0}/${row.losses ?? 0}` : (row.result || "—");
      const matchPts = isStand ? (row.tablePoints ?? 0) : (row.matchPoints ?? 0);
      const totalFantasy = isStand ? (row.totalFantasyPoints ?? 0) : (row.fantasyPoints ?? 0);

      return (
        <div key={row.userId || idx} className="tpBoardRow">
          <span>{idx + 1}</span>
          <span><UserChip user={userById[row.userId] || { userId: row.userId, name }} /></span>
          <span>{wdl}</span>
          <span>{matchPts}</span>
          <span>{totalFantasy}</span>
        </div>
      );
    })}
  </div>

  {String(weekResults?.status || "").toUpperCase() === "LIVE" ? (
    <div className="tpText" style={{ marginTop: 10, opacity: 0.75 }}>
      Live updating… (last update: {fmtDT(weekResults.computedAt)})
    </div>
  ) : null}
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
            <UserChip user={userById[myMatchup.homeUserId] || { userId: myMatchup.homeUserId, name: myMatchup.homeUserId }} />
          </span>
          <span>{myMatchup.homeTotal}</span>
        </div>
        <div className="tpMatchRow">
          <span>
            <UserChip user={userById[myMatchup.awayUserId] || { userId: myMatchup.awayUserId, name: myMatchup.awayUserId }} />
          </span>
          <span>{myMatchup.awayTotal}</span>
        </div>
        <div className="tpMatchFooter">
          Result:{" "}
          <b>{myMatchup.homeUserId === me?.userId ? myMatchup.homeResult : myMatchup.awayResult}</b>
        </div>
      </div>

      <div className="tpLineups">
        <div className="tpSide tpSideMe">
          <div className="tpLineupHead">
            <span className="tpLineupName">
              <UserChip user={userById[me?.userId] || { userId: me?.userId, name: me?.userId }} />
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

        <div className="tpSide">
          <div className="tpLineupHead">
            <span className="tpLineupName">
              <UserChip user={userById[opponentUid] || { userId: opponentUid, name: opponentUid }} />
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
      {otherMatchups.map((m) => {
        const homeUser = userById[m.homeUserId] || {
          userId: m.homeUserId,
          displayName: nameById[m.homeUserId] || m.homeUserId,
          teamName: "",
          photoURL: "",
        };

        const awayUser = userById[m.awayUserId] || {
          userId: m.awayUserId,
          displayName: nameById[m.awayUserId] || m.awayUserId,
          teamName: "",
          photoURL: "",
        };

        return (
          <div key={`${m.homeUserId}-${m.awayUserId}`} className="tpMatchRow">
            <div className="tpMatchTeams">
              <UserChip user={homeUser} />
              <span className="tpVs">vs</span>
              <UserChip user={awayUser} />
            </div>

            <span className="tpMatchScore">
              {m.homeTotal} — {m.awayTotal}
            </span>
          </div>
        );
      })}
    </div>
  )}
</div>

  </div>
    </div>
  );
}
