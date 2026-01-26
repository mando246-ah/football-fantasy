// src/pages/TournamentPage/TournamentPage.jsx
import { useParams, Link } from "react-router-dom";
import { useTournament } from "../../tournament/hooks/useTournament";
import "./TournamentPage.css";

export default function TournamentPage() {
  const { roomId } = useParams();

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

  const { loading, error, data } = useTournament(roomId);

  if (loading) return <div className="tpWrap">Loading tournament…</div>;

  if (error) {
    return (
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">Something went wrong: {String(error.message || error)}</p>
      </div>
    );
  }

  // ✅ New shape
  const results = data?.results;
  const users = data?.users || [];

  if (!results) {
    return (
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">No results yet.</p>
      </div>
    );
  }

  // For now: show the first user as "you" in the demo
  const me = users[0];
  const myTotal = results.teamScoresByUserId?.[me.userId] ?? 0;

  const myMatchup =
    results.matchups?.find((m) => m.homeUserId === me.userId || m.awayUserId === me.userId) || null;

  const myBreakdown = results.breakdownByUserId?.[me.userId];

  return (
    <div className="tpWrap">
      <h2 className="tpTitle">Tournament</h2>

      <p className="tpText">
        Room: <b>{roomId}</b> • Round: <b>{results.roundId}</b> • Your Total: <b>{myTotal}</b>
      </p>

      <div className="tpGrid">
        {/* Left: Your starters */}
        <div className="tpCard">
          <h3 className="tpCardTitle">Your Starters</h3>
          <ul className="tpList">
            {(me?.starters || []).map((p) => {
              const pp = myBreakdown?.perPlayer?.[p.id]?.points ?? 0;
              return (
                <li key={p.id} className="tpRow">
                  <span className="tpName">{p.name}</span>
                  <span className="tpMeta">{p.position}</span>
                  <span className="tpPts">{pp} pts</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Right: Matchup */}
        <div className="tpCard">
          <h3 className="tpCardTitle">Your Matchup</h3>
          {!myMatchup ? (
            <p className="tpText">No matchup yet.</p>
          ) : (
            <div className="tpMatchup">
              <div className="tpMatchRow">
                <span>
                  <b>{myMatchup.homeUserId}</b>
                </span>
                <span>{myMatchup.homeTotal}</span>
              </div>
              <div className="tpMatchRow">
                <span>
                  <b>{myMatchup.awayUserId}</b>
                </span>
                <span>{myMatchup.awayTotal}</span>
              </div>
              <div className="tpMatchFooter">
                Result:{" "}
                <b>
                  {myMatchup.homeUserId === me.userId ? myMatchup.homeResult : myMatchup.awayResult}
                </b>
              </div>
            </div>
          )}
        </div>

        {/* Full width: Leaderboard */}
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

            {(results.leaderboard || []).map((row, idx) => (
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

        {/* Optional debug */}
        <div className="tpCard tpFull">
          <h3 className="tpCardTitle">Debug</h3>
          <pre className="tpPre">{JSON.stringify(results, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
