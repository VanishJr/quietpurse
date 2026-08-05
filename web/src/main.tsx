import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Inter, self-hosted: the login design is set in it, and a webfont fetched from
// someone else's CDN is a third party on the one screen that handles a password.
// Regular / Medium / Bold, plus the Semi Bold the register frame sets "I agree to
// the Terms & Conditions" in.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// the palette, radii and durations this screen shares with the landing page; the
// app's own colours are the theme's (theme.tsx) and are unaffected
import './styles/tokens.css';
import './styles.css';
import './styles/auth.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in index.html');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
