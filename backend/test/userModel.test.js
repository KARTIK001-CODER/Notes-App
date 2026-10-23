const { test } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');

test('allows Google-only users without a password', async () => {
  const user = new User({
    name: 'Google User',
    email: 'google@example.com',
    googleId: 'google-sub-123'
  });

  await user.validate();

  assert.equal(user.password, undefined);
  assert.equal(user.googleId, 'google-sub-123');
});

test('still requires a password for non-Google users', async () => {
  const user = new User({
    name: 'Local User',
    email: 'local@example.com'
  });

  await assert.rejects(
    user.validate(),
    (error) => Boolean(error.errors?.password)
  );
});

test('declares unique indexes for email and the Google subject identifier', () => {
  const indexes = User.schema.indexes();
  const emailIndex = indexes.find(([fields]) => fields.email === 1);
  const googleIdIndex = indexes.find(([fields]) => fields.googleId === 1);

  assert.equal(emailIndex[1].unique, true);
  assert.equal(googleIdIndex[1].unique, true);
  assert.equal(googleIdIndex[1].sparse, true);
});
