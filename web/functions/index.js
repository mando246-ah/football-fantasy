const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();
const db = admin.firestore();

function formatWhen(ms) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

async function getEmailsForUids(uids) {
  const chunks = [];
  for (let i = 0; i < uids.length; i += 100) chunks.push(uids.slice(i, i + 100));

  const out = [];
  for (const chunk of chunks) {
    const res = await admin.auth().getUsers(chunk.map((uid) => ({ uid })));
    for (const u of res.users) {
      if (u.email) out.push({ uid: u.uid, email: u.email, name: u.displayName || "" });
    }
  }
  return out;
}

async function queueEmails(recipients, subject, html, text, meta) {
  const batch = db.batch();
  for (const r of recipients) {
    const ref = db.collection("mail").doc();
    batch.set(ref, {
      to: r.email,
      message: { subject, html, text },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: meta || {},
    });
  }
  await batch.commit();
  return recipients.length;
}

/**
 * Draft scheduling: sets startAt + creates reminder doc + queues "Draft Scheduled" email now
 */
exports.scheduleDraft = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { roomId, startAtMs } = request.data || {};
  if (!roomId || !startAtMs) {
    throw new HttpsError("invalid-argument", "Missing roomId/startAtMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data();
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  const members = Array.isArray(room.members) ? room.members : [];
  const memberUids = members
    .map((m) => (typeof m === "string" ? m : m?.uid))
    .filter(Boolean);

  if (memberUids.length === 0) return { ok: true, emailsQueued: 0 };

  const whenStr = formatWhen(Number(startAtMs));
  const reminderSendAtMs = Number(startAtMs) - 10 * 60 * 1000;

  const oldReminderId = room.draftReminderId || null;
  const newReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  if (oldReminderId) batch.delete(db.doc(`reminders/${oldReminderId}`));

  batch.set(newReminderRef, {
    type: "draft_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    startAtMs: Number(startAtMs),
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.update(roomRef, {
    startAt: Number(startAtMs),
    draftReminderId: newReminderRef.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  const recipients = await getEmailsForUids(memberUids);
  const subject = "FIFA Fantasy — Draft Scheduled";
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2>Draft Scheduled</h2>
      <p><b>Host</b> has scheduled the draft for:</p>
      <p style="font-size:16px;"><b>${whenStr}</b></p>
      <p>Room: <b>${roomId}</b></p>
      <p>You’ll get a reminder 10 minutes before it starts.</p>
    </div>
  `;
  const text = `Draft Scheduled\nHost has scheduled the draft for: ${whenStr}\nRoom: ${roomId}\nReminder: 10 minutes before.`;

  const emailsQueued = await queueEmails(recipients, subject, html, text, {
    type: "draft_scheduled",
    roomId,
    startAtMs: Number(startAtMs),
  });

  return { ok: true, emailsQueued };
});

/**
 * Market scheduling: writes schedule to rooms/{roomId}/market/current
 * + NEW: creates a "market_10min" reminder doc
 */
exports.scheduleMarket = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { roomId, scheduledAtMs, durationMs } = request.data || {};
  if (!roomId || !scheduledAtMs || durationMs == null) {
    throw new HttpsError("invalid-argument", "Missing roomId/scheduledAtMs/durationMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data();
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  const members = Array.isArray(room.members) ? room.members : [];
  const memberUids = members
    .map((m) => (typeof m === "string" ? m : m?.uid))
    .filter(Boolean);

  const openStr = formatWhen(Number(scheduledAtMs));
  const durStr = formatDuration(Number(durationMs));

  const marketRef = db.doc(`rooms/${roomId}/market/current`);
  const marketSnap = await marketRef.get();
  const prevMarket = marketSnap.exists ? (marketSnap.data() || {}) : {};

  // NEW: create/replace market reminder
  const reminderSendAtMs = Number(scheduledAtMs) - 10 * 60 * 1000;
  const oldMarketReminderId = prevMarket.marketReminderId || null;
  const newMarketReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  if (oldMarketReminderId) batch.delete(db.doc(`reminders/${oldMarketReminderId}`));

  batch.set(newMarketReminderRef, {
    type: "market_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.set(
    marketRef,
    {
      status: "scheduled",
      scheduledAt: Number(scheduledAtMs),
      durationMs: Number(durationMs),

      openedAt: null,
      closesAt: null,
      resolvedAt: null,

      // NEW: link reminder so reschedules replace it
      marketReminderId: newMarketReminderRef.id,

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();

  // Email: "Market Scheduled" (immediate)
  const recipients = await getEmailsForUids(memberUids);
  const subject = "FIFA Fantasy — Market Scheduled";
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2>Market Scheduled</h2>
      <p><b>Host</b> has scheduled the market to open at:</p>
      <p style="font-size:16px;"><b>${openStr}</b></p>
      <p>It will stay open for: <b>${durStr}</b></p>
      <p>Room: <b>${roomId}</b></p>
      <p>You’ll get a reminder 10 minutes before it opens.</p>
    </div>
  `;
  const text = `Market Scheduled\nHost scheduled market open at: ${openStr}\nOpen duration: ${durStr}\nRoom: ${roomId}\nReminder: 10 minutes before.`;

  const emailsQueued = await queueEmails(recipients, subject, html, text, {
    type: "market_scheduled",
    roomId,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
  });

  return { ok: true, emailsQueued };
});

/**
 * Runs every minute to send reminder emails that are due
 * (Draft 10-min reminders + Market 10-min reminders)
 */
exports.processReminders = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();

    const snap = await db
      .collection("reminders")
      .where("sentAt", "==", null)
      .where("sendAtMs", "<=", now)
      .limit(50)
      .get();

    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      const r = docSnap.data();

      const uidsRaw = Array.isArray(r.recipientUids) ? r.recipientUids : [];
      const uids = uidsRaw.map((m) => (typeof m === "string" ? m : m?.uid)).filter(Boolean);
      const recipients = await getEmailsForUids(uids);

      // --- Draft reminder ---
      if (r.type === "draft_10min") {
        const whenStr = formatWhen(r.startAtMs);

        const subject = "FIFA Fantasy — Draft starts in 10 minutes";
        const html = `
          <div style="font-family:Arial,sans-serif;">
            <h2>Draft Reminder</h2>
            <p>The draft begins in <b>10 minutes</b>.</p>
            <p><b>Start time:</b> ${whenStr}</p>
            <p>Room: <b>${r.roomId}</b></p>
          </div>
        `;
        const text = `Draft Reminder\nThe draft begins in 10 minutes.\nStart time: ${whenStr}\nRoom: ${r.roomId}`;

        await queueEmails(recipients, subject, html, text, {
          type: "draft_10min_reminder",
          roomId: r.roomId,
          startAtMs: r.startAtMs,
        });

        await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      // --- NEW: Market reminder ---
      if (r.type === "market_10min") {
        const openStr = formatWhen(r.scheduledAtMs);
        const durStr = formatDuration(Number(r.durationMs || 0));

        const subject = "FIFA Fantasy — Market opens in 10 minutes";
        const html = `
          <div style="font-family:Arial,sans-serif;">
            <h2>Market Reminder</h2>
            <p>The market opens in <b>10 minutes</b>.</p>
            <p><b>Opens at:</b> ${openStr}</p>
            <p><b>Duration:</b> ${durStr}</p>
            <p>Room: <b>${r.roomId}</b></p>
          </div>
        `;
        const text = `Market Reminder\nThe market opens in 10 minutes.\nOpens at: ${openStr}\nDuration: ${durStr}\nRoom: ${r.roomId}`;

        await queueEmails(recipients, subject, html, text, {
          type: "market_10min_reminder",
          roomId: r.roomId,
          scheduledAtMs: r.scheduledAtMs,
          durationMs: r.durationMs,
        });

        await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      // Unknown reminder type: mark as sent so it doesn't loop forever
      await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
);

/**
 * Market scheduler (auto open/close)
 */
exports.processMarketSchedule = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();
    const roomsSnap = await db.collection("rooms").get();

    for (const roomDoc of roomsSnap.docs) {
      const roomId = roomDoc.id;
      const marketRef = db.doc(`rooms/${roomId}/market/current`);
      const marketSnap = await marketRef.get();
      if (!marketSnap.exists) continue;

      const m = marketSnap.data() || {};
      const scheduledAt = Number(m.scheduledAt);
      const durationMs = Number(m.durationMs || 0);

      if (m.status === "scheduled" && Number.isFinite(scheduledAt) && scheduledAt <= now) {
        const closesAt = durationMs ? now + durationMs : null;

        await marketRef.set(
          {
            status: "open",
            openedAt: now,
            closesAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      if (m.status === "open" && Number.isFinite(m.closesAt) && m.closesAt <= now) {
        await marketRef.set(
          {
            status: "closed",
            resolvedAt: now,
            scheduledAt: null, // prevent reopening
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }
    }
  }
);
