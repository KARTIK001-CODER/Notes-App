const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema({
  title: { type: String, default: 'Untitled' },
  content: { type: String, default: '' }, // HTML from Quill
  contentVersion: { type: Number, default: 0 },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isPublic: { type: Boolean, default: false }, // Allow public access
  shareToken: { type: String, unique: true, sparse: true } // Unique token for sharing
}, { timestamps: true });

module.exports = mongoose.model('Note', NoteSchema);
