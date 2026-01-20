import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { db } from "../../firebase";
import { collection, onSnapshot } from "firebase/firestore";

export default function WaitingRoom({ roomId, user, onStartDraft }) {
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    if (!roomId) return;
    const unsub = onSnapshot(collection(db, "rooms", roomId, "players"), (snapshot) => {
      setPlayers(snapshot.docs.map(doc => doc.data()));
    });
    return () => unsub();
  }, [roomId]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-900 text-white">
      <Card className="w-full max-w-2xl bg-neutral-800 border border-neutral-700 shadow-xl">
        <CardHeader className="flex flex-col items-center">
          <CardTitle className="text-3xl font-bold text-green-500">
            ⚽ FIFA Fantasy Draft
          </CardTitle>
          <p className="text-neutral-400">Room Code: <span className="font-mono">{roomId}</span></p>
        </CardHeader>
        <CardContent>
          <h2 className="text-xl font-semibold mb-4">Players in Room</h2>
          <div className="grid grid-cols-2 gap-3">
            {players.length === 0 ? (
              <p className="col-span-2 text-neutral-400 italic">Waiting for players to join...</p>
            ) : (
              players.map((p, i) => (
                <div
                  key={i}
                  className="p-3 rounded-lg bg-neutral-700 border border-neutral-600 flex items-center justify-between"
                >
                  <span className="font-semibold">{p.displayName || p.email}</span>
                  <span className="text-green-400">✅</span>
                </div>
              ))
            )}
          </div>

          {user?.isHost && (
            <div className="flex justify-center mt-6">
              <Button
                onClick={onStartDraft}
                className="bg-green-600 hover:bg-green-700 text-white text-lg px-6 py-3 rounded-xl shadow-lg"
              >
                Start Draft
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
