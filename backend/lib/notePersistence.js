const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_WAIT_MS = 3000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_RECENT_WRITES = 1000;

function normalizeVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function versionFilter(version) {
  if (version === 0) {
    return {
      $or: [
        { contentVersion: 0 },
        { contentVersion: { $exists: false } }
      ]
    };
  }
  return { contentVersion: version };
}

function normalizeEditId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function createNotePersistence({
  Note,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  logger = console,
  onPersisted = () => {},
  onFailed = () => {},
  onConflict = () => {}
} = {}) {
  if (!Note || typeof Note.findOneAndUpdate !== 'function') {
    throw new TypeError('A Note model with findOneAndUpdate is required');
  }

  const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const states = new Map();
  const failures = new Map();
  const recentWrites = new Map();

  function clearTimer(state) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function schedule(state, delay) {
    if (state.inFlight) return;
    clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush(state.noteId);
    }, Math.max(0, delay));
  }

  function notify(callback, ...args) {
    try {
      const result = callback(...args);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          if (logger && typeof logger.error === 'function') {
            logger.error('Failed to report note persistence event');
          }
        });
      }
    } catch {
      if (logger && typeof logger.error === 'function') {
        logger.error('Failed to report note persistence event');
      }
    }
  }

  function stateMetadata(state) {
    return {
      sourceKey: state.sourceKey,
      sourceSocketId: state.sourceSocketId,
      clientEditId: state.clientEditId
    };
  }

  function rememberWrite(noteId, sourceKey, contentVersion) {
    recentWrites.delete(noteId);
    recentWrites.set(noteId, { sourceKey, contentVersion });
    if (recentWrites.size > MAX_RECENT_WRITES) {
      const oldestNoteId = recentWrites.keys().next().value;
      recentWrites.delete(oldestNoteId);
    }
  }

  function canContinue(noteId, baseVersion, sourceKey) {
    const normalizedBase = normalizeVersion(baseVersion);
    const state = states.get(noteId);

    if (
      state
      && state.sourceKey === sourceKey
      && (
        normalizedBase === state.baseVersion
        || normalizedBase + 1 === state.baseVersion
      )
    ) {
      return true;
    }

    const recent = recentWrites.get(noteId);
    return Boolean(
      recent
      && recent.sourceKey === sourceKey
      && normalizedBase + 1 === recent.contentVersion
    );
  }

  function reportFailure(state, error) {
    clearTimer(state);
    state.inFlight = false;
    state.dirty = false;
    states.delete(state.noteId);
    failures.set(state.noteId, error instanceof Error ? error : new Error('Note persistence failed'));

    if (logger && typeof logger.error === 'function') {
      logger.error('Failed to persist debounced note update');
    }

    notify(onFailed, state.noteId, {
      ...stateMetadata(state),
      error
    });
  }

  function reportConflict(state, contentVersion) {
    clearTimer(state);
    state.inFlight = false;
    state.dirty = false;
    states.delete(state.noteId);

    notify(onConflict, state.noteId, {
      ...stateMetadata(state),
      contentVersion: normalizeVersion(contentVersion)
    });
  }

  async function persist(state, content, baseVersion) {
    const saved = await Note.findOneAndUpdate(
      { _id: state.noteId, ...versionFilter(normalizeVersion(baseVersion)) },
      {
        $set: { content, updatedAt: new Date() },
        $inc: { contentVersion: 1 }
      },
      { new: true }
    );

    if (saved) return saved;

    if (typeof Note.findById !== 'function') {
      throw new Error('Note no longer exists');
    }

    const current = await Note.findById(state.noteId)
      .select('contentVersion')
      .lean();

    if (!current) throw new Error('Note no longer exists');
    return { conflictVersion: normalizeVersion(current.contentVersion) };
  }

  async function flush(noteId) {
    const state = states.get(noteId);
    if (!state || state.inFlight || !state.dirty) return;

    clearTimer(state);
    state.inFlight = true;
    const generation = state.generation;
    const content = state.content;
    const baseVersion = state.baseVersion;
    const metadata = stateMetadata(state);
    state.dirty = false;

    try {
      const result = await persist(state, content, baseVersion);

      if (result.conflictVersion !== undefined) {
        const currentVersion = normalizeVersion(result.conflictVersion);
        if (state.generation !== generation && currentVersion === state.baseVersion) {
          state.inFlight = false;
          state.dirty = true;
          schedule(state, 0);
          return;
        }

        reportConflict(state, currentVersion);
        return;
      }

      const contentVersion = normalizeVersion(result.contentVersion);
      state.attempts = 0;
      state.inFlight = false;
      rememberWrite(noteId, state.sourceKey, contentVersion);

      if (state.generation === generation) {
        states.delete(noteId);
      } else {
        state.baseVersion = contentVersion;
        state.firstQueuedAt = Date.now();
        state.dirty = true;
        schedule(state, debounceMs);
      }

      notify(onPersisted, noteId, {
        ...metadata,
        content,
        contentVersion
      });
    } catch (err) {
      state.dirty = true;
      state.inFlight = false;
      state.attempts += 1;

      if (state.attempts >= attemptLimit) {
        reportFailure(state, err);
        return;
      }

      state.firstQueuedAt = Date.now();

      if (logger && typeof logger.error === 'function') {
        logger.error('Failed to persist debounced note update');
      }

      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (state.attempts - 1));
      schedule(state, delay);
    }
  }

  function queue(noteId, content, baseVersion = 0, meta = {}) {
    const now = Date.now();
    let normalizedBaseVersion = normalizeVersion(baseVersion);
    const clientEditId = normalizeEditId(meta.clientEditId);
    const sourceKey = typeof meta.sourceKey === 'string' && meta.sourceKey
      ? meta.sourceKey
      : 'default';
    const sourceSocketId = typeof meta.sourceSocketId === 'string' ? meta.sourceSocketId : null;
    let state = states.get(noteId);

    if (state) {
      if (state.sourceKey !== sourceKey) {
        return { ok: false, code: 'WRITE_IN_PROGRESS', contentVersion: state.baseVersion };
      }

      if (normalizedBaseVersion + 1 === state.baseVersion) {
        normalizedBaseVersion = state.baseVersion;
      }

      if (clientEditId !== null && state.clientEditId !== null) {
        if (clientEditId < state.clientEditId) {
          return { ok: false, code: 'STALE_EDIT', contentVersion: state.baseVersion };
        }
        if (clientEditId === state.clientEditId) {
          if (content === state.content) {
            state.sourceSocketId = sourceSocketId;
            return { ok: true, duplicate: true };
          }
          return { ok: false, code: 'STALE_EDIT', contentVersion: state.baseVersion };
        }
      }

      if (normalizedBaseVersion < state.baseVersion) {
        return { ok: false, code: 'STALE_EDIT', contentVersion: state.baseVersion };
      }

      if (!state.dirty) state.firstQueuedAt = now;
      state.content = content;
      state.baseVersion = Math.max(state.baseVersion, normalizedBaseVersion);
      state.clientEditId = clientEditId ?? state.clientEditId;
      state.sourceSocketId = sourceSocketId ?? state.sourceSocketId;
      state.dirty = true;
      state.generation += 1;

      if (state.inFlight) return { ok: true };

      const dueAt = Math.min(now + debounceMs, state.firstQueuedAt + maxWaitMs);
      schedule(state, dueAt - now);
      return { ok: true };
    }

    const recent = recentWrites.get(noteId);
    if (
      recent
      && recent.sourceKey === sourceKey
      && normalizedBaseVersion + 1 === recent.contentVersion
    ) {
      normalizedBaseVersion = recent.contentVersion;
    }

    state = {
      noteId,
      content,
      baseVersion: normalizedBaseVersion,
      sourceKey,
      sourceSocketId,
      clientEditId,
      dirty: true,
      inFlight: false,
      generation: 1,
      firstQueuedAt: now,
      attempts: 0,
      timer: null
    };
    states.set(noteId, state);

    const dueAt = Math.min(now + debounceMs, state.firstQueuedAt + maxWaitMs);
    schedule(state, dueAt - now);
    return { ok: true };
  }

  async function flushAll() {
    const deadline = Date.now() + maxWaitMs + 2000;

    while (states.size > 0 && Date.now() < deadline) {
      for (const state of states.values()) {
        clearTimer(state);
      }

      await Promise.all(Array.from(states.keys()).map((noteId) => flush(noteId)));

      if (states.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const pending = states.size;
    const failureList = Array.from(failures.entries()).map(([noteId, error]) => ({
      noteId,
      error
    }));
    failures.clear();

    return {
      ok: pending === 0 && failureList.length === 0,
      pending,
      failures: failureList
    };
  }

  function pendingCount() {
    return states.size;
  }

  function hasPending(noteId) {
    return states.has(noteId);
  }

  return {
    queue,
    canContinue,
    flushAll,
    pendingCount,
    hasPending
  };
}

module.exports = {
  createNotePersistence,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_MAX_ATTEMPTS
};
