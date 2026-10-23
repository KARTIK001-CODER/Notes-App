const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotePersistence } = require('../lib/notePersistence');

const silentLogger = { error() {} };

function noteId() {
  return 'a'.repeat(24);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await delay(5);
  }
}

function createFakeNote({ contentVersion = 0, onUpdate } = {}) {
  const state = { content: '', contentVersion };
  const calls = [];

  return {
    state,
    calls,
    async findOneAndUpdate(filter, update) {
      calls.push({ filter, update });
      if (onUpdate) await onUpdate(calls.length, state);

      const expectedVersion = Number.isInteger(filter.contentVersion)
        ? filter.contentVersion
        : 0;
      if ((state.contentVersion || 0) !== expectedVersion) return null;

      state.content = update.$set.content;
      state.contentVersion = (state.contentVersion || 0) + update.$inc.contentVersion;
      return { ...state };
    },
    findById() {
      return {
        select() {
          return this;
        },
        async lean() {
          return { ...state };
        }
      };
    }
  };
}

test('debounces rapid edits and persists only the latest content', async () => {
  const Note = createFakeNote();
  const persisted = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 25,
    maxWaitMs: 200,
    logger: silentLogger,
    onPersisted: (id, version) => persisted.push({ id, version })
  });

  persistence.queue(noteId(), 'first', 0);
  persistence.queue(noteId(), 'second', 0);
  persistence.queue(noteId(), 'third', 0);

  await waitFor(() => Note.calls.length === 1);
  await waitFor(() => persistence.pendingCount() === 0);

  assert.equal(Note.calls.length, 1);
  assert.equal(Note.calls[0].update.$set.content, 'third');
  assert.equal(Note.state.content, 'third');
  assert.deepEqual(persisted, [{ id: noteId(), version: 1 }]);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
});

test('persists an edit queued while an earlier save is in flight', async () => {
  let releaseFirstSave;
  let firstSaveStarted;
  const firstSaveGate = new Promise((resolve) => {
    releaseFirstSave = resolve;
  });
  const firstSaveStartedPromise = new Promise((resolve) => {
    firstSaveStarted = resolve;
  });

  const Note = createFakeNote({
    onUpdate(callNumber) {
      if (callNumber === 1) {
        firstSaveStarted();
        return firstSaveGate;
      }
      return undefined;
    }
  });

  const persistence = createNotePersistence({
    Note,
    debounceMs: 10,
    maxWaitMs: 100,
    logger: silentLogger
  });

  persistence.queue(noteId(), 'first', 0);
  await firstSaveStartedPromise;

  persistence.queue(noteId(), 'second', 0);
  releaseFirstSave();

  await waitFor(() => Note.calls.length === 2);
  assert.deepEqual(
    Note.calls.map((call) => call.update.$set.content),
    ['first', 'second']
  );
  assert.equal(Note.state.content, 'second');

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
  assert.equal(persistence.pendingCount(), 0);
});

test('retries failed saves without dropping the latest content', async () => {
  let attempts = 0;
  const Note = createFakeNote({
    onUpdate() {
      attempts += 1;
      if (attempts === 1) throw new Error('database unavailable');
    }
  });
  const persistence = createNotePersistence({
    Note,
    debounceMs: 5,
    maxWaitMs: 100,
    retryBaseMs: 5,
    retryMaxMs: 20,
    maxAttempts: 3,
    logger: silentLogger
  });

  persistence.queue(noteId(), 'latest content', 0);

  await waitFor(() => Note.calls.length === 2);
  assert.equal(Note.state.content, 'latest content');
  await waitFor(() => persistence.pendingCount() === 0);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
});

test('reports retry exhaustion without claiming persistence succeeded', async () => {
  const Note = createFakeNote({
    onUpdate() {
      throw new Error('database unavailable');
    }
  });
  const failed = [];
  const persisted = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 5,
    maxWaitMs: 100,
    retryBaseMs: 5,
    retryMaxMs: 10,
    maxAttempts: 2,
    logger: silentLogger,
    onFailed: (id) => failed.push(id),
    onPersisted: (id) => persisted.push(id)
  });

  persistence.queue(noteId(), 'will fail', 0);

  await waitFor(() => failed.length === 1);
  assert.equal(Note.calls.length, 2);
  assert.deepEqual(persisted, []);
  assert.equal(persistence.pendingCount(), 0);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, false);
  assert.equal(flushed.pending, 0);
  assert.equal(flushed.failures.length, 1);
  assert.equal(flushed.failures[0].noteId, noteId());
});

test('reports shutdown flush failure when pending writes cannot be persisted', async () => {
  const Note = createFakeNote({
    onUpdate() {
      throw new Error('database unavailable');
    }
  });
  const persistence = createNotePersistence({
    Note,
    debounceMs: 1000,
    maxWaitMs: 20,
    retryBaseMs: 1000,
    retryMaxMs: 1000,
    maxAttempts: 10,
    logger: silentLogger
  });

  persistence.queue(noteId(), 'pending', 0);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, false);
  assert.ok(flushed.pending > 0 || flushed.failures.length > 0);
});

test('waits for pending writes during shutdown flush', async () => {
  const Note = createFakeNote();
  const persistence = createNotePersistence({
    Note,
    debounceMs: 10_000,
    maxWaitMs: 500,
    logger: silentLogger
  });

  persistence.queue(noteId(), 'shutdown content', 0);

  const flushed = await persistence.flushAll();

  assert.deepEqual(flushed, { ok: true, pending: 0, failures: [] });
  assert.equal(Note.state.content, 'shutdown content');
  assert.equal(persistence.pendingCount(), 0);
});

test('reloads the current version and retries after a version conflict', async () => {
  const Note = createFakeNote();
  Note.state.contentVersion = 1;
  const persisted = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 5,
    maxWaitMs: 100,
    logger: silentLogger,
    onPersisted: (id, version) => persisted.push(version)
  });

  persistence.queue(noteId(), 'socket content', 0);

  await waitFor(() => persisted.length === 1);

  assert.equal(Note.calls.length, 2);
  assert.deepEqual(Note.calls[0].filter.$or, [
    { contentVersion: 0 },
    { contentVersion: { $exists: false } }
  ]);
  assert.equal(Note.calls[1].filter.contentVersion, 1);
  assert.equal(Note.state.content, 'socket content');
  assert.equal(Note.state.contentVersion, 2);
  assert.deepEqual(persisted, [2]);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
});
