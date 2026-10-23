export function normalizeRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function decideSnapshotAction({
  snapshot,
  localContent,
  baseRevision,
  dirty,
  sentContents = []
}) {
  const serverRevision = normalizeRevision(snapshot?.contentVersion);
  const serverContent = typeof snapshot?.content === 'string' ? snapshot.content : '';
  const local = typeof localContent === 'string' ? localContent : '';
  const base = normalizeRevision(baseRevision);

  if (serverRevision < base) {
    return {
      type: 'ignore-stale',
      serverContent,
      serverRevision
    };
  }

  if (!dirty) {
    return {
      type: 'apply-server',
      serverContent,
      serverRevision
    };
  }

  if (serverContent === local) {
    return {
      type: 'mark-saved',
      serverContent,
      serverRevision
    };
  }

  if (
    serverRevision === base + 1
    && Array.isArray(sentContents)
    && sentContents.includes(serverContent)
  ) {
    return {
      type: 'retry-pending',
      serverContent,
      serverRevision,
      localContent: local,
      followsOwnSave: true
    };
  }

  if (serverRevision === base) {
    return {
      type: 'retry-pending',
      serverContent,
      serverRevision,
      localContent: local
    };
  }

  return {
    type: 'conflict',
    serverContent,
    serverRevision,
    localContent: local
  };
}

export function isFullyAcknowledged(ackEditId, latestEditId) {
  return Number.isInteger(ackEditId)
    && Number.isInteger(latestEditId)
    && ackEditId >= latestEditId;
}

export function shouldApplyRemoteRevision(currentRevision, incomingRevision) {
  return Number.isInteger(incomingRevision)
    && incomingRevision > normalizeRevision(currentRevision);
}

export function createReconnectRecovery({
  fetchSnapshot,
  getLocalState,
  onApplyServer = () => {},
  onMarkSaved = () => {},
  onRetryPending = () => {},
  onConflict = () => {},
  onError = () => {}
}) {
  let disposed = false;
  let inFlight = null;

  async function recover() {
    if (disposed) return null;
    if (inFlight) return inFlight;

    const promise = (async () => {
      let snapshot;
      try {
        snapshot = await fetchSnapshot();
      } catch (error) {
        if (!disposed) onError(error);
        return null;
      }

      if (disposed) return null;

      const localState = getLocalState();
      const action = decideSnapshotAction({
        snapshot,
        localContent: localState.localContent,
        baseRevision: localState.baseRevision,
        dirty: localState.dirty,
        sentContents: localState.sentContents
      });

      if (action.type === 'apply-server') {
        onApplyServer(snapshot, action);
      } else if (action.type === 'mark-saved') {
        onMarkSaved(snapshot, action);
      } else if (action.type === 'retry-pending') {
        onRetryPending(snapshot, action);
      } else if (action.type === 'conflict') {
        onConflict(snapshot, action);
      }

      return action;
    })();

    inFlight = promise;
    try {
      return await promise;
    } finally {
      if (inFlight === promise) inFlight = null;
    }
  }

  function dispose() {
    disposed = true;
  }

  return {
    recover,
    dispose
  };
}
