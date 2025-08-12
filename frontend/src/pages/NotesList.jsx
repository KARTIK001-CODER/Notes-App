import React, { useEffect, useState } from 'react';
import { Box, Paper, Typography, Button, List, ListItem, ListItemText, IconButton } from '@mui/material';
import { Add, Delete } from '@mui/icons-material';
import API from '../api';
import { Link } from 'react-router-dom';

export default function NotesList() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchNotes = async () => {
    try {
      const res = await API.get('/notes');
      setNotes(res.data);
    } catch (e) {
      console.error(e);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchNotes(); }, []);

  const createNote = async () => {
    const res = await API.post('/notes', { title: 'New Note' });
    window.location.href = `/notes/${res.data._id}`;
  };

  const deleteNote = async (id) => {
    if (!confirm('Delete this note?')) return;
    await API.delete(`/notes/${id}`);
    setNotes(n => n.filter(x => x._id !== id));
  };

  return (
    <Paper sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h5">Your Notes</Typography>
        <Button variant="contained" startIcon={<Add />} onClick={createNote}>New Note</Button>
      </Box>

      {loading ? (
        <Typography>Loading...</Typography>
      ) : (
        <List>
          {notes.map(note => (
            <ListItem key={note._id}
                      secondaryAction={
                        <IconButton edge="end" onClick={() => deleteNote(note._id)}><Delete/></IconButton>
                      }
                      component={Link}
                      to={`/notes/${note._id}`}
                      sx={{ textDecoration: 'none' }}>
              <ListItemText primary={note.title} secondary={new Date(note.updatedAt).toLocaleString()} />
            </ListItem>
          ))}
        </List>
      )}
    </Paper>
  );
}
