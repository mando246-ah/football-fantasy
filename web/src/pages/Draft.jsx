import { useEffect, useMemo, useRef, useState } from "react";
import {
  auth,
  db,
  watchAuth,
  getUserProfile,
  watchRoom,
  joinRoom,
  leaveRoom,
  getLastRoomId,
  setLastRoomId,
  callMakePick,
  callMaybeStartDraft,
  callStartDraftNow,
  callAutoPick,
} from "../firebase";
import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  updateDoc,
  query,
  orderBy,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";

import WaitingRoom from "../components/ui/WaitingRoom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
//import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Users, Trophy, Medal} from "lucide-react";
import Marketplace from "../components/ui/Marketplace";
import { seedRoomPlayers } from "../firebase";
import { httpsCallable } from "firebase/functions";
import { app, functions } from "../firebase";
import "./Draft.css";
import useUserProfiles from "../lib/useUserProfiles";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";


// ----- Config -----
const TURN_SECONDS = 120;

// ----- Mock pool (30 players) -----
const MOCK_PLAYERS = [
  // ATT (10)
  { id: "erling-haaland", name: "Erling Haaland", position: "ATT" },
  { id: "kylian-mbappe", name: "Kylian Mbappé", position: "ATT" },
  { id: "harry-kane", name: "Harry Kane", position: "ATT" },
  { id: "vinicius-junior", name: "Vinícius Júnior", position: "ATT" },
  { id: "lautaro-martinez", name: "Lautaro Martínez", position: "ATT" },
  { id: "robert-lewandowski", name: "Robert Lewandowski", position: "ATT" },
  { id: "mohamed-salah", name: "Mohamed Salah", position: "ATT" },
  { id: "osimhen", name: "Victor Osimhen", position: "ATT" },
  { id: "julian-alvarez", name: "Julián Álvarez", position: "ATT" },
  { id: "rafa-leao", name: "Rafael Leão", position: "ATT" },
  // MID (10)
  { id: "kevin-de-bruyne", name: "Kevin De Bruyne", position: "MID" },
  { id: "jude-bellingham", name: "Jude Bellingham", position: "MID" },
  { id: "bernardo-silva", name: "Bernardo Silva", position: "MID" },
  { id: "rodri", name: "Rodri", position: "MID" },
  { id: "martin-odegaard", name: "Martin Ødegaard", position: "MID" },
  { id: "florian-wirtz", name: "Florian Wirtz", position: "MID" },
  { id: "bukayo-saka", name: "Bukayo Saka", position: "MID" },
  { id: "bruno-fernandes", name: "Bruno Fernandes", position: "MID" },
  { id: "ilkay-gundogan", name: "İlkay Gündoğan", position: "MID" },
  { id: "pedri", name: "Pedri", position: "MID" },
  // DEF (8)
  { id: "ruben-dias", name: "Rúben Dias", position: "DEF" },
  { id: "virgil-van-dijk", name: "Virgil van Dijk", position: "DEF" },
  { id: "alphonso-davies", name: "Alphonso Davies", position: "DEF" },
  { id: "kyle-walker", name: "Kyle Walker", position: "DEF" },
  { id: "achraf-hakimi", name: "Achraf Hakimi", position: "DEF" },
  { id: "theo-hernandez", name: "Theo Hernández", position: "DEF" },
  { id: "kim-min-jae", name: "Kim Min-jae", position: "DEF" },
  { id: "john-stones", name: "John Stones", position: "DEF" },
  // GK (2)
  { id: "thibaut-courtois", name: "Thibaut Courtois", position: "GK" },
  { id: "ederson", name: "Ederson", position: "GK" },
];

//Email

const fnScheduleDraft = httpsCallable(functions, "scheduleDraft");

// ----- Helpers -----  
function randomKey(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n).toUpperCase();
}
function roundOrder(order, roundIndex) {
  if (!order?.length) return [];
  return roundIndex % 2 === 0 ? order : [...order].reverse();
}
function displayNameOf(m, fallback = "User") {
  return m?.displayName || m?.uid || fallback;
}

function formatWhen(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function secondsUntil(ms, nowMs) {
  if (!ms) return null;
  return Math.floor((ms - nowMs) / 1000);
}

function countdownStr(sec) {
  if (sec == null) return "";
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Returns next occurrence of a weekday as YYYY-MM-DD in a given IANA timezone.
// targetDow: 0=Sun ... 6=Sat
function nextWeekdayISO(targetDow, timeZone = "America/Los_Angeles") {
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const now = new Date();
  let currentDow;

  try {
    const dowStr = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(now);
    currentDow = DOW[dowStr];
  } catch {
    currentDow = now.getDay();
  }
  if (typeof currentDow !== "number") currentDow = now.getDay();

  const t = Number(targetDow);
  const target = Number.isFinite(t) ? ((t % 7) + 7) % 7 : 3;

  let delta = (target - currentDow + 7) % 7;
  const day = new Date(now.getTime() + delta * 24 * 60 * 60 * 1000);

  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(day);
  } catch {
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}



export default function DraftWithPresence() {
  // Auth
  const [user, setUser] = useState(null);
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // Routing / room selection
  const [roomId, setRoomId] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get("room") || getLastRoomId() || "";
  });
  const [roomKeyInput, setRoomKeyInput] = useState("");

  // Live room state
  const [room, setRoom] = useState(null);
  const [members, setMembers] = useState([]);
  const [picks, setPicks] = useState([]);
  const [joining, setJoining] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [seedingPlayers, setSeedingPlayers] = useState(false);

  // Host scheduling
  const [startLocalISO, setStartLocalISO] = useState("");
  const [marketLocalISO, setMarketLocalISO] = useState("");

  // Player list UI
  const [posFilter, setPosFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  // Countdown + auto-pick
  const [timeLeft, setTimeLeft] = useState(TURN_SECONDS);
  const triedAutoRef = useRef(false);
  const [ clockNow, setClockNow] = useState(Date.now());

  //Live Listener
  const [poolPlayers, setPoolPlayers] = useState([]);

  useEffect(() => {
    if (!roomId) {
      setPoolPlayers([]);
      return;
    }
    const ref = collection(db, "rooms", roomId, "players");
    return onSnapshot(ref, (snap) => {
      setPoolPlayers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [roomId]);

  //Clock tick
  useEffect(() => {
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Watch room doc (members live in the room doc's `members` array)
  useEffect(() => {
    if(roomId) setLastRoomId(roomId);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    setLastRoomId(roomId);

    const unsubRoom = watchRoom(roomId, (data) => {
      setRoom(data);
      setMembers(Array.isArray(data?.members) ? data.members : []);
    });

    // Auto-join when signed-in & roomId present
    let didJoin = false;
    const tryJoin = async () => {
      if (didJoin || !roomId || !auth.currentUser) return;
      didJoin = true;
      setJoining(true);
      try {
        const profile = await getUserProfile(auth.currentUser.uid).catch(() => null);
        const displayName = profile?.displayName || auth.currentUser.displayName || auth.currentUser.email;
        await joinRoom(roomId, { displayName });
      } catch (e) {
        console.error("joinRoom failed:", e);
      } finally {
        setJoining(false);
      }
    };
    const unAuth = watchAuth(() => tryJoin());
    tryJoin();

    // Leave on unload (best effort)
    const onBye = () => leaveRoom(roomId);
    window.addEventListener("beforeunload", onBye);

    // Picks stream
    const unsubPicks = onSnapshot(
      query(collection(db, "rooms", roomId, "picks"), orderBy("turn", "asc")),
      (snap) => setPicks(snap.docs.map((d) => d.data()))
    );

    return () => {
      window.removeEventListener("beforeunload", onBye);
      unAuth && unAuth();
      unsubRoom && unsubRoom();
      unsubPicks && unsubPicks();
    };
  }, [roomId]);

  // Create a room (host)
  async function createRoom() {
    if (!user) return alert("Sign in first");
    if (creatingRoom) return;

    setCreatingRoom(true);
    setSeedingPlayers(false);

    try {
      const key = randomKey();
      const ref = doc(db, "rooms", key);
      if ((await getDoc(ref)).exists()) return alert("Key collision, try again");

      const profile = await getUserProfile(user.uid).catch(() => null);
      const displayName = profile?.displayName || user.displayName || user.email || "Host";
      const initialMembers = [{ uid: user.uid, displayName }];

      await setDoc(ref, {
        code: key,
        name: "Friends Draft",
        hostUid: user.uid,
        members: initialMembers,
        turnIndex: 0,
        totalRounds: 16,                                  //<-------------------------------------change here for total rounds
        draftPlan: null,
        started: false,
        startAt: null,
        turnDeadlineAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // hard-coded for now
      const competition = { provider: "api-football", league: 2, season: 2025, timezone: "America/Los_Angeles" };
      await updateDoc(doc(db, "rooms", key), { competition });

      // Create the fast “mirrors” (these are quick)
      await setDoc(
        doc(db, "rooms", key, "members", user.uid),
        { uid: user.uid, displayName, joinedAt: serverTimestamp() },
        { merge: true }
      );

      await setDoc(
        doc(db, "users", user.uid, "rooms", key),
        {
          roomId: key,
          code: key,
          name: "Friends Draft",
          hostUid: user.uid,
          joinedAt: serverTimestamp(),
          lastSeenAt: serverTimestamp(),
        },
        { merge: true }
      );

      // ✅ CONNECT IMMEDIATELY (this makes UI feel instant)
      setRoomKeyInput(key);
      setRoomId(key);

      // ✅ seed players WITHOUT blocking UI
      const tz = "America/Los_Angeles";
      const fixtureDate = nextWeekdayISO(3, tz); // 3 = Wednesday

      setSeedingPlayers(true);
      const seedFn = httpsCallable(functions, "seedPlayersFromCompetition");
      seedFn({
        roomId: key,
        league: 2,
        season: 2025,
        fixtureDate,          // ✅ NEW
        timezone: tz,         // ✅ NEW
        maxPagesPerTeam: 2,   // ✅ NEW (usually plenty)
      })
        .then(() => setSeedingPlayers(false))
        .catch((e) => {
          console.error(e);
          setSeedingPlayers(false);
          alert("Room created, but fetching players failed. Check Functions logs.");
        });
    } catch (e) {
      console.error(e);
      alert("Failed to create room. Check console for details.");
    } finally {
      setCreatingRoom(false);
    }
  }

  // Join by code
  async function joinByCode() {
    if (!user) return alert("Sign in first");
    const key = roomKeyInput.trim().toUpperCase();
    if (!key) return alert("Enter a room key");
    const ref = doc(db, "rooms", key);
    const snap = await getDoc(ref);
    if (!snap.exists()) return alert("Room not found");

    const profile = await getUserProfile(user.uid).catch(() => null);
    const displayName = profile?.displayName || user.displayName || user.email || "User";

    // Subcollection mirror (optional)
    await setDoc(doc(db, "rooms", key, "members", user.uid), {
      uid: user.uid,
      displayName,
      joinedAt: serverTimestamp(),
    }, { merge: true });

    // Update room.members array if not present
    const data = snap.data();
    const arr = Array.isArray(data.members) ? data.members : [];
    if (!arr.find(m => m.uid === user.uid)) {
      await updateDoc(ref, { members: [...arr, { uid: user.uid, displayName }], updatedAt: serverTimestamp() });
    }

    await setDoc(doc(db, "users", user.uid, "rooms", key), {
      roomId: key,
      code: data.code || key,
      name: data.name || "Room",
      hostUid: data.hostUid || "",
      joinedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    }, { merge: true });


    setRoomId(key);
  }

  // Host: schedule start
  async function scheduleStart() {
    if (!user || !room) return;
    if (room.hostUid !== user.uid) return alert("Only host can schedule");
    if (!startLocalISO) return alert("Pick a date/time");
    const whenMillis = new Date(startLocalISO).getTime();
    await fnScheduleDraft({ roomId, startAtMs: whenMillis });
  }

  //Display Market Schedule 
  async function scheduleMarketOpen() {
    if (!user || !room) return;
    if (room.hostUid !== user.uid) return alert("Only host can schedule");
    if (!marketLocalISO) return alert("Pick a date/time");
    const whenMillis = new Date(marketLocalISO).getTime();
    await updateDoc(doc(db, "rooms", roomId), {
      marketOpenAt: whenMillis,
      updatedAt: serverTimestamp(),
    });
  }
  // Host: start now
  async function startNow() {
    if (!user || !room) return;
    if (room.hostUid !== user.uid) return alert("Only host can start");
    try {
      await callStartDraftNow({ roomId });
    } catch (e) {
      alert(e?.message || "Failed to start");
    }
  }

  // Flip to started when scheduled time arrives
  useEffect(() => {
    if (!room?.startAt || room.started || !roomId) return;
    const targetMillis =
      typeof room.startAt === "number"
        ? room.startAt
        : room.startAt?.toDate
        ? room.startAt.toDate().getTime()
        : null;
    if (!targetMillis) return;

    const tid = setInterval(async () => {
      if (Date.now() >= targetMillis) {
        clearInterval(tid);
        try { await callMaybeStartDraft({ roomId }); } catch {}
      }
    }, 1000);
    return () => clearInterval(tid);
  }, [room?.startAt, room?.started, roomId]);

  // Who is on the clock (snake)
  const currentPicker = useMemo(() => {
    if (!room) return null;
    const order = (Array.isArray(room.draftOrder) && room.draftOrder.length)
      ? room.draftOrder
      : (Array.isArray(room.members) ? room.members : []);
    const n = order.length;
    if (!n) return null;
    const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    const totalRounds = room.totalRounds ?? 16;
    const maxPicks = totalRounds * n;
    if (ti >= maxPicks) return null;
    const roundIndex = Math.floor(ti / n);
    const withinRound = ti % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    return order[orderIndex] || null;
  }, [room]);

  //Next picker 
  const nextPicker = useMemo(() => {
    if (!room) return null;
    const order = (Array.isArray(room.draftOrder) && room.draftOrder.length)
      ? room.draftOrder
      : (Array.isArray(room.members) ? room.members : []);
    const n = order.length;
    if (!n) return null;

    const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    const totalRounds = room.totalRounds ?? 16;
    const maxPicks = totalRounds * n;
    if (ti + 1 >= maxPicks) return null;

    const nextTi = ti + 1;
    const roundIndex = Math.floor(nextTi / n);
    const withinRound = nextTi % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    return order[orderIndex] || null;
  }, [room]);


  const currentRoundIdx = useMemo(() => {
    const n = room?.draftOrder?.length || room?.members?.length || 1;
    return Math.floor((room?.turnIndex ?? 0) / n);
  }, [room?.turnIndex, room?.members?.length, room?.draftOrder?.length]);

  const requiredSlot = null;

  const [posFilterState, searchState] = [posFilter, search]; // just to keep deps short
  const pickedIds = useMemo(() => new Set(picks.map(p => String(p.playerId))), [picks]);
  const loadingPlayers = !!roomId && poolPlayers.length === 0;

  // Put this ABOVE your availablePlayers useMemo
  function normalizeDraftPos(pos) {
    const p = String(pos || "").toUpperCase();

    // API-Football often gives FWD/ST/CF etc — your draft only allows ATT/MID/DEF/GK
    if (["FWD", "FW", "ST", "CF"].includes(p)) return "ATT";

    if (["ATT"].includes(p)) return "ATT";
    if (["MID", "MF", "CM", "CDM", "CAM", "LM", "RM"].includes(p)) return "MID";
    if (["DEF", "DF", "CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";
    if (["GK", "GKP"].includes(p)) return "GK";

    return p;
  }

  // If you have poolPlayers from Firestore, use them; otherwise fall back to MOCK_PLAYERS
  const ALL_PLAYERS = (poolPlayers?.length ? poolPlayers : MOCK_PLAYERS).map((p) => ({
    ...p,
    id: String(p.id),
    name: p.fullName ?? p.name ?? "",
    position: normalizeDraftPos(p.position),
  }));

  const availablePlayers = useMemo(() => {
    const q = searchState.trim().toLowerCase();

    // show nothing until user types
    if (!q) return [];

    return ALL_PLAYERS
      .filter((p) => {
        if (pickedIds.has(p.id)) return false;
        if (posFilterState !== "ALL" && p.position !== posFilterState) return false;
        if (!p.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .slice(0, 10);
  }, [ALL_PLAYERS, posFilterState, searchState, pickedIds]);

  const canPickNow = room?.started && currentPicker?.uid === user?.uid;

  const isDraftComplete = useMemo(() => {
    const n = room?.draftOrder?.length || room?.members?.length || 0;
    if (!n) return false;
    const totalRounds = room?.totalRounds ?? 9;
    const ti = Number.isFinite(room?.turnIndex) ? room.turnIndex : 0;
    return ti >= totalRounds * n;
  }, [room]);

  async function pickPlayer(player) {
    if (!canPickNow) return alert(!room?.started ? "Draft not started" : "Not your turn");
    if (isDraftComplete) return alert("Draft is complete");
    try {
      await callMakePick({
        roomId,
        playerId: player.id,
        position: normalizeDraftPos(player.position),
        playerName: player.name,

        apiPlayerId: player.apiPlayerId ?? player.id,
        apiTeamId: player.apiTeamId ?? player.teamId,
        teamName: player.teamName ?? "",

        nationality: player.nationality ?? "",
      });
    } catch (e) {
      alert(e?.message || "Pick failed");
    }
  }

  // Countdown
  useEffect(() => {
    triedAutoRef.current = false;
    const deadlineMs = typeof room?.turnDeadlineAt === "number" ? room.turnDeadlineAt : null;
    const tick = () => {
      if (!deadlineMs) return setTimeLeft(TURN_SECONDS);
      setTimeLeft(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [room?.turnDeadlineAt, room?.turnIndex]);

  // Host auto-pick when timer hits 0
  useEffect(() => {
    if (!room?.started || isDraftComplete) return;
    if (timeLeft > 0 || triedAutoRef.current) return;
    triedAutoRef.current = true;
    if (!room?.hostUid) return;

    const candidates = availablePlayers.map(p => ({
      id: p.id,
      name: p.name,
      position: normalizeDraftPos(p.position),
      apiPlayerId: p.apiPlayerId ?? p.id,
      apiTeamId: p.apiTeamId ?? p.teamId,
      teamName: p.teamName ?? "",
      nationality: p.nationality ?? "",
    }));

    if (!candidates.length) return;

    (async () => {
      try { await callAutoPick({ roomId, candidates }); }
      catch (e) { console.warn("Auto-pick failed:", e?.message || e); }
    })();
  }, [timeLeft, room?.started, isDraftComplete, user?.uid, room?.hostUid, roomId, availablePlayers, requiredSlot]);

  //User Picture 
  const memberUids = useMemo(() => {
    return (room?.members || []).map((m) => m.uid).filter(Boolean);
  }, [room?.members]);
  const profilesByUid = useUserProfiles(memberUids);

  function profileOf(uid) {
    return profilesByUid?.[uid] || {};
  }

  const currentName = displayNameOf(currentPicker, "—");
  const nextName = displayNameOf(nextPicker, "—");
  const currentPhoto = currentPicker ? profileOf(currentPicker.uid)?.photoURL : "";
  const nextPhoto = nextPicker ? profileOf(nextPicker.uid)?.photoURL : "";

  //Draft Name 
  const isHost = user?.uid && room?.hostUid === user.uid;

  const [isEditingDraftName, setIsEditingDraftName] = useState(false);
  const [draftNameInput, setDraftNameInput] = useState("");

  // keep input synced when room updates
  useEffect(() => {
    setDraftNameInput(room?.name || "Friends Draft");
  }, [room?.name]);

  async function saveDraftName() {
    if (!isHost || !roomId) return;

    const clean = (draftNameInput || "").trim();
    if (clean.length < 2) return alert("Draft name must be at least 2 characters.");
    if (clean.length > 30) return alert("Draft name must be 30 characters or less.");

    await updateDoc(doc(db, "rooms", roomId), {
      name: clean,
      updatedAt: serverTimestamp(),
    });

    setIsEditingDraftName(false);
  }

  // ----- UI -----
  return (
    <div className="min-h-screen w-full bg-gray-50">
      <div className="mx-auto max-w-6xl lg:max-w-7xl px-4 md:px-6 py-6">
      {/* Create / Join */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 mb-4">
        <div className="text-lg font-semibold mb-2">Create / Join a Room</div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="flex items-center gap-2">
            <button
              onClick={createRoom}
              disabled={creatingRoom}
              className="draftRoomBtn draftRoomBtnPrimary"
            >
              {creatingRoom ? "Creating Room..." : "Create Room (Host)"}
            </button>
            {seedingPlayers && (<div className="text-sm opacity-70">Fetching players…</div>)}
            {room?.code && <div className="text-sm">Room Key: <b>{room.code}</b></div>}
          </div>
          <div className="flex items-center gap-2">
            <input
              className="border px-3 py-2 rounded w-full"
              placeholder="Enter room key"
              value={roomKeyInput}
              onChange={(e) => setRoomKeyInput(e.target.value.toUpperCase())}
            />
            <button onClick={joinByCode} className="draftRoomBtn draftRoomBtnOutline">Join</button>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-sm opacity-70">
              {roomId ? <>Connected to <b>{roomId}</b></> : "Not connected"}
            </div>
          </div>
        </div>
      </div>

      {/* If no room selected */}
      {!room && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 text-center">
          <div className="text-lg font-semibold mb-2">Waiting to connect…</div>
          <p className="opacity-70">Create a room or enter a room key to continue.</p>
        </div>
      )}

      {/* Room UI */}
      {room && (
        <>
          {/* Waiting room */}
          {!room.started && (
             <div>
              {/* Soccer-themed waiting room header */}
              <div className="flex items-center gap-2 mb-4">
                <Medal className="text-green-500 w-6 h-6" />
                <h2 className="font-bold text-2xl text-slate-800">Waiting Room</h2>
              </div>
              {seedingPlayers && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                  <b>Fetching players…</b> You can stay in the room while the player pool loads.
                </div>
              )}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Left: Room & Managers */}
              <Card className="bg-pitch text-line shadow-lg border border-goal min-h-[420px]">
                <CardHeader>
                  <CardTitle className="font-sporty text-2xl md:text-3xl">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span>🏟️</span>

                      {!isEditingDraftName ? (
                        <>
                          <span className="tracking-wide">{room?.name || "Friends Draft"}</span>

                          {isHost && (
                            <button
                              type="button"
                              className="rounded-md px-3 py-2 text-sm font-semibold tracking-widest bg-line/25 hover:bg-line/35 border border-line/60"
                              onClick={() => setIsEditingDraftName(true)}
                              title="Edit draft name"
                            >
                              Edit
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            value={draftNameInput}
                            onChange={(e) => setDraftNameInput(e.target.value)}
                            className="w-56 max-w-full rounded border border-line/60 bg-white px-2 py-1 text-lg  tracking-widest text-slate-900"
                            placeholder="Draft name"
                            autoFocus
                          />
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-xs tracking-widest bg-goal text-ball hover:opacity-95"
                            onClick={saveDraftName}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-xs tracking-widest bg-line/20 hover:bg-line/30"
                            onClick={() => {
                              setDraftNameInput(room?.name || "Friends Draft");
                              setIsEditingDraftName(false);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-base md:text-lg font-bold tracking-widest">Room Code:</span>
                      <span className="px-3 py-1 rounded-lg bg-pitchLight border border-line/60 text-base md:text-lg font-bold tracking-widest">
                        {room.code || roomId}
                      </span>
                    </div>
                  </CardTitle>
                  <p className="text-sm/relaxed opacity-90">
                    Host: {members.find((m) => m.uid === room.hostUid)?.displayName || room.hostUid}
                  </p>
                </CardHeader>
                <CardContent>
                  <h3 className="font-semibold mb-2">⚽ Managers in Room</h3>
                  <div className="space-y-2">
                    {(room.members || []).map((m) => (
                      <div
                        key={m.uid}
                        className="flex items-center justify-between rounded-lg border border-line/60 bg-pitchLight p-2"
                      >
                        <div className="flex items-center gap-3">
                          {(() => {
                            const p = profileOf(m.uid);
                            const name = displayNameOf(m);
                            return (
                              <Avatar className="h-10 w-10 border-2 border-line/60">
                                <AvatarImage src={p.photoURL || undefined} alt={name} />
                                <AvatarFallback className="bg-line text-pitch font-bold">
                                  {(name || "U").slice(0, 2).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                            );
                          })()}
                          <span className="font-medium">{displayNameOf(m)}</span>
                        </div>
                        {m.uid === room.hostUid && <Badge className="bg-goal text-ball">Host</Badge>}
                      </div>
                    ))}
                    {(!room.members || room.members.length === 0) && (
                      <p className="text-sm opacity-80">No members yet.</p>
                    )}
                  </div>

                  <h3 className="font-semibold mt-4 mb-2">📋 Draft Order (Round 1)</h3>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    {roundOrder(room.members || [], 0).map((m, idx) => (
                      <li key={m.uid} className="rounded border border-line/60 bg-pitch/70 px-2 py-1">
                        #{idx + 1} — {displayNameOf(m)}
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs opacity-90 mt-2">
                    Order locks when the host starts.
                  </p>
                </CardContent>
              </Card>

              {/* Right: Draft Status / Host Controls */}
              <Card className="bg-pitch text-line shadow-lg border border-goal min-h-[420px]">
                <CardHeader>
                  <CardTitle className="font-sporty text-2xl">📊 Draft Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm mb-3">
                    {room.startAt ? "Scheduled" : "Not scheduled"} • Turn: {room.turnIndex ?? 0}
                  </p>
                  {/* Everyone sees scheduled draft start */}
                  {room.startAt ? (
                    <div className="text-sm mb-3">
                      🗓️ <b>Draft starts:</b> {formatWhen(room.startAt)}{" "}
                      <span className="opacity-80">
                        ({countdownStr(secondsUntil(room.startAt, clockNow))} remaining)
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm mb-3 opacity-80">
                      🗓️ Draft start time not set yet.
                    </div>
                  )}

                  {user?.uid === room.hostUid ? (
                    <HostControls
                      startLocalISO={startLocalISO}
                      setStartLocalISO={setStartLocalISO}
                      scheduleStart={scheduleStart}
                      startNow={startNow}
                      seedingPlayers={seedingPlayers}
                    />
                  ) : (
                    <p className="text-sm opacity-90">
                      Waiting for host to schedule or start…
                    </p>
                  )}
                  <p className="mt-4 text-xs opacity-90">
                    Draft plan: Pick any player.
                  </p>
                </CardContent>
              </Card>
            </div>
            </div>
          )}


          {/* Draft started */}
          {room.started && (
            <div className="grid gap-4 md:grid-cols-3">
              {/* Summary + countdown */}
              <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
                <div className="font-semibold">{room.name} — {room.code || roomId}</div>
                <div className="text-sm opacity-70">
                  Round: <b>{Math.floor((room.turnIndex ?? 0) / (room.members?.length || 1)) + 1}</b> / {room.totalRounds ?? 9}
                </div>
                <div className="mt-2 text-sm">Required slot: <b>{requiredSlot || "-"}</b></div>
                <div className="draftTurnBanner">
                  <div className="draftTurnMain">
                    <Avatar className="draftTurnAvatar">
                      <AvatarImage src={currentPhoto || undefined} alt={currentName} />
                      <AvatarFallback className="draftTurnFallback">
                        {(currentName || "U").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>

                    <div>
                      <div className="draftTurnLabel">On the clock</div>
                      <div className="draftTurnName">{currentName}</div>
                    </div>
                  </div>

                  <div className="draftTurnNext">
                    <div className="draftTurnLabel">Next</div>
                    <div className="draftTurnNextRow">
                      <Avatar className="draftTurnAvatarSmall">
                        <AvatarImage src={nextPhoto || undefined} alt={nextName} />
                        <AvatarFallback className="draftTurnFallbackSmall">
                          {(nextName || "U").slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="draftTurnNextName">{nextName}</span>
                    </div>
                  </div>
                </div>
                {!isDraftComplete && (
                  <div className="mt-3">
                    <div className="text-sm font-semibold">Time left</div>
                    <div className={`text-2xl font-bold ${timeLeft <= 5 ? "text-red-600" : ""}`}>{timeLeft}s</div>
                    {user?.uid === room.hostUid && (
                      <div className="text-xs opacity-70 mt-1">Host will auto-pick if timer hits 0.</div>
                    )}
                  </div>
                )}
              </div>

              {/* Player Pool (only current picker sees it) */}
              {isDraftComplete ? (
                <div className="rounded-2xl border border-emerald-300 p-4 bg-emerald-50 shadow-sm md:col-span-1 grid place-items-center">
                  <div className="text-center">
                    <div className="font-semibold">Draft complete 🎉</div>
                    <div className="text-sm opacity-70">All rounds are finished.</div>
                  </div>
                </div>
              ) : currentPicker?.uid === user?.uid ? (
                <PlayerPool
                  availablePlayers={availablePlayers}
                  loadingPlayers={loadingPlayers}
                  posFilter={posFilter}
                  setPosFilter={setPosFilter}
                  search={search}
                  setSearch={setSearch}
                  onPick={pickPlayer}
                  requiredSlot={requiredSlot}
                />
              ) : (
                <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm md:col-span-1 grid place-items-center">
                  <div className="text-center">
                    <div className="font-semibold">Waiting for pick…</div>
                    <div className="text-sm opacity-70">
                      {displayNameOf(currentPicker, "Someone")} is on the clock.
                    </div>
                  </div>
                </div>
              )}

              {/* Draft Order + Picks */}
              <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm md:col-span-1">
                <div className="font-semibold mb-2">Draft Order (Frozen)</div>
                <ol className="text-sm space-y-1 list-decimal list-inside">
                  {(room.draftOrder || []).map((m, idx) => {
                    const isCurrent = currentPicker?.uid === m.uid;
                    return (
                      <li
                        key={m.uid}
                        className={`border rounded px-2 py-1 ${isCurrent ? "bg-yellow-50 border-yellow-300" : ""}`}
                        title={isCurrent ? "On the clock" : ""}
                      >
                        #{idx + 1} — {displayNameOf(m)} {isCurrent ? " • on the clock" : ""}
                      </li>
                    );
                  })}
                  {(!room.draftOrder || room.draftOrder.length === 0) && (
                    <div className="opacity-60">Order appears when the draft starts.</div>
                  )}
                </ol>

                <div className="mt-4">
                  <div className="font-semibold mb-1">
                    This Round Order (Round {Math.floor((room.turnIndex ?? 0) / (room.members?.length || 1)) + 1})
                  </div>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    {roundOrder(room.draftOrder || room.members || [], Math.floor((room.turnIndex ?? 0) / (room.members?.length || 1)))
                      .map((m, idx) => {
                        const isCurrent = currentPicker?.uid === m.uid;
                        return (
                          <li key={m.uid} className={`border rounded px-2 py-1 ${isCurrent ? "bg-green-50 border-green-300" : ""}`}>
                            #{idx + 1} — {displayNameOf(m)} {isCurrent ? " • on the clock" : ""}
                          </li>
                        );
                      })}
                  </ol>
                </div>

                <div className="font-semibold mt-4 mb-2">All Picks</div>
                <ol className="text-sm space-y-1 max-h-[40vh] overflow-auto">
                  {picks.map((p) => (
                    <li key={p.playerId} className="border rounded px-2 py-1 flex items-center justify-between">
                      <span>
                        <b>#{p.turn}</b> — {p.displayName} picked <b>{p.playerName}</b>{" "}
                        <span className="opacity-70">({p.position})</span>
                      </span>
                      <span className="opacity-70">Round {p.round}</span>
                    </li>
                  ))}
                  {picks.length === 0 && <div className="opacity-60">No picks yet.</div>}
                </ol>
              </div>
            </div>         
          )}

          {roomId && isDraftComplete && (
            <div className="mt-6">
              <Marketplace
                roomId={roomId}
                user={user}
                isHost={user?.uid === room?.hostUid}
                players={poolPlayers}
              />
            </div>
          )}


        </>
      )}
      </div>
    </div>
  );
}

// ----- Subcomponents -----
function HostControls({ startLocalISO, setStartLocalISO, scheduleStart, startNow, seedingPlayers }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <input
        type="datetime-local"
        className="border px-2 py-2 rounded w-full sm:w-auto"
        value={startLocalISO}
        onChange={(e) => setStartLocalISO(e.target.value)}
      />
      <button onClick={scheduleStart} disabled={seedingPlayers} className="draftRoomBtn draftRoomBtnAmber">
        {seedingPlayers ? "Fetching players..." : "Schedule"}
      </button>
      <button
       onClick={startNow}
       disabled={seedingPlayers}
       className="draftRoomBtn draftRoomBtnPrimary">
        {seedingPlayers ? "Fetching players..." : "Start Draft Now"}
      </button>
    </div>
  );
}

function PlayerPool({
  availablePlayers,
  loadingPlayers,         
  posFilter,
  setPosFilter,
  search,
  setSearch,
  onPick,
  requiredSlot,
}) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm md:col-span-1">
      <div className="font-semibold mb-2">Player Pool</div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          className="border px-3 py-2 rounded"
          value={posFilter}
          onChange={(e) => setPosFilter(e.target.value)}
        >
          <option value="ALL">All</option>
          <option value="ATT">ATT</option>
          <option value="MID">MID</option>
          <option value="DEF">DEF</option>
          <option value="GK">GK</option>
        </select>

        <input
          className="border px-3 py-2 rounded flex-1 min-w-[200px]"
          placeholder="Search player…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="text-xs opacity-70 mb-2">
        Required this round: <b>{requiredSlot || "-"}</b>
        {requiredSlot === "SUB" ? " (any position allowed)" : ""}
      </div>

      <div className="grid gap-2">
        {loadingPlayers ? (
          <div className="opacity-70 p-2">Loading players from API…</div>
        ) : (
          <>
            {availablePlayers.map((pl) => {
              const blocked = requiredSlot && requiredSlot !== "SUB" && pl.position !== requiredSlot;

              return (
                <div key={pl.id} className="border rounded p-3 flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{pl.name}</div>

                    {/* ✅ C: show nationality (country) */}
                    <div className="text-xs opacity-70">
                      {pl.position}
                      {pl.nationality ? ` • ${pl.nationality}` : ""}
                      {pl.teamName ? ` • ${pl.teamName}` : ""}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="border px-3 py-1 rounded bg-black text-white disabled:opacity-50"
                    disabled={blocked}
                    onClick={() => onPick(pl)}
                    title={blocked ? `This round requires ${requiredSlot}` : "Pick"}
                  >
                    Pick
                  </button>
                </div>
              );
            })}

            {availablePlayers.length === 0 && (
              <div className="opacity-60">No players match filters / all taken.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

