// web/src/pages/DraftSummary.jsx
import { useEffect, useMemo, useState, useRef } from "react";
import { auth, db, watchRoom, getLastRoomId } from "../firebase";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { setLastRoomId } from "../firebase";
import TradePanel from "../components/ui/TradePanel";
import useUserProfiles from "../lib/useUserProfiles";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";
import useTeamNames from "../lib/useTeamNames";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { Pencil } from "lucide-react";

const DEFAULT_DRAFT_PLAN = ["ATT", "ATT", "MID", "MID", "DEF", "DEF", "GK", "SUB", "SUB"];

function displayNameOf(m) {
  return m?.displayName || m?.uid || "User";
}

export default function DraftSummary() {
  // pick up room from URL or last saved
  const [urlRoomId] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get("room") || getLastRoomId() || "";
  });

  // We'll allow the UI to switch rooms via prompt as well
  const [roomId, setRoomId] = useState(urlRoomId);

  //Use team name
  const teamNamesByUid = useTeamNames(roomId);
  const myUid = auth.currentUser?.uid;

  //Trade: user to user
  const [room, setRoom] = useState(null);
  const [picks, setPicks] = useState([]);
  const tradeRoomPath = room?.code && room.code !== roomId ? room.code : roomId;
  const [sortMode, setSortMode] = useState("order"); // 'order' | 'alpha'


  // Persist last used room id for convenience
  useEffect(() => {
    if (roomId) localStorage.setItem("lastRoomId", roomId);
    if(roomId) setLastRoomId(roomId);
  }, [roomId]);

  // Live room doc (by current roomId)
  useEffect(() => {
    if (!roomId) return;
    const unsub = watchRoom(roomId, (data) => setRoom(data || null));
    return () => unsub && unsub();
  }, [roomId]);

  /**
   * Picks stream
   * Some projects created rooms with a doc ID different from the visible room "code".
   * This listener will:
   *   1) Start listening at rooms/{roomId}/picks
   *   2) If the loaded room contains a different .code, it will rewire to rooms/{room.code}/picks
   */
  useEffect(() => {
    let unsub = null;

    function attach() {
      if (!tradeRoomPath) return;
      const picksRef = collection(db, "rooms", tradeRoomPath, "picks");
      const q = query(picksRef, orderBy("turn", "asc"));
      unsub = onSnapshot(q, (snap) => {
        setPicks(snap.docs.map((d) => ({id: d.id, ...d.data()}))); // expects {playerId, playerName, position, uid, displayName, turn, round}
      });
    }

    // 1) start with roomId immediately
    attach(roomId);

    return () => {
      if (unsub) unsub();
    };
  }, [roomId]);

  // If the loaded room has a different .code than roomId, prefer that path for picks
  useEffect(() => {
    if (!room?.code || room?.code === roomId) return;

    // Swap listener to the room.code path
    const picksRef = collection(db, "rooms", tradeRoomPath, "picks");
    const q = query(picksRef, orderBy("turn", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setPicks(snap.docs.map((d) => ({id: d.id, ...d.data()})));
    });
    return () => unsub();
  }, [room?.code, roomId]);

  const members = useMemo(() => (Array.isArray(room?.members) ? room.members : []), [room?.members]);
  const draftOrder = useMemo(
    () => (Array.isArray(room?.draftOrder) && room.draftOrder.length ? room.draftOrder : members),
    [room?.draftOrder, members]
  );

  // Profiles (photoURL + displayName) for members
  const memberUids = useMemo(() => members.map((m) => m.uid).filter(Boolean), [members]);
  const profilesByUid = useUserProfiles(memberUids);
  const profileOf = (uid) => profilesByUid?.[uid] || {};


  // Group picks by manager uid
  const byManager = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      map.set(m.uid, { manager: m, picks: [] });
    }
    for (const p of picks) {
      const uid = p.uid || "unknown";
      if (!map.has(uid)) {
        map.set(uid, { manager: { uid, displayName: p.displayName || uid }, picks: [] });
      }
      map.get(uid).picks.push(p);
    }
    return map;
  }, [members, picks]);

  // Ordering of manager cards (you first, then by draft order or A–Z)
  const currentUid = auth.currentUser?.uid || null;
  const managerRows = useMemo(() => {
    const rows = Array.from(byManager.values());

    rows.sort((a, b) => {
      const aYou = a.manager.uid === currentUid;
      const bYou = b.manager.uid === currentUid;
      if (aYou && !bYou) return -1;
      if (bYou && !aYou) return 1;

      if (sortMode === "alpha") {
        const an = (a.manager.displayName || "").toLowerCase();
        const bn = (b.manager.displayName || "").toLowerCase();
        return an.localeCompare(bn);
      }

      // sort by draft order
      const aIdx = draftOrder.findIndex((m) => m.uid === a.manager.uid);
      const bIdx = draftOrder.findIndex((m) => m.uid === b.manager.uid);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });

    return rows;
  }, [byManager, draftOrder, currentUid, sortMode]);

  // Header computed values
  const totalRounds = room?.totalRounds ?? 9;
  const perRoundPlan =
    Array.isArray(room?.draftPlan) && room.draftPlan.length === totalRounds
      ? room.draftPlan
      : DEFAULT_DRAFT_PLAN;

  const n = draftOrder.length || 1;
  const turnIndex = Number.isFinite(room?.turnIndex) ? room.turnIndex : 0;
  const roundNumber = Math.floor(turnIndex / n) + 1;
  const requiredSlot = perRoundPlan[roundNumber - 1] || null;

  return (
    <div className="min-h-screen w-full p-4 md:p-6 bg-gray-50">
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">
              {room?.name || "Draft Room"}{" "}
              {room?.code ? `— ${room.code}` : roomId ? `— ${roomId}` : ""}
            </div>
            <div className="text-sm text-gray-600">
              Host: <b>{displayNameOf(members.find((m) => m.uid === room?.hostUid))}</b> ·{" "}
              Status: {room?.started ? <b>Live</b> : <b>Waiting</b>} ·{" "}
              Round: <b>{Math.max(1, Math.min(roundNumber, totalRounds))}</b> / {totalRounds} ·{" "}
              Required: <b>{requiredSlot || "-"}</b>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="px-3 py-2 rounded border"
              onClick={() => {
                const id = prompt("Enter room key to switch");
                if (id) setRoomId(id.toUpperCase());
              }}
            >
              Switch Room
            </button>
            <button
              className="px-3 py-2 rounded border"
              onClick={() => {
                if (!roomId) return;
                navigator.clipboard.writeText(`${window.location.origin}/room?room=${room?.code || roomId}`);
                alert("Link copied");
              }}
              disabled={!roomId}
            >
              Copy Link
            </button>
            <select
              className="px-2 py-2 rounded border"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
              title="Sort teams"
            >
              <option value="order">Order</option>
              <option value="alpha">A–Z</option>
            </select>
          </div>
        </div>

        {/* Members */}
        <div className="mt-3">
          <div className="text-sm text-gray-600 mb-1">Members</div>
          <div className="flex flex-wrap gap-2">
              {(members || []).map((m) => {
                const p = profileOf(m.uid);
                const name = displayNameOf(m);

                return (
                  <div
                    key={m.uid}
                    className="flex items-center gap-2 px-2 py-1 rounded bg-gray-100 text-sm"
                  >
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={p.photoURL || ""} alt={name} />
                      <AvatarFallback className="text-[10px] font-bold">
                        {(name || "U").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span>{name}</span>
                  </div>
                );
              })}
            {(!members || members.length === 0) && (
              <div className="text-sm text-gray-500">No members yet.</div>
            )}
          </div>
        </div>
      </div>

      {/* Rosters */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {managerRows.map(({ manager, picks }) => (
          <ManagerRosterCard
            key={manager.uid}
            manager={manager}
            picks={picks}
            totalRounds={totalRounds}
            photoURL={profileOf(manager.uid).photoURL || ""}
            teamName={teamNamesByUid[manager.uid] || ""}
            roomId={roomId}
            myUid={myUid}
          />
        ))}
      </div>

      {/* Empty state */}
      {(!picks || picks.length === 0) && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="font-semibold mb-1">No picks found yet</div>
          <div className="text-sm opacity-70">
            Make sure you opened the summary for the correct room and that drafting has started.
          </div>
        </div>
      )}

      <TradePanel
        roomId={roomId}
        tradeRoomPath={tradeRoomPath}
        room={room}
        picks={picks}
      />
    </div>
  );
}

function ManagerRosterCard({ manager, picks, totalRounds, photoURL, teamName, roomId, myUid }) {
  // Group by position for quick visual
  const byPos = useMemo(() => {
    const map = { ATT: [], MID: [], DEF: [], GK: [], SUB: [] };
    for (const p of picks) {
      const key = p.position && ["ATT", "MID", "DEF", "GK"].includes(p.position) ? p.position : "SUB";
      map[key].push(p);
    }
    return map;
  }, [picks]);

  const name = displayNameOf(manager);
  const showTeamName = teamName?.trim();
  const title = showTeamName ? `${name} — ${showTeamName}` : name;
  const isMe = myUid && manager.uid === myUid;
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(teamName || "");

  useEffect(() => setInput(teamName || ""), [teamName]);

  async function saveTeamName() {
    const clean = (input || "").trim();
    if (clean.length < 2) return alert("Team name must be at least 2 characters.");
    if (clean.length > 30) return alert("Team name must be 30 characters or less.");

    await setDoc(
      doc(db, "rooms", roomId, "teamNames", myUid),
      { teamName: clean, updatedAt: serverTimestamp() },
      { merge: true }
    );

    setEditing(false);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center gap-3 mb-1">
        <Avatar className="h-10 w-10 border">
          <AvatarImage src={photoURL || ""} alt={displayNameOf(manager)} />
          <AvatarFallback className="font-bold">
            {(name || "U").slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="flex items-start justify-between gap-2 w-full">
          <div className="font-semibold text-xl leading-tight">{title}</div>

          {isMe && !editing && (
            <button
              type="button"
              className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
              onClick={() => setEditing(true)}
              title="Edit team name"
              aria-label="Edit team name"
            >
              ✏️
            </button>
          )}
        </div>
        {isMe && editing && (
          <div className="mt-2 w-full">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder="Your team name"
            />

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="border rounded px-3 py-1 text-sm"
                onClick={saveTeamName}
              >
                Save
              </button>

              <button
                type="button"
                className="border rounded px-3 py-1 text-sm"
                onClick={() => {
                  setInput(teamName || "");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="text-xs text-gray-500 mb-3">
        Picks: {picks.length} / {totalRounds}
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <PosBlock title="ATT" list={byPos.ATT} />
        <PosBlock title="MID" list={byPos.MID} />
        <PosBlock title="DEF" list={byPos.DEF} />
        <PosBlock title="GK" list={byPos.GK} />
        <div className="col-span-2">
          <PosBlock title="SUB" list={byPos.SUB} />
        </div>
      </div>

      {/* Flat list ordered by turn */}
      <div className="mt-3">
        <div className="text-xs text-gray-500 mb-1">All Picks (by draft order)</div>
        <ol className="space-y-1 max-h-48 overflow-auto">
          {[...picks]
            .sort((a, b) => (a.turn || 0) - (b.turn || 0))
            .map((p) => (
              <li key={p.id || `${p.uid}-${p.turn}`} className="border rounded px-2 py-1 flex items-center justify-between">
                <span>
                  <b>#{p.turn}</b> — {p.playerName}{" "}
                  <span className="opacity-70">({p.position || "SUB"})</span>
                </span>
                <span className="opacity-60 text-xs">R{p.round}</span>
              </li>
            ))}
          {picks.length === 0 && <div className="opacity-60 text-sm">No picks yet.</div>}
        </ol>
      </div>
    </div>
  );
}

function PosBlock({ title, list }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs font-semibold mb-1">{title}</div>
      <ul className="space-y-1">
        {list.map((p) => (
          <li key={p.id || `${p.uid}-${p.turn}`} className="border rounded px-2 py-1">
            {p.playerName}
          </li>
        ))}
        {list.length === 0 && <li className="text-xs text-gray-400">—</li>}
      </ul>
    </div>
  );
}
