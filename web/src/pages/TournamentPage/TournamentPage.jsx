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

  const { starters, statsByPlayerId, scored } = data;

  return (
    <div className="tpWrap">
      <h2 className="tpTitle">Tournament</h2>
      <p className="tpText">
        Room: <b>{roomId}</b> • Round: <b>{data.roundId}</b> • Team Total: <b>{scored.total}</b>
      </p>

      <div className="tpGrid">
        <div className="tpCard">
          <h3 className="tpCardTitle">Starters</h3>
          <ul className="tpList">
            {starters.map((p) => {
              const s = statsByPlayerId[p.id] || {};
              const pp = scored.perPlayer?.[p.id]?.points ?? 0;
              return (
                <li key={p.id} className="tpRow">
                  <span className="tpName">{p.name}</span>
                  <span className="tpMeta">{p.position}</span>
                  <span className="tpMeta">Min: {s.minutes ?? 0}</span>
                  <span className="tpMeta">Pass: {s.passesCompleted ?? 0}</span>
                  <span className="tpPts">{pp} pts</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="tpCard">
          <h3 className="tpCardTitle">Debug</h3>
          <pre className="tpPre">{JSON.stringify(data, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
