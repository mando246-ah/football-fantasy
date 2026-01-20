import React, { useEffect, useMemo, useRef, useState } from "react";
import "./Marketplace.css";
import { db } from "../../firebase";
import { orderBy, query} from "firebase/firestore";
import {
   marketSaveInterest, marketResolve
} from "../../firebase";
import {
  collection, getDocs, onSnapshot, doc
} from "firebase/firestore";
import { Timestamp, where } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import {app} from "../../firebase";

const functions = getFunctions(app, "us-west2");
const fnScheduleMarket = httpsCallable(functions, "scheduleMarket");

function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatWhenMs(ms) {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleString([], {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function toMillis(value) {
  if (!value) return null;

  // Firestore Timestamp
  if (typeof value === "object" && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  // Firestore-like { seconds, nanoseconds }
  if (typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }

  // Number (could be seconds or ms)
  if (typeof value === "number") {
    // if it's too small to be ms, treat as seconds
    return value < 1e12 ? value * 1000 : value;
  }

  // String: ISO or numeric
  if (typeof value === "string") {
    // numeric string
    const asNum = Number(value);
    if (!Number.isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;

    // ISO datetime string
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}



function useCountdown(targetMs, isActive) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isActive || !targetMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive, targetMs]); 

  const remainingMs = useMemo(() => {
    if (!targetMs) return 0;
    return targetMs - now;
  }, [targetMs, now]);

  return { remainingMs, label: formatMs(remainingMs) };
}

const AcquireSearch = React.memo(function AcquireSearch({
  label,
  search,
  setSearch,
  state,
  setState,
  pool,          // full player pool (MOCK_PLAYERS / API later)
  pickedSet,     // Set of drafted playerIds
  disabled,
}) {
  const q = search.trim().toLowerCase();

  const results =
    q.length < 2
      ? []
      : (pool || [])
          .filter((p) => (p?.name || "").toLowerCase().includes(q))
          .slice(0, 20);

  const selected =
    state.wantId
      ? (pool || []).find((p) => String(p.id) === String(state.wantId))
      : null;

  return (
    <div className="w-full">
      <input
        className="border rounded px-2 py-1 w-full"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search player to acquire (${label})…`}
        disabled={disabled}
      />

      {selected && (
        <div className="text-xs opacity-70 mt-1">
          Selected: <b>{selected.name}</b> ({selected.position})
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              setState({ ...state, wantId: "" });
              setSearch("");
            }}
          >
            clear
          </button>
        </div>
      )}

      {!selected && results.length > 0 && (
        <div className="border rounded mt-2 max-h-56 overflow-auto bg-white">
          {results.map((p) => {
            const taken = pickedSet?.has(String(p.id));
            return (
              <button
                type="button"
                key={p.id}
                className="w-full text-left px-2 py-2 hover:bg-slate-100 disabled:opacity-50"
                disabled={taken}
                onClick={() => {
                  setState({ ...state, wantId: p.id });
                  setSearch(p.name);
                }}
                title={taken ? "Already drafted" : disabled ? "Click Edit to change" : "Select"}
              >
                <div className="font-medium">
                  {p.name} {taken ? " (taken)" : ""}
                </div>
                <div className="text-xs opacity-70">{p.position}</div>
              </button>
            );
          })}
        </div>
      )}

      {q.length >= 2 && !selected && results.length === 0 && (
        <div className="text-xs opacity-60 mt-1">No matches.</div>
      )}
    </div>
  );
});


export default function Marketplace({ roomId, user, isHost, players= [] }) {
  const [market, setMarket] = useState(null);
  const [room, setRoom] = useState(null);
  const [undrafted, setUndrafted] = useState([]);
  const [myRoster, setMyRoster] = useState([]);
  const [choiceA, setChoiceA] = useState({ wantId: "", swapOutId: "" });
  const [choiceB, setChoiceB] = useState({ wantId: "", swapOutId: "" });
  const [dur, setDur] = useState({ days: 0, hours: 0, minutes: 10 });
  const [startISO, setStartISO] = useState("");
  const [searchA, setSearchA] = useState("");
  const [searchB, setSearchB] = useState("");
  const [pickedSet, setPickedSet] = useState(new Set());
  const [isEditing, setIsEditing] = useState(true); // default: editable
  const [saveStatus, setSaveStatus] = useState(""); 
  const [ marketResults, setMarketResults ] = useState([]);

  //Display Results After Market Closes
  useEffect(() => {
  if (!roomId) return;

  // If market has never resolved yet, don't show anything
  if (!market?.closesAt) {
    setMarketResults([]);
    return;
  }

  // resolvedAt is Timestamp; closeAt is ms number
  // We'll show results resolved AFTER (closeAt - 5 minutes) to capture the batch
  const from = Timestamp.fromMillis(Number(market.closesAt) - 5 * 60 * 1000);

  const qy = query(
    collection(db, "rooms", roomId, "marketResults"),
    where("resolvedAt", ">=", from),
    orderBy("resolvedAt", "desc")
  );

  const unsub = onSnapshot(qy, (snap) => {
    setMarketResults(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });

  return () => unsub();
}, [roomId, market?.closesAt]);


  useEffect(() => {
    if (!roomId) return;

    const roomRef = doc(db, "rooms", roomId);
    const marketRef = doc(db, "rooms", roomId, "market", "current");

    const unsubRoom = onSnapshot(roomRef, (snap) => {
      setRoom(snap.exists() ? snap.data() : null);
    });

    const unsubMarket = onSnapshot(marketRef, (snap) => {
      setMarket(snap.exists() ? snap.data() : { status: "closed" });
    });

    return () => {
      unsubRoom();
      unsubMarket();
    };
  }, [roomId]);


 /* useEffect(() => watchMarket(roomId, (m, wholeRoom) => {
    setMarket(m || { status: "closed" });
    setRoom(wholeRoom || null);
  }), [roomId]); */



  // Load undrafted & my roster
  useEffect(() => {
    async function load() {
      const picksSnap = await getDocs(collection(db, "rooms", roomId, "picks"));

      // who is already drafted
      const picked = new Set();
      picksSnap.forEach(d => picked.add(String(d.data().playerId)));
      setPickedSet(picked);

      // 1) Prefer passed-in players (MOCK_PLAYERS)
      let all = (players || []).map(p => ({
        ...p,
        id: String(p.id),
      }));

      // 2) Fallback: if none passed, load from Firestore players collection
      if (all.length === 0) {
        const playersSnap = await getDocs(collection(db, "rooms", roomId, "players"));
        all = playersSnap.docs.map(d => {
          const data = d.data();
          return { ...data, id: String(data.id ?? d.id) };
        });
      }

      setUndrafted(all.filter(p => !picked.has(String(p.id))));

      // my roster from picks
      const mine = [];
      picksSnap.forEach(d => {
        const p = d.data();
        if (p.uid === user?.uid) mine.push(p);
      });
      setMyRoster(mine);
    }

    if (roomId) load();
  }, [roomId, user?.uid, market?.status, players]);


  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!roomId || !user?.uid) return;

    const nameFromPool = (id) =>
    (players || []).find(p => String(p.id) === String(id))?.name || "";

    const ref = doc(db, "rooms", roomId, "marketInterest", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const choices = Array.isArray(data?.choices) ? data.choices : [];

      const a = choices[0] || { wantId: "", swapOutId: "" };
      const b = choices[1] || { wantId: "", swapOutId: "" };

      setChoiceA({ wantId: a.wantId || "", swapOutId: a.swapOutId || "" });
      setChoiceB({ wantId: b.wantId || "", swapOutId: b.swapOutId || "" });

      // Optional: set search inputs to selected player names
      // (only if you kept searchA/searchB)
      setSearchA( nameFromPool(a.wantId) || "" );
      setSearchB( nameFromPool(b.wantId) || "" );
    });

    return () => unsub();
  }, [roomId, user?.uid]);

  //Market count down
  useEffect(() => {
    if (market?.status !== "open" || !market?.closesAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [market?.status, market?.closesAt]);

  const countdown = useMemo(() => {
    if (market?.status !== "open" || !market?.closesAt) return null;
    const closesAtMs = toMillis(market?.closesAt);
    const diff = (closesAtMs ?? 0) - now;
    if (diff <= 0) return "00:00";
    const mm = Math.floor(diff / 60000);
    const ss = Math.floor((diff % 60000) / 1000);
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }, [market?.status, market?.closesAt, now]);


  const durationMs = (Number(dur.days||0)*86400000) + (Number(dur.hours||0)*3600000) + (Number(dur.minutes||0)*60000);
  const scheduledAtMs = useMemo(() => toMillis(market?.scheduledAt), [market?.scheduledAt]);


  const scheduledOpenCountdown = useCountdown(
    scheduledAtMs,
    market?.status !== "open" && !!scheduledAtMs && scheduledAtMs > Date.now()
  );


  //Resolving Market
  const resolveOnceRef = useRef(false);
  useEffect(() => {
  if (!roomId || !isHost) return;

  if (market?.status !== "resolving") {
    resolveOnceRef.current = false;
    return;
  }

  if (resolveOnceRef.current) return;
  resolveOnceRef.current = true;

  (async () => {
    try {
      console.log("Attempting market resolve", {
        isHost,
        myUid: user?.uid,
        roomId,
        marketStatus: market?.status,
      });

      const res = await marketResolve({ roomId });
      console.log("marketResolve() result:", res);
    } catch (e) {
      console.error("marketResolve failed:", e);
      resolveOnceRef.current = false;
    }
  })();
}, [roomId, isHost, market?.status]);


  async function onSaveInterest() {
    if (!market || market.status !== "open") return;

    try {
      setSaveStatus("saving");

      const choices = [];
      if (choiceA.wantId && choiceA.swapOutId) choices.push(choiceA);
      if (choiceB.wantId && choiceB.swapOutId) choices.push(choiceB);

      await marketSaveInterest({ roomId, choices });

      setSaveStatus("saved");
      setIsEditing(false); // lock inputs after save
    } catch (e) {
      console.error(e);
      setSaveStatus("error");
    }
  }


  async function onStartNow() {
    if (!durationMs) return alert("Please set a duration.");
    await marketOpenNow({ roomId, durationMs });
  }
  async function onSchedule() {
  if (!durationMs || !startISO) return alert("Start time + duration required.");

    const whenMillis = new Date(startISO).getTime();
    if (!Number.isFinite(whenMillis)) return alert("Invalid start time.");

    // call your Cloud Function (this is the one that emails everyone + writes market/current)
    const res = await fnScheduleMarket({
      roomId,
      scheduledAtMs: whenMillis,
      durationMs,
    });

    console.log("scheduleMarket()", res);
  }

  async function onResolve() {
    const res = await marketResolve({ roomId });
    console.log("marketResolve()", res);
    alert(`Market resolved. Trades: ${res?.resultsCount ?? 0}`);
  }

  
  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Marketplace</h2>
        <div className="text-sm">
          {market?.status === "open" ? (
            <span className="px-2 py-1 rounded bg-green-100 text-green-700">Open • {countdown ?? "—"}</span>
          ) : market?.status === "resolved" ? (
            <span className="px-2 py-1 rounded bg-blue-100 text-blue-700">Resolved</span>
          ) : scheduledAtMs && scheduledAtMs > Date.now() ? (
            <span className="px-2 py-1 rounded bg-amber-100 text-amber-700">
              Scheduled • {scheduledOpenCountdown.label}
            </span>
          ) : (
            <span className="px-2 py-1 rounded bg-slate-100 text-slate-700">Closed</span>
          )}
        </div>
      </div>

      {/* Host controls */}
      {isHost && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="col-span-1">
            <label className="text-xs font-semibold block mb-1">Duration</label>
            <div className="flex gap-2">
              <input className="border rounded px-2 py-1 w-20" type="number" min="0" value={dur.days} onChange={e=>setDur({...dur, days:e.target.value})}/> <span className="text-sm self-center">days</span>
              <input className="border rounded px-2 py-1 w-20" type="number" min="0" value={dur.hours} onChange={e=>setDur({...dur, hours:e.target.value})}/> <span className="text-sm self-center">hrs</span>
              <input className="border rounded px-2 py-1 w-20" type="number" min="0" value={dur.minutes} onChange={e=>setDur({...dur, minutes:e.target.value})}/> <span className="text-sm self-center">min</span>
            </div>
          </div>
          <div className="col-span-1">
            <label className="text-xs font-semibold block mb-1">Schedule start</label>
            <input className="border rounded px-2 py-1 w-full" type="datetime-local" value={startISO} onChange={e=>setStartISO(e.target.value)} />
            <button className="mt-2 px-3 py-1 rounded bg-amber-600 text-white" onClick={onSchedule}>Schedule</button>
          </div>
          <div className="col-span-1 flex items-end">
            <button className="px-3 py-2 rounded bg-green-600 text-white" onClick={onStartNow}>Open Now</button>
            {market?.status !== "resolved" ? (
              <button className="ml-2 px-3 py-2 rounded bg-blue-600 text-white" onClick={onResolve}>Resolve Now</button>
            ) : null}
          </div>
        </div>
      )}

      {/* Status note */}
      <div className="mt-4 text-sm opacity-70">
        {market?.status === "open"
          ? "Market is OPEN. Set up to two interests below."
          : scheduledAtMs && scheduledAtMs > Date.now()
          ? `Market is CLOSED (scheduled to open automatically at ${formatWhenMs(scheduledAtMs)}).`
          : "Market is CLOSED. You can still browse available players."}
      </div>

      {/* Available players */}
      <div className="mt-4">
        <div className="font-semibold mb-2">Available Players</div>
        <div className="grid gap-2 md:grid-cols-3">
          {undrafted.map(p => (
            <div key={p.id} className="border rounded p-2">
              <div className="font-medium">{p.name}</div>
              <div className="text-xs opacity-70">{p.position}</div>
            </div>
          ))}
          {undrafted.length === 0 && <div className="opacity-60 text-sm">None.</div>}
        </div>
      </div>

      {/* My interest (private to me) */}
      <div className="mt-6">
        <div className="font-semibold mb-2">Your Interest (private)</div>
        <div className="grid md:grid-cols-2 gap-3">
          {[{label:"Choice A", state: choiceA, set: setChoiceA},
            {label:"Choice B", state: choiceB, set: setChoiceB}].map(({label, state, set}) => (
            <div key={label} className="border rounded p-3">
              <div className="text-sm font-medium mb-2">{label}</div>
              <div className="flex gap-2 items-center">
                <AcquireSearch
                  label={label}
                  search={label === "Choice A" ? searchA : searchB}
                  setSearch={label === "Choice A" ? setSearchA : setSearchB}
                  state={state}
                  setState={set}
                  pool={players}
                  pickedSet={pickedSet}
                  disabled={!isEditing}
                />
                <span className="text-xs opacity-60">for</span>
                <select disabled={!isEditing} className="border rounded px-2 py-1 w-full" value={state.swapOutId} onChange={e=>set({...state, swapOutId:e.target.value})}>
                  <option value="">— Select your player to release —</option>
                  {myRoster.map(p => <option key={p.playerId} value={p.playerId}>{p.playerName} ({p.position})</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
        <button className="mt-3 px-4 py-2 rounded bg-slate-900 text-white" onClick={onSaveInterest} disabled={!market || market.status!=="open" || !isEditing}>Save Interest</button>
        <button
          className="px-4 py-2 rounded border disabled:opacity-50"
          onClick={() => setIsEditing(true)}
          disabled={!market || market.status !== "open"}
        >
          Edit choices
        </button>
        
        {market?.status !== "open" && <div className="text-xs opacity-60 mt-1">Interest can be saved only while market is open.</div>}
        <div className="mt-2 text-sm min-h-[20px]">
          {saveStatus === "saving" && (
            <span className="opacity-70">Saving your interest…</span>
          )}
          {saveStatus === "saved" && (
            <span className="text-green-600">
              ✓ Interest saved. You can edit until the market closes.
            </span>
          )}
          {saveStatus === "error" && (
            <span className="text-red-600">
              Failed to save interest. Please try again.
            </span>
          )}
        </div>

          {market?.status === "resolved" && (
            <div className="marketResultsPanel">
              <div className="marketResultsTitle">Market Results</div>

              {marketResults.length === 0 ? (
                <div className="marketResultsEmpty">No successful trades were recorded.</div>
              ) : (
                <div className="marketResultsList">
                  {marketResults.map(r => (
                    <div key={r.id} className="marketResultRow">
                      <div className="marketResultUser">{r.displayName || r.uid}</div>
                      <div className="marketResultSwap">
                        Dropped <b>{r.releasedName || r.releasedId}</b> → Added <b>{r.gotName || r.gotId}</b>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
      </div>

    </div>
  );
}
