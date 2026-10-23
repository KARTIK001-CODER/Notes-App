const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
require('dotenv').config();

function createAuthResponse(user) {
  const payload = { user: { id: user.id } };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: 'User already exists' });

    const hashed = await bcrypt.hash(password, 10);
    user = new User({ name, email, password: hashed });
    await user.save();

    res.json(createAuthResponse(user));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !user.password) return res.status(400).json({ message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Invalid credentials' });

    res.json(createAuthResponse(user));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  const body = req.body || {};
  const idToken = typeof body.idToken === 'string' && body.idToken
    ? body.idToken
    : (typeof body.credential === 'string' ? body.credential : '');

  if (!idToken) {
    return res.status(400).json({
      message: 'Google ID token is required',
      code: 'GOOGLE_TOKEN_REQUIRED'
    });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({
      message: 'Google Sign-In is not configured on the server',
      code: 'GOOGLE_AUTH_NOT_CONFIGURED'
    });
  }

  let payload;
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    payload = ticket.getPayload();
  } catch (err) {
    console.error('Google ID token verification failed:', err.message);
    return res.status(401).json({
      message: 'Invalid Google ID token',
      code: 'INVALID_GOOGLE_TOKEN'
    });
  }

  if (!payload || !payload.sub || !payload.email || payload.aud !== clientId) {
    return res.status(401).json({
      message: 'Invalid Google ID token',
      code: 'INVALID_GOOGLE_TOKEN'
    });
  }

  if (payload.email_verified !== true) {
    return res.status(403).json({
      message: 'Google account email is not verified',
      code: 'GOOGLE_EMAIL_NOT_VERIFIED'
    });
  }

  const googleId = String(payload.sub);
  const email = String(payload.email).trim().toLowerCase();
  const name = (typeof payload.name === 'string' && payload.name.trim()) || email.split('@')[0];
  const avatarUrl = typeof payload.picture === 'string' && payload.picture ? payload.picture : undefined;

  try {
    let user = await User.findOne({ googleId });

    if (!user) {
      const existingEmailUser = await User.findOne({ email });

      if (existingEmailUser) {
        if (existingEmailUser.googleId === googleId) {
          user = existingEmailUser;
        } else if (existingEmailUser.googleId) {
          return res.status(409).json({
            message: 'This email is already linked to a different Google account',
            code: 'GOOGLE_ACCOUNT_CONFLICT'
          });
        } else {
          return res.status(409).json({
            message: 'An account with this email already exists. Please sign in with your password.',
            code: 'ACCOUNT_LINK_REQUIRED'
          });
        }
      }
    }

    if (!user) {
      try {
        user = await User.create({ name, email, googleId, avatarUrl });
      } catch (err) {
        if (err.code === 11000) {
          const racedUser = await User.findOne({ googleId });
          if (racedUser) {
            user = racedUser;
          } else {
            return res.status(409).json({
              message: 'An account with this email already exists',
              code: 'ACCOUNT_EXISTS'
            });
          }
        } else {
          throw err;
        }
      }
    }

    res.json(createAuthResponse(user));
  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
