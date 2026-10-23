import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  const contentVersionRef = useRef(0);
  const latestContentRef = useRef(null);

  const showSnackbar = useCallback((message, severity = 'success') => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  }, []);

  const saveToServer = useCallback(async (content) => {
    if (typeof content !== 'string') return;

    try {
      setSaving(true);
      const res = await API.put(`/notes/${id}`, {
        content,
        contentVersion: contentVersionRef.current
      });
      if (Number.isInteger(res.data.contentVersion)) {
        contentVersionRef.current = Math.max(
          contentVersionRef.current,
          res.data.contentVersion
        );
      }
      setSaving(false);
    } catch (e) {
      const status = e.response?.status;
      const code = e.response?.data?.code;

      if (status === 409 && code === 'WRITE_IN_PROGRESS') {
        setSaving(false);
        if (saveTimeout.current) clearTimeout(saveTimeout.current);
        saveTimeout.current = setTimeout(() => {
          saveTimeout.current = null;
          void saveToServer(content);
        }, 1000);
        return;
      }

      if (status === 409) {
        const serverVersion = e.response.data?.contentVersion;
        if (Number.isInteger(serverVersion)) {
          contentVersionRef.current = Math.max(contentVersionRef.current, serverVersion);
        }
        setSaving(false);
        showSnackbar('A newer version was saved elsewhere. Refresh to sync.', 'warning');
        return;
      }

      console.error('Save failed', e);
      setSaving(false);
      showSnackbar('Changes could not be saved. Please retry.', 'error');
    }
  }, [id, showSnackbar]);

  const scheduleRestSave = useCallback((content) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      saveTimeout.current = null;
      void saveToServer(content);
    }, 1500);
  }, [saveToServer]);

  useEffect(() => {
    // load note
    const load = async () => {
      try {
        const res = await API.get(`/notes/${id}`);
        setNote(res.data);
        contentVersionRef.current = Number.isInteger(res.data.contentVersion)
          ? res.data.contentVersion
          : 0;
        latestContentRef.current = res.data.content || '';
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
    const token = localStorage.getItem('token');
    socketRef.current = io(SOCKET_URL, { auth: { token } });

    socketRef.current.on('connect', () => {
      socketRef.current.emit('join-note', id, (response) => {
        if (response?.ok === false) {
          console.error('Realtime collaboration unavailable:', response.code);
        }
      });
    });

    socketRef.current.on('connect_error', () => {
      console.error('Realtime connection unavailable');
    });

    socketRef.current.on('note-update', ({ content }) => {
      if (typeof content === 'string') {
        if (saveTimeout.current) {
          clearTimeout(saveTimeout.current);
          saveTimeout.current = null;
        }
        latestContentRef.current = content;
        setNote(n => ({ ...n, content }));
        setSaving(false);
      }
    });

    socketRef.current.on('note-saved', ({ contentVersion }) => {
      if (Number.isInteger(contentVersion)) {
        contentVersionRef.current = Math.max(contentVersionRef.current, contentVersion);
      }
      setSaving(false);
    });

    socketRef.current.on('note-save-error', () => {
      setSaving(false);
      showSnackbar('Realtime save failed. Retrying through the API.', 'error');
      scheduleRestSave(latestContentRef.current);
    });

    socketRef.current.on('note-access-revoked', () => {
      setSaving(false);
      showSnackbar('You no longer have access to edit this note.', 'error');
    });

    socketRef.current.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return;
      showSnackbar('Realtime connection lost. Saving through the API.', 'warning');
      if (latestContentRef.current !== null) {
        scheduleRestSave(latestContentRef.current);
      }
    });

    return () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current);
        saveTimeout.current = null;
      }
      if (socketRef.current.connected) {
        socketRef.current.emit('leave-note', id);
      }
      socketRef.current.disconnect();
    };
  }, [id, navigate, scheduleRestSave, showSnackbar]);

  // send edits through socket (debounced)
  const onContentChange = (value) => {
    latestContentRef.current = value;
    setNote(n => ({ ...n, content: value }));
    setSaving(true);

    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('note-edit', { noteId: id, content: value }, (response) => {
        if (response?.ok === false) {
          setSaving(false);
          showSnackbar('Realtime save failed. Retrying through the API.', 'error');
          scheduleRestSave(value);
        }
      });
      return;
    }

    scheduleRestSave(value);
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
