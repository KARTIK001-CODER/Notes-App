const jwt = require('jsonwebtoken');
const { createNotePersistence } = require('./lib/notePersistence');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const DEFAULT_CONTENT_LIMIT_BYTES = 100 * 1024;

function isValidObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

function normalizeId(value) {
  return value.toLowerCase();
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

  const persistence = createNotePersistence({
    Note,
    debounceMs,
    maxWaitMs,
    maxAttempts,
    logger,
    onPersisted(noteId, contentVersion) {
      io.to(roomFor(noteId)).emit('note-saved', { contentVersion });
    },
    onFailed(noteId) {
      io.to(roomFor(noteId)).emit('note-save-error', { code: 'SAVE_FAILED' });
    }
  });

  async function loadNoteAccess(noteId) {
    return Note.findById(noteId)
      .select('_id owner collaborators isPublic contentVersion')
      .lean();
  }

  async function broadcastUpdate(socket, note, noteId, content) {
    const room = roomFor(noteId);

    if (note.isPublic) {
      socket.to(room).emit('note-update', { content });
      return;
    }

    const sockets = await io.in(room).fetchSockets();
    for (const target of sockets) {
      if (target.id === socket.id) continue;
      if (isOwnerOrCollaborator(note, target.data.userId)) {
        target.emit('note-update', { content });
      } else {
        target.leave(room);
        target.emit('note-access-revoked');
      }
    }
  }

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
          readOnly: !isOwnerOrCollaborator(note, socket.data.userId)
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

      const { noteId, content } = payload;

      if (!isValidObjectId(noteId)) {
        return sendAck(ack, { ok: false, code: 'INVALID_NOTE_ID' });
      }
      if (typeof content !== 'string') {
        return sendAck(ack, { ok: false, code: 'INVALID_PAYLOAD' });
      }
      if (Buffer.byteLength(content, 'utf8') > contentLimitBytes) {
        return sendAck(ack, { ok: false, code: 'CONTENT_TOO_LARGE' });
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

        persistence.queue(normalizedNoteId, content, note.contentVersion);
        await broadcastUpdate(socket, note, normalizedNoteId, content);
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
