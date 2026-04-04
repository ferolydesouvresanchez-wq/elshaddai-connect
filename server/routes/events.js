const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAllUsers } = require('../helpers/notify');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  function enrichEvent(event, userId) {
    const rsvpCount = db.prepare('SELECT COUNT(*) as count FROM event_rsvps WHERE eventId = ?').get(event.id).count;
    const myRsvp = userId ? db.prepare('SELECT id, createdAt FROM event_rsvps WHERE eventId = ? AND userId = ?').get(event.id, userId) : null;
    const myCheckin = userId ? db.prepare("SELECT id, checkedAt FROM event_checkins WHERE eventId = ? AND userId = ? AND type = 'checkin'").get(event.id, userId) : null;
    const myCheckout = userId ? db.prepare("SELECT id, checkedAt FROM event_checkins WHERE eventId = ? AND userId = ? AND type = 'checkout'").get(event.id, userId) : null;
    const checkinCount = db.prepare("SELECT COUNT(*) as count FROM event_checkins WHERE eventId = ? AND type = 'checkin'").get(event.id).count;
    return {
      ...event,
      rsvpCount,
      checkinCount,
      myRsvp: myRsvp ? { id: myRsvp.id, createdAt: myRsvp.createdAt } : null,
      myCheckin: myCheckin ? { id: myCheckin.id, checkedAt: myCheckin.checkedAt } : null,
      myCheckout: myCheckout ? { id: myCheckout.id, checkedAt: myCheckout.checkedAt } : null,
    };
  }

  // GET /api/events
  router.get('/', (req, res) => {
    const { upcoming, month, year, type, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT e.*, u.firstName as creatorFirst, u.lastName as creatorLast FROM events e LEFT JOIN users u ON e.createdBy = u.id WHERE 1=1';
    const params = [];

    if (upcoming === 'true') {
      sql += " AND e.date >= date('now')";
    }
    if (month && year) {
      const datePrefix = `${year}-${String(month).padStart(2, '0')}`;
      sql += " AND e.date LIKE ? || '%'";
      params.push(datePrefix);
    }
    if (type) { sql += ' AND e.type = ?'; params.push(type); }

    sql += ' ORDER BY e.date ASC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const events = db.prepare(sql).all(...params);
    res.json(events.map(e => enrichEvent(e, req.user.id)));
  });

  // GET /api/events/:id
  router.get('/:id', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Get full RSVP list with user names
    const rsvps = db.prepare(`
      SELECT er.*, u.firstName, u.lastName, u.avatar
      FROM event_rsvps er JOIN users u ON er.userId = u.id
      WHERE er.eventId = ?
    `).all(req.params.id);

    // Get check-ins
    const checkins = db.prepare(`
      SELECT ec.*, u.firstName, u.lastName
      FROM event_checkins ec JOIN users u ON ec.userId = u.id
      WHERE ec.eventId = ?
    `).all(req.params.id);

    res.json({ ...enrichEvent(event, req.user.id), rsvps, checkins });
  });

  // POST /api/events
  router.post('/', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { title, description, date, time, endDate, endTime, location, type, recurring, photo, lat, lng } = req.body;
    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date required' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO events (id, title, description, date, time, endDate, endTime, location, type, recurring, photo, lat, lng, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description || null, date, time || null, endDate || null, endTime || null,
           location || null, type || 'general', recurring ? 1 : 0, photo || null,
           lat != null ? lat : null, lng != null ? lng : null, req.user.id);

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);

    // Notify all users about the new event
    notifyAllUsers(db, {
      type: 'new_event',
      title: 'New Event: ' + title,
      message: `${date}${time ? ' at ' + time : ''}${location ? ' - ' + location : ''}`,
      refId: id,
      excludeUserId: req.user.id,
    });

    res.status(201).json(enrichEvent(event, req.user.id));
  });

  // PUT /api/events/:id
  router.put('/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role === 'ministry_leader' && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Can only edit your own events' });
    }

    const { title, description, date, time, endDate, endTime, location, type, recurring, photo, lat, lng } = req.body;
    db.prepare(`
      UPDATE events SET title=?, description=?, date=?, time=?, endDate=?, endTime=?, location=?, type=?, recurring=?, photo=?, lat=?, lng=?, updatedAt=datetime('now')
      WHERE id = ?
    `).run(
      title || existing.title, description !== undefined ? description : existing.description,
      date || existing.date, time !== undefined ? time : existing.time,
      endDate !== undefined ? endDate : existing.endDate,
      endTime !== undefined ? endTime : existing.endTime,
      location !== undefined ? location : existing.location,
      type || existing.type, recurring !== undefined ? (recurring ? 1 : 0) : existing.recurring,
      photo !== undefined ? photo : existing.photo,
      lat !== undefined ? lat : existing.lat,
      lng !== undefined ? lng : existing.lng,
      req.params.id
    );

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    res.json(enrichEvent(event, req.user.id));
  });

  // DELETE /api/events/:id
  router.delete('/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role === 'ministry_leader' && event.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Can only delete your own events' });
    }
    db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
    res.json({ message: 'Event deleted' });
  });

  // POST /api/events/:id/rsvp
  router.post('/:id/rsvp', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    try {
      db.prepare('INSERT INTO event_rsvps (id, eventId, userId) VALUES (?, ?, ?)').run(
        uuidv4(), req.params.id, req.user.id
      );
      res.status(201).json({ message: 'RSVP confirmed' });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.json({ message: 'Already RSVPd' });
      throw e;
    }
  });

  // DELETE /api/events/:id/rsvp
  router.delete('/:id/rsvp', (req, res) => {
    db.prepare('DELETE FROM event_rsvps WHERE eventId = ? AND userId = ?').run(req.params.id, req.user.id);
    // Also remove check-ins if RSVP is cancelled
    db.prepare('DELETE FROM event_checkins WHERE eventId = ? AND userId = ?').run(req.params.id, req.user.id);
    res.json({ message: 'RSVP cancelled' });
  });

  // GET /api/events/:id/rsvps - Get all RSVPs for an event
  router.get('/:id/rsvps', (req, res) => {
    const rsvps = db.prepare(`
      SELECT er.*, u.firstName, u.lastName, u.avatar
      FROM event_rsvps er JOIN users u ON er.userId = u.id
      WHERE er.eventId = ?
    `).all(req.params.id);
    res.json(rsvps);
  });

  // Helper: calculate distance between two lat/lng points in meters (Haversine)
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  const CHECKIN_RADIUS_METERS = 150; // Must be within 150m of event location

  // POST /api/events/:id/checkin - Check in to event (requires geolocation)
  router.post('/:id/checkin', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Must have RSVP'd first
    const rsvp = db.prepare('SELECT id FROM event_rsvps WHERE eventId = ? AND userId = ?').get(req.params.id, req.user.id);
    if (!rsvp) return res.status(400).json({ error: 'Must RSVP before checking in' });

    // Verify geolocation if event has coordinates
    const { lat, lng } = req.body || {};
    if (event.lat != null && event.lng != null) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Location required for check-in. Please enable GPS.' });
      }
      const dist = distanceMeters(lat, lng, event.lat, event.lng);
      if (dist > CHECKIN_RADIUS_METERS) {
        return res.status(400).json({
          error: `You must be at the event location to check in. You are ${Math.round(dist)}m away (max ${CHECKIN_RADIUS_METERS}m).`,
          distance: Math.round(dist),
          maxDistance: CHECKIN_RADIUS_METERS
        });
      }
    }

    try {
      db.prepare("INSERT INTO event_checkins (id, eventId, userId, type) VALUES (?, ?, ?, 'checkin')").run(
        uuidv4(), req.params.id, req.user.id
      );
      res.status(201).json({ message: 'Checked in successfully!' });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.json({ message: 'Already checked in' });
      throw e;
    }
  });

  // POST /api/events/:id/checkout - Check out from event (requires geolocation)
  router.post('/:id/checkout', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Must have checked in first
    const checkin = db.prepare("SELECT id FROM event_checkins WHERE eventId = ? AND userId = ? AND type = 'checkin'").get(req.params.id, req.user.id);
    if (!checkin) return res.status(400).json({ error: 'Must check in before checking out' });

    // Verify geolocation if event has coordinates
    const { lat, lng } = req.body || {};
    if (event.lat != null && event.lng != null) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Location required for check-out. Please enable GPS.' });
      }
      const dist = distanceMeters(lat, lng, event.lat, event.lng);
      if (dist > CHECKIN_RADIUS_METERS) {
        return res.status(400).json({
          error: `You must be at the event location to check out. You are ${Math.round(dist)}m away (max ${CHECKIN_RADIUS_METERS}m).`,
          distance: Math.round(dist),
          maxDistance: CHECKIN_RADIUS_METERS
        });
      }
    }

    try {
      db.prepare("INSERT INTO event_checkins (id, eventId, userId, type) VALUES (?, ?, ?, 'checkout')").run(
        uuidv4(), req.params.id, req.user.id
      );
      res.status(201).json({ message: 'Checked out successfully!' });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.json({ message: 'Already checked out' });
      throw e;
    }
  });

  return router;
};
