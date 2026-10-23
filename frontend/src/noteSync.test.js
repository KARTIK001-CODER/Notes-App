import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReconnectRecovery,
  decideSnapshotAction,
  isFullyAcknowledged,
  normalizeRevision,
  shouldApplyRemoteRevision
} from './noteSync.js';

test('normalizes missing and invalid revisions to zero', () => {
  assert.equal(normalizeRevision(undefined), 0);
  assert.equal(normalizeRevision(null), 0);
  assert.equal(normalizeRevision(-1), 0);
  assert.equal(normalizeRevision(2), 2);
});

test('reconnect without pending edits restores the latest server state', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'server content', contentVersion: 4 },
    localContent: 'old content',
    baseRevision: 3,
    dirty: false
  });

  assert.deepEqual(action, {
    type: 'apply-server',
    serverContent: 'server content',
    serverRevision: 4
  });
});

test('reconnect preserves unsaved local edits when their base revision is valid', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'unchanged server content', contentVersion: 2 },
    localContent: 'unsaved local draft',
    baseRevision: 2,
    dirty: true
  });

  assert.equal(action.type, 'retry-pending');
  assert.equal(action.localContent, 'unsaved local draft');
  assert.equal(action.serverRevision, 2);
});

test('reconnect detects a revision mismatch without discarding either version', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'new server content', contentVersion: 5 },
    localContent: 'unsaved local draft',
    baseRevision: 2,
    dirty: true
  });

  assert.equal(action.type, 'conflict');
  assert.equal(action.serverContent, 'new server content');
  assert.equal(action.localContent, 'unsaved local draft');
  assert.equal(action.serverRevision, 5);
});

test('marks pending content saved when the server already has the same content', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'same content', contentVersion: 3 },
    localContent: 'same content',
    baseRevision: 2,
    dirty: true
  });

  assert.deepEqual(action, {
    type: 'mark-saved',
    serverContent: 'same content',
    serverRevision: 3
  });
});

test('recognizes a lost acknowledgement when the server has this client save', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'previously sent content', contentVersion: 4 },
    localContent: 'newer local draft',
    baseRevision: 3,
    dirty: true,
    sentContents: ['previously sent content']
  });

  assert.equal(action.type, 'retry-pending');
  assert.equal(action.followsOwnSave, true);
  assert.equal(action.serverRevision, 4);
  assert.equal(action.localContent, 'newer local draft');
});

test('does not treat another writer content as an acknowledged local save', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'other writer content', contentVersion: 4 },
    localContent: 'newer local draft',
    baseRevision: 3,
    dirty: true,
    sentContents: ['previously sent content']
  });

  assert.equal(action.type, 'conflict');
});

test('ignores stale snapshot responses from an older revision', () => {
  const action = decideSnapshotAction({
    snapshot: { content: 'older content', contentVersion: 1 },
    localContent: 'current content',
    baseRevision: 3,
    dirty: false
  });

  assert.equal(action.type, 'ignore-stale');
});

test('stale save acknowledgements do not mark newer edits saved', () => {
  assert.equal(isFullyAcknowledged(2, 3), false);
  assert.equal(isFullyAcknowledged(3, 3), true);
  assert.equal(isFullyAcknowledged(4, 3), true);
  assert.equal(isFullyAcknowledged(undefined, 3), false);
});

test('stale remote revisions do not overwrite newer editor state', () => {
  assert.equal(shouldApplyRemoteRevision(4, 3), false);
  assert.equal(shouldApplyRemoteRevision(4, 5), true);
});

test('coalesces repeated reconnect recoveries and retries pending content once', async () => {
  let fetchCount = 0;
  let retryCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const recovery = createReconnectRecovery({
    async fetchSnapshot() {
      fetchCount += 1;
      await fetchGate;
      return { content: 'server content', contentVersion: 2 };
    },
    getLocalState() {
      return {
        localContent: 'local draft',
        baseRevision: 2,
        dirty: true
      };
    },
    onRetryPending() {
      retryCount += 1;
    }
  });

  const first = recovery.recover();
  const second = recovery.recover();
  assert.equal(fetchCount, 1);

  releaseFetch();
  const [firstAction, secondAction] = await Promise.all([first, second]);

  assert.equal(fetchCount, 1);
  assert.equal(retryCount, 1);
  assert.equal(firstAction.type, 'retry-pending');
  assert.equal(secondAction.type, 'retry-pending');
});

test('reconnect recovery advances past an unacknowledged save authored here', async () => {
  let retry = null;
  const recovery = createReconnectRecovery({
    async fetchSnapshot() {
      return { content: 'previously sent content', contentVersion: 4 };
    },
    getLocalState() {
      return {
        localContent: 'newer local draft',
        baseRevision: 3,
        dirty: true,
        sentContents: ['previously sent content']
      };
    },
    onRetryPending(snapshot, action) {
      retry = { snapshot, action };
    },
    onConflict() {
      assert.fail('should not open a conflict for this client own save');
    }
  });

  const action = await recovery.recover();

  assert.equal(action.type, 'retry-pending');
  assert.equal(action.followsOwnSave, true);
  assert.equal(retry.action.serverRevision, 4);
});

test('reconnect recovery surfaces conflicts instead of applying server content', async () => {
  let applied = 0;
  let conflict = null;
  const recovery = createReconnectRecovery({
    async fetchSnapshot() {
      return { content: 'new server content', contentVersion: 7 };
    },
    getLocalState() {
      return {
        localContent: 'local draft',
        baseRevision: 2,
        dirty: true
      };
    },
    onApplyServer() {
      applied += 1;
    },
    onConflict(snapshot, action) {
      conflict = { snapshot, action };
    }
  });

  const action = await recovery.recover();

  assert.equal(action.type, 'conflict');
  assert.equal(applied, 0);
  assert.equal(conflict.snapshot.contentVersion, 7);
  assert.equal(conflict.action.localContent, 'local draft');
});

test('reconnect recovery reports fetch failures and can be disposed', async () => {
  let errors = 0;
  let fetches = 0;
  const recovery = createReconnectRecovery({
    async fetchSnapshot() {
      fetches += 1;
      throw new Error('offline');
    },
    getLocalState() {
      return { localContent: '', baseRevision: 0, dirty: false };
    },
    onError() {
      errors += 1;
    }
  });

  assert.equal(await recovery.recover(), null);
  assert.equal(errors, 1);

  recovery.dispose();
  assert.equal(await recovery.recover(), null);
  assert.equal(fetches, 1);
});
