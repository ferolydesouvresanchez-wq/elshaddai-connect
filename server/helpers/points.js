const { v4: uuidv4 } = require('uuid');

// =============================================================
// POINT VALUES — single source of truth
// =============================================================
const POINT_VALUES = {
  // Attendance & Events
  rsvp: 5,
  checkin_ontime: 20,
  checkin_late: 5,
  checkin_verylate: 0,
  walkin_checkin: 3,
  checkout: 10,
  full_attendance: 15,
  missed_event: -10,

  // App Engagement
  daily_login: 3,
  streak_7: 25,
  streak_30: 100,
  publish_post: 8,
  comment: 3,
  like: 1,
  share: 5,

  // Community & Social
  follow: 2,
  followed: 3,
  join_group: 10,
  group_activity: 5,
  invite_member: 30,

  // Ministry Participation
  volunteer: 25,
  volunteer_complete: 40,
  ministry_leader: 50,

  // Profile Completion
  profile_complete: 20,
  social_connect: 10,
  banner_set: 5,
};

// =============================================================
// TIER DEFINITIONS
// =============================================================
const TIERS = [
  { name: 'seed',      min: 0,    max: 99,   icon: '🌱', label: 'Seed' },
  { name: 'sprout',    min: 100,  max: 299,  icon: '🌿', label: 'Sprout' },
  { name: 'builder',   min: 300,  max: 599,  icon: '🔨', label: 'Builder' },
  { name: 'faithful',  min: 600,  max: 999,  icon: '⭐', label: 'Faithful' },
  { name: 'pillar',    min: 1000, max: 1999, icon: '🏛️', label: 'Pillar' },
  { name: 'champion',  min: 2000, max: 3999, icon: '🏆', label: 'Champion' },
  { name: 'legend',    min: 4000, max: Infinity, icon: '👑', label: 'Legend' },
];

function getTierForPoints(points) {
  return TIERS.find(t => points >= t.min && points <= t.max) || TIERS[0];
}

function getNextTier(currentTierName) {
  const idx = TIERS.findIndex(t => t.name === currentTierName);
  return idx < TIERS.length - 1 ? TIERS[idx + 1] : null;
}

// =============================================================
// CORE: Award points (server-side only)
// =============================================================
/**
 * Award points to a user. Prevents duplicates, clamps to zero, handles tier changes.
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {string} userId
 * @param {string} actionType - one of the POINT_VALUES keys or 'admin_adjust'
 * @param {number} points - can be negative for deductions
 * @param {string|null} relatedEntityId - eventId, postId, etc.
 * @param {string|null} relatedEntityType - 'event', 'post', 'group', etc.
 * @param {object|null} metadata - { note, adminId, arrivalStatus, etc. }
 * @returns {{ success: boolean, newTotal: number, tierChanged: boolean, newTier: object|null, reason?: string }}
 */
function awardPoints(db, userId, actionType, points, relatedEntityId, relatedEntityType, metadata) {
  // Ensure user_points row exists
  ensureUserPoints(db, userId);

  // Duplicate check: for non-admin actions, check if this exact action+entity was already scored
  if (actionType !== 'admin_adjust' && relatedEntityId) {
    const existing = db.prepare(
      'SELECT id FROM point_ledger WHERE userId = ? AND actionType = ? AND relatedEntityId = ?'
    ).get(userId, actionType, relatedEntityId);
    if (existing) {
      return { success: false, reason: 'duplicate', newTotal: getUserPoints(db, userId), tierChanged: false, newTier: null };
    }
  }

  // For daily_login, use date as the relatedEntityId to prevent double-scoring same day
  if (actionType === 'daily_login' && !relatedEntityId) {
    const today = new Date().toISOString().split('T')[0];
    relatedEntityId = today;
    const existing = db.prepare(
      'SELECT id FROM point_ledger WHERE userId = ? AND actionType = ? AND relatedEntityId = ?'
    ).get(userId, 'daily_login', today);
    if (existing) {
      return { success: false, reason: 'duplicate', newTotal: getUserPoints(db, userId), tierChanged: false, newTier: null };
    }
  }

  // Insert ledger entry
  const ledgerId = uuidv4();
  db.prepare(`
    INSERT INTO point_ledger (id, userId, actionType, points, relatedEntityId, relatedEntityType, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ledgerId, userId, actionType, points, relatedEntityId || null, relatedEntityType || null, metadata ? JSON.stringify(metadata) : null);

  // Update user_points — clamp to zero
  const currentRow = db.prepare('SELECT totalPoints, currentTier FROM user_points WHERE userId = ?').get(userId);
  const oldTotal = currentRow.totalPoints;
  const oldTierName = currentRow.currentTier;
  const newTotal = Math.max(0, oldTotal + points);

  const newTier = getTierForPoints(newTotal);

  db.prepare(`
    UPDATE user_points SET totalPoints = ?, currentTier = ?, updatedAt = datetime('now') WHERE userId = ?
  `).run(newTotal, newTier.name, userId);

  // Check for tier change and send notification
  let tierChanged = false;
  if (newTier.name !== oldTierName) {
    tierChanged = true;
    const direction = newTotal > oldTotal ? 'upgraded' : 'changed';
    db.prepare(`
      INSERT INTO notifications (id, userId, type, title, message, refId)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), userId, 'tier_change',
      `Tier ${direction}!`,
      `You are now ${newTier.icon} ${newTier.label} (${newTotal} points)`,
      newTier.name
    );
  }

  return { success: true, newTotal, tierChanged, newTier, ledgerId };
}

// =============================================================
// Ensure user_points row exists
// =============================================================
function ensureUserPoints(db, userId) {
  const exists = db.prepare('SELECT userId FROM user_points WHERE userId = ?').get(userId);
  if (!exists) {
    db.prepare(`
      INSERT INTO user_points (userId, totalPoints, currentTier, loginStreak, bestLoginStreak, lastLoginDate)
      VALUES (?, 0, 'seed', 0, 0, NULL)
    `).run(userId);
  }
}

function getUserPoints(db, userId) {
  ensureUserPoints(db, userId);
  return db.prepare('SELECT totalPoints FROM user_points WHERE userId = ?').get(userId).totalPoints;
}

// =============================================================
// LOGIN STREAK PROCESSING
// =============================================================
/**
 * Process a user login: award daily points, track streak, award streak bonuses.
 */
function processLogin(db, userId) {
  const today = new Date().toISOString().split('T')[0];
  ensureUserPoints(db, userId);

  // Record login in login_history (unique per day)
  try {
    db.prepare('INSERT INTO login_history (id, userId, loginDate) VALUES (?, ?, ?)').run(uuidv4(), userId, today);
  } catch (e) {
    if (!e.message.includes('UNIQUE')) throw e;
    // Already logged in today — no points
    return { alreadyLoggedToday: true };
  }

  // Award daily login points
  awardPoints(db, userId, 'daily_login', POINT_VALUES.daily_login, today, 'login', null);

  // Calculate streak
  const row = db.prepare('SELECT loginStreak, bestLoginStreak, lastLoginDate FROM user_points WHERE userId = ?').get(userId);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  let newStreak;
  if (row.lastLoginDate === yesterdayStr) {
    // Consecutive day
    newStreak = row.loginStreak + 1;
  } else if (row.lastLoginDate === today) {
    // Same day (shouldn't get here due to UNIQUE, but safety)
    newStreak = row.loginStreak;
  } else {
    // Streak broken
    newStreak = 1;
  }

  const newBest = Math.max(row.bestLoginStreak, newStreak);

  db.prepare('UPDATE user_points SET loginStreak = ?, bestLoginStreak = ?, lastLoginDate = ? WHERE userId = ?').run(
    newStreak, newBest, today, userId
  );

  // Award streak bonuses (only once per milestone)
  if (newStreak === 7) {
    awardPoints(db, userId, 'streak_7', POINT_VALUES.streak_7, `streak_7_${today}`, 'login', { streak: 7 });
  }
  if (newStreak === 30) {
    awardPoints(db, userId, 'streak_30', POINT_VALUES.streak_30, `streak_30_${today}`, 'login', { streak: 30 });
  }

  return { streak: newStreak, bestStreak: newBest, alreadyLoggedToday: false };
}

// =============================================================
// MISSED EVENT PROCESSOR
// =============================================================
/**
 * Find events that have ended where users RSVPd but never checked in, and deduct points.
 * Should be called periodically (e.g., every hour or via cron endpoint).
 */
function processMissedEvents(db) {
  // Find events that ended (endDate+endTime < now OR date+endTime < now, with fallback to date if no time)
  // Only process events not already processed
  const now = new Date().toISOString();
  const today = new Date().toISOString().split('T')[0];

  // Get events that have ended: endDate passed (or date passed if no endDate), and have GPS (real events)
  const endedEvents = db.prepare(`
    SELECT e.id, e.title, e.date, e.endDate, e.time, e.endTime
    FROM events e
    WHERE COALESCE(e.endDate, e.date) < ?
    OR (COALESCE(e.endDate, e.date) = ? AND e.endTime IS NOT NULL AND e.endTime < strftime('%H:%M', 'now'))
  `).all(today, today);

  let processed = 0;
  for (const event of endedEvents) {
    // Find RSVPs with no check-in
    const missedRsvps = db.prepare(`
      SELECT er.userId FROM event_rsvps er
      WHERE er.eventId = ?
      AND er.userId NOT IN (
        SELECT ec.userId FROM event_checkins ec WHERE ec.eventId = ? AND ec.type = 'checkin'
      )
    `).all(event.id, event.id);

    for (const { userId } of missedRsvps) {
      // Only deduct once per event per user
      const result = awardPoints(db, userId, 'missed_event', POINT_VALUES.missed_event, event.id, 'event', { eventTitle: event.title });
      if (result.success) processed++;
    }
  }

  return { processed, eventsChecked: endedEvents.length };
}

// =============================================================
// PROFILE COMPLETION CHECK
// =============================================================
function checkProfileComplete(db, userId) {
  const user = db.prepare('SELECT firstName, lastName, avatar, birthDate, phone, email FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  // Profile is "complete" if they have: avatar, birthDate, and at least phone or email
  return !!(user.avatar && user.birthDate && (user.phone || user.email));
}

module.exports = {
  POINT_VALUES,
  TIERS,
  getTierForPoints,
  getNextTier,
  awardPoints,
  ensureUserPoints,
  getUserPoints,
  processLogin,
  processMissedEvents,
  checkProfileComplete,
};
