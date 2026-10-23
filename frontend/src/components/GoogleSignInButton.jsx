import { useEffect, useRef, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let gisLoadPromise = null;

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${GIS_SCRIPT_SRC}"]`);

    const handleLoad = () => {
      if (window.google?.accounts?.id) {
        resolve();
      } else {
        reject(new Error('Google Identity Services did not initialize'));
      }
    };

    const handleError = () => {
      gisLoadPromise = null;
      reject(new Error('Failed to load Google Identity Services'));
    };

    if (existingScript) {
      existingScript.addEventListener('load', handleLoad, { once: true });
      existingScript.addEventListener('error', handleError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = handleLoad;
    script.onerror = handleError;
    document.head.appendChild(script);
  });

  return gisLoadPromise;
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function GoogleSignInButton({ onCredential, loading = false, disabled = false }) {
  const containerRef = useRef(null);
  const credentialHandlerRef = useRef(onCredential);
  const submittingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const isBusy = loading || disabled;

  useEffect(() => {
    credentialHandlerRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return undefined;

    let cancelled = false;

    loadGoogleIdentityServices()
      .then(() => {
        if (cancelled || !containerRef.current) return;

        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: (response) => {
            if (!response?.credential) {
              setError('Google sign-in did not return a credential.');
              return;
            }
            if (submittingRef.current) return;

            submittingRef.current = true;
            setError('');
            Promise.resolve(credentialHandlerRef.current?.(response.credential))
              .catch(() => setError('Google sign-in failed. Please try again.'))
              .finally(() => {
                submittingRef.current = false;
              });
          }
        });

        containerRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: Math.min(containerRef.current.clientWidth || 400, 400)
        });
        setReady(true);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <Box>
        <Button
          fullWidth
          size="large"
          variant="outlined"
          disabled
          startIcon={<GoogleIcon />}
          sx={{ py: 1.25, borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
        >
          Continue with Google
        </Button>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1, textAlign: 'center' }}
        >
          Google Sign-In is not configured.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ position: 'relative' }}>
        <Box
          ref={containerRef}
          sx={{
            display: isBusy ? 'none' : 'flex',
            justifyContent: 'center',
            minHeight: 40,
            opacity: ready ? 1 : 0.6
          }}
        />
        {isBusy && (
          <Button
            fullWidth
            size="large"
            variant="outlined"
            disabled
            startIcon={loading ? <CircularProgress size={18} /> : <GoogleIcon />}
            sx={{ py: 1.25, borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
          >
            {loading ? 'Signing in with Google...' : 'Continue with Google'}
          </Button>
        )}
      </Box>
      {!ready && !isBusy && !error && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1, textAlign: 'center' }}
        >
          Loading Google Sign-In...
        </Typography>
      )}
      {error && (
        <Typography
          variant="caption"
          color="error.main"
          sx={{ display: 'block', mt: 1, textAlign: 'center' }}
        >
          {error}
        </Typography>
      )}
    </Box>
  );
}
