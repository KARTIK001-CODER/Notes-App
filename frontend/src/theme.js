import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    primary: { main: '#6a11cb' },
    secondary: { main: '#2575fc' },
    background: { default: '#0f1724' },
    text: { primary: '#e6eef8' }
  },
  components: {
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: 'linear-gradient(90deg,#6a11cb,#2575fc)'
        }
      }
    }
  },
  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif'
  }
});

export default theme;
