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
    { ok: true, readOnly: false, contentVersion: 0 }
  );
  assert.deepEqual(
    await emitAck(collaborator, 'join-note', note._id),
    { ok: true, readOnly: false, contentVersion: 0 }
  );
});

test('allows an authenticated user to join a public note read-only', async () => {
  const note = createNote({ isPublic: true });
  const stranger = await connectAs(randomId());

  const response = await emitAck(stranger, 'join-note', note._id);

  assert.deepEqual(response, { ok: true, readOnly: true, contentVersion: 0 });
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
    content: 'unauthorized public edit',
    contentVersion: 0
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
    content: 'unauthorized private edit',
    contentVersion: 0
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
    emitAck(owner, 'note-edit', {
      noteId: note._id,
      content: 'first edit',
      contentVersion: 0,
      clientEditId: 1
    }),
    emitAck(owner, 'note-edit', {
      noteId: note._id,
      content: 'second edit',
      contentVersion: 0,
      clientEditId: 2
    })
  ]);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });

  await waitFor(() => persistenceCalls.length === 1);
  await waitFor(() => updates.length === 1);
  assert.deepEqual(updates, ['second edit']);
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
    content: 'collaborator edit',
    contentVersion: 0
  });
  const update = await updatePromise;

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(update, { content: 'collaborator edit', contentVersion: 1 });

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
    content: 'now private',
    contentVersion: 0
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(await collaboratorUpdate, { content: 'now private', contentVersion: 1 });
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
    content: 'removed collaborator edit',
    contentVersion: 0
  });
  await revoked;
  await noUpdate;

  assert.deepEqual(editResponse, { ok: false, code: 'FORBIDDEN' });
  assert.equal(note.content, '');
  assert.equal(persistenceCalls.length, 0);

  const roomMembers = await io.in(`note:${note._id}`).fetchSockets();
  assert.ok(roomMembers.every((member) => member.id !== collaborator.id));
});

test('rejects a stale content revision without broadcasting or persisting', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId, content: 'current', contentVersion: 2 });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note._id);

  const noUpdate = expectNoEvent(owner, 'note-update');
  const response = await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'stale content',
    contentVersion: 1
  });

  assert.deepEqual(response, {
    ok: false,
    code: 'VERSION_CONFLICT',
    contentVersion: 2
  });
  await noUpdate;
  await delay(DEBOUNCE_MS + 50);
  assert.equal(persistenceCalls.length, 0);
  assert.equal(note.content, 'current');
  assert.equal(note.contentVersion, 2);
});

test('reports a persistence conflict when another writer wins the same revision', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note._id);

  const conflictPromise = waitForEvent(owner, 'note-save-conflict');
  const response = await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'socket content',
    contentVersion: 0
  });
  assert.deepEqual(response, { ok: true });

  note.content = 'external REST content';
  note.contentVersion = 1;

  assert.deepEqual(await conflictPromise, {
    code: 'VERSION_CONFLICT',
    contentVersion: 1
  });
  await delay(DEBOUNCE_MS + 50);
  assert.equal(note.content, 'external REST content');
  assert.equal(note.contentVersion, 1);
});

test('rejects a concurrent writer while another client write is pending', async () => {
  const ownerId = randomId();
  const collaboratorId = randomId();
  const note = createNote({ owner: ownerId, collaborators: [collaboratorId] });
  const owner = await connectAs(ownerId);
  const collaborator = await connectAs(collaboratorId);

  await emitAck(owner, 'join-note', note._id);
  await emitAck(collaborator, 'join-note', note._id);

  const ownerResponse = await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'owner pending content',
    contentVersion: 0
  });
  const collaboratorResponse = await emitAck(collaborator, 'note-edit', {
    noteId: note._id,
    content: 'collaborator content',
    contentVersion: 0
  });

  assert.deepEqual(ownerResponse, { ok: true });
  assert.equal(collaboratorResponse.ok, false);
  assert.equal(collaboratorResponse.code, 'WRITE_IN_PROGRESS');
  assert.equal(collaboratorResponse.contentVersion, 0);

  await waitFor(() => note.content === 'owner pending content');
  assert.equal(note.contentVersion, 1);
  assert.equal(persistenceCalls.length, 1);
});

test('returns the persisted revision to the writer after the save', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note._id);
  const saved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'revision tracked',
    contentVersion: 0,
    clientId: 'client-a',
    clientEditId: 7
  });

  assert.deepEqual(await saved, { contentVersion: 1, clientEditId: 7 });
  assert.equal(note.contentVersion, 1);
});

test('accepts a same-client follow-up that trails its own completed save', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note._id);
  const firstSaved = waitForEvent(owner, 'note-saved');
  await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'first',
    contentVersion: 0,
    clientId: 'client-a',
    clientEditId: 1
  });
  assert.deepEqual(await firstSaved, { contentVersion: 1, clientEditId: 1 });

  const conflicts = [];
  owner.on('note-save-conflict', (payload) => conflicts.push(payload));

  const secondSaved = waitForEvent(owner, 'note-saved');
  const response = await emitAck(owner, 'note-edit', {
    noteId: note._id,
    content: 'second',
    contentVersion: 0,
    clientId: 'client-a',
    clientEditId: 2
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(await secondSaved, { contentVersion: 2, clientEditId: 2 });
  await delay(DEBOUNCE_MS + 50);
  assert.deepEqual(conflicts, []);
  assert.equal(note.content, 'second');
  assert.equal(note.contentVersion, 2);
});

test('rejects malformed and oversized note-edit payloads', async () => {
  const ownerId = randomId();
  const note = createNote({ owner: ownerId });
  const owner = await connectAs(ownerId);

  await emitAck(owner, 'join-note', note._id);

  const cases = [
    [null, 'INVALID_PAYLOAD'],
    [[], 'INVALID_PAYLOAD'],
    [{ noteId: 'not-an-object-id', content: 'text', contentVersion: 0 }, 'INVALID_NOTE_ID'],
    [{ noteId: note._id, content: 42, contentVersion: 0 }, 'INVALID_PAYLOAD'],
    [{ noteId: note._id, content: 'text' }, 'VERSION_REQUIRED'],
    [{ noteId: note._id, content: 'text', contentVersion: -1 }, 'VERSION_REQUIRED'],
    [{ noteId: note._id, content: 'x'.repeat(CONTENT_LIMIT_BYTES + 1), contentVersion: 0 }, 'CONTENT_TOO_LARGE'],
    [{ noteId: note._id, content: 'text', contentVersion: 0, clientId: 'bad client id' }, 'INVALID_PAYLOAD'],
    [{ noteId: note._id, content: 'text', contentVersion: 0, clientEditId: -1 }, 'INVALID_PAYLOAD']
  ];

  for (const [payload, expectedCode] of cases) {
    const response = await emitAck(owner, 'note-edit', payload);
    assert.deepEqual(response, { ok: false, code: expectedCode });
  }

  await delay(DEBOUNCE_MS + 50);
  assert.equal(persistenceCalls.length, 0);
});
