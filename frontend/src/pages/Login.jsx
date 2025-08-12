import React, { useState } from 'react';
import { Box, TextField, Button, Paper, Typography } from '@mui/material';
import API from '../api';

export default function Login() {
  const [form, setForm] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');

  const handle = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async () => {
    setErr('');
    try {
      const res = await API.post('/auth/login', form);
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data.user));
      window.location.href = '/';
    } catch (e) {
      setErr(e.response?.data?.message || 'Login error');
    }
  };

  return (
    <Paper sx={{ p: 4, maxWidth: 420, mx: 'auto' }}>
      <Typography variant="h5" mb={2}>Welcome back</Typography>
      {err && <Typography color="error" mb={2}>{err}</Typography>}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField label="Email" name="email" value={form.email} onChange={handle} />
        <TextField label="Password" name="password" type="password" value={form.password} onChange={handle} />
        <Button variant="contained" onClick={submit}>Login</Button>
      </Box>
    </Paper>
  );
}
