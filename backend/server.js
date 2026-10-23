const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const noteRoutes = require('./routes/notes');
const Note = require('./models/Note');
const { createRealtimeServer } = require('./socket');

const app = express();


app.use(cors({
  origin: [
    "http://localhost:5173",         // for local dev
    "https://notes-app-xo1c.onrender.com",  // deployed frontend
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));


app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/notes', noteRoutes);

const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: [
      "http://localhost:5173",           // frontend dev server
      "https://notes-app-xo1c.onrender.com" // deployed frontend
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});


const realtime = createRealtimeServer(io, { Note });
app.locals.notePersistence = realtime;

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  let flushResult;
  try {
    flushResult = await realtime.flushAll();
  } catch {
    flushResult = { ok: false, pending: realtime.pendingCount(), failures: [] };
  }

  if (!flushResult.ok) {
    console.error('Failed to flush pending note updates');
  }

  io.close();
  server.close(() => process.exit(flushResult.ok ? 0 : 1));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

// connect to DB & start
mongoose.connect(process.env.MONGO_URI, { })
  .then(async () => {
    await Note.updateMany(
      {
        $or: [
          { contentVersion: { $exists: false } },
          { contentVersion: null }
        ]
      },
      { $set: { contentVersion: 0 } }
    );
    console.log('MongoDB connected');
    const port = process.env.PORT || 5000;
    server.listen(port, () => console.log(`Server running on ${port}`));
  })
  .catch(err => console.error(err));
