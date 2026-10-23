const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-jwt-secret';

const users = [];
let userCounter = 0;

function matchesQuery(user, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some((subQuery) => matchesQuery(user, subQuery));
    return user[key] === value;
  });
}

class FakeUser {
  constructor(data = {}) {
    Object.assign(this, data);
    if (!this._id) this._id = `user-${++userCounter}`;
    this.id = this._id;
  }

  async save() {
    await new Promise((resolve) => setImmediate(resolve));

    if (users.some((user) => user !== this && user.email === this.email)) {
      const error = new Error('duplicate email');
      error.code = 11000;
      throw error;
    }

    if (this.googleId && users.some((user) => user !== this && user.googleId === this.googleId)) {
      const error = new Error('duplicate googleId');
      error.code = 11000;
      throw error;
    }

    if (!users.includes(this)) users.push(this);
    return this;
  }

  static async findOne(query = {}) {
    return users.find((user) => matchesQuery(user, query)) || null;
  }

  static async create(data) {
    const user = new FakeUser(data);
    await user.save();
    return user;
  }
}

const userModelPath = require.resolve('../models/User');
require.cache[userModelPath] = {
  id: userModelPath,
  filename: userModelPath,
  loaded: true,
  exports: FakeUser
};

const googleState = {
  payload: null,
  error: null,
  lastOptions: null
};

class FakeOAuth2Client {
  constructor(clientId) {
    this.clientId = clientId;
  }

  async verifyIdToken(options) {
    googleState.lastOptions = options;
    if (googleState.error) throw googleState.error;
    return { getPayload: () => googleState.payload };
  }
}

const googleAuthPath = require.resolve('google-auth-library');
require.cache[googleAuthPath] = {
  id: googleAuthPath,
  filename: googleAuthPath,
  loaded: true,
  exports: { OAuth2Client: FakeOAuth2Client }
};

const authRoutes = require('../routes/auth');
const authMiddleware = require('../middleware/authMiddleware');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.get('/api/protected', authMiddleware, (req, res) => res.json({ userId: req.user.id }));

let server;
let baseUrl;

function makeGooglePayload(overrides = {}) {
  return {
    sub: 'google-sub-123',
    email: 'google.user@example.com',
    email_verified: true,
    name: 'Google User',
    picture: 'https://example.com/avatar.png',
    aud: 'test-google-client-id',
    iss: 'https://accounts.google.com',
    ...overrides
  };
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  users.length = 0;
  userCounter = 0;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  googleState.payload = makeGooglePayload();
  googleState.error = null;
  googleState.lastOptions = null;
});

test('rejects a missing Google ID token', async () => {
  const response = await post('/api/auth/google', {});

  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'GOOGLE_TOKEN_REQUIRED');
  assert.equal(googleState.lastOptions, null);
});

test('returns a configuration error when GOOGLE_CLIENT_ID is missing', async () => {
  delete process.env.GOOGLE_CLIENT_ID;

  const response = await post('/api/auth/google', { idToken: 'any-token' });

  assert.equal(response.status, 503);
  assert.equal(response.data.code, 'GOOGLE_AUTH_NOT_CONFIGURED');
  assert.equal(googleState.lastOptions, null);
});

test('rejects invalid and expired Google ID tokens', async () => {
  for (const message of ['Invalid signature', 'Token used too late']) {
    googleState.error = new Error(message);

    const response = await post('/api/auth/google', { idToken: 'bad-token' });

    assert.equal(response.status, 401);
    assert.equal(response.data.code, 'INVALID_GOOGLE_TOKEN');
  }
});

test('validates the token audience against the configured client ID', async () => {
  googleState.payload = makeGooglePayload({ aud: 'some-other-client-id' });

  const response = await post('/api/auth/google', { idToken: 'wrong-audience-token' });

  assert.equal(response.status, 401);
  assert.equal(response.data.code, 'INVALID_GOOGLE_TOKEN');
  assert.equal(googleState.lastOptions.idToken, 'wrong-audience-token');
  assert.equal(googleState.lastOptions.audience, 'test-google-client-id');
});

test('rejects Google accounts with an unverified email', async () => {
  googleState.payload = makeGooglePayload({ email_verified: false });

  const response = await post('/api/auth/google', { credential: 'verified-token' });

  assert.equal(response.status, 403);
  assert.equal(response.data.code, 'GOOGLE_EMAIL_NOT_VERIFIED');
  assert.equal(users.length, 0);
});

test('creates a passwordless user for a new verified Google account', async () => {
  googleState.payload = makeGooglePayload({ email: 'Google.User@Example.com' });

  const response = await post('/api/auth/google', {
    credential: 'valid-google-token',
    email: 'attacker@example.com',
    name: 'Attacker',
    sub: 'attacker-sub'
  });

  assert.equal(response.status, 200);
  assert.equal(users.length, 1);

  const user = users[0];
  assert.equal(user.email, 'google.user@example.com');
  assert.equal(user.name, 'Google User');
  assert.equal(user.googleId, 'google-sub-123');
  assert.equal(user.password, undefined);
  assert.equal(user.avatarUrl, 'https://example.com/avatar.png');

  const decoded = jwt.verify(response.data.token, process.env.JWT_SECRET);
  assert.equal(decoded.user.id, user.id);
  assert.deepEqual(response.data.user, {
    id: user.id,
    name: 'Google User',
    email: 'google.user@example.com'
  });
});

test('signs in an existing Google-linked user without creating a duplicate', async () => {
  const existing = new FakeUser({
    name: 'Existing Google User',
    email: 'google.user@example.com',
    googleId: 'google-sub-123',
    avatarUrl: 'https://example.com/old.png'
  });
  users.push(existing);

  const response = await post('/api/auth/google', { credential: 'valid-google-token' });

  assert.equal(response.status, 200);
  assert.equal(users.length, 1);
  assert.equal(response.data.user.id, existing.id);
  assert.equal(response.data.user.name, 'Existing Google User');
});

test('rejects automatic linking to an existing password account', async () => {
  const passwordHash = await bcrypt.hash('Secret123!', 4);
  const localUser = new FakeUser({
    name: 'Local User',
    email: 'google.user@example.com',
    password: passwordHash
  });
  users.push(localUser);

  const response = await post('/api/auth/google', { credential: 'valid-google-token' });

  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'ACCOUNT_LINK_REQUIRED');
  assert.equal(localUser.googleId, undefined);
  assert.equal(users.length, 1);
  assert.equal(await bcrypt.compare('Secret123!', localUser.password), true);
});

test('rejects a Google identity that conflicts with another linked account', async () => {
  const existing = new FakeUser({
    name: 'Other Google User',
    email: 'google.user@example.com',
    googleId: 'different-google-sub'
  });
  users.push(existing);

  const response = await post('/api/auth/google', { credential: 'valid-google-token' });

  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'GOOGLE_ACCOUNT_CONFLICT');
  assert.equal(existing.googleId, 'different-google-sub');
  assert.equal(users.length, 1);
});

test('handles concurrent Google sign-ins without duplicate accounts', async () => {
  googleState.payload = makeGooglePayload();

  const [first, second] = await Promise.all([
    post('/api/auth/google', { credential: 'valid-google-token' }),
    post('/api/auth/google', { credential: 'valid-google-token' })
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(users.length, 1);
  assert.equal(users.filter((user) => user.googleId === 'google-sub-123').length, 1);
});

test('keeps email/password registration working', async () => {
  const response = await post('/api/auth/register', {
    name: 'Password User',
    email: 'password@example.com',
    password: 'Secret123!'
  });

  assert.equal(response.status, 200);
  assert.equal(users.length, 1);

  const user = users[0];
  assert.notEqual(user.password, 'Secret123!');
  assert.equal(await bcrypt.compare('Secret123!', user.password), true);
  assert.equal(user.googleId, undefined);

  const decoded = jwt.verify(response.data.token, process.env.JWT_SECRET);
  assert.equal(decoded.user.id, user.id);
});

test('keeps email/password login working for password accounts', async () => {
  const passwordHash = await bcrypt.hash('Secret123!', 4);
  users.push(new FakeUser({
    name: 'Password User',
    email: 'password@example.com',
    password: passwordHash
  }));

  const success = await post('/api/auth/login', {
    email: 'password@example.com',
    password: 'Secret123!'
  });
  const failure = await post('/api/auth/login', {
    email: 'password@example.com',
    password: 'wrong-password'
  });

  assert.equal(success.status, 200);
  assert.equal(failure.status, 400);
  assert.equal(failure.data.message, 'Invalid credentials');
});

test('returns invalid credentials for password login on a Google-only account', async () => {
  users.push(new FakeUser({
    name: 'Google Only',
    email: 'google.only@example.com',
    googleId: 'google-only-sub'
  }));

  const response = await post('/api/auth/login', {
    email: 'google.only@example.com',
    password: 'anything'
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.message, 'Invalid credentials');
});

test('issues JWTs that the existing auth middleware accepts', async () => {
  const registerResponse = await post('/api/auth/register', {
    name: 'JWT User',
    email: 'jwt@example.com',
    password: 'Secret123!'
  });
  assert.equal(registerResponse.status, 200);

  const decoded = jwt.verify(registerResponse.data.token, process.env.JWT_SECRET);
  const protectedResponse = await fetch(`${baseUrl}/api/protected`, {
    headers: { Authorization: `Bearer ${registerResponse.data.token}` }
  });
  const protectedBody = await protectedResponse.json();

  assert.equal(protectedResponse.status, 200);
  assert.equal(protectedBody.userId, decoded.user.id);

  const unauthorizedResponse = await fetch(`${baseUrl}/api/protected`);
  assert.equal(unauthorizedResponse.status, 401);

  const invalidTokenResponse = await fetch(`${baseUrl}/api/protected`, {
    headers: { Authorization: 'Bearer invalid-token' }
  });
  assert.equal(invalidTokenResponse.status, 401);
});
