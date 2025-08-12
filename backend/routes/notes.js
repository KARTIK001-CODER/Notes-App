const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const Note = require('../models/Note');

// Create note
router.post('/', auth, async (req, res) => {
  const { title, content } = req.body;
  try {
    const note = new Note({ title: title || 'Untitled', content: content || '', owner: req.user.id });
    await note.save();
    res.json(note);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Get all user's notes
router.get('/', auth, async (req, res) => {
  try {
    const notes = await Note.find({
      $or: [
        { owner: req.user.id },
        { collaborators: req.user.id }
      ]
    }).sort({ updatedAt: -1 });
    res.json(notes);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Get single note
router.get('/:id', auth, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });
    // basic access control
    if (note.owner.toString() !== req.user.id && !note.collaborators.includes(req.user.id))
      return res.status(403).json({ message: 'Access denied' });
    res.json(note);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Update note (save)
router.put('/:id', auth, async (req, res) => {
  const { title, content } = req.body;
  try {
    let note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (note.owner.toString() !== req.user.id && !note.collaborators.includes(req.user.id))
      return res.status(403).json({ message: 'Access denied' });

    note.title = title ?? note.title;
    note.content = content ?? note.content;
    note.updatedAt = new Date();
    await note.save();
    res.json(note);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Delete note
router.delete('/:id', auth, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (note.owner.toString() !== req.user.id) return res.status(403).json({ message: 'Only owner can delete' });
    await note.remove();
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

module.exports = router;
