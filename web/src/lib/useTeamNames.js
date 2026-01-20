import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

export default function useTeamNames(roomId) {
  const [teamNamesByUid, setTeamNamesByUid] = useState({});

  useEffect(() => {
    if (!roomId) {
      setTeamNamesByUid({});
      return;
    }

    const colRef = collection(db, "rooms", roomId, "teamNames");
    const unsub = onSnapshot(colRef, (snap) => {
      const next = {};
      snap.forEach((doc) => {
        next[doc.id] = doc.data()?.teamName || "";
      });
      setTeamNamesByUid(next);
    });

    return () => unsub();
  }, [roomId]);

  return teamNamesByUid;
}
