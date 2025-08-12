import React, { useEffect, useRef, useState } from 'react';
import { Box, Paper, TextField, Button, Typography } from '@mui/material';
import { useParams, useNavigate } from 'react-router-dom';
import API from '../api';
import { io } from 'socket.io-client';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

export default function NoteEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [note, setNote] = useState(null);
  const [saving, setSaving] = useState(false);
  const socketRef = useRef(null);
  const saveTimeout = useRef(null);

  useEffect(() => {
    // load note
    const load = async () => {
      try {
        const res = await API.get(`/notes/${id}`);
        setNote(res.data);
      } catch (e) {
        console.error(e);
        alert('Cannot open note');
        navigate('/');
      }
    };
    load();

    // connect socket
    socketRef.current = io(SOCKET_URL);
    socketRef.current.emit('join-note', id);

    socketRef.current.on('note-update', ({ content }) => {
      setNote(n => ({ ...n, content }));
    });

    return () => {
      socketRef.current.emit('leave-note', id);
      socketRef.current.disconnect();
    };
  }, [id]);

  // send edits through socket (debounced)
  const onContentChange = (value) => {
    setNote(n => ({ ...n, content: value }));
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('note-edit', { noteId: id, content: value });
    }

    // also schedule a save to API (debounce)
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => saveToServer(value), 1500);
  };

  const saveToServer = async (content) => {
    try {
      setSaving(true);
      await API.put(`/notes/${id}`, { content });
    } catch (e) {
      console.error('Save failed', e);
    } finally { setSaving(false); }
  };

  const onTitleChange = async (e) => {
    setNote(n => ({ ...n, title: e.target.value }));
    try {
      await API.put(`/notes/${id}`, { title: e.target.value });
    } catch (e) { console.error(e); }
  };

  if (!note) return <Typography>Loading...</Typography>;

  return (
    <Paper sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <TextField value={note.title} onChange={onTitleChange} fullWidth />
        <Button onClick={() => { navigator.clipboard.writeText(window.location.href); }}>Share Link</Button>
      </Box>

      <ReactQuill theme="snow" value={note.content || ''} onChange={onContentChange} style={{ height: 400, marginBottom: 20 }} />
      <Typography variant="caption" color={saving ? 'primary' : 'text.secondary'}>
        {saving ? 'Saving...' : 'All changes saved locally (and to server shortly)'}
      </Typography>
    </Paper>
  );
}
