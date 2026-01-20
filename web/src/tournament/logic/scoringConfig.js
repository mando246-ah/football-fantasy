// src/tournament/logic/scoringConfig.js

export const SCORING_V1 = {
  appearance: {
    anyMinutes: 1,     // played > 0 mins
    sixtyPlus: 1,      // played >= 60 mins
  },

  assists: 3,

  goals: {
    GK: 6,
    DEF: 6,
    MID: 5,
    FWD: 4,
  },

  cleanSheet: {
    GK: 4,
    DEF: 4,
    MID: 1,
    FWD: 0,
    minMinutes: 60, // must play >= 60 to earn clean sheet
  },

  goalsConceded: {
    GK: -1,      // -1 per 2 conceded
    DEF: -1,
    per: 2,
  },

  saves: {
    GK: 1,       // +1 per 3 saves
    per: 3,
  },

  cards: {
    yellow: -1,
    red: -3,
  },

  pens: {
    saved: 5,
    missed: -2,
  },

  ownGoal: -2,

  passesCompleted: {
    enabled: true,

    // 1 point per X completed passes, depending on position
    perByPos: {
        GK: 25,
        DEF: 20,
        MID: 20,
        FWD: 15,
    },

    pointsPerChunk: 1,
    },

  // optional if your provider supplies it later
  bonus: {
    perPoint: 1,
  },
};
