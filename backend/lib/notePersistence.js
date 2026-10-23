const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_WAIT_MS = 3000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 5;

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

function createNotePersistence({
  Note,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  logger = console,
  onPersisted = () => {},
  onFailed = () => {}
} = {}) {
  if (!Note || typeof Note.findOneAndUpdate !== 'function') {
    throw new TypeError('A Note model with findOneAndUpdate is required');
  }

  const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const states = new Map();
  const failures = new Map();

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

  function reportFailure(state, error) {
    clearTimer(state);
    state.inFlight = false;
    state.dirty = false;
    states.delete(state.noteId);
    failures.set(state.noteId, error instanceof Error ? error : new Error('Note persistence failed'));

    if (logger && typeof logger.error === 'function') {
      logger.error('Failed to persist debounced note update');
    }

    try {
      onFailed(state.noteId);
    } catch {
      if (logger && typeof logger.error === 'function') {
        logger.error('Failed to report note persistence failure');
      }
    }
  }

  async function persist(state) {
    const saved = await Note.findOneAndUpdate(
      { _id: state.noteId, ...versionFilter(normalizeVersion(state.baseVersion)) },
      {
        $set: { content: state.content, updatedAt: new Date() },
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
    state.dirty = false;

    try {
      const result = await persist(state);

      if (result.conflictVersion !== undefined) {
        state.conflictAttempts += 1;
        if (state.conflictAttempts >= attemptLimit) {
          reportFailure(state, new Error('Note persistence conflict limit reached'));
          return;
        }

        state.baseVersion = result.conflictVersion;
        state.inFlight = false;
        state.dirty = true;
        schedule(state, 0);
        return;
      }

      const contentVersion = normalizeVersion(result.contentVersion);
      state.attempts = 0;
      state.conflictAttempts = 0;
      state.inFlight = false;

      try {
        onPersisted(noteId, contentVersion);
      } catch {
        if (logger && typeof logger.error === 'function') {
          logger.error('Failed to report note persistence success');
        }
      }

      if (state.generation !== generation) {
        state.baseVersion = contentVersion;
        state.firstQueuedAt = Date.now();
        schedule(state, debounceMs);
      } else {
        states.delete(noteId);
      }
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

  function queue(noteId, content, baseVersion = 0) {
    let state = states.get(noteId);
    const now = Date.now();

    if (!state) {
      state = {
        noteId,
        content,
        baseVersion: normalizeVersion(baseVersion),
        dirty: true,
        inFlight: false,
        generation: 1,
        firstQueuedAt: now,
        attempts: 0,
        conflictAttempts: 0,
        timer: null
      };
      states.set(noteId, state);
    } else {
      if (!state.dirty) state.firstQueuedAt = now;
      state.content = content;
      state.dirty = true;
      state.generation += 1;
    }

    if (state.inFlight) return;

    const dueAt = Math.min(now + debounceMs, state.firstQueuedAt + maxWaitMs);
    schedule(state, dueAt - now);
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
