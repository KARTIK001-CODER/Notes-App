import React, { useEffect, useState } from 'react';
import { Box, Paper, Typography, Alert } from '@mui/material';
import { useParams } from 'react-router-dom';
import API from '../api';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

export default function PublicNoteViewer() {
  const { id } = useParams();
  const [note, setNote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadNote = async () => {
      try {
        const res = await API.get(`/notes/public/${id}`);
        setNote(res.data);
      } catch (e) {
        console.error(e);
        setError(e.response?.data?.message || 'Note not found or not publicly accessible');
      } finally {
        setLoading(false);
      }
    };
    loadNote();
  }, [id]);

  if (loading) return <Typography>Loading...</Typography>;
  
  if (error) {
    return (
      <Paper sx={{ p: 3, mt: 4 }}>
        <Alert severity="error">{error}</Alert>
      </Paper>
    );
  }

  return (
    <Paper sx={{ p: 3, mt: 4 }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h4" gutterBottom>
          {note.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Last updated: {new Date(note.updatedAt).toLocaleString()}
        </Typography>
      </Box>

      <Box sx={{ border: '1px solid #e0e0e0', borderRadius: 1, p: 2 }}>
        <ReactQuill 
          value={note.content || ''} 
          readOnly={true}
          theme="bubble"
          style={{ border: 'none' }}
        />
      </Box>
      
      <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
        This is a public note. Anyone with this link can view it.
      </Typography>
    </Paper>
  );
}
