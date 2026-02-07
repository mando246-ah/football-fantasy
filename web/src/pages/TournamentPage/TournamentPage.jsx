// src/pages/TournamentPage/TournamentPage.jsx
import { useEffect, useState, useRef} from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";

import { useTournament } from "../../tournament/hooks/useTournament";
import { app, auth, db } from "../../firebase";

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

// --- PASTE THIS AT THE TOP OF THE FILE (Outside the component) ---
const SCORING_DISPLAY = [
  { label: "Playing Time", detail: "1 pt (Appearance) + 1 pt (60+ mins)" },
  { label: "Goals", detail: "GK/DEF: 6, MID: 5, FWD: 4" },
  { label: "Assists", detail: "3 pts" },
  { label: "Clean Sheet", detail: "GK/DEF: 4, MID: 1 (Min 60 mins)" },
  { label: "Saves (GK)", detail: "1 pt every 3 saves" },
  { label: "Goals Conceded", detail: "-1 pt every 2 goals (GK/DEF)" },
  { label: "Penalties", detail: "Saved: +5, Missed: -2" },
  { label: "Cards", detail: "Yellow: -1, Red: -3" },
  { label: "Passing (Total)", detail: "GK: 30, DEF/MID: 25, FWD: 20 passes = 1 pt" },
];


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
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [showScoring, setShowScoring] = useState(false);

  const togglePlayer = (pid) => {
    setExpandedPlayerId(expandedPlayerId === pid ? null : pid);
  };

  const createNextWeekFn = httpsCallable(functions, "createNextWeek");
  const scoringRef = useRef(null);

  useEffect(() => {
    if (!showScoring) return;

    const onMouseDown = (e) => {
      if (scoringRef.current && !scoringRef.current.contains(e.target)) {
        setShowScoring(false);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") setShowScoring(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showScoring]);
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
      <div className="tpPage">
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">Join or create a room to get started.</p>
        <div className="tpLinks">
          <Link to="/draft">Create / Join Room</Link>
          <Link to="/">Go Home</Link>
        </div>
      </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="tpPage">
        <div className="tpCenter">
        <div className="tpWrap tpCenter">
          <div className="loader" aria-label="Loading tournament">
            <div className="loader_cube loader_cube--color" />
            <div className="loader_cube loader_cube--glowing" />
          </div>
        </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tpPage">
        <div className="tpWrap">
          <h2 className="tpTitle">Tournament</h2>
          <p className="tpText">Something went wrong: {String(error.message || error)}</p>
        </div>
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

    // ... (Keep all the logic above this line: const me = ..., const myTotal = ...)

  // REPLACE THE FINAL RETURN WITH THIS:
  return (
    <div className="tpPage">
      <div className="tpWrap">
        
        {/* HEADER AREA */}
        <div className="tpHeaderRow">
          <div>
            {/* TITLE + POINTS BUTTON ROW */}
              <h2 className="tpTitle">Tournament</h2>

               <div className="tpHeaderActions" ref={scoringRef}>
                <button
                  type="button"
                  className="tpScoringBtn"
                  onClick={() => setShowScoring((v) => !v)}
                  aria-expanded={showScoring}
                  aria-haspopup="dialog"
                >
                  Scoring <span className={`tpCaret ${showScoring ? "open" : ""}`}>▾</span>
                </button>

                {showScoring && (
                  <div className="tpScoringPopover" role="dialog" aria-label="Scoring rules">
                    <div className="tpScoringTitle">Scoring</div>
                    <ul className="tpScoringList">
                      {SCORING_DISPLAY.map((r) => (
                        <li key={r.label} className="tpScoringItem">
                          <span className="tpScoringLabel">{r.label}</span>
                          <span className="tpScoringDetail">{r.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* ROOM INFO */}
            <p className="tpText">
              Room: <b>{roomId}</b>
              {currentWeekIndex != null ? (
                <> • Week: <b>{currentWeekIndex}</b></>
              ) : null}
              {" "}• Your Total: <b>{myTotal}</b>
            </p>

            {weekDoc && (
              <p className="tpText">
                Window: <b>{fmtDT(weekDoc.startAtMs)}</b> → <b>{fmtDT(weekDoc.endAtMs)}</b>
                {weekDoc.roundLabel ? (<> • Round: <b>{weekDoc.roundLabel}</b></>) : null}
              </p>
            )}
          </div>
        </div>

        <div className="tpGrid">
          
          {/* LEADERBOARD CARD */}
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
              <div className="tpText tpLiveHint" >
                Live updating… (last update: {fmtDT(weekResults.computedAt)})
              </div>
            ) : null}
          </div>

          {/* MATCHUP & LINEUPS CARD */}
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
                    Result: <b>{myMatchup.homeUserId === me?.userId ? myMatchup.homeResult : myMatchup.awayResult}</b>
                  </div>
                </div>

                <div className="tpLineups">
                  {/* MY TEAM */}
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
                        const breakdown = typeof entry === "object" ? entry?.breakdown : {};
                        const stats = typeof entry === "object" ? entry?.stats : {};
                        const realTeamName = typeof entry === "object" ? entry?.realTeamName : "";
                        const opponentName = typeof entry === "object" ? entry?.opponentName : "";
                        const isOpen = expandedPlayerId === p.id;
                        
                        return (
                          <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                            <div className="tpRow" onClick={() => togglePlayer(p.id)}>
                              <div className="tpPlayerInfo">
                                <span className="tpName">{p.name}</span>
                              </div>
                              <div className="tpMeta">{p.position}</div>
                              <div className="tpPts">{pts} pts</div>
                            </div>
                            {isOpen && (
                              <PlayerStatsCard 
                                stats={stats} 
                                breakdown={breakdown}
                                teamName={realTeamName}
                                opponentName={opponentName}
                              />
                            )}
                          </li>
                        );     
                      })}
                    </ul>
                  </div>

                  {/* OPPONENT TEAM */}
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
                        const breakdown = typeof entry === "object" ? entry?.breakdown : {};
                        const stats = typeof entry === "object" ? entry?.stats : {};
                        const realTeamName = typeof entry === "object" ? entry?.realTeamName : "";
                        const opponentName = typeof entry === "object" ? entry?.opponentName : "";
                        const isOpen = expandedPlayerId === p.id;

                        return (
                          <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                            <div className="tpRow" onClick={() => togglePlayer(p.id)}>
                              <div className="tpPlayerInfo">
                                <span className="tpName">{p.name}</span>
                              </div>
                              <div className="tpMeta">{p.position}</div>
                              <div className="tpPts">{pts} pts</div>
                            </div>
                            {isOpen && (
                              <PlayerStatsCard 
                                stats={stats} 
                                breakdown={breakdown}
                                teamName={realTeamName}
                                opponentName={opponentName}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* OTHER MATCHUPS CARD */}
          <div className="tpCard tpFull">
            <h3 className="tpCardTitle">Other Matchups</h3>
            {!otherMatchups.length ? (
              <p className="tpText">No other matchups.</p>
            ) : (
              <div className="tpMatchup">
                {otherMatchups.map((m) => {
                  const homeUser = userById[m.homeUserId] || { userId: m.homeUserId, displayName: nameById[m.homeUserId] || m.homeUserId };
                  const awayUser = userById[m.awayUserId] || { userId: m.awayUserId, displayName: nameById[m.awayUserId] || m.awayUserId };

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
    <div className="tpPage">
    <div className="tpWrap">
      <div className="tpHeaderRow">
        <div className="tpHeaderLeft">
          <h2 className="tpTitle">Tournament</h2>

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

        <div className="tpHeaderRight" ref={scoringRef}>
          <div className="tpHeaderRightTop">
            <div className="tpRoomMeta">
              Room: <b>{roomId}</b>
              {currentWeekIndex != null ? (
                <>
                  {" "}
                  • Week: <b>{currentWeekIndex}</b>
                </>
              ) : null}
              {" "}
              • Your Total: <b>{myTotal}</b>
            </div>

            <button
              type="button"
              className="tpScoringBtn"
              onClick={() => setShowScoring((v) => !v)}
              aria-expanded={showScoring}
              aria-haspopup="dialog"
            >
              Scoring <span className={`tpCaret ${showScoring ? "open" : ""}`}>▾</span>
            </button>
          </div>

          {showScoring && (
            <div className="tpScoringPopover" role="dialog" aria-label="Scoring rules">
              <div className="tpScoringTitle">Scoring</div>
              <ul className="tpScoringList">
                {SCORING_DISPLAY.map((r) => (
                  <li key={r.label} className="tpScoringItem">
                    <span className="tpScoringLabel">{r.label}</span>
                    <span className="tpScoringDetail">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
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
    <div className="tpText tpLiveHint" >
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
              const breakdown = typeof entry === "object" ? entry?.breakdown : {};
              const stats = typeof entry === "object" ? entry?.stats : {};
              const realTeamName = typeof entry === "object" ? entry?.realTeamName : "";
              const opponentName = typeof entry === "object" ? entry?.opponentName : "";
              const isOpen = expandedPlayerId === p.id;
              
              return (
                <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                  <div className="tpRow" onClick={() => togglePlayer(p.id)}>
                    
                    {/* 1. CLEAN ROW: Just the Name */}
                    <div className="tpPlayerInfo">
                      <span className="tpName">{p.name}</span>
                    </div>

                    {/* 2. Position Pill */}
                    <div className="tpMeta">
                      {p.position}
                    </div>

                    {/* 3. Points */}
                    <div className="tpPts">
                      {pts} pts
                    </div>
                  </div>
                  
                  {/* 4. PASS DATA TO CARD */}
                  {isOpen && (
                    <PlayerStatsCard 
                      stats={stats} 
                      breakdown={breakdown}
                      teamName={realTeamName}       // <--- NEW PROP
                      opponentName={opponentName}   // <--- NEW PROP
                    />
                  )}
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
              const breakdown = typeof entry === "object" ? entry?.breakdown : {};
              const stats = typeof entry === "object" ? entry?.stats : {};
              const realTeamName = typeof entry === "object" ? entry?.realTeamName : "";
              const opponentName = typeof entry === "object" ? entry?.opponentName : "";
              const isOpen = expandedPlayerId === p.id;

              return (
                <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                  <div className="tpRow" onClick={() => togglePlayer(p.id)}>
                    
                    {/* 1. CLEAN ROW: Just the Name */}
                    <div className="tpPlayerInfo">
                      <span className="tpName">{p.name}</span>
                    </div>

                    {/* 2. Position Pill */}
                    <div className="tpMeta">
                      {p.position}
                    </div>

                    {/* 3. Points */}
                    <div className="tpPts">
                      {pts} pts
                    </div>
                  </div>
                  
                  {/* 4. PASS DATA TO CARD */}
                  {isOpen && (
                    <PlayerStatsCard 
                      stats={stats} 
                      breakdown={breakdown}
                      teamName={realTeamName}       // <--- NEW PROP
                      opponentName={opponentName}   // <--- NEW PROP
                    />
                  )}
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

function PlayerStatsCard({ stats, breakdown, teamName, opponentName }) {
  if (!stats) return null;
  
  const labels = {
    minutes: "Mins", goals: "Goals", assists: "Assists", 
    passesCompleted: "Passes", saves: "Saves", goalsConceded: "Conceded",
    yellow: "Yellow", red: "Red", cleanSheet: "Clean Sheet", sixtyPlus: "60+ Mins", appearance: "Appearance",
  };

  return (
    <div className="tpStatsCard">
      
      {/* --- NEW: MATCH HEADER INSIDE DROPDOWN --- */}
      {(teamName || opponentName) && (
        <div className="tpCardHeader">
          <span className="tpCardTeam">{teamName}</span>
          {opponentName && (
             <span className="tpCardVs">vs {opponentName}</span>
          )}
        </div>
      )}
      {/* ----------------------------------------- */}

      <div className="tpStatsGrid">
        {/* RAW STATS COLUMN */}
        <div className="tpStatsCol">
          <span className="tpStatsHead">Raw Stats</span>
          {Object.entries(stats).map(([k, v]) => {
            if (!v && v !== 0) return null;
            if (v === false) return null;
            if (k === "minutes" && v === 0) return null;
            if (!labels[k]) return null;
            return (
              <div key={k} className="tpStatRow">
                <span>{labels[k]}</span>
                <span>{String(v)}</span>
              </div>
            );
          })}
        </div>

        {/* POINTS BREAKDOWN COLUMN */}
        <div className="tpStatsCol">
          <span className="tpStatsHead">Points</span>
          {Object.entries(breakdown || {}).map(([k, v]) => (
            <div key={k} className="tpStatRow">
              <span>{labels[k] || k}</span>
              <span className={v > 0 ? "tpPos" : "tpNeg"}>
                {v > 0 ? "+" : ""}{v}
              </span>
            </div>
          ))}
          {Object.keys(breakdown || {}).length === 0 && (
            <div className="tpStatRow"><span>Base</span><span>0</span></div>
          )}
        </div>
      </div>
    </div>
  );
}