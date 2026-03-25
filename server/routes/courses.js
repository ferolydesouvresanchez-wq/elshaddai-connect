const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate, requireRole } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'courses');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.mov', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only video (mp4, webm, mov) and PDF files are allowed'));
    }
  }
});

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/courses/:groupId
  router.get('/:groupId', (req, res) => {
    const courses = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM lessons WHERE courseId = c.id) as lessonCount
      FROM courses c WHERE c.groupId = ? ORDER BY c.sortOrder
    `).all(req.params.groupId);
    res.json(courses);
  });

  // POST /api/courses
  router.post('/', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { groupId, title, description } = req.body;
    if (!groupId || !title) return res.status(400).json({ error: 'groupId and title required' });

    const maxOrder = db.prepare('SELECT MAX(sortOrder) as max FROM courses WHERE groupId = ?').get(groupId);
    const id = uuidv4();
    db.prepare('INSERT INTO courses (id, groupId, title, description, sortOrder, createdBy) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, groupId, title, description || null, (maxOrder.max || 0) + 1, req.user.id
    );

    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
    res.status(201).json(course);
  });

  // PUT /api/courses/:id
  router.put('/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { title, description, sortOrder } = req.body;
    const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Course not found' });

    db.prepare('UPDATE courses SET title=?, description=?, sortOrder=? WHERE id = ?').run(
      title || existing.title, description !== undefined ? description : existing.description,
      sortOrder !== undefined ? sortOrder : existing.sortOrder, req.params.id
    );

    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    res.json(course);
  });

  // DELETE /api/courses/:id
  router.delete('/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    // Delete associated lesson files
    const lessons = db.prepare('SELECT * FROM lessons WHERE courseId = ?').all(req.params.id);
    for (const lesson of lessons) {
      if (lesson.filePath) {
        try { fs.unlinkSync(path.join(__dirname, '..', lesson.filePath)); } catch (e) {}
      }
    }
    db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
    res.json({ message: 'Course deleted' });
  });

  // GET /api/courses/:courseId/lessons
  router.get('/:courseId/lessons', (req, res) => {
    const lessons = db.prepare('SELECT * FROM lessons WHERE courseId = ? ORDER BY sortOrder').all(req.params.courseId);

    // Add user progress
    const withProgress = lessons.map(lesson => {
      const progress = db.prepare('SELECT * FROM lesson_progress WHERE lessonId = ? AND userId = ?').get(lesson.id, req.user.id);
      return { ...lesson, progress: progress || null };
    });

    res.json(withProgress);
  });

  // POST /api/courses/:courseId/lessons - Add lesson (with file upload)
  router.post('/:courseId/lessons', requireRole('superadmin', 'admin', 'ministry_leader'),
    upload.single('file'), (req, res) => {
      const { title, type, url } = req.body;
      if (!title || !type) return res.status(400).json({ error: 'title and type required' });

      const maxOrder = db.prepare('SELECT MAX(sortOrder) as max FROM lessons WHERE courseId = ?').get(req.params.courseId);
      const id = uuidv4();
      const filePath = req.file ? `uploads/courses/${req.file.filename}` : null;

      db.prepare(`
        INSERT INTO lessons (id, courseId, title, type, url, filePath, duration, sortOrder)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, req.params.courseId, title, type, url || null, filePath,
             req.body.duration ? Number(req.body.duration) : null, (maxOrder.max || 0) + 1);

      const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
      res.status(201).json(lesson);
    }
  );

  // DELETE /api/courses/lessons/:id
  router.delete('/lessons/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    if (lesson.filePath) {
      try { fs.unlinkSync(path.join(__dirname, '..', lesson.filePath)); } catch (e) {}
    }
    db.prepare('DELETE FROM lessons WHERE id = ?').run(req.params.id);
    res.json({ message: 'Lesson deleted' });
  });

  // PUT /api/courses/lessons/:id/progress
  router.put('/lessons/:id/progress', (req, res) => {
    const { completed, progress, lastPosition } = req.body;
    const existing = db.prepare('SELECT * FROM lesson_progress WHERE lessonId = ? AND userId = ?').get(req.params.id, req.user.id);

    if (existing) {
      db.prepare(`
        UPDATE lesson_progress SET completed=?, progress=?, lastPosition=?, updatedAt=datetime('now')
        WHERE lessonId = ? AND userId = ?
      `).run(completed ? 1 : 0, progress || 0, lastPosition || 0, req.params.id, req.user.id);
    } else {
      db.prepare(`
        INSERT INTO lesson_progress (id, lessonId, userId, completed, progress, lastPosition)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), req.params.id, req.user.id, completed ? 1 : 0, progress || 0, lastPosition || 0);
    }

    res.json({ message: 'Progress updated' });
  });

  return router;
};
