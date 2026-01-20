import React from "react";
import { Link } from "react-router-dom";
import "./Home.css";

export default function Home({ user }) {
  return (
    <div className="homePage">
      <h1 className="homeTitle">⚽ Football Fantasy</h1>
      <p className="homeSubtitle">Create a room, invite friends, and draft live.</p>

      {!user && (
        <Link className="homeCta" to="/signin">
          Sign in to get started
        </Link>
      )}
    </div>
  );
}
