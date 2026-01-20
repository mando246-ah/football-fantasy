import { useEffect, useMemo, useState } from "react";
import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";

// Firestore "in" queries support up to 10 values, so we chunk.
function chunk10(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
}

export default function useUserProfiles(uids) {
  const cleanUids = useMemo(() => {
    const set = new Set((uids || []).filter(Boolean));
    return Array.from(set);
  }, [uids]);

  const [profilesByUid, setProfilesByUid] = useState({});

  useEffect(() => {
    if (!cleanUids.length) {
      setProfilesByUid({});
      return;
    }

    const unsubscribers = [];
    const chunks = chunk10(cleanUids);

    chunks.forEach((uidsChunk) => {
      const q = query(collection(db, "users"), where(documentId(), "in", uidsChunk));

      const unsub = onSnapshot(q, (snap) => {
        setProfilesByUid((prev) => {
          const next = { ...prev };
          snap.forEach((docSnap) => {
            next[docSnap.id] = docSnap.data();
          });
          return next;
        });
      });

      unsubscribers.push(unsub);
    });

    return () => unsubscribers.forEach((u) => u());
  }, [cleanUids]);

  return profilesByUid;
}
