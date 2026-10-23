const JWT_SECRET = 'mongo-integration-secret';
process.env.JWT_SECRET = JWT_SECRET;

const { after, afterEach, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const Note = require('../models/Note');
const noteRoutes = require('../routes/notes');
const { createRealtimeServer } = require('../socket');

const silentLogger = { error() {} };
const clients = new Set();

let mongoServer;
let setupError;
let app;
let httpServer;
let io;
let realtime;
let apiUrl;
let socketUrl;

function randomId() {
  return new mongoose.Types.ObjectId().toString();
}

function makeToken(userId) {
  return jwt.sign({ user: { id: userId } }, JWT_SECRET, { expiresIn: '1h' });
}

function createSocket(token, url = socketUrl) {
  const socket = createClient(url, {
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    transports: ['websocket'],
    auth: token ? { token } : {}
  });
  clients.add(socket);
  return socket;
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Connection timed out'));
    }, 5000);

    function cleanup() {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    }

    function onConnect() {
      cleanup();
      resolve(socket);
    }

    function onConnectError(error) {
      cleanup();
      reject(error);
    }

    socket.once('connect', onConnect);
    socket.once('connect_error', onConnectError);
    socket.connect();
  });
}

async function connectAs(userId, url = socketUrl) {
  const socket = createSocket(makeToken(userId), url);
  await waitForConnect(socket);
  return socket;
}

function emitAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 5000);
    socket.emit(event, ...args, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off(event, onEvent);
    }

    function onEvent(payload) {
      cleanup();
      resolve(payload);
    }

    socket.once(event, onEvent);
  });
}

function expectNoEvent(socket, event, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off(event, onEvent);
    }

    function onEvent() {
      cleanup();
      reject(new Error(`Unexpected ${event} received`));
    }

    socket.on(event, onEvent);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDbNote(noteId, predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const note = await Note.findById(noteId).lean();
    if (note && predicate(note)) return note;
    await delay(20);
  }
  throw new Error('Timed out waiting for database state');
}

async function putNote(noteId, body, token, baseUrl = apiUrl) {
  const response = await fetch(`${baseUrl}/api/notes/${noteId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function getNote(noteId, token) {
  const response = await fetch(`${apiUrl}/api/notes/${noteId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function createNote(overrides = {}) {
  return Note.create({
    title: 'Test note',
    content: '',
    owner: randomId(),
    collaborators: [],
    isPublic: false,
    ...overrides
  });
}

async function startLongDebounceRealtimeServer() {
  const longHttpServer = http.createServer();
  const longIo = new Server(longHttpServer);
  const longRealtime = createRealtimeServer(longIo, {
    Note,
    jwtSecret: JWT_SECRET,
    debounceMs: 60_000,
    maxWaitMs: 1000,
    maxAttempts: 3,
    logger: silentLogger
  });

  await new Promise((resolve) => {
    longHttpServer.listen(0, '127.0.0.1', resolve);
  });

  return {
    httpServer: longHttpServer,
    io: longIo,
    realtime: longRealtime,
    url: `http://127.0.0.1:${longHttpServer.address().port}`
  };
}

async function stopRealtimeServer(server) {
  await server.realtime.flushAll();
  await new Promise((resolve) => server.io.close(resolve));
  if (server.httpServer.listening) {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}

function requireMongo(t) {
  if (!setupError) return true;
  t.skip(`Real MongoDB unavailable: ${setupError.message}`);
  return false;
}

before(async () => {
  try {
    mongoServer = await MongoMemoryServer.create({
      instance: { dbName: `collabnotes_test_${process.pid}_${Date.now()}` }
    });
    await mongoose.connect(mongoServer.getUri(), {
      serverSelectionTimeoutMS: 10_000
    });

    app = express();
    app.use(express.json());
    app.use('/api/notes', noteRoutes);

    httpServer = http.createServer(app);
    io = new Server(httpServer);
    realtime = createRealtimeServer(io, {
      Note,
      jwtSecret: JWT_SECRET,
      debounceMs: 40,
      maxWaitMs: 300,
      maxAttempts: 3,
      logger: silentLogger
    });
    app.locals.notePersistence = realtime;

    await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = `http://127.0.0.1:${httpServer.address().port}`;
    apiUrl = address;
    socketUrl = address;
  } catch (err) {
    setupError = err;
  }
});

after(async () => {
  for (const socket of clients) socket.disconnect();
  clients.clear();

  if (realtime) await realtime.flushAll();
  if (io) await new Promise((resolve) => io.close(resolve));
  if (httpServer?.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop({ doCleanup: true, force: true });
  }
});

beforeEach(async () => {
  if (!setupError) await Note.deleteMany({});
});

afterEach(async () => {
  for (const socket of clients) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  clients.clear();
  if (realtime) await realtime.flushAll();
});

test('persists accepted socket edits and reads them back from MongoDB', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note.id);
  const saved = waitForEvent(owner, 'note-saved');
  const response = await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: '<p>persisted from socket</p>',
    contentVersion: 0
  });
  const status = await saved;

  assert.deepEqual(response, { ok: true });
  assert.ok(Number.isInteger(status.contentVersion));
  assert.ok(status.contentVersion >= 1);

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.content, '<p>persisted from socket</p>');
  assert.equal(stored.contentVersion, status.contentVersion);
});

test('persists the latest of rapid successive socket edits', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note.id);
  const saved = waitForEvent(owner, 'note-saved');

  const responses = await Promise.all([
    emitAck(owner, 'note-edit', {
      noteId: note.id,
      content: 'first',
      contentVersion: 0,
      clientEditId: 1
    }),
    emitAck(owner, 'note-edit', {
      noteId: note.id,
      content: 'second',
      contentVersion: 0,
      clientEditId: 2
    }),
    emitAck(owner, 'note-edit', {
      noteId: note.id,
      content: 'third',
      contentVersion: 0,
      clientEditId: 3
    })
  ]);

  assert.ok(responses.every((response) => response.ok === true));
  await saved;

  const stored = await waitForDbNote(note.id, (doc) => doc.content === 'third');
  assert.equal(stored.content, 'third');
});

test('accepts a same-client follow-up that trails its own completed save', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note.id);
  const firstSaved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'first',
    contentVersion: 0,
    clientId: 'client-a',
    clientEditId: 1
  });
  assert.equal((await firstSaved).contentVersion, 1);

  const conflicts = [];
  owner.on('note-save-conflict', (payload) => conflicts.push(payload));

  const secondSaved = waitForEvent(owner, 'note-saved');
  const response = await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'second',
    contentVersion: 0,
    clientId: 'client-a',
    clientEditId: 2
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(await secondSaved, { contentVersion: 2, clientEditId: 2 });

  const stored = await waitForDbNote(note.id, (doc) => doc.content === 'second');
  assert.equal(stored.contentVersion, 2);
  assert.deepEqual(conflicts, []);
});

test('rejoining after a socket reconnect resumes from the current revision', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  const firstJoin = await emitAck(owner, 'join-note', note.id);
  assert.equal(firstJoin.ok, true);
  assert.equal(firstJoin.contentVersion, 0);

  const firstSaved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'before reconnect',
    contentVersion: firstJoin.contentVersion,
    clientId: 'client-a',
    clientEditId: 1
  });
  assert.equal((await firstSaved).contentVersion, 1);

  owner.disconnect();

  const reconnected = await connectAs(ownerId);
  const secondJoin = await emitAck(reconnected, 'join-note', note.id);
  assert.equal(secondJoin.ok, true);
  assert.equal(secondJoin.contentVersion, 1);

  const secondSaved = waitForEvent(reconnected, 'note-saved');
  const response = await emitAck(reconnected, 'note-edit', {
    noteId: note.id,
    content: 'after reconnect',
    contentVersion: secondJoin.contentVersion,
    clientId: 'client-a',
    clientEditId: 2
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(await secondSaved, { contentVersion: 2, clientEditId: 2 });

  const stored = await waitForDbNote(note.id, (doc) => doc.content === 'after reconnect');
  assert.equal(stored.contentVersion, 2);
});

test('flushes pending socket writes and reports success during shutdown', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const longServer = await startLongDebounceRealtimeServer();

  try {
    const owner = await connectAs(ownerId, longServer.url);
    await emitAck(owner, 'join-note', note.id);
    const response = await emitAck(owner, 'note-edit', {
      noteId: note.id,
      content: 'saved during shutdown flush',
      contentVersion: 0
    });
    assert.deepEqual(response, { ok: true });

    const flushResult = await longServer.realtime.flushAll();
    assert.deepEqual(flushResult, { ok: true, pending: 0, failures: [] });

    const stored = await Note.findById(note.id).lean();
    assert.equal(stored.content, 'saved during shutdown flush');
    assert.equal(stored.contentVersion, 1);
  } finally {
    await stopRealtimeServer(longServer);
  }
});

test('rejects stale REST content without overwriting newer socket content', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);
  await emitAck(owner, 'join-note', note.id);

  const saved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'socket newer content',
    contentVersion: 0
  });
  const status = await saved;

  const staleResponse = await putNote(note.id, {
    content: 'stale REST content',
    contentVersion: 0
  }, makeToken(ownerId));

  assert.equal(staleResponse.status, 409);
  assert.equal(staleResponse.data.code, 'VERSION_CONFLICT');

  let stored = await Note.findById(note.id).lean();
  assert.equal(stored.content, 'socket newer content');
  assert.equal(stored.contentVersion, status.contentVersion);

  const currentResponse = await putNote(note.id, {
    content: 'REST updated content',
    contentVersion: status.contentVersion
  }, makeToken(ownerId));

  assert.equal(currentResponse.status, 200);
  stored = await Note.findById(note.id).lean();
  assert.equal(stored.content, 'REST updated content');
  assert.equal(stored.contentVersion, status.contentVersion + 1);
});

test('increments the revision atomically for concurrent REST writes', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId, content: 'original' });
  const token = makeToken(ownerId);

  const [first, second] = await Promise.all([
    putNote(note.id, { content: 'first concurrent write', contentVersion: 0 }, token),
    putNote(note.id, { content: 'second concurrent write', contentVersion: 0 }, token)
  ]);

  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);

  const conflict = [first, second].find((response) => response.status === 409);
  assert.equal(conflict.data.code, 'VERSION_CONFLICT');
  assert.equal(conflict.data.contentVersion, 1);

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.contentVersion, 1);
  assert.ok(['first concurrent write', 'second concurrent write'].includes(stored.content));
});

test('rejects a socket write that conflicts with a concurrent REST write', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const longServer = await startLongDebounceRealtimeServer();

  try {
    const owner = await connectAs(ownerId, longServer.url);
    await emitAck(owner, 'join-note', note.id);

    const conflictPromise = waitForEvent(owner, 'note-save-conflict');
    const socketResponse = await emitAck(owner, 'note-edit', {
      noteId: note.id,
      content: 'socket content',
      contentVersion: 0,
      clientEditId: 1
    });
    assert.deepEqual(socketResponse, { ok: true });

    const restResponse = await putNote(note.id, {
      content: 'REST content',
      contentVersion: 0
    }, makeToken(ownerId));
    assert.equal(restResponse.status, 200);
    assert.equal(restResponse.data.contentVersion, 1);

    const flushResult = await longServer.realtime.flushAll();
    assert.equal(flushResult.ok, true);

    const conflict = await conflictPromise;
    assert.deepEqual(conflict, {
      code: 'VERSION_CONFLICT',
      contentVersion: 1
    });

    const stored = await Note.findById(note.id).lean();
    assert.equal(stored.content, 'REST content');
    assert.equal(stored.contentVersion, 1);
  } finally {
    await stopRealtimeServer(longServer);
  }
});

test('reads legacy notes without a revision and initializes it on first write', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const noteId = new mongoose.Types.ObjectId();
  await Note.collection.insertOne({
    _id: noteId,
    title: 'Legacy note',
    content: 'legacy content',
    owner: new mongoose.Types.ObjectId(ownerId),
    collaborators: [],
    isPublic: false,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  const fetched = await getNote(noteId.toString(), makeToken(ownerId));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.contentVersion, 0);

  const updated = await putNote(noteId.toString(), {
    content: 'legacy note updated',
    contentVersion: 0
  }, makeToken(ownerId));
  assert.equal(updated.status, 200);
  assert.equal(updated.data.contentVersion, 1);

  const stored = await Note.findById(noteId).lean();
  assert.equal(stored.content, 'legacy note updated');
  assert.equal(stored.contentVersion, 1);
});

test('title-only REST updates preserve socket-persisted content', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);
  await emitAck(owner, 'join-note', note.id);

  const saved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'content that must survive',
    contentVersion: 0
  });
  const status = await saved;

  const response = await putNote(note.id, { title: 'Renamed safely' }, makeToken(ownerId));
  assert.equal(response.status, 200);

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.title, 'Renamed safely');
  assert.equal(stored.content, 'content that must survive');
  assert.equal(stored.contentVersion, status.contentVersion);
});

test('rejects content updates without a content version', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId, content: 'original' });

  const response = await putNote(note.id, { content: 'unversioned' }, makeToken(ownerId));

  assert.equal(response.status, 428);
  assert.equal(response.data.code, 'VERSION_REQUIRED');

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.content, 'original');
});

test('rejects REST content while a socket write is pending', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const note = await createNote({ owner: ownerId });
  const longServer = await startLongDebounceRealtimeServer();
  const previousPersistence = app.locals.notePersistence;

  try {
    app.locals.notePersistence = longServer.realtime;
    const owner = await connectAs(ownerId, longServer.url);
    await emitAck(owner, 'join-note', note.id);
    const response = await emitAck(owner, 'note-edit', {
      noteId: note.id,
      content: 'accepted socket content',
      contentVersion: 0
    });
    assert.deepEqual(response, { ok: true });

    const restResponse = await putNote(note.id, {
      content: 'REST content before socket flush',
      contentVersion: 0
    }, makeToken(ownerId));
    assert.equal(restResponse.status, 409);
    assert.equal(restResponse.data.code, 'WRITE_IN_PROGRESS');

    const flushResult = await longServer.realtime.flushAll();
    assert.equal(flushResult.ok, true);

    const stored = await Note.findById(note.id).lean();
    assert.equal(stored.content, 'accepted socket content');
    assert.equal(stored.contentVersion, 1);
  } finally {
    app.locals.notePersistence = previousPersistence;
    await stopRealtimeServer(longServer);
  }
});

test('public viewers are read-only and are removed after the note becomes private', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const viewerId = randomId();
  const note = await createNote({ owner: ownerId, isPublic: true });
  const owner = await connectAs(ownerId);
  const viewer = await connectAs(viewerId);

  const joinResponse = await emitAck(viewer, 'join-note', note.id);
  assert.deepEqual(joinResponse, { ok: true, readOnly: true, contentVersion: 0 });
  await emitAck(owner, 'join-note', note.id);

  const forbidden = await emitAck(viewer, 'note-edit', {
    noteId: note.id,
    content: 'public viewer write',
    contentVersion: 0
  });
  assert.deepEqual(forbidden, { ok: false, code: 'FORBIDDEN' });

  await Note.updateOne({ _id: note.id }, { $set: { isPublic: false } });

  const noUpdate = expectNoEvent(viewer, 'note-update');
  const revoked = waitForEvent(viewer, 'note-access-revoked');
  const saved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'owner only now',
    contentVersion: 0
  });
  await saved;
  await noUpdate;
  await revoked;

  const roomMembers = await io.in(`note:${note.id}`).fetchSockets();
  assert.ok(roomMembers.every((member) => member.id !== viewer.id));

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.content, 'owner only now');
});

test('former owners lose edit access after ownership changes', async (t) => {
  if (!requireMongo(t)) return;

  const formerOwnerId = randomId();
  const newOwnerId = randomId();
  const note = await createNote({ owner: formerOwnerId });
  const formerOwner = await connectAs(formerOwnerId);
  const newOwner = await connectAs(newOwnerId);

  await emitAck(formerOwner, 'join-note', note.id);

  await Note.updateOne(
    { _id: note.id },
    { $set: { owner: newOwnerId, collaborators: [] } }
  );

  const joinResponse = await emitAck(newOwner, 'join-note', note.id);
  assert.deepEqual(joinResponse, { ok: true, readOnly: false, contentVersion: 0 });

  const revoked = waitForEvent(formerOwner, 'note-access-revoked');
  const noUpdate = expectNoEvent(formerOwner, 'note-update');
  const forbidden = await emitAck(formerOwner, 'note-edit', {
    noteId: note.id,
    content: 'former owner write',
    contentVersion: 0
  });
  await revoked;
  await noUpdate;

  assert.deepEqual(forbidden, { ok: false, code: 'FORBIDDEN' });

  const saved = waitForEvent(newOwner, 'note-saved');
  await emitAck(newOwner, 'note-edit', {
    noteId: note.id,
    content: 'new owner content',
    contentVersion: 0
  });
  await saved;

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.owner.toString(), newOwnerId);
  assert.equal(stored.content, 'new owner content');
});

test('removed collaborators cannot edit or receive updates through an existing socket', async (t) => {
  if (!requireMongo(t)) return;

  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = await createNote({
    owner: ownerId,
    collaborators: [collaboratorId]
  });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);

  await emitAck(owner, 'join-note', note.id);
  await emitAck(collaborator, 'join-note', note.id);

  await Note.updateOne(
    { _id: note.id },
    { $set: { collaborators: [] } }
  );

  const revoked = waitForEvent(collaborator, 'note-access-revoked');
  const noUpdate = expectNoEvent(collaborator, 'note-update');
  const forbidden = await emitAck(collaborator, 'note-edit', {
    noteId: note.id,
    content: 'removed collaborator write',
    contentVersion: 0
  });
  await revoked;
  await noUpdate;

  assert.deepEqual(forbidden, { ok: false, code: 'FORBIDDEN' });

  const saved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note.id,
    content: 'owner content',
    contentVersion: 0
  });
  await saved;

  const stored = await Note.findById(note.id).lean();
  assert.equal(stored.content, 'owner content');

  const roomMembers = await io.in(`note:${note.id}`).fetchSockets();
  assert.ok(roomMembers.every((member) => member.id !== collaborator.id));
});
