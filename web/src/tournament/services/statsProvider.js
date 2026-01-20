// src/tournament/services/statsProvider.js
import { mockStatsProvider } from "./mockStatsProvider";

// Later you’ll swap this to apiStatsProvider (same interface).
let currentProvider = mockStatsProvider;

export function setStatsProvider(provider) {
  currentProvider = provider;
}

export function getStatsProvider() {
  return currentProvider;
}
