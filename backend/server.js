const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const noteRoutes = require('./routes/notes');
const Note = require('./models/Note');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/notes', noteRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // refine later to frontend URL
});

/**
 * Socket.IO: Rooms per note ID.
 * Clients join 'note:<noteId>' and emit 'note-edit' with { noteId, content }.
 * Server broadcasts 'note-update' to room except sender.
 */

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-note', (noteId) => {
    const room = `note:${noteId}`;
    socket.join(room);
    console.log(socket.id, 'joined', room);
  });

  socket.on('leave-note', (noteId) => {
    socket.leave(`note:${noteId}`);
  });

  socket.on('note-edit', async ({ noteId, content }) => {
    // broadcast to others in room
    socket.to(`note:${noteId}`).emit('note-update', { content });

    // optional: persist (debounce on client ideally)
    try {
      await Note.findByIdAndUpdate(noteId, { content, updatedAt: new Date() });
    } catch (err) {
      console.error('Error saving note from socket:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected', socket.id);
  });
});

// connect to DB & start
mongoose.connect(process.env.MONGO_URI, { })
  .then(() => {
    console.log('MongoDB connected');
    const port = process.env.PORT || 5000;
    server.listen(port, () => console.log(`Server running on ${port}`));
  })
  .catch(err => console.error(err));
