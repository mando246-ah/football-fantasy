import { useEffect, useState } from "react";
import { db } from "../../firebase";
import { doc, onSnapshot } from "firebase/firestore";

export function useUserRoom(uid) {
  const [loading, setLoading] = useState(true);
  const [currentRoomId, setCurrentRoomId] = useState(null);

  useEffect(() => {
    if (!uid) return;

    const ref = doc(db, "users", uid);

    const unsub = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        setCurrentRoomId(data?.currentRoomId || null); // <-- choose your field name
        setLoading(false);
      },
      () => setLoading(false)
    );

    return () => unsub();
  }, [uid]);

  return { loading, currentRoomId };
}
