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
    onPersisted: (id, result) => persisted.push({ id, ...result })
  });

  persistence.queue(noteId(), 'first', 0, { clientEditId: 1 });
  persistence.queue(noteId(), 'second', 0, { clientEditId: 2 });
  persistence.queue(noteId(), 'third', 0, { clientEditId: 3 });

  await waitFor(() => Note.calls.length === 1);
  await waitFor(() => persistence.pendingCount() === 0);

  assert.equal(Note.calls.length, 1);
  assert.equal(Note.calls[0].update.$set.content, 'third');
  assert.equal(Note.state.content, 'third');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].content, 'third');
  assert.equal(persisted[0].contentVersion, 1);
  assert.equal(persisted[0].clientEditId, 3);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
});

test('persists edits queued while an earlier save is in flight', async () => {
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

  const persisted = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 10,
    maxWaitMs: 100,
    logger: silentLogger,
    onPersisted: (id, result) => persisted.push(result)
  });

  persistence.queue(noteId(), 'first', 0, { clientEditId: 1 });
  await firstSaveStartedPromise;

  persistence.queue(noteId(), 'second', 0, { clientEditId: 2 });
  releaseFirstSave();

  await waitFor(() => Note.calls.length === 2);
  await waitFor(() => persistence.pendingCount() === 0);
  assert.deepEqual(
    Note.calls.map((call) => call.update.$set.content),
    ['first', 'second']
  );
  assert.equal(Note.state.content, 'second');
  assert.equal(Note.state.contentVersion, 2);
  assert.deepEqual(
    persisted.map((entry) => ({ content: entry.content, version: entry.contentVersion })),
    [
      { content: 'first', version: 1 },
      { content: 'second', version: 2 }
    ]
  );

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
});

test('accepts a same-client edit that trails its own completed save by one revision', async () => {
  const Note = createFakeNote();
  const persisted = [];
  const conflicts = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 5,
    maxWaitMs: 100,
    logger: silentLogger,
    onPersisted: (id, result) => persisted.push(result),
    onConflict: (id, result) => conflicts.push(result)
  });

  const first = persistence.queue(noteId(), 'first', 0, {
    sourceKey: 'user-a:client-a',
    clientEditId: 1
  });
  assert.deepEqual(first, { ok: true });
  await waitFor(() => persisted.length === 1);
  assert.equal(persistence.pendingCount(), 0);

  const followUp = persistence.queue(noteId(), 'second', 0, {
    sourceKey: 'user-a:client-a',
    clientEditId: 2
  });
  assert.deepEqual(followUp, { ok: true });
  assert.equal(
    persistence.canContinue(noteId(), 0, 'user-a:client-a'),
    true
  );
  assert.equal(
    persistence.canContinue(noteId(), 0, 'user-b:client-b'),
    false
  );

  await waitFor(() => Note.state.content === 'second');
  await waitFor(() => persistence.pendingCount() === 0);

  assert.deepEqual(conflicts, []);
  assert.equal(Note.state.contentVersion, 2);
  assert.deepEqual(
    persisted.map((entry) => ({
      content: entry.content,
      contentVersion: entry.contentVersion
    })),
    [
      { content: 'first', contentVersion: 1 },
      { content: 'second', contentVersion: 2 }
    ]
  );
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
    onFailed: (id, result) => failed.push({ id, ...result }),
    onPersisted: (id) => persisted.push(id)
  });

  persistence.queue(noteId(), 'will fail', 0);

  await waitFor(() => failed.length === 1);
  assert.equal(Note.calls.length, 2);
  assert.deepEqual(persisted, []);
  assert.equal(persistence.pendingCount(), 0);
  assert.equal(failed[0].clientEditId, null);

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

test('rejects a stale queued revision without overwriting newer content', async () => {
  const Note = createFakeNote();
  Note.state.content = 'newer server content';
  Note.state.contentVersion = 1;
  const conflicts = [];
  const persisted = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 5,
    maxWaitMs: 100,
    logger: silentLogger,
    onConflict: (id, result) => conflicts.push({ id, ...result }),
    onPersisted: (id) => persisted.push(id)
  });

  persistence.queue(noteId(), 'stale socket content', 0, {
    sourceKey: 'user-a:client-a',
    sourceSocketId: 'socket-a',
    clientEditId: 1
  });

  await waitFor(() => conflicts.length === 1);
  assert.equal(Note.calls.length, 1);
  assert.equal(conflicts[0].contentVersion, 1);
  assert.equal(conflicts[0].sourceSocketId, 'socket-a');
  assert.equal(conflicts[0].clientEditId, 1);
  assert.equal(Note.state.content, 'newer server content');
  assert.equal(Note.state.contentVersion, 1);
  assert.deepEqual(persisted, []);
  assert.equal(persistence.pendingCount(), 0);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
});

test('does not retry a permanent version conflict indefinitely', async () => {
  const Note = createFakeNote();
  Note.state.content = 'external content';
  Note.state.contentVersion = 3;
  let conflicts = 0;
  const persistence = createNotePersistence({
    Note,
    debounceMs: 1,
    maxWaitMs: 50,
    retryBaseMs: 1,
    maxAttempts: 10,
    logger: silentLogger,
    onConflict: () => { conflicts += 1; }
  });

  persistence.queue(noteId(), 'stale', 2);

  await waitFor(() => conflicts === 1);
  await delay(50);
  assert.equal(conflicts, 1);
  assert.equal(Note.calls.length, 1);
  assert.equal(persistence.pendingCount(), 0);
});

test('rejects out-of-order edits from the same client', async () => {
  const Note = createFakeNote();
  const persistence = createNotePersistence({
    Note,
    debounceMs: 10,
    maxWaitMs: 100,
    logger: silentLogger
  });

  const first = persistence.queue(noteId(), 'newer', 0, {
    sourceKey: 'user-a:client-a',
    clientEditId: 2
  });
  const second = persistence.queue(noteId(), 'older', 0, {
    sourceKey: 'user-a:client-a',
    clientEditId: 1
  });
  const duplicate = persistence.queue(noteId(), 'newer', 0, {
    sourceKey: 'user-a:client-a',
    clientEditId: 2
  });

  assert.deepEqual(first, { ok: true });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'STALE_EDIT');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
  assert.equal(Note.state.content, 'newer');
});

test('rejects a different concurrent writer for the same note', async () => {
  const Note = createFakeNote();
  const persistence = createNotePersistence({
    Note,
    debounceMs: 10_000,
    maxWaitMs: 1000,
    logger: silentLogger
  });

  assert.deepEqual(
    persistence.queue(noteId(), 'first writer', 0, { sourceKey: 'user-a:client-a' }),
    { ok: true }
  );
  const second = persistence.queue(noteId(), 'second writer', 0, { sourceKey: 'user-b:client-b' });

  assert.equal(second.ok, false);
  assert.equal(second.code, 'WRITE_IN_PROGRESS');
  assert.equal(second.contentVersion, 0);

  const flushed = await persistence.flushAll();
  assert.equal(flushed.ok, true);
  assert.equal(Note.state.content, 'first writer');
});

test('retries newer same-client content after an in-flight conflict', async () => {
  let releaseFirstSave;
  let firstSaveStarted;
  const firstSaveGate = new Promise((resolve) => {
    releaseFirstSave = resolve;
  });
  const firstSaveStartedPromise = new Promise((resolve) => {
    firstSaveStarted = resolve;
  });

  const Note = createFakeNote({
    async onUpdate(callNumber, state) {
      if (callNumber === 1) {
        firstSaveStarted();
        await firstSaveGate;
        state.content = 'external content';
        state.contentVersion = 1;
      }
    }
  });
  const persisted = [];
  const conflicts = [];
  const persistence = createNotePersistence({
    Note,
    debounceMs: 5,
    maxWaitMs: 100,
    logger: silentLogger,
    onPersisted: (id, result) => persisted.push(result),
    onConflict: (id, result) => conflicts.push(result)
  });

  persistence.queue(noteId(), 'first local content', 0, {
    sourceKey: 'user-a:client-a',
    clientEditId: 1
  });
  await firstSaveStartedPromise;

  persistence.queue(noteId(), 'newer local content', 1, {
    sourceKey: 'user-a:client-a',
    clientEditId: 2
  });
  releaseFirstSave();

  await waitFor(() => persisted.length === 1);
  await waitFor(() => persistence.pendingCount() === 0);

  assert.deepEqual(conflicts, []);
  assert.equal(Note.state.content, 'newer local content');
  assert.equal(Note.state.contentVersion, 2);
  assert.equal(persisted[0].content, 'newer local content');
  assert.equal(persisted[0].contentVersion, 2);
});
