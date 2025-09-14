const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const Note = require('../models/Note');
const crypto = require('crypto');

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

    // Debug logging
    console.log('Debug - Note access check:');
    console.log('Note ID:', req.params.id);
    console.log('Note owner:', note.owner.toString());
    console.log('Request user ID:', req.user.id);
    console.log('User ID type:', typeof req.user.id);
    console.log('Owner ID type:', typeof note.owner.toString());
    console.log('Are they equal?', note.owner.toString() === req.user.id);
    console.log('Collaborators:', note.collaborators);
    console.log('User in collaborators?', note.collaborators.includes(req.user.id));

    // basic access control - fix ObjectId comparison
    const isOwner = note.owner.toString() === req.user.id.toString();
    const isCollaborator = note.collaborators.some(collab => collab.toString() === req.user.id.toString());
    
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ 
        message: 'Access denied',
        debug: {
          noteOwner: note.owner.toString(),
          userId: req.user.id.toString(),
          isOwner,
          isCollaborator,
          collaborators: note.collaborators.map(c => c.toString())
        }
      });
    }

    res.json(note);
  } catch (err) {
    console.error('Error in get note:', err);
    res.status(500).send('Server error');
  }
});


// Update note (save)
router.put('/:id', auth, async (req, res) => {
  const { title, content } = req.body;
  try {
    let note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });
    // Fix ObjectId comparison for update route
    const isOwner = note.owner.toString() === req.user.id.toString();
    const isCollaborator = note.collaborators.some(collab => collab.toString() === req.user.id.toString());
    
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ message: 'Access denied' });
    }

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

// Public access to note (no authentication required)
router.get('/public/:id', async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });
    
    if (!note.isPublic) {
      return res.status(403).json({ message: 'This note is not publicly accessible' });
    }

    res.json({
      _id: note._id,
      title: note.title,
      content: note.content,
      isPublic: true,
      updatedAt: note.updatedAt
    });
  } catch (err) {
    console.error('Error in public note access:', err);
    res.status(500).send('Server error');
  }
});

// Make note public/private
router.put('/:id/visibility', auth, async (req, res) => {
  try {
    const { isPublic } = req.body;
    const note = await Note.findById(req.params.id);
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (note.owner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Only owner can change visibility' });
    }

    note.isPublic = isPublic;
    if (isPublic && !note.shareToken) {
      note.shareToken = crypto.randomBytes(16).toString('hex');
    } else if (!isPublic) {
      note.shareToken = undefined;
    }
    
    await note.save();
    res.json({ 
      isPublic: note.isPublic, 
      shareToken: note.shareToken,
      publicUrl: isPublic ? `/notes/public/${note._id}` : null
    });
  } catch (err) {
    console.error('Error updating note visibility:', err);
    res.status(500).send('Server error');
  }
});

// Add collaborator to note
router.post('/:id/collaborators', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const note = await Note.findById(req.params.id);
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (note.owner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Only owner can add collaborators' });
    }

    if (!note.collaborators.includes(userId)) {
      note.collaborators.push(userId);
      await note.save();
    }

    res.json({ message: 'Collaborator added successfully', collaborators: note.collaborators });
  } catch (err) {
    console.error('Error adding collaborator:', err);
    res.status(500).send('Server error');
  }
});

// Remove collaborator from note
router.delete('/:id/collaborators/:userId', auth, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (note.owner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Only owner can remove collaborators' });
    }

    note.collaborators = note.collaborators.filter(collab => collab.toString() !== req.params.userId);
    await note.save();

    res.json({ message: 'Collaborator removed successfully', collaborators: note.collaborators });
  } catch (err) {
    console.error('Error removing collaborator:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
