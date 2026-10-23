import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  Button, 
  Card,
  CardContent,
  CardActions,
  Grid,
  Skeleton,
  Fade,
  Alert
} from '@mui/material';
import { 
  OpenInNew,
  AccessTime,
  Public
} from '@mui/icons-material';
import API from '../api';
import { useNavigate } from 'react-router-dom';

export default function PublicNotesList() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const fetchPublicNotes = async () => {
    try {
      const res = await API.get('/notes/public');
      setNotes(res.data);
      setError('');
    } catch (e) {
      console.error('Error fetching public notes:', e);
      setError('Failed to load public notes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPublicNotes();
  }, []);

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now - date) / (1000 * 60 * 60);
    
    if (diffInHours < 24) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffInHours < 168) {
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
            <Public sx={{ mr: 1, verticalAlign: 'middle' }} />
            Public Notes
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {loading ? 'Loading...' : `${notes.length} public note${notes.length !== 1 ? 's' : ''}`}
          </Typography>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : notes.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            No public notes available yet
          </Typography>
        </Paper>
      ) : (
        <Fade in={!loading}>
          <Grid container spacing={3}>
            {notes.map((note) => (
              <Grid item xs={12} sm={6} md={4} key={note._id}>
                <Card 
                  sx={{ 
                    height: '100%', 
                    display: 'flex', 
                    flexDirection: 'column',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease',
                    '&:hover': {
                      transform: 'translateY(-4px)',
                      boxShadow: 3
                    }
                  }}
                  onClick={() => navigate(`/notes/public/${note._id}`)}
                >
                  <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="h6" fontWeight={600} sx={{ flex: 1, pr: 1 }}>
                        {note.title}
                      </Typography>
                      <Public sx={{ fontSize: 20, color: 'primary.main', flexShrink: 0 }} />
                    </Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                      {getContentPreview(note.content)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <AccessTime sx={{ fontSize: 16 }} />
                      {formatDate(note.updatedAt)}
                    </Typography>
                  </CardContent>
                  <CardActions sx={{ pt: 0 }}>
                    <Button 
                      size="small" 
                      color="primary"
                      endIcon={<OpenInNew />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/notes/public/${note._id}`);
                      }}
                    >
                      View
                    </Button>
                  </CardActions>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Fade>
      )}
    </Box>
  );
}
