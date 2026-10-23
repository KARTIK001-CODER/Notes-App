const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const Note = require('../models/Note');
const crypto = require('crypto');

function normalizeContentVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function accessFilter(userId) {
  return { $or: [{ owner: userId }, { collaborators: userId }] };
}

function contentVersionFilter(version) {
  if (version === 0) {
    return {
      $or: [
        { contentVersion: 0 },
        { contentVersion: { $exists: false } }
      ]
    };
  }
  return { contentVersion: version };
}

async function findCurrentVersion(noteId) {
  const note = await Note.findById(noteId).select('contentVersion').lean();
  return note ? normalizeContentVersion(note.contentVersion) : null;
}

function hasPendingContentWrite(req, noteId) {
  const persistence = req.app.locals?.notePersistence;
  if (!persistence || typeof persistence.hasPending !== 'function') return false;
  return persistence.hasPending(String(noteId).toLowerCase());
}

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

// Get all public notes (no authentication required)
router.get('/public', async (req, res) => {
  try {
    const notes = await Note.find({ isPublic: true })
      .select('_id title content isPublic updatedAt owner')
      .sort({ updatedAt: -1 });
    res.json(notes);
  } catch (err) {
    console.error('Error fetching public notes:', err);
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

// Get single note
router.get('/:id', auth, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });

    const isOwner = note.owner.toString() === req.user.id.toString();
    const isCollaborator = note.collaborators.some(collab => collab.toString() === req.user.id.toString());

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(note);
  } catch (err) {
    console.error('Error in get note:', err);
    res.status(500).send('Server error');
  }
});


// Update note (save)
router.put('/:id', auth, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });

    const isOwner = note.owner.toString() === req.user.id.toString();
    const isCollaborator = note.collaborators.some(collab => collab.toString() === req.user.id.toString());

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'title')) {
      updates.title = req.body.title;
    }

    const hasContent = Object.prototype.hasOwnProperty.call(req.body, 'content');
    if (!hasContent) {
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: 'No supported fields to update' });
      }

      updates.updatedAt = new Date();
      const updated = await Note.findOneAndUpdate(
        { _id: req.params.id, $and: [accessFilter(req.user.id)] },
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        const exists = await Note.exists({ _id: req.params.id });
        return exists
          ? res.status(403).json({ message: 'Access denied' })
          : res.status(404).json({ message: 'Note not found' });
      }

      return res.json(updated);
    }

    if (typeof req.body.content !== 'string') {
      return res.status(400).json({ code: 'INVALID_CONTENT', message: 'Content must be a string' });
    }

    const contentVersion = req.body.contentVersion;
    const currentVersion = normalizeContentVersion(note.contentVersion);

    if (!Number.isInteger(contentVersion) || contentVersion < 0) {
      return res.status(428).json({
        code: 'VERSION_REQUIRED',
        message: 'contentVersion is required when updating content',
        contentVersion: currentVersion
      });
    }

    if (contentVersion !== currentVersion) {
      return res.status(409).json({
        code: 'VERSION_CONFLICT',
        message: 'Note content has changed since it was loaded',
        contentVersion: currentVersion
      });
    }

    if (hasPendingContentWrite(req, note._id)) {
      return res.status(409).json({
        code: 'WRITE_IN_PROGRESS',
        message: 'A realtime content write is pending',
        contentVersion: currentVersion
      });
    }

    updates.content = req.body.content;
    updates.updatedAt = new Date();

    const updated = await Note.findOneAndUpdate(
      {
        _id: req.params.id,
        $and: [accessFilter(req.user.id), contentVersionFilter(contentVersion)]
      },
      {
        $set: updates,
        $inc: { contentVersion: 1 }
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      const latestVersion = await findCurrentVersion(req.params.id);
      if (latestVersion === null) {
        return res.status(404).json({ message: 'Note not found' });
      }
      return res.status(409).json({
        code: 'VERSION_CONFLICT',
        message: 'Note content has changed since it was loaded',
        contentVersion: latestVersion
      });
    }

    if (hasPendingContentWrite(req, note._id)) {
      return res.status(409).json({
        code: 'WRITE_IN_PROGRESS',
        message: 'A realtime content write is pending',
        contentVersion: updated.contentVersion
      });
    }

    res.json(updated);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Delete note
router.delete('/:id', auth, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (note.owner.toString() !== req.user.id.toString()) return res.status(403).json({ message: 'Only owner can delete' });
    await note.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (err) {
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
