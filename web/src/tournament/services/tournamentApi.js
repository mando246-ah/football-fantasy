// src/tournament/services/tournamentApi.js
import { db } from "../../firebase";
import { doc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";

export function onTournamentSnapshot(roomId, onData, onErr) {
  const ref = doc(db, "rooms", roomId, "tournament", "meta");
  return onSnapshot(ref, (snap) => onData(snap.exists() ? snap.data() : null), onErr);
}

export function onRoundSnapshot(roomId, onData, onErr) {
  const ref = doc(db, "rooms", roomId, "tournament", "roundState");
  return onSnapshot(ref, (snap) => onData(snap.exists() ? snap.data() : null), onErr);
}

export function onMarketSnapshot(roomId, onData, onErr) {
  const ref = doc(db, "rooms", roomId, "tournament", "market");
  return onSnapshot(ref, (snap) => onData(snap.exists() ? snap.data() : null), onErr);
}

export function onUserSquadSnapshot(roomId, uid, onData, onErr) {
  const ref = doc(db, "rooms", roomId, "tournamentSquads", uid);
  return onSnapshot(ref, (snap) => onData(snap.exists() ? snap.data() : null), onErr);
}

export function onUserLineupSnapshot(roomId, uid, onData, onErr) {
  const ref = doc(db, "rooms", roomId, "tournamentLineups", uid);
  return onSnapshot(ref, (snap) => onData(snap.exists() ? snap.data() : null), onErr);
}

export async function saveUserLineup(roomId, uid, lineup) {
  const ref = doc(db, "rooms", roomId, "tournamentLineups", uid);
  await setDoc(ref, { ...lineup, updatedAt: serverTimestamp() }, { merge: true });
}

export async function submitTransfer(roomId, uid, payload) {
  const ref = doc(db, "rooms", roomId, "tournamentTransfers", `${uid}_${Date.now()}`);
  await setDoc(ref, { uid, ...payload, createdAt: serverTimestamp(), status: "pending" });
}
