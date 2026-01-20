// web/src/pages/Profile.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth, saveDisplayName, watchUserProfile, getRememberMe, setRememberMe, signOutNow, uploadUserAvatar } from "../firebase";
import { onAuthStateChanged } from "firebase/auth";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";

export default function Profile() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedPref, setSavedPref] = useState(false);
  const nav = useNavigate();
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState("");

  //Profile Picture
  async function handleUploadAvatar() {
    if (!user?.uid || !avatarFile) return;

    setAvatarUploading(true);
    setAvatarMsg("");

    try {
      console.log("1)upload uid:", user.uid, "auth uid:", auth.currentUser?.uid);
      await uploadUserAvatar(user.uid, avatarFile);
      console.log("2.)upload uid:", user.uid, "auth uid:", auth.currentUser?.uid);
      setAvatarFile(null);
      setAvatarMsg("✅ Profile picture updated!");
    } catch (e) {
      setAvatarMsg(`❌ ${e?.message || "Upload failed"}`);
    } finally {
      setAvatarUploading(false);
    }
  }


  // watch auth user
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // watch profile doc
  useEffect(() => {
    if (!user?.uid) return;
    const unsub = watchUserProfile(user.uid, (p) => {
      setProfile(p);
      if (p?.displayName) setName(p.displayName);
    });
    return unsub;
  }, [user?.uid]);

  // load remember-me pref
  useEffect(() => {
    setRemember(getRememberMe());
  }, []);

  async function onSaveDisplayName(e) {
    e.preventDefault();
    if (!user?.uid) return;
    const displayName = name.trim();
    if (!displayName) return;
    setSaving(true);
    try {
      await saveDisplayName(user.uid, displayName);
      nav("/draft");
    } finally {
      setSaving(false);
    }
  }

  function onSaveRemember() {
    setRememberMe(remember);
    setSavedPref(true);
    setTimeout(() => setSavedPref(false), 2000);
  }

  async function applyRememberNow() {
    // To apply immediately, sign out so the next sign-in uses the new persistence
    await signOutNow();
  }

  if (!user) {
    return (
      <div className="min-h-[60vh] grid place-items-center p-6">
        <div className="text-center">
          <h1 className="text-xl font-bold">Please sign in first</h1>
          <p className="opacity-70">Then come back to set your display name.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] grid place-items-center p-6">
      <div className="w-full max-w-md space-y-6">
        <form onSubmit={onSaveDisplayName} className="border rounded-2xl p-6 bg-white shadow-sm">
          <h1 className="text-xl font-bold mb-2">Choose your Display name</h1>
          <p className="text-sm opacity-70 mb-4">Other users will see this name.</p>
          <input
            className="w-full border rounded px-3 py-2 mb-3"
            placeholder="e.g. Arman"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            required
          />
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="w-full px-3 py-2 rounded-xl border bg-black text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save & Continue"}
          </button>
        </form>
        <section className="border rounded-2xl p-6 bg-white shadow-sm">
          <h2 className="text-xl font-bold mb-2">Profile Picture</h2>

          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <Avatar className="h-16 w-16">
              <AvatarImage src={profile?.photoURL || ""} alt="Profile picture" />
              <AvatarFallback>
                {(profile?.displayName || user?.email || "?").slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div style={{ display: "grid", gap: 8 }}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setAvatarFile(e.target.files?.[0] || null)}
              />

              <button
                type="button"
                onClick={handleUploadAvatar}
                disabled={!avatarFile || avatarUploading}
              >
                {avatarUploading ? "Uploading..." : "Upload"}
              </button>

              {avatarMsg && <div style={{ fontSize: 13 }}>{avatarMsg}</div>}
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                PNG/JPG/WEBP up to 2MB
              </div>
            </div>
          </div>
        </section>

        <div className="border rounded-2xl p-6 bg-white shadow-sm">
          <h2 className="text-lg font-semibold mb-2">Sign-in preference</h2>
          <label className="flex items-center gap-2 mb-3">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Keep me signed in on this device</span>
          </label>

          <div className="flex gap-3">
            <button
              onClick={onSaveRemember}
              className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700"
            >
              Save preference
            </button>
            <button
              onClick={applyRememberNow}
              className="px-3 py-2 rounded bg-slate-200 hover:bg-slate-300"
              title="Sign out so your new preference applies on the next sign-in"
            >
              Apply now (sign out)
            </button>
          </div>

          {savedPref && (
            <div className="mt-2 text-sm text-green-700">Saved!</div>
          )}

          <p className="mt-2 text-xs opacity-70">
            This applies on your next sign-in. Click “Apply now” to sign out so the change takes effect immediately.
          </p>
        </div>
      </div>
    </div>
  );
}
