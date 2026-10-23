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
  CheckCircle,
  CloudOff,
  ErrorOutline,
  WarningAmber
} from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import API from '../api';
import { io } from 'socket.io-client';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import {
  createReconnectRecovery,
  isFullyAcknowledged,
  normalizeRevision,
  shouldApplyRemoteRevision
} from '../noteSync';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

function createClientId(noteId) {
  const storageKey = `note-sync-client:${noteId}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;

    const generated = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function publicUrlFor(noteId, isPublic) {
  if (!isPublic) return '';
  return `${window.location.origin}/notes/public/${noteId}`;
}

function rememberSentContent(sentByRevision, revision, content) {
  let contents = sentByRevision.get(revision);
  if (!contents) {
    contents = new Set();
    sentByRevision.set(revision, contents);
    if (sentByRevision.size > 8) {
      const oldestRevision = sentByRevision.keys().next().value;
      if (oldestRevision !== revision) {
        sentByRevision.delete(oldestRevision);
      }
    }
  }

  contents.add(content);
  if (contents.size > 12) {
    contents.delete(contents.values().next().value);
  }
}

export default function NoteEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [note, setNote] = useState(null);
  const [saveState, setSaveState] = useState('loading');
  const [conflict, setConflict] = useState(null);
  const [isPublic, setIsPublic] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState('success');
  const socketRef = useRef(null);
  const recoveryRef = useRef(null);
  const saveViaRestRef = useRef(null);
  const restTimerRef = useRef(null);
  const restRequestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const loadedRef = useRef(false);
  const connectedRef = useRef(false);
  const clientIdRef = useRef('');
  const latestContentRef = useRef('');
  const baseRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const editSeqRef = useRef(0);
  const lastSentEditIdRef = useRef(0);
  const lastAckedEditIdRef = useRef(0);
  const sentContentsRef = useRef(new Map());
  const conflictRef = useRef(null);

  const showSnackbar = useCallback((message, severity = 'success') => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  }, []);

  const updateMetadata = useCallback((snapshot) => {
    if (!snapshot) return;

    setNote(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        title: typeof snapshot.title === 'string' ? snapshot.title : prev.title,
        updatedAt: snapshot.updatedAt || prev.updatedAt
      };
    });

    if (typeof snapshot.isPublic === 'boolean') {
      setIsPublic(snapshot.isPublic);
      setPublicUrl(publicUrlFor(id, snapshot.isPublic));
    }
  }, [id]);

  const applyServerSnapshot = useCallback((snapshot) => {
    const content = typeof snapshot.content === 'string' ? snapshot.content : '';
    const contentVersion = normalizeRevision(snapshot.contentVersion);

    if (loadedRef.current && contentVersion < baseRevisionRef.current) {
      return false;
    }

    loadedRef.current = true;
    latestContentRef.current = content;
    baseRevisionRef.current = contentVersion;
    dirtyRef.current = false;
    conflictRef.current = null;
    lastAckedEditIdRef.current = Math.max(
      lastAckedEditIdRef.current,
      editSeqRef.current,
      lastSentEditIdRef.current
    );

    setConflict(null);
    setNote(prev => ({
      ...(prev || {}),
      ...snapshot,
      content,
      contentVersion
    }));
    setIsPublic(Boolean(snapshot.isPublic));
    setPublicUrl(publicUrlFor(id, snapshot.isPublic));
    setSaveState('saved');
    return true;
  }, [id]);

  const enterConflict = useCallback((serverSnapshot, fallbackRevision) => {
    const serverRevision = normalizeRevision(
      serverSnapshot?.contentVersion ?? fallbackRevision
    );
    const serverContent = typeof serverSnapshot?.content === 'string'
      ? serverSnapshot.content
      : null;

    if (serverSnapshot) updateMetadata(serverSnapshot);

    const conflictState = {
      serverContent,
      serverRevision,
      localContent: latestContentRef.current
    };

    conflictRef.current = conflictState;
    setConflict(conflictState);
    dirtyRef.current = true;
    setSaveState('conflict');
  }, [updateMetadata]);

  const fetchSnapshot = useCallback(async () => {
    const response = await API.get(`/notes/${id}`);
    return response.data;
  }, [id]);

  const sendContent = useCallback((content) => {
    if (conflictRef.current) return false;
    if (typeof content !== 'string') return false;
    if (!connectedRef.current || !socketRef.current) {
      setSaveState('offline');
      return false;
    }

    const editId = Math.max(1, editSeqRef.current);
    lastSentEditIdRef.current = Math.max(lastSentEditIdRef.current, editId);
    rememberSentContent(sentContentsRef.current, baseRevisionRef.current, content);
    setSaveState('saving');

    socketRef.current.emit('note-edit', {
      noteId: id,
      content,
      contentVersion: baseRevisionRef.current,
      clientId: clientIdRef.current,
      clientEditId: editId
    }, (response) => {
      if (!mountedRef.current) return;
      if (response?.ok) return;

      if (editId < lastSentEditIdRef.current && response?.code !== 'VERSION_CONFLICT') {
        return;
      }

      if (response?.code === 'VERSION_CONFLICT') {
        enterConflict(null, response.contentVersion);
        void recoveryRef.current?.recover();
        return;
      }

      if (response?.code === 'WRITE_IN_PROGRESS') {
        setSaveState('error');
        showSnackbar('Another save is still in progress. Your draft is kept locally.', 'warning');
        return;
      }

      if (response?.code === 'STALE_EDIT') {
        setSaveState('error');
        showSnackbar('A newer local edit superseded this save. Syncing your draft.', 'warning');
        void recoveryRef.current?.recover();
        return;
      }

      if (response?.code === 'FORBIDDEN') {
        setSaveState('error');
        showSnackbar('You no longer have access to edit this note.', 'error');
        return;
      }

      setSaveState('error');
      showSnackbar('Realtime save failed. Your draft is kept locally.', 'error');
    });

    return true;
  }, [enterConflict, id, showSnackbar]);

  const scheduleRestSave = useCallback((delayMs = 1500) => {
    if (!dirtyRef.current || conflictRef.current) return;
    if (connectedRef.current) return;
    if (restTimerRef.current) clearTimeout(restTimerRef.current);
    restTimerRef.current = setTimeout(() => {
      restTimerRef.current = null;
      void saveViaRestRef.current?.();
    }, delayMs);
  }, []);

  const saveViaRest = useCallback(async (
    content = latestContentRef.current,
    editId = editSeqRef.current,
    revision = baseRevisionRef.current,
    attempt = 0
  ) => {
    if (!dirtyRef.current || conflictRef.current) return;
    if (connectedRef.current) return;
    if (typeof content !== 'string') return;

    rememberSentContent(sentContentsRef.current, revision, content);
    const requestId = ++restRequestIdRef.current;

    try {
      const response = await API.put(`/notes/${id}`, {
        content,
        contentVersion: revision
      });

      if (!mountedRef.current || requestId !== restRequestIdRef.current) return;

      const contentVersion = normalizeRevision(response.data.contentVersion);
      baseRevisionRef.current = Math.max(baseRevisionRef.current, contentVersion);
      setNote(prev => prev ? {
        ...prev,
        contentVersion: Math.max(
          normalizeRevision(prev.contentVersion),
          contentVersion
        )
      } : prev);

      if (editId >= editSeqRef.current && content === latestContentRef.current) {
        lastAckedEditIdRef.current = Math.max(lastAckedEditIdRef.current, editId);
        if (isFullyAcknowledged(lastAckedEditIdRef.current, editSeqRef.current)) {
          dirtyRef.current = false;
          conflictRef.current = null;
          setConflict(null);
          setSaveState('saved');
        }
      } else if (connectedRef.current) {
        sendContent(latestContentRef.current);
      } else {
        setSaveState('offline');
        scheduleRestSave(1500);
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== restRequestIdRef.current) return;

      const status = error.response?.status;
      const code = error.response?.data?.code;

      if (status === 409 && code === 'VERSION_CONFLICT') {
        enterConflict(null, error.response.data?.contentVersion);
        void recoveryRef.current?.recover();
        return;
      }

      if (status === 409 && code === 'WRITE_IN_PROGRESS') {
        if (attempt < 2) {
          setSaveState('reconnecting');
          if (restTimerRef.current) clearTimeout(restTimerRef.current);
          restTimerRef.current = setTimeout(() => {
            restTimerRef.current = null;
            void saveViaRest(
              latestContentRef.current,
              editSeqRef.current,
              baseRevisionRef.current,
              attempt + 1
            );
          }, 1000);
        } else {
          setSaveState('error');
          showSnackbar('Another save is still in progress. Your draft is kept locally.', 'warning');
        }
        return;
      }

      console.error('Fallback save failed', error);
      setSaveState(connectedRef.current ? 'error' : 'offline');
      showSnackbar('Changes could not be saved. Your draft is kept locally.', 'error');
    }
  }, [enterConflict, id, scheduleRestSave, sendContent, showSnackbar]);

  useEffect(() => {
    saveViaRestRef.current = saveViaRest;
  }, [saveViaRest]);

  const handleNoteSaved = useCallback((payload = {}) => {
    const contentVersion = normalizeRevision(payload.contentVersion);
    if (contentVersion > baseRevisionRef.current) {
      baseRevisionRef.current = contentVersion;
    }

    const acknowledgedId = Number.isInteger(payload.clientEditId)
      ? payload.clientEditId
      : lastSentEditIdRef.current;
    lastAckedEditIdRef.current = Math.max(
      lastAckedEditIdRef.current,
      acknowledgedId
    );

    setNote(prev => prev ? {
      ...prev,
      contentVersion: Math.max(
        normalizeRevision(prev.contentVersion),
        contentVersion
      )
    } : prev);

    if (isFullyAcknowledged(lastAckedEditIdRef.current, editSeqRef.current)) {
      dirtyRef.current = false;
      conflictRef.current = null;
      setConflict(null);
      setSaveState('saved');
    } else if (dirtyRef.current) {
      setSaveState(connectedRef.current ? 'saving' : 'offline');
    }
  }, []);

  const handleRemoteUpdate = useCallback((payload = {}) => {
    if (!loadedRef.current || typeof payload.content !== 'string') return;

    const contentVersion = normalizeRevision(payload.contentVersion);
    if (!shouldApplyRemoteRevision(baseRevisionRef.current, contentVersion)) {
      return;
    }

    if (!dirtyRef.current) {
      latestContentRef.current = payload.content;
      baseRevisionRef.current = contentVersion;
      conflictRef.current = null;
      setConflict(null);
      setNote(prev => prev ? {
        ...prev,
        content: payload.content,
        contentVersion
      } : prev);
      setSaveState('saved');
      return;
    }

    if (payload.content === latestContentRef.current) {
      baseRevisionRef.current = contentVersion;
      lastAckedEditIdRef.current = Math.max(
        lastAckedEditIdRef.current,
        editSeqRef.current
      );
      dirtyRef.current = false;
      conflictRef.current = null;
      setConflict(null);
      setNote(prev => prev ? { ...prev, contentVersion } : prev);
      setSaveState('saved');
      return;
    }

    enterConflict({
      content: payload.content,
      contentVersion
    });
  }, [enterConflict]);

  const handleSaveConflict = useCallback((payload = {}) => {
    enterConflict(null, payload.contentVersion);
    void recoveryRef.current?.recover();
  }, [enterConflict]);

  const handleSaveError = useCallback(() => {
    setSaveState(connectedRef.current ? 'error' : 'offline');
    showSnackbar('Realtime save failed. Your draft is kept locally.', 'error');
  }, [showSnackbar]);

  const keepLocalDraft = useCallback(() => {
    const conflictState = conflictRef.current;
    if (!conflictState) return;

    baseRevisionRef.current = conflictState.serverRevision;
    conflictRef.current = null;
    setConflict(null);
    dirtyRef.current = true;
    editSeqRef.current += 1;

    if (connectedRef.current) {
      setSaveState('saving');
      sendContent(latestContentRef.current);
    } else {
      setSaveState('offline');
      scheduleRestSave(1500);
    }
  }, [scheduleRestSave, sendContent]);

  const loadLatestVersion = useCallback(async () => {
    setSaveState('reconnecting');
    try {
      const snapshot = await fetchSnapshot();
      if (!applyServerSnapshot(snapshot)) {
        setSaveState('conflict');
        showSnackbar('The server changed while reloading. Review the conflict again.', 'warning');
      }
    } catch (error) {
      console.error('Failed to reload note', error);
      setSaveState('conflict');
      showSnackbar('Could not load the latest server version.', 'error');
    }
  }, [applyServerSnapshot, fetchSnapshot, showSnackbar]);

  const onContentChange = useCallback((value) => {
    if (typeof value !== 'string' || value === latestContentRef.current) return;

    latestContentRef.current = value;
    setNote(prev => prev ? { ...prev, content: value } : prev);
    editSeqRef.current += 1;
    dirtyRef.current = true;

    if (conflictRef.current) {
      setSaveState('conflict');
      return;
    }

    if (connectedRef.current) {
      setSaveState('saving');
      sendContent(value);
    } else {
      setSaveState('offline');
      scheduleRestSave(1500);
    }
  }, [scheduleRestSave, sendContent]);

  useEffect(() => {
    mountedRef.current = true;
    loadedRef.current = false;
    connectedRef.current = false;
    clientIdRef.current = createClientId(id);

    const recovery = createReconnectRecovery({
      fetchSnapshot,
      getLocalState: () => ({
        localContent: latestContentRef.current,
        baseRevision: baseRevisionRef.current,
        dirty: dirtyRef.current,
        sentContents: Array.from(
          sentContentsRef.current.get(baseRevisionRef.current) || []
        )
      }),
      onApplyServer: (snapshot) => {
        applyServerSnapshot(snapshot);
      },
      onMarkSaved: (snapshot, action) => {
        updateMetadata(snapshot);
        baseRevisionRef.current = Math.max(
          baseRevisionRef.current,
          action.serverRevision
        );
        lastAckedEditIdRef.current = Math.max(
          lastAckedEditIdRef.current,
          editSeqRef.current
        );
        dirtyRef.current = false;
        conflictRef.current = null;
        setConflict(null);
        setNote(prev => prev ? {
          ...prev,
          contentVersion: Math.max(
            normalizeRevision(prev.contentVersion),
            action.serverRevision
          ),
          updatedAt: snapshot.updatedAt || prev.updatedAt
        } : prev);
        setSaveState('saved');
      },
      onRetryPending: (snapshot, action) => {
        updateMetadata(snapshot);
        if (conflictRef.current) return;

        if (action.followsOwnSave) {
          baseRevisionRef.current = Math.max(
            baseRevisionRef.current,
            action.serverRevision
          );
          setNote(prev => prev ? {
            ...prev,
            contentVersion: Math.max(
              normalizeRevision(prev.contentVersion),
              action.serverRevision
            )
          } : prev);
        } else if (action.serverRevision !== baseRevisionRef.current) {
          void recoveryRef.current?.recover();
          return;
        }

        if (connectedRef.current) {
          sendContent(latestContentRef.current);
        } else {
          setSaveState('offline');
          scheduleRestSave(1500);
        }
      },
      onConflict: (snapshot) => {
        enterConflict(snapshot);
      },
      onError: (error) => {
        console.error('Snapshot sync failed', error);
        if (!loadedRef.current) {
          alert('Cannot open note');
          navigate('/');
          return;
        }
        setSaveState(connectedRef.current ? 'error' : 'offline');
      }
    });

    recoveryRef.current = recovery;

    const socket = io(SOCKET_URL, {
      auth: { token: localStorage.getItem('token') }
    });
    socketRef.current = socket;

    const onConnect = () => {
      connectedRef.current = true;
      restRequestIdRef.current += 1;
      if (restTimerRef.current) {
        clearTimeout(restTimerRef.current);
        restTimerRef.current = null;
      }
      if (conflictRef.current) {
        setSaveState('conflict');
      } else {
        setSaveState('reconnecting');
      }

      socket.emit('join-note', id, (response) => {
        if (!mountedRef.current) return;
        if (response?.ok === false) {
          setSaveState('error');
          showSnackbar('Realtime collaboration is unavailable for this note.', 'error');
          return;
        }
        void recovery.recover();
      });
    };

    const onConnectError = () => {
      connectedRef.current = false;
      if (!conflictRef.current) setSaveState('offline');
    };

    const onDisconnect = (reason) => {
      if (reason === 'io client disconnect') return;
      connectedRef.current = false;
      restRequestIdRef.current += 1;
      if (restTimerRef.current) {
        clearTimeout(restTimerRef.current);
        restTimerRef.current = null;
      }
      if (!conflictRef.current) setSaveState('reconnecting');
      showSnackbar('Realtime connection lost. Your draft is kept locally.', 'warning');
      if (dirtyRef.current) scheduleRestSave(1500);
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('disconnect', onDisconnect);
    socket.on('note-update', handleRemoteUpdate);
    socket.on('note-saved', handleNoteSaved);
    socket.on('note-save-error', handleSaveError);
    socket.on('note-save-conflict', handleSaveConflict);
    socket.on('note-access-revoked', () => {
      setSaveState('error');
      showSnackbar('You no longer have access to edit this note.', 'error');
    });

    void recovery.recover();

    return () => {
      mountedRef.current = false;
      loadedRef.current = false;
      connectedRef.current = false;
      restRequestIdRef.current += 1;
      if (restTimerRef.current) {
        clearTimeout(restTimerRef.current);
        restTimerRef.current = null;
      }
      recovery.dispose();
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [
    applyServerSnapshot,
    enterConflict,
    fetchSnapshot,
    handleNoteSaved,
    handleRemoteUpdate,
    handleSaveConflict,
    handleSaveError,
    id,
    navigate,
    scheduleRestSave,
    sendContent,
    showSnackbar,
    updateMetadata
  ]);

  const onTitleChange = async (e) => {
    setNote(n => ({ ...n, title: e.target.value }));
    try {
      await API.put(`/notes/${id}`, { title: e.target.value });
    } catch (e) {
      console.error(e);
    }
  };

  const togglePublic = async () => {
    try {
      const res = await API.put(`/notes/${id}/visibility`, { isPublic: !isPublic });
      setIsPublic(res.data.isPublic);
      setPublicUrl(publicUrlFor(id, res.data.isPublic));
    } catch (e) {
      console.error('Error toggling public access:', e);
      alert('Failed to update sharing settings');
    }
  };

  const copyPublicLink = () => {
    if (publicUrl) {
      navigator.clipboard.writeText(publicUrl);
      showSnackbar('Public link copied to clipboard!');
    }
  };

  const copyPrivateLink = () => {
    navigator.clipboard.writeText(window.location.href);
    showSnackbar('Private link copied to clipboard!');
  };

  if (!note) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <Typography variant="h6" color="text.secondary">Loading note...</Typography>
      </Box>
    );
  }

  const statusContent = (() => {
    if (saveState === 'saved') {
      return {
        icon: <CheckCircle sx={{ fontSize: 16, color: 'success.main' }} />,
        label: 'All changes saved',
        color: 'text.secondary'
      };
    }
    if (saveState === 'conflict') {
      return {
        icon: <WarningAmber sx={{ fontSize: 16, color: 'warning.main' }} />,
        label: 'Version conflict - review required',
        color: 'warning.main'
      };
    }
    if (saveState === 'offline' || saveState === 'reconnecting') {
      return {
        icon: <CloudOff sx={{ fontSize: 16, color: 'warning.main' }} />,
        label: saveState === 'offline' ? 'Offline - draft kept locally' : 'Reconnecting - draft kept locally',
        color: 'warning.main'
      };
    }
    if (saveState === 'error') {
      return {
        icon: <ErrorOutline sx={{ fontSize: 16, color: 'error.main' }} />,
        label: 'Save failed - draft kept locally',
        color: 'error.main'
      };
    }
    return {
      icon: <Save sx={{ fontSize: 16, color: 'primary.main' }} />,
      label: 'Saving...',
      color: 'primary.main'
    };
  })();

  return (
    <Box>
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

      {conflict && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={(
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button color="inherit" size="small" onClick={loadLatestVersion}>
                Load latest
              </Button>
              <Button color="warning" size="small" variant="outlined" onClick={keepLocalDraft}>
                Keep my draft
              </Button>
            </Box>
          )}
        >
          Your local draft conflicts with server revision {conflict.serverRevision}.
          Choose which version to keep.
        </Alert>
      )}

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

      <Fade in>
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          mt: 2,
          px: 1
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {statusContent.icon}
            <Typography variant="caption" color={statusContent.color}>
              {statusContent.label}
            </Typography>
          </Box>
          
          <Typography variant="caption" color="text.secondary">
            Last updated: {new Date(note.updatedAt).toLocaleString()}
          </Typography>
        </Box>
      </Fade>

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
