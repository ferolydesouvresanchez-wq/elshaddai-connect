const { v4: uuidv4 } = require('uuid');

/**
 * Send a notification to all active, approved users (except the sender)
 */
function notifyAllUsers(db, { type, title, message, refId, excludeUserId }) {
  const users = db.prepare(
    "SELECT id FROM users WHERE active = 1 AND status = 'approved' AND id != ?"
  ).all(excludeUserId || '');

  const insert = db.prepare(
    'INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((userList) => {
    for (const user of userList) {
      insert.run(uuidv4(), user.id, type, title, message || null, refId || null);
    }
  });

  insertMany(users);
  return users.length;
}

/**
 * Send a notification to specific users
 */
function notifyUsers(db, userIds, { type, title, message, refId }) {
  const insert = db.prepare(
    'INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((ids) => {
    for (const userId of ids) {
      insert.run(uuidv4(), userId, type, title, message || null, refId || null);
    }
  });

  insertMany(userIds);
  return userIds.length;
}

module.exports = { notifyAllUsers, notifyUsers };
