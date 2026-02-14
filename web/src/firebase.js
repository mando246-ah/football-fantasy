// web/src/firebase.js
import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  updateProfile,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  serverTimestamp,
  updateDoc,
  onSnapshot,
} from "firebase/firestore";
import { collection, getDocs, query, where, addDoc } from "firebase/firestore";
import { writeBatch } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

//Player pool to FireStore
export async function seedRoomPlayers(roomId, players) {
  if (!roomId) throw new Error("Missing roomId");
  if (!Array.isArray(players) || players.length === 0) return;

  const batch = writeBatch(db);

  for (const p of players) {
    const id = String(p.id);
    const ref = doc(db, "rooms", roomId, "players", id);
    batch.set(ref, { ...p, id }, { merge: true });
  }

  await batch.commit();
}

/* =========================
   Firebase App Config
   =========================
*/

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
};

// Dev vs Prod base URL for magic link redirect
const ORIGIN = (typeof window !== "undefined" && window.location.origin) || "";
const IS_LOCAL = ORIGIN.includes("localhost") || ORIGIN.includes("127.0.0.1");
const PROD_URL = "https://fifa-fantasy-4a7e3.web.app";
export const WEB_BASE_URL = IS_LOCAL ? "http://localhost:5173" : PROD_URL;

// Init
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const functions = getFunctions(app, "us-west2");


//User Pictures
export async function uploadUserAvatar(uid, file) {
  if (!uid) throw new Error("Missing uid");
  if (!file) throw new Error("No file selected");

  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) throw new Error("Please upload a PNG, JPG, or WEBP.");
  if (file.size > 2 * 1024 * 1024) throw new Error("Max file size is 2MB.");

  const storage = getStorage(app);

  const ext =
    file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";

  // Overwrite so you don’t store infinite avatars
  const avatarRef = ref(storage, `userAvatars/${uid}/avatar.${ext}`);

  await uploadBytes(avatarRef, file, {
    contentType: file.type,
    cacheControl: "public,max-age=86400",
  });

  const photoURL = await getDownloadURL(avatarRef);

  // Save to Firestore profile doc so your app can show it everywhere
  await setDoc(
    doc(db, "users", uid),
    { photoURL, updatedAt: serverTimestamp() },
    { merge: true }
  );

  return photoURL;
}
/* =========================
   “Remember me” preference
   ========================= */
const REMEMBER_KEY = "remember_me";

export function getRememberMe() {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== "0";
  } catch {
    return true; // default to remember
  }
}
export function setRememberMe(value) {
  try {
    localStorage.setItem(REMEMBER_KEY, value ? "1" : "0");
  } catch {}
}

export async function choosePersistenceFromPref() {
  const remember = getRememberMe();
  await setPersistence(
    auth,
    remember ? browserLocalPersistence : browserSessionPersistence
  );
}

// Google Sign In
const googleProvider = new GoogleAuthProvider();
// optional: forces account chooser each time
googleProvider.setCustomParameters({ prompt: "select_account" });

export async function signInWithGoogleWithPref() {
  await choosePersistenceFromPref();

  try {
    // Best UX on desktop
    return await signInWithPopup(auth, googleProvider);
  } catch (e) {
    // Popup blocked or third-party cookie issues → fallback
    if (e?.code === "auth/popup-blocked" || e?.code === "auth/popup-closed-by-user") {
      await signInWithRedirect(auth, googleProvider);
      return null;
    }
    throw e;
  }
}

// Call this once on app load (e.g., App.jsx useEffect) to complete redirect flow
export async function completeGoogleRedirectIfAny() {
  try {
    const res = await getRedirectResult(auth);
    return res || null;
  } catch (e) {
    // ignore if no redirect is pending
    if (e?.code === "auth/no-auth-event") return null;
    throw e;
  }
}


/* =========================
   Magic link auth helpers
   ========================= */
export async function sendMagicLinkWithPref(email) {
  await choosePersistenceFromPref();

  // store the email only if remember-me is on
  if (getRememberMe()) {
    localStorage.setItem("magicLinkEmail", email);
  } else {
    localStorage.removeItem("magicLinkEmail");
  }

  const actionCodeSettings = {
    url: `${WEB_BASE_URL}/signin`,
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
}
export async function sendMagicLink(email) {
  const actionCodeSettings = {
    url: window.location.origin + "/signin",
    handleCodeInApp: true,
  };
  localStorage.setItem("magicLinkEmail", email);
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
}

export async function completeRedirectIfAny() {
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let email = localStorage.getItem("magicLinkEmail");
    if (!email) {
      email = window.prompt("Confirm your email to finish sign-in:");
    }
    await signInWithEmailLink(auth, email, window.location.href);
    if (!getRememberMe()) localStorage.removeItem("magicLinkEmail");
  }
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function signOutNow() {
  await signOut(auth);
}

/* =========================
   User profile helpers
   ========================= */
export async function saveDisplayName(uid, displayName) {
  const ref = doc(db, "users", uid);
  await setDoc(
    ref,
    { displayName, updatedAt: serverTimestamp() },
    { merge: true }
  );
  try {
    if (auth.currentUser?.uid === uid) {
      await updateProfile(auth.currentUser, { displayName });
    }
  } catch {
    // non-fatal
  }
}

export async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

export function watchUserProfile(uid, cb) {
  if (!uid) return () => {};
  const ref = doc(db, "users", uid);
  return onSnapshot(ref, (s) => cb(s.exists() ? s.data() : null)
);
}

/* =========================
   Room helpers
   ========================= */
export function setLastRoomId(roomId) {
  if (roomId){
    localStorage.setItem("lastRoomId", roomId);
    window.dispatchEvent(new Event("lastRoomIdChanged"));
  } 
}
export function getLastRoomId() {
  return localStorage.getItem("lastRoomId");
}

export async function joinRoom(roomId, { displayName }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  if (!roomId) throw new Error("Missing roomId");

  const roomRef = doc(db, "rooms", roomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) throw new Error("Room not found");

  const room = snap.data();
  const members = Array.isArray(room.members) ? room.members : [];

  const name =
    displayName ||
    user.displayName ||
    user.email ||
    "Manager";

  const exists = members.some(m => m.uid === user.uid);
  const nextMembers = exists
    ? members.map(m => m.uid === user.uid ? { ...m, displayName: name } : m)
    : [...members, { uid: user.uid, displayName: name, joinedAt: Date.now() }];

  await updateDoc(roomRef, {
    members: nextMembers,
    updatedAt: serverTimestamp(),
  });

  setLastRoomId(roomId);
  return { ok: true };
}

export async function leaveRoom(roomId) {
  const user = auth.currentUser;
  if (!user) return;

  const roomRef = doc(db, "rooms", roomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;

  const room = snap.data();
  const members = Array.isArray(room.members) ? room.members : [];
  const next = members.filter(m => m.uid !== user.uid);

  await updateDoc(roomRef, {
    members: next,
    updatedAt: serverTimestamp(),
  });
}


export function watchRoom(roomId, cb) {
  if (!roomId) return () => {};
  const roomRef = doc(db, "rooms", roomId);
  return onSnapshot(roomRef, (s) => cb(s.exists() ? s.data() : null));
}

/* =========================
   Draft helpers
   ========================= */
const TURN_SECONDS = 120; // used for deadline; UI can show a small timer
const DEFAULT_DRAFT_PLAN = ["ATT", "ATT", "MID", "MID", "DEF", "DEF", "GK", "SUB", "SUB"];

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  return user;
}
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


export async function callMaybeStartDraft({ roomId }) {
  const roomRef = doc(db, "rooms", roomId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const room = snap.data();
    if (room.started) return;

    const now = Date.now();
    const startAtMillis =
      typeof room.startAt === "number"
        ? room.startAt
        : room.startAt?.toDate
        ? room.startAt.toDate().getTime()
        : null;

    if (startAtMillis && now >= startAtMillis) {
      const members = Array.isArray(room.members) ? room.members : [];
      if (members.length === 0) throw new Error("No members to start draft");
      const draftOrder = room.draftOrder?.length ? room.draftOrder : shuffleArray(members);
      const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
      tx.update(roomRef, {
        started: true,
        startedAt: serverTimestamp(),
        draftOrder,
        turnIndex: ti,
        turnDeadlineAt: now + TURN_SECONDS * 1000,
        updatedAt: serverTimestamp(),
      });
    }
  });
  return { ok: true };
}

export async function callStartDraftNow({ roomId }) {
  const user = requireUser();
  const roomRef = doc(db, "rooms", roomId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const room = snap.data();
    if (room.started) return;
    if (room.hostUid !== user.uid) throw new Error("Only host can start");

    const members = Array.isArray(room.members) ? room.members : [];
    if (members.length === 0) throw new Error("No members to start draft");

    const draftOrder = room.draftOrder?.length ? room.draftOrder : shuffleArray(members);
    const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    tx.update(roomRef, {
      started: true,
      startedAt: serverTimestamp(),
      draftOrder,
      turnIndex: ti,
      turnDeadlineAt: Date.now() + TURN_SECONDS * 1000,
      updatedAt: serverTimestamp(),
    });
  });
  return { ok: true };
}

function normalizePos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "FWD") return "ATT";
  return p;
}

export async function callMakePick({
  roomId,
  playerId,
  position,
  playerName,
  apiPlayerId,
  apiTeamId,
  teamName,
  nationality,
}) {
  const user = requireUser();

  const allowedPositions = new Set(["ATT", "MID", "DEF", "GK"]);
  const pos = normalizePos(position);
  if (!allowedPositions.has(pos)) throw new Error("Position must be one of ATT, MID, DEF, GK");

  const pid = String(playerId);
  const roomRef = doc(db, "rooms", roomId);
  const pickRef = doc(db, "rooms", roomId, "picks", pid);

  await runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("Room not found");
    const room = roomSnap.data();
    if (!room.started) throw new Error("Draft has not started");

    const order =
      (Array.isArray(room.draftOrder) && room.draftOrder.length)
        ? room.draftOrder
        : (Array.isArray(room.members) ? room.members : []);

    const n = order.length;
    if (n === 0) throw new Error("Room has no members");

    const totalRounds = room.totalRounds ?? 9;
    const maxPicks = totalRounds * n;
    const turnIndex = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    if (turnIndex >= maxPicks) throw new Error("All rounds completed");

    const roundIndex = Math.floor(turnIndex / n);
    const withinRound = turnIndex % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    const picker = order[orderIndex];
    if (!picker?.uid) throw new Error("Invalid draft order");
    if (picker.uid !== user.uid) throw new Error("Not your turn");

    const existingPick = await tx.get(pickRef);
    if (existingPick.exists()) throw new Error("Player already picked");

    const pickerName =
      user.displayName ||
      (await getDisplayNameFallback(tx, user.uid)) ||
      "Manager";

    const now = Date.now();
    const nextTurnIndex = turnIndex + 1;
    const nextDeadline = (nextTurnIndex < maxPicks) ? now + TURN_SECONDS * 1000 : null;

    tx.set(pickRef, {
      playerId: pid,
      playerName: String(playerName || playerId),
      position: pos,

      uid: picker.uid,
      displayName: pickerName,

      turn: turnIndex + 1,
      round: roundIndex + 1,
      createdAt: serverTimestamp(),

      ...(apiPlayerId != null ? { apiPlayerId: Number(apiPlayerId) } : {}),
      ...(apiTeamId != null ? { apiTeamId: Number(apiTeamId) } : {}),
      ...(teamName ? { teamName: String(teamName) } : {}),
      ...(nationality ? { nationality: String(nationality) } : {}),
    });

    tx.update(roomRef, {
      turnIndex: nextTurnIndex,
      turnDeadlineAt: nextDeadline,
      updatedAt: serverTimestamp(),
    });
  });

  return { ok: true };
}

export async function callAutoPick({ roomId, candidates }) {
  const user = requireUser();
  const roomRef = doc(db, "rooms", roomId);

  await runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("Room not found");
    const room = roomSnap.data();

    if (!room.started) throw new Error("Draft not started");
    if (room.hostUid !== user.uid) throw new Error("Only host can auto-pick");

    const order = (Array.isArray(room.draftOrder) && room.draftOrder.length)
      ? room.draftOrder
      : (Array.isArray(room.members) ? room.members : []);
    const n = order.length;
    if (n === 0) throw new Error("Room has no members");

    const totalRounds = room.totalRounds ?? 9;
    const maxPicks = totalRounds * n;
    const turnIndex = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    if (turnIndex >= maxPicks) throw new Error("Draft complete");

    const deadline = typeof room.turnDeadlineAt === "number" ? room.turnDeadlineAt : null;
    if (!deadline || Date.now() < deadline) throw new Error("Deadline not reached");

    const roundIndex = Math.floor(turnIndex / n);
    const withinRound = turnIndex % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    const picker = order[orderIndex];
    if (!picker?.uid) throw new Error("Invalid draft order");

    const pool = Array.isArray(candidates) ? candidates : [];
    if (!pool.length) throw new Error("No candidates available for auto-pick");

    let choice = null;
    for (let safety = 0; safety < 50 && !choice; safety++) {
      const tryOne = pool[Math.floor(Math.random() * pool.length)];
      if (!tryOne) continue;
      const pid = String(tryOne.id);
      const pRef = doc(db, "rooms", roomId, "picks", pid);
      const exists = await tx.get(pRef);
      if (!exists.exists()) choice = tryOne;
    }
    if (!choice) throw new Error("Could not find a free player to auto-pick");

    const pid = String(choice.id);
    const allowed = new Set(["ATT","MID","DEF","GK"]);
    const pos = normalizePos(choice.position);

    const pickRef = doc(db, "rooms", roomId, "picks", pid);

    const pickerName =
      picker.displayName ||
      (await getDisplayNameFallback(tx, picker.uid)) ||
      "Manager";

    const now = Date.now();
    const nextTurnIndex = turnIndex + 1;
    const nextDeadline = (nextTurnIndex < maxPicks) ? now + TURN_SECONDS * 1000 : null;

    tx.set(pickRef, {
      playerId: pid,
      playerName: choice.name || pid,
      position: pos,
      uid: picker.uid,
      displayName: pickerName,
      turn: turnIndex + 1,
      round: roundIndex + 1,
      createdAt: serverTimestamp(),

      ...(choice.apiPlayerId != null ? { apiPlayerId: String(choice.apiPlayerId) } : {}),
      ...(choice.apiTeamId != null ? { apiTeamId: String(choice.apiTeamId) } : {}),
      ...(choice.teamName ? { teamName: String(choice.teamName) } : {}),
      ...(choice.nationality ? { nationality: String(choice.nationality) } : {}),
    });

    tx.update(roomRef, {
      turnIndex: nextTurnIndex,
      turnDeadlineAt: nextDeadline,
      updatedAt: serverTimestamp(),
    });
  });

  return { ok: true };
}

// Save interest (up to two choices), each with a swapOut from your roster
export async function marketSaveInterest({ roomId, choices }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  // Trim to two
  const trimmed = Array.isArray(choices) ? choices.slice(0, 2) : [];

  // Normalize items
  const clean = trimmed
    .filter((c) => c && c.wantId && c.swapOutId)
    .map((c) => ({ wantId: String(c.wantId), swapOutId: String(c.swapOutId) }));

  // ✅ reliable display name
  const profile = await getUserProfile(user.uid).catch(() => null);
  const displayName =
    profile?.displayName ||
    user.displayName ||
    user.email ||
    "Manager";

  await setDoc(doc(db, "rooms", roomId, "marketInterest", user.uid), {
    uid: user.uid,
    displayName,         // ✅ now defined
    choices: clean,      // ✅ save the cleaned version
    updatedAt: serverTimestamp(),
  }, { merge: true });

  return { ok: true };
}


// Resolve the market by priority (lowest total points first)
export async function marketResolve({ roomId }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);
  if(!roomSnap.exists()) throw new Error("Room Not Found");

  const room = roomSnap.data();
  if(room.hostUid !== user.uid){
    throw new Error(`Only host can resolve market (hostUid=${room.hostUid}, you=${user.uid})`);
  }

  // We’ll read everything we need outside the TX, then confirm state+write in TX.
  const [picksSnap, playersSnap, interestSnap] = await Promise.all([
    getDocs(collection(db, "rooms", roomId, "picks")),
    getDocs(collection(db, "rooms", roomId, "players")),
    getDocs(collection(db, "rooms", roomId, "marketInterest")),
  ]);

  // Build helper maps/sets
  const pickedIds = new Set();
  const picksByUser = new Map(); // uid -> pick docs (for points + swap validation)
  picksSnap.forEach((d) => {
    const p = d.data();
    pickedIds.add(p.playerId);
    const arr = picksByUser.get(p.uid) || [];
    arr.push({ ...p, _id: d.id });
    picksByUser.set(p.uid, arr);
  });

  // Undrafted = players minus pickedIds
  const allPlayers = [];
  const byId = new Map();
  playersSnap.forEach((d) => {
    const pl = d.data();
    allPlayers.push(pl);
    byId.set(String(pl.id), pl);
  });
  const available = new Set(allPlayers.map((pl) => String(pl.id)).filter(id => !pickedIds.has(id)));

  // Aggregate team points (placeholder: sum pick.pts || 0)
  const teamPoints = [];
  picksByUser.forEach((arr, uid) => {
    const total = arr.reduce((sum, p) => sum + (Number(p.pts) || 0), 0);
    teamPoints.push({ uid, points: total });
  });

  // Ensure users without picks still in list (points=0)
  interestSnap.forEach((d) => {
    const uid = d.id;
    if (!teamPoints.find(t => t.uid === uid)) teamPoints.push({ uid, points: 0 });
  });

  // Load interest
  const interests = interestSnap.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }));

  // Priority: ascending points (lowest first)
  teamPoints.sort((a, b) => a.points - b.points);
  const priorityUids = teamPoints.map(t => t.uid);

  // Prepare result records we’ll commit
  const results = [];

  const members = Array.isArray(room.members) ? room.members : [];
  const nameByUid = new Map(members.map(m => [m.uid, m.displayName]));


  // Apply choices in priority order; users can get up to two swaps
  // Apply choicos in priority order; users can get up to two swaps
for (const  uid of priorityUids) {
  const interest = interests.find(i => i.uid === uid);
  if (!interest?.choices?.length) continue;

  const displayName = nameByUid.get(uid) || interest.displayName || uid;

  // We’ll check the user’s current picks for swapOut validity
  const myPicks = picksByUser.get(uid) || [];
  const myPickByPlayerId = new Map(myPicks.map(p => [String(p.playerId), p]));

  for (const choice of interest.choices) {
    const wantId = String(choice.wantId || "");
    const swapOutId = String(choice.swapOutId || "");

    if (!wantId || !swapOutId) {
      results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "MISSING_FIELDS" });
      continue;
    }

    if (wantId === swapOutId) {
      results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "SAME_PLAYER" });
      continue;
    }

    // Want must be available (waiver wire rule)
    if (!available.has(wantId)) {
      results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "WANT_NOT_AVAILABLE" });
      continue;
    }

    // swapOut must be currently owned by user
    const ownedPick = myPickByPlayerId.get(swapOutId);
    if (!ownedPick) {
      results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "SWAPOUT_NOT_OWNED" });
      continue;
    }

    const wantPlayer = byId.get(wantId);
    if (!wantPlayer) {
      results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "WANT_NOT_IN_POOL" });
      continue;
    }

    // "Apply" swap locally
    available.delete(wantId);          // consumed
    myPickByPlayerId.delete(swapOutId); // released

    results.push({
      uid,
      displayName,
      ok: true,
      gotId: wantId,
      gotName: wantPlayer.name,
      releasedId: swapOutId,
      releasedName: ownedPick.playerName || swapOutId,
    });

    // Released player becomes available for later processing
    available.add(swapOutId);
  }
}


  // Commit: status -> resolving -> resolved, write picks & results atomically
  await runTransaction(db, async (tx) => {
    const rs = await tx.get(roomRef);
    if (!rs.exists()) throw new Error("Room not found");
    const room = rs.data();
    const m = room.market || {};
    if (m.status !== "resolving" && m.status !== "open") {
      // Allow host to force resolve if stuck open
      // Otherwise require resolving/close
    }

    // For each result: delete released pick, add new pick for gotId
    for (const r of results) {
    // ✅ Always log the result for everyone to see
    const resDoc = doc(collection(db, "rooms", roomId, "marketResults"));
    tx.set(resDoc, { ...r, resolvedAt: serverTimestamp() });

    // ✅ Only successful results should change picks
    if (!r.ok) continue;

    // Find the pick doc that is being swapped out
    const pickToUpdate = picksSnap.docs.find(d => {
      const p = d.data();
      return (
        p.uid === r.uid &&
        String(p.playerId) === String(r.releasedId)
      );
    });

    if (!pickToUpdate) {
      // still recorded as a result already; just skip applying
      continue;
    }

    // Update the EXISTING pick doc in place
    tx.update(doc(db, "rooms", roomId, "picks", pickToUpdate.id), {
      playerId: r.gotId,
      playerName: r.gotName,
      position: byId.get(r.gotId)?.position || "SUB",
      updatedAt: serverTimestamp(),
    });
  }
    tx.update(roomRef, {
      market: { ...m, isOpen: false, status: "resolved", closeAt: Date.now() },
      updatedAt: serverTimestamp(),
    });
  });

  const okCount = results.filter(r => r.ok).length;
  return { ok: true, resultsCount: okCount};
}

// Live watch of market object
/*export function watchMarket(roomId, cb) {
  const ref = doc(db, "rooms", roomId);
  return onSnapshot(
    ref,
    (s) => {
      const data = s.exists() ? s.data() : null;
      cb(data?.market || null, data);
    },
    (err) => {
      console.error("watchMarket snapshot error:", err);
      cb(null, null); // fail gracefully so UI doesn't explode
    }
  );
} */



/* =========================
   Internal helper for TX
   ========================= */
async function getDisplayNameFallback(tx, uid) {
  const uref = doc(db, "users", uid);
  const usnap = await tx.get(uref);
  return usnap.exists() ? usnap.data()?.displayName : null;
}

// -------------------------
// Trades (user-to-user)
// -------------------------

export async function createTradeOffer({ roomId, toUid, give, receive }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  if (!roomId || !toUid) throw new Error("Missing roomId/toUid");

  // up to 2 each side, must be equal count (keeps roster sizes consistent)
  const giveArr = Array.isArray(give) ? give.filter(Boolean).slice(0, 2) : [];
  const recvArr = Array.isArray(receive) ? receive.filter(Boolean).slice(0, 2) : [];

  if (giveArr.length < 1) throw new Error("Select at least 1 player you give");
  if (recvArr.length < 1) throw new Error("Select at least 1 player you receive");
  if (giveArr.length !== recvArr.length) throw new Error("Trade must be 1-for-1 or 2-for-2");

  // Resolve names (nice UX)
  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw new Error("Room not found");
  const room = roomSnap.data();
  const members = Array.isArray(room.members) ? room.members : [];
  const nameByUid = new Map(members.map(m => [m.uid, m.displayName]));

  const profile = await getUserProfile(user.uid).catch(() => null);
  const fromName = profile?.displayName || nameByUid.get(user.uid) || user.displayName || user.email || "Manager";
  const toName = nameByUid.get(toUid) || "Manager";

  const tradesRef = collection(db, "rooms", roomId, "trades");
  const docRef = await addDoc(tradesRef, {
    fromUid: user.uid,
    fromName,
    toUid,
    toName,

    give: giveArr.map(p => ({ playerId: String(p.playerId), playerName: p.playerName, position: p.position || "SUB" })),
    receive: recvArr.map(p => ({ playerId: String(p.playerId), playerName: p.playerName, position: p.position || "SUB" })),

    status: "pending",           // pending | accepted | rejected | canceled | completed
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    respondedAt: null,
    appliedAt: null,
  });

  return { ok: true, tradeId: docRef.id };
}

export async function respondToTradeOffer({ roomId, tradeId, action }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const tradeRef = doc(db, "rooms", roomId, "trades", tradeId);
  const snap = await getDoc(tradeRef);
  if (!snap.exists()) throw new Error("Trade not found");
  const t = snap.data();

  if (t.status !== "pending") return { ok: true, status: t.status };

  if (action === "cancel") {
    if (user.uid !== t.fromUid) throw new Error("Only the sender can cancel");
    await updateDoc(tradeRef, { status: "canceled", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "canceled" };
  }

  if (action === "reject") {
    if (user.uid !== t.toUid) throw new Error("Only the recipient can reject");
    await updateDoc(tradeRef, { status: "rejected", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "rejected" };
  }

  if (action === "accept") {
    if (user.uid !== t.toUid) throw new Error("Only the recipient can accept");
    // Host will apply the swap and mark completed
    await updateDoc(tradeRef, { status: "accepted", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "accepted" };
  }

  throw new Error("Unknown action");
}

// Host-only: apply an accepted trade by swapping pick docs
export async function applyAcceptedTrade({ roomId, tradeId }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw new Error("Room not found");
  const room = roomSnap.data();
  if (room.hostUid !== user.uid) throw new Error("Only host can apply trades");

  const tradeRef = doc(db, "rooms", roomId, "trades", tradeId);
  const tradeSnap = await getDoc(tradeRef);
  if (!tradeSnap.exists()) throw new Error("Trade not found");
  const t = tradeSnap.data();

  if (t.status !== "accepted") return { ok: true, status: t.status };
  if (t.appliedAt) return { ok: true, status: "completed" };

  const give = Array.isArray(t.give) ? t.give : [];
  const receive = Array.isArray(t.receive) ? t.receive : [];
  if (give.length < 1 || give.length > 2) throw new Error("Invalid give length");
  if (receive.length !== give.length) throw new Error("Trade must be 1-for-1 or 2-for-2");

  const picksRef = collection(db, "rooms", roomId, "picks");

  // Fetch rosters by uid (single equality filter = easy, no index headaches)
  const [fromRosterSnap, toRosterSnap] = await Promise.all([
    getDocs(query(picksRef, where("uid", "==", t.fromUid))),
    getDocs(query(picksRef, where("uid", "==", t.toUid))),
  ]);

  const fromDocs = fromRosterSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  const toDocs = toRosterSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

  // Find pick docs that currently hold the players being traded
  const fromPickRefs = give.map(g =>
    fromDocs.find(p => String(p.playerId) === String(g.playerId))
  );
  const toPickRefs = receive.map(r =>
    toDocs.find(p => String(p.playerId) === String(r.playerId))
  );

  if (fromPickRefs.some(x => !x) || toPickRefs.some(x => !x)) {
    // Someone no longer owns the listed players
    await updateDoc(tradeRef, { status: "rejected", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "rejected" };
  }

  await runTransaction(db, async (tx) => {
    const freshTrade = await tx.get(tradeRef);
    if (!freshTrade.exists()) throw new Error("Trade missing");
    const ft = freshTrade.data();
    if (ft.status !== "accepted" || ft.appliedAt) return;

    // Pairwise swap: give[i] <-> receive[i]
    for (let i = 0; i < give.length; i++) {
      const fromPick = fromPickRefs[i];
      const toPick = toPickRefs[i];

      // swap fields
      tx.update(fromPick.ref, {
        playerId: String(receive[i].playerId),
        playerName: receive[i].playerName,
        position: receive[i].position || "SUB",
        updatedAt: serverTimestamp(),
      });

      tx.update(toPick.ref, {
        playerId: String(give[i].playerId),
        playerName: give[i].playerName,
        position: give[i].position || "SUB",
        updatedAt: serverTimestamp(),
      });
    }

    tx.update(tradeRef, {
      status: "completed",
      appliedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return { ok: true, status: "completed" };
}
