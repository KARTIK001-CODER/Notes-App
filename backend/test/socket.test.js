const { after, afterEach, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { createRealtimeServer } = require('../socket');

const JWT_SECRET = 'socket-test-secret';
const CONTENT_LIMIT_BYTES = 64;
const DEBOUNCE_MS = 100;
const MAX_WAIT_MS = 300;
const silentLogger = { error() {} };

const notes = new Map();
const persistenceCalls = [];
const clients = new Set();

const FakeNote = {
  findById(id) {
    const note = notes.get(String(id)) || null;
    const query = {
      select() {
        return query;
      },
      async lean() {
        return note;
      }
    };
    return query;
  },
  async findOneAndUpdate(filter, update) {
    const note = notes.get(String(filter._id)) || null;
    if (!note) return null;

    const expectedVersion = Number.isInteger(filter.contentVersion)
      ? filter.contentVersion
      : 0;
    if ((note.contentVersion || 0) !== expectedVersion) return null;

    note.content = update.$set.content;
    note.updatedAt = update.$set.updatedAt;
    note.contentVersion = (note.contentVersion || 0) + update.$inc.contentVersion;
    persistenceCalls.push({ noteId: String(filter._id), content: note.content });
    return { ...note };
  }
};

let httpServer;
let io;
let realtime;
let socketUrl;

function randomId() {
  return crypto.randomBytes(12).toString('hex');
}

function createNote(overrides = {}) {
  const id = randomId();
  const note = {
    _id: id,
    owner: randomId(),
    collaborators: [],
    isPublic: false,
    content: '',
    contentVersion: 0,
    ...overrides
  };
  notes.set(id, note);
  return note;
}

function makeToken(userId, options = {}) {
  return jwt.sign({ user: { id: userId } }, JWT_SECRET, {
    expiresIn: '1h',
    ...options
  });
}

function createSocket(token) {
  const socket = createClient(socketUrl, {
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
    }, 3000);

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

async function connectAs(userId, token = makeToken(userId)) {
  const socket = createSocket(token);
  await waitForConnect(socket);
  return socket;
}

function emitAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 3000);
    socket.emit(event, ...args, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForEvent(socket, event, timeoutMs = 3000) {
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

function expectNoEvent(socket, event, timeoutMs = 200) {
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

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await delay(10);
  }
}

before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  realtime = createRealtimeServer(io, {
    Note: FakeNote,
    jwtSecret: JWT_SECRET,
    contentLimitBytes: CONTENT_LIMIT_BYTES,
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    logger: silentLogger
  });

  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  socketUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  for (const socket of clients) socket.disconnect();
  clients.clear();
  await realtime.flushAll();
  await new Promise((resolve) => io.close(resolve));
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

beforeEach(() => {
  notes.clear();
  persistenceCalls.length = 0;
});

afterEach(async () => {
  for (const socket of clients) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  clients.clear();
  await realtime.flushAll();
});

test('rejects connections without a token', async () => {
  const socket = createSocket(null);
  await assert.rejects(waitForConnect(socket), /Unauthorized/);
});

test('rejects invalid, expired, and malformed tokens', async () => {
  await assert.rejects(
    waitForConnect(createSocket('not-a-valid-jwt')),
    /Unauthorized/
  );

  await assert.rejects(
    waitForConnect(createSocket(makeToken(randomId(), { expiresIn: -10 }))),
    /Unauthorized/
  );

  await assert.rejects(
    waitForConnect(createSocket(makeToken('not-an-object-id'))),
    /Unauthorized/
  );
});

test('rejects join-note for a private note when the user is not authorized', async () => {
  const note = createNote();
  const stranger = await connectAs(randomId());

  const response = await emitAck(stranger, 'join-note', note._id);

  assert.deepEqual(response, { ok: false, code: 'FORBIDDEN' });
});

test('allows the owner and a collaborator to join a private note', async () => {
  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = createNote({ owner: ownerId, collaborators: [collaboratorId] });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);

  assert.deepEqual(
    await emitAck(owner, 'join-note', note._id),
    { ok: true, readOnly: false }
  );
  assert.deepEqual(
    await emitAck(collaborator, 'join-note', note._id),
    { ok: true, readOnly: false }
  );
});

test('allows an authenticated user to join a public note read-only', async () => {
  const note = createNote({ isPublic: true });
  const stranger = await connectAs(randomId());

  const response = await emitAck(stranger, 'join-note', note._id);

  assert.deepEqual(response, { ok: true, readOnly: true });
});

test('rejects edits from an authenticated non-collaborator to a public note', async () => {
  const note = createNote({ isPublic: true });
  const ownerId = randomId();
  const owner = await connectAs(ownerId);
  const stranger = await connectAs(randomId());

  await emitAck(owner, 'join-note', note._id);
  await emitAck(stranger, 'join-note', note._id);

  const response = await emitAck(stranger, 'note-edit', {
    noteId: note._id,
    content: 'unauthorized public edit'
  });

  assert.deepEqual(response, { ok: false, code: 'FORBIDDEN' });
  await expectNoEvent(owner, 'note-update');
  await delay(DEBOUNCE_MS + 50);
  assert.equal(persistenceCalls.length, 0);
});

test('rejects unauthorized edits to a private note without broadcasting or persisting', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);
  const stranger = await connectAs(randomId());

  await emitAck(owner, 'join-note', note._id);

  const response = await emitAck(stranger, 'note-edit', {
    noteId: note._id,
    content: 'unauthorized private edit'
  });

  assert.deepEqual(response, { ok: false, code: 'FORBIDDEN' });
  await expectNoEvent(owner, 'note-update');
  await delay(DEBOUNCE_MS + 50);
  assert.equal(persistenceCalls.length, 0);
});

test('allows owner edits, broadcasts them, and persists the latest debounced content', async () => {
  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = createNote({ owner: ownerId, collaborators: [collaboratorId] });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);
  const updates = [];

  collaborator.on('note-update', ({ content }) => updates.push(content));

  await emitAck(owner, 'join-note', note._id);
  await emitAck(collaborator, 'join-note', note._id);

  const [first, second] = await Promise.all([
    emitAck(owner, 'note-edit', { noteId: note._id, content: 'first edit' }),
    emitAck(owner, 'note-edit', { noteId: note._id, content: 'second edit' })
  ]);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });

  await waitFor(() => updates.length === 2);
  assert.deepEqual(updates, ['first edit', 'second edit']);

  await waitFor(() => persistenceCalls.length === 1);
  await waitFor(() => note.content === 'second edit');
  assert.equal(persistenceCalls[0].content, 'second edit');
});

test('allows an authorized collaborator to edit and persist content', async () => {
  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = createNote({ owner: ownerId, collaborators: [collaboratorId] });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);

  await emitAck(owner, 'join-note', note._id);
  await emitAck(collaborator, 'join-note', note._id);

  const updatePromise = waitForEvent(owner, 'note-update');
  const response = await emitAck(collaborator, 'note-edit', {
    noteId: note._id,
    content: 'collaborator edit'
  });
  const update = await updatePromise;

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(update, { content: 'collaborator edit' });

  await waitFor(() => persistenceCalls.length === 1);
  assert.equal(persistenceCalls[0].content, 'collaborator edit');
});

test('stops broadcasting to previously public viewers after a note becomes private', async () => {
  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = createNote({
    owner: ownerId,
    collaborators: [collaboratorId],
    isPublic: true
  });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);
  const stranger = await connectAs(randomId());

  await emitAck(owner, 'join-note', note._id);
  await emitAck(collaborator, 'join-note', note._id);
  await emitAck(stranger, 'join-note', note._id);

  note.isPublic = false;

  const collaboratorUpdate = waitForEvent(collaborator, 'note-update');
  const strangerUpdate = expectNoEvent(stranger, 'note-update');
  const strangerRevoked = waitForEvent(stranger, 'note-access-revoked');

  const response = await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'now private'
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(await collaboratorUpdate, { content: 'now private' });
  await strangerUpdate;
  await strangerRevoked;

  const roomMembers = await io.in(`note:${note._id}`).fetchSockets();
  assert.ok(roomMembers.every((member) => member.id !== stranger.id));
});

test('revokes an already-connected collaborator after access is removed', async () => {
  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = createNote({ owner: ownerId, collaborators: [collaboratorId] });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);

  await emitAck(owner, 'join-note', note._id);
  await emitAck(collaborator, 'join-note', note._id);

  note.collaborators = [];

  const revoked = waitForEvent(collaborator, 'note-access-revoked');
  const noUpdate = expectNoEvent(collaborator, 'note-update');
  const editResponse = await emitAck(collaborator, 'note-edit', {
    noteId: note._id,
    content: 'removed collaborator edit'
  });
  await revoked;
  await noUpdate;

  assert.deepEqual(editResponse, { ok: false, code: 'FORBIDDEN' });
  assert.equal(note.content, '');
  assert.equal(persistenceCalls.length, 0);

  const roomMembers = await io.in(`note:${note._id}`).fetchSockets();
  assert.ok(roomMembers.every((member) => member.id !== collaborator.id));
});

test('rejects malformed and oversized note-edit payloads', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note._id);

  const cases = [
    [null, 'INVALID_PAYLOAD'],
    [[], 'INVALID_PAYLOAD'],
    [{ noteId: 'not-an-object-id', content: 'text' }, 'INVALID_NOTE_ID'],
    [{ noteId: note._id, content: 42 }, 'INVALID_PAYLOAD'],
    [{ noteId: note._id, content: 'x'.repeat(CONTENT_LIMIT_BYTES + 1) }, 'CONTENT_TOO_LARGE']
  ];

  for (const [payload, expectedCode] of cases) {
    const response = await emitAck(owner, 'note-edit', payload);
    assert.deepEqual(response, { ok: false, code: expectedCode });
  }

  await delay(DEBOUNCE_MS + 50);
  assert.equal(persistenceCalls.length, 0);
});
