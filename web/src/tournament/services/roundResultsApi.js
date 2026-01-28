import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase";

export async function getRoundResults(roomId, roundId) {
  const ref = doc(db, "rooms", roomId, "roundResults", String(roundId));
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

export async function saveRoundResults(roomId, roundId, results) {
  const ref = doc(db, "rooms", roomId, "roundResults", String(roundId));
  await setDoc(
    ref,
    {
      ...results,
      roundId,
      computedAt: serverTimestamp(),
    },
    { merge: true }
  );
}
