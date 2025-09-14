import React, { useEffect, useRef, useState } from 'react';
import { 
  Box, 
  Paper, 
  TextField, 
  Button, 
  Typography, 
  IconButton,
  Tooltip,
  Chip,
  Fade,
  Alert,
  Snackbar
} from '@mui/material';
import { 
  Share, 
  Public, 
  Lock, 
  ContentCopy, 
  Save,
  ArrowBack,
  CheckCircle
} from '@mui/icons-material';
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
  const [isPublic, setIsPublic] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState('success');
  const socketRef = useRef(null);
  const saveTimeout = useRef(null);

  useEffect(() => {
    // load note
    const load = async () => {
      try {
        const res = await API.get(`/notes/${id}`);
        setNote(res.data);
        setIsPublic(res.data.isPublic || false);
        if (res.data.isPublic) {
          setPublicUrl(`${window.location.origin}/notes/public/${id}`);
        }
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

  const togglePublic = async () => {
    try {
      const res = await API.put(`/notes/${id}/visibility`, { isPublic: !isPublic });
      setIsPublic(res.data.isPublic);
      if (res.data.isPublic) {
        setPublicUrl(`${window.location.origin}/notes/public/${id}`);
      } else {
        setPublicUrl('');
      }
    } catch (e) {
      console.error('Error toggling public access:', e);
      alert('Failed to update sharing settings');
    }
  };

  const copyPublicLink = () => {
    if (publicUrl) {
      navigator.clipboard.writeText(publicUrl);
      setSnackbarMessage('Public link copied to clipboard!');
      setSnackbarSeverity('success');
      setSnackbarOpen(true);
    }
  };

  const copyPrivateLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setSnackbarMessage('Private link copied to clipboard!');
    setSnackbarSeverity('success');
    setSnackbarOpen(true);
  };

  const showSnackbar = (message, severity = 'success') => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  };

  if (!note) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <Typography variant="h6" color="text.secondary">Loading note...</Typography>
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        mb: 3,
        flexWrap: 'wrap',
        gap: 2
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0 }}>
          <Tooltip title="Back to notes">
            <IconButton 
              onClick={() => navigate('/')}
              sx={{ 
                bgcolor: 'grey.100',
                '&:hover': { bgcolor: 'grey.200' }
              }}
            >
              <ArrowBack />
            </IconButton>
          </Tooltip>
          
          <TextField 
            value={note.title} 
            onChange={onTitleChange} 
            fullWidth
            variant="outlined"
            placeholder="Untitled Note"
            sx={{
              '& .MuiOutlinedInput-root': {
                fontSize: '1.5rem',
                fontWeight: 600,
                '& fieldset': { border: 'none' },
                '&:hover fieldset': { border: '1px solid', borderColor: 'grey.300' },
                '&.Mui-focused fieldset': { border: '2px solid', borderColor: 'primary.main' }
              }
            }}
          />
        </Box>

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Chip
            icon={isPublic ? <Public /> : <Lock />}
            label={isPublic ? 'Public' : 'Private'}
            color={isPublic ? 'success' : 'default'}
            variant={isPublic ? 'filled' : 'outlined'}
            onClick={togglePublic}
            sx={{ cursor: 'pointer' }}
          />
          
          <Tooltip title="Copy private link">
            <IconButton onClick={copyPrivateLink} color="primary">
              <ContentCopy />
            </IconButton>
          </Tooltip>
          
          {isPublic && (
            <Tooltip title="Copy public link">
              <IconButton onClick={copyPublicLink} color="success">
                <Share />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>

      {/* Editor */}
      <Paper 
        elevation={0}
        sx={{ 
          border: '1px solid',
          borderColor: 'grey.200',
          borderRadius: 2,
          overflow: 'hidden'
        }}
      >
        <ReactQuill 
          theme="snow" 
          value={note.content || ''} 
          onChange={onContentChange} 
          style={{ 
            height: '60vh',
            minHeight: 400
          }}
        />
      </Paper>

      {/* Status Bar */}
      <Fade in>
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          mt: 2,
          px: 1
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {saving ? (
              <>
                <Save sx={{ fontSize: 16, color: 'primary.main' }} />
                <Typography variant="caption" color="primary.main">
                  Saving...
                </Typography>
              </>
            ) : (
              <>
                <CheckCircle sx={{ fontSize: 16, color: 'success.main' }} />
                <Typography variant="caption" color="text.secondary">
                  All changes saved
                </Typography>
              </>
            )}
          </Box>
          
          <Typography variant="caption" color="text.secondary">
            Last updated: {new Date(note.updatedAt).toLocaleString()}
          </Typography>
        </Box>
      </Fade>

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={3000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert 
          onClose={() => setSnackbarOpen(false)} 
          severity={snackbarSeverity}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}
