// web/src/App.jsx
import React, { useEffect, useState } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  NavLink,
  Navigate,
} from "react-router-dom";

import Draft from "./pages/Draft";             
import Profile from "./pages/Profile";
import DraftSummary from "./pages/DraftSummary";
import Home from "./pages/Home";

import {
  watchAuth,
  signOutNow,
  completeRedirectIfAny,
  watchUserProfile,
  getLastRoomId,
  sendMagicLink,
} from "./firebase";
import TournamentPage from "./pages/TournamentPage/TournamentPage";
import { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar";

function Nav({ user, displayName, photoURL }) {
  const [lastRoomId, setLastRoomIdState] = useState(() => getLastRoomId());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const refresh = () => setLastRoomIdState(getLastRoomId());
    window.addEventListener("lastRoomIdChanged", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("lastRoomIdChanged", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // close mobile menu on route change (basic)
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);

  const tabs = [
    { to: "/", label: "Home" },
    { to: "/draft", label: "Draft" },
    {
      to: lastRoomId ? `/room?room=${lastRoomId}` : null,
      label: "View Rosters",
      hideWhenNoUser: true,
      disabled: !lastRoomId,
    },
    {
      to: lastRoomId ? `/tournament/${lastRoomId}` : "/tournament",
      label: "Tournament",
      hideWhenNoUser: true,
      disabled: !lastRoomId,
    },
    { to: "/profile", label: "Profile", hideWhenNoUser: true },
    { to: "/signin", label: "Sign In", hideWhenAuthed: true },
  ];

  const visibleTabs = tabs.filter(
    (t) => !(t.hideWhenAuthed && user) && !(t.hideWhenNoUser && !user)
  );

  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <Link to="/" className="font-bold text-lg whitespace-nowrap">
          ⚽ Football Fantasy
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-4 text-sm">
          {visibleTabs.map((t) => {
            if (t.disabled || !t.to) {
              return (
                <span key={t.label} className="opacity-50 cursor-not-allowed">
                  {t.label}
                </span>
              );
            }
            return (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  isActive
                    ? "font-semibold text-blue-600"
                    : "opacity-70 hover:opacity-100"
                }
              >
                {t.label}
              </NavLink>
            );
          })}
        </nav>

        {/* Right side (desktop) */}
        <div className="hidden md:flex items-center gap-3">
          {user ? (
            <>
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={photoURL || ""} alt="Profile picture" />
                  <AvatarFallback>
                    {(displayName || user.email || "?").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm opacity-80">{displayName || user.email}</span>
              </div>

              <button
                onClick={signOutNow}
                className="px-3 py-1 rounded-lg border bg-red-500 text-white hover:bg-red-600"
              >
                Sign out
              </button>
            </>
          ) : (
            <NavLink
              to="/signin"
              className="px-3 py-1 rounded-lg border bg-blue-600 text-white hover:bg-blue-700"
            >
              Sign In
            </NavLink>
          )}
        </div>

        {/* Mobile menu button */}
        <button
          className="md:hidden px-3 py-2 rounded-lg border bg-white"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Toggle menu"
        >
          ☰
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden border-t border-gray-200 bg-white">
          <div className="px-4 py-3 flex flex-col gap-3">
            {user && (
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={photoURL || ""} alt="Profile picture" />
                  <AvatarFallback>
                    {(displayName || user.email || "?").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm opacity-80">{displayName || user.email}</span>
              </div>
            )}

            <nav className="flex flex-col gap-2">
              {visibleTabs.map((t) => {
                if (t.disabled || !t.to) {
                  return (
                    <span key={t.label} className="opacity-50 cursor-not-allowed">
                      {t.label}
                    </span>
                  );
                }
                return (
                  <NavLink
                    key={t.to}
                    to={t.to}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      isActive
                        ? "font-semibold text-blue-600"
                        : "opacity-80"
                    }
                  >
                    {t.label}
                  </NavLink>
                );
              })}
            </nav>

            {user ? (
              <button
                onClick={signOutNow}
                className="w-full px-3 py-2 rounded-lg border bg-red-500 text-white hover:bg-red-600"
              >
                Sign out
              </button>
            ) : (
              <NavLink
                to="/signin"
                onClick={() => setOpen(false)}
                className="w-full text-center px-3 py-2 rounded-lg border bg-blue-600 text-white hover:bg-blue-700"
              >
                Sign In
              </NavLink>
            )}
          </div>
        </div>
      )}
    </header>
  );
}


function RequireAuth({ user, children }) {
  if (!user) return <Navigate to="/signin" replace />;
  return children;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  async function onSend(e) {
    e.preventDefault();
    setErr("");
    try {
      await sendMagicLink(email);
      setSent(true);
    } catch (e) {
      setErr(e?.message || "Failed to send link.");
    }
  }

  return (
    <div className="min-h-[60vh] grid place-items-center p-6">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 w-full max-w-md">
        <h1 className="text-xl font-bold mb-2">Sign in</h1>
        <p className="text-sm opacity-70 mb-4">Use a passwordless email link.</p>
        {!sent ? (
          <form onSubmit={onSend} className="space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full border rounded px-3 py-2"
            />
            <button type="submit" className="w-full px-3 py-2 rounded-xl border bg-black text-white">
              Send magic link
            </button>
          </form>
        ) : (
          <div className="text-sm">
            We sent a link to <b>{email}</b>. Open it here to finish sign-in.
          </div>
        )}
        {err && <div className="text-red-600 text-sm mt-3">{String(err)}</div>}
      </div>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const displayName = profile?.displayName;
  const photoURL = profile?.photoURL;

  useEffect(() => {
    completeRedirectIfAny();
    const unsub = watchAuth(setUser);
    return unsub;
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setProfile(null);
      return;
    }
    return watchUserProfile(user.uid, setProfile);
  }, [user?.uid]);

  return (
    <Router>
      <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
        <Nav user={user} displayName={displayName} photoURL={photoURL} />
        <main className="flex-1 mx-auto w-full max-w-7xl p-4">
          <Routes>
            <Route path="/tournament" element={<RequireAuth user={user}><TournamentPage /></RequireAuth>} />
            <Route
              path="/tournament/:roomId"
              element={
                <RequireAuth user={user}>
                  <TournamentPage />
                </RequireAuth>
              }
            />
            <Route
              path="/room"
              element={
                <RequireAuth user={user}>
                  <DraftSummary />
                </RequireAuth>
              }
            />
            <Route path="/" element={<Home user={user} />} />
            <Route path="*" element={<Home user={user} />} />
            <Route
              path="/signin"
              element={user ? <Navigate to="/" replace /> : <SignIn />}
            />
            <Route
              path="/profile"
              element={
                <RequireAuth user={user}>
                  <Profile />
                </RequireAuth>
              }
            />
            <Route
              path="/draft"
              element={
                user && !displayName ? (
                  <Navigate to="/profile" replace />
                ) : (
                  <RequireAuth user={user}>
                    <Draft />
                  </RequireAuth>
                )
              }
            />
          </Routes>
        </main>
      </div>
    </Router>
  );
}
