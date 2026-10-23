const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: {
    type: String,
    required: function() { return !this.googleId; }
  },
  googleId: { type: String, unique: true, sparse: true },
  avatarUrl: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
