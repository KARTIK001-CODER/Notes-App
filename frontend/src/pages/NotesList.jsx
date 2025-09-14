import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  Button, 
  Card,
  CardContent,
  CardActions,
  IconButton,
  Chip,
  Grid,
  Skeleton,
  Fade,
  Tooltip
} from '@mui/material';
import { 
  Add, 
  Delete, 
  Edit,
  Public,
  Lock,
  AccessTime,
  MoreVert
} from '@mui/icons-material';
import API from '../api';
import { Link, useNavigate } from 'react-router-dom';

export default function NotesList() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

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
    try {
    const res = await API.post('/notes', { title: 'New Note' });
      navigate(`/notes/${res.data._id}`);
    } catch (e) {
      console.error('Error creating note:', e);
    }
  };

  const deleteNote = async (id, event) => {
    event.stopPropagation();
    if (!confirm('Delete this note?')) return;
    try {
    await API.delete(`/notes/${id}`);
    setNotes(n => n.filter(x => x._id !== id));
    } catch (e) {
      console.error('Error deleting note:', e);
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now - date) / (1000 * 60 * 60);
    
    if (diffInHours < 24) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffInHours < 168) { // 7 days
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const getContentPreview = (content) => {
    if (!content) return 'No content yet...';
    const textContent = content.replace(/<[^>]*>/g, '');
    return textContent.length > 100 ? textContent.substring(0, 100) + '...' : textContent;
  };

  const LoadingSkeleton = () => (
    <Grid container spacing={3}>
      {[...Array(6)].map((_, index) => (
        <Grid item xs={12} sm={6} md={4} key={index}>
          <Card>
            <CardContent>
              <Skeleton variant="text" height={32} />
              <Skeleton variant="text" height={20} width="60%" />
              <Skeleton variant="text" height={16} width="80%" />
              <Skeleton variant="text" height={16} width="40%" />
            </CardContent>
            <CardActions>
              <Skeleton variant="rectangular" height={36} width={100} />
            </CardActions>
          </Card>
        </Grid>
      ))}
    </Grid>
  );

  return (
    <Box>
      <Box sx={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        mb: 4,
        flexWrap: 'wrap',
        gap: 2
      }}>
        <Box>
          <Typography variant="h4" fontWeight={700} color="text.primary">
            Your Notes
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {loading ? 'Loading...' : `${notes.length} note${notes.length !== 1 ? 's' : ''}`}
          </Typography>
        </Box>
        <Button 
          variant="contained" 
          startIcon={<Add />} 
          onClick={createNote}
          size="large"
          sx={{
            borderRadius: 2,
            px: 3,
            py: 1.5,
            textTransform: 'none',
            fontWeight: 600
          }}
        >
          New Note
        </Button>
      </Box>

      {loading ? (
        <LoadingSkeleton />
      ) : notes.length === 0 ? (
        <Paper 
          sx={{ 
            p: 6, 
            textAlign: 'center',
            background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
            borderRadius: 3
          }}
        >
          <Box sx={{ mb: 3 }}>
            <Edit sx={{ fontSize: 64, color: 'text.secondary', opacity: 0.5 }} />
          </Box>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No notes yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Create your first note to get started with collaborative editing
          </Typography>
          <Button variant="contained" startIcon={<Add />} onClick={createNote}>
            Create Note
          </Button>
        </Paper>
      ) : (
        <Grid container spacing={3}>
          {notes.map((note, index) => (
            <Grid item xs={12} sm={6} md={4} key={note._id}>
              <Fade in timeout={300 + index * 100}>
                <Card 
                  sx={{ 
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease-in-out',
                    '&:hover': {
                      transform: 'translateY(-4px)',
                      boxShadow: '0px 8px 25px -5px rgba(0, 0, 0, 0.1)',
                    }
                  }}
                  onClick={() => navigate(`/notes/${note._id}`)}
                >
                  <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
                      <Typography 
                        variant="h6" 
                        fontWeight={600}
                        sx={{ 
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          lineHeight: 1.3
                        }}
                      >
                        {note.title || 'Untitled'}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 0.5, ml: 1 }}>
                        {note.isPublic ? (
                          <Tooltip title="Public">
                            <Public sx={{ fontSize: 16, color: 'success.main' }} />
                          </Tooltip>
                        ) : (
                          <Tooltip title="Private">
                            <Lock sx={{ fontSize: 16, color: 'text.secondary' }} />
                          </Tooltip>
                        )}
                      </Box>
                    </Box>
                    
                    <Typography 
                      variant="body2" 
                      color="text.secondary"
                      sx={{ 
                        mb: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        lineHeight: 1.4
                      }}
                    >
                      {getContentPreview(note.content)}
                    </Typography>
                    
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      <AccessTime sx={{ fontSize: 14, color: 'text.secondary' }} />
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(note.updatedAt)}
                      </Typography>
                    </Box>
                  </CardContent>
                  
                  <CardActions sx={{ px: 2, pb: 2, pt: 0 }}>
                    <Button 
                      size="small" 
                      startIcon={<Edit />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/notes/${note._id}`);
                      }}
                    >
                      Edit
                    </Button>
                    <Box sx={{ flexGrow: 1 }} />
                    <Tooltip title="Delete note">
                      <IconButton 
                        size="small" 
                        onClick={(e) => deleteNote(note._id, e)}
                        sx={{ color: 'error.main' }}
                      >
                        <Delete />
                      </IconButton>
                    </Tooltip>
                  </CardActions>
                </Card>
              </Fade>
            </Grid>
          ))}
        </Grid>
      )}
    </Box>
  );
}
