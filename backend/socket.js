const jwt = require('jsonwebtoken');
const { createNotePersistence } = require('./lib/notePersistence');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const DEFAULT_CONTENT_LIMIT_BYTES = 100 * 1024;

function isValidObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

function normalizeId(value) {
  return value.toLowerCase();
}

function normalizeVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function roomFor(noteId) {
  return `note:${noteId}`;
}

function isOwnerOrCollaborator(note, userId) {
  const id = String(userId);
  if (note.owner && String(note.owner) === id) return true;
  return Array.isArray(note.collaborators)
    && note.collaborators.some((collaborator) => String(collaborator) === id);
}

function canReadNote(note, userId) {
  return Boolean(note.isPublic) || isOwnerOrCollaborator(note, userId);
}

function extractToken(socket) {
  const authToken = socket.handshake?.auth?.token;
  const authHeader = socket.handshake?.headers?.authorization;
  const raw = typeof authToken === 'string' && authToken.trim()
    ? authToken.trim()
    : (typeof authHeader === 'string' ? authHeader.trim() : '');

  if (!raw) return '';
  return raw.replace(/^Bearer\s+/i, '');
}

function sendAck(ack, result) {
  if (typeof ack === 'function') ack(result);
}

function unauthorizedError() {
  const error = new Error('Unauthorized');
  error.data = { code: 'UNAUTHORIZED' };
  return error;
}

function createRealtimeServer(io, {
  Note,
  jwtSecret = process.env.JWT_SECRET,
  contentLimitBytes = DEFAULT_CONTENT_LIMIT_BYTES,
  debounceMs,
  maxWaitMs,
  maxAttempts,
  logger = console
} = {}) {
  if (!io || typeof io.use !== 'function' || typeof io.on !== 'function') {
    throw new TypeError('A Socket.IO server instance is required');
  }
  if (!Note || typeof Note.findById !== 'function') {
    throw new TypeError('A Note model is required');
  }

  async function loadNoteAccess(noteId) {
    return Note.findById(noteId)
      .select('_id owner collaborators isPublic contentVersion')
      .lean();
  }

  async function broadcastPersisted(noteId, {
    content,
    contentVersion,
    sourceSocketId,
    clientEditId
  }) {
    const note = await loadNoteAccess(noteId);
    if (!note) return;

    if (sourceSocketId) {
      io.to(sourceSocketId).emit('note-saved', {
        contentVersion,
        clientEditId
      });
    }

    const room = roomFor(noteId);

    if (note.isPublic) {
      if (sourceSocketId) {
        io.to(room).except(sourceSocketId).emit('note-update', { content, contentVersion });
      } else {
        io.to(room).emit('note-update', { content, contentVersion });
      }
      return;
    }

    const sockets = await io.in(room).fetchSockets();
    for (const target of sockets) {
      if (target.id === sourceSocketId) continue;
      if (isOwnerOrCollaborator(note, target.data.userId)) {
        target.emit('note-update', { content, contentVersion });
      } else {
        target.leave(room);
        target.emit('note-access-revoked');
      }
    }
  }

  function emitToSource(sourceSocketId, event, payload) {
    if (sourceSocketId) {
      io.to(sourceSocketId).emit(event, payload);
    }
  }

  const persistence = createNotePersistence({
    Note,
    debounceMs,
    maxWaitMs,
    maxAttempts,
    logger,
    onPersisted(noteId, result) {
      return broadcastPersisted(noteId, result);
    },
    onFailed(noteId, { sourceSocketId }) {
      emitToSource(sourceSocketId, 'note-save-error', { code: 'SAVE_FAILED' });
    },
    onConflict(noteId, { sourceSocketId, contentVersion }) {
      emitToSource(sourceSocketId, 'note-save-conflict', {
        code: 'VERSION_CONFLICT',
        contentVersion
      });
    }
  });

  io.use((socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token || !jwtSecret) return next(unauthorizedError());

      const decoded = jwt.verify(token, jwtSecret);
      const userId = decoded?.user?.id;

      if (!isValidObjectId(userId)) return next(unauthorizedError());

      socket.data.userId = normalizeId(String(userId));
      next();
    } catch {
      next(unauthorizedError());
    }
  });

  io.on('connection', (socket) => {
    socket.on('join-note', async (noteId, ack) => {
      if (!isValidObjectId(noteId)) {
        return sendAck(ack, { ok: false, code: 'INVALID_NOTE_ID' });
      }

      const normalizedNoteId = normalizeId(noteId);

      try {
        const note = await loadNoteAccess(normalizedNoteId);
        if (!note) {
          return sendAck(ack, { ok: false, code: 'NOTE_NOT_FOUND' });
        }
        if (!canReadNote(note, socket.data.userId)) {
          return sendAck(ack, { ok: false, code: 'FORBIDDEN' });
        }

        await socket.join(roomFor(normalizedNoteId));
        sendAck(ack, {
          ok: true,
          readOnly: !isOwnerOrCollaborator(note, socket.data.userId),
          contentVersion: normalizeVersion(note.contentVersion)
        });
      } catch {
        sendAck(ack, { ok: false, code: 'SERVER_ERROR' });
      }
    });

    socket.on('leave-note', (noteId) => {
      if (!isValidObjectId(noteId)) return;
      const room = roomFor(normalizeId(noteId));
      if (socket.rooms.has(room)) socket.leave(room);
    });

    socket.on('note-edit', async (payload, ack) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendAck(ack, { ok: false, code: 'INVALID_PAYLOAD' });
      }

      const { noteId, content, contentVersion, clientId, clientEditId } = payload;

      if (!isValidObjectId(noteId)) {
        return sendAck(ack, { ok: false, code: 'INVALID_NOTE_ID' });
      }
      if (typeof content !== 'string') {
        return sendAck(ack, { ok: false, code: 'INVALID_PAYLOAD' });
      }
      if (Buffer.byteLength(content, 'utf8') > contentLimitBytes) {
        return sendAck(ack, { ok: false, code: 'CONTENT_TOO_LARGE' });
      }
      if (!Number.isInteger(contentVersion) || contentVersion < 0) {
        return sendAck(ack, { ok: false, code: 'VERSION_REQUIRED' });
      }
      if (clientId !== undefined && (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId))) {
        return sendAck(ack, { ok: false, code: 'INVALID_PAYLOAD' });
      }
      if (clientEditId !== undefined && (!Number.isInteger(clientEditId) || clientEditId < 0)) {
        return sendAck(ack, { ok: false, code: 'INVALID_PAYLOAD' });
      }

      const normalizedNoteId = normalizeId(noteId);

      try {
        const note = await loadNoteAccess(normalizedNoteId);
        if (!note) {
          return sendAck(ack, { ok: false, code: 'NOTE_NOT_FOUND' });
        }
        if (!isOwnerOrCollaborator(note, socket.data.userId)) {
          if (!note.isPublic) {
            await socket.leave(roomFor(normalizedNoteId));
            socket.emit('note-access-revoked');
          }
          return sendAck(ack, { ok: false, code: 'FORBIDDEN' });
        }

        const currentVersion = normalizeVersion(note.contentVersion);
        const sourceKey = `${socket.data.userId}:${clientId || socket.id}`;
        if (contentVersion !== currentVersion) {
          const followsOwnSave = contentVersion + 1 === currentVersion
            && persistence.canContinue(normalizedNoteId, contentVersion, sourceKey);
          if (!followsOwnSave) {
            return sendAck(ack, {
              ok: false,
              code: 'VERSION_CONFLICT',
              contentVersion: currentVersion
            });
          }
        }

        const queued = persistence.queue(normalizedNoteId, content, contentVersion, {
          sourceKey,
          sourceSocketId: socket.id,
          clientEditId
        });

        if (!queued.ok) {
          return sendAck(ack, {
            ok: false,
            code: queued.code,
            contentVersion: queued.contentVersion
          });
        }

        sendAck(ack, { ok: true });
      } catch {
        sendAck(ack, { ok: false, code: 'SERVER_ERROR' });
      }
    });
  });

  return {
    flushAll: persistence.flushAll,
    pendingCount: persistence.pendingCount,
    hasPending: persistence.hasPending
  };
}

module.exports = {
  createRealtimeServer,
  DEFAULT_CONTENT_LIMIT_BYTES
};
