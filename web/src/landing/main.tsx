import React from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './Landing';
// Inter, self-hosted, the same four weights the auth screens set: the landing and
// the screen behind "Back to Website" are one surface, and a page that loaded its
// type from someone else's CDN would also be telling a visitor about privacy while
// announcing them to a third party.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '../styles/tokens.css';
import './landing.css';

// deliberately not './styles.css': the app's stylesheet is for the app, and this
// page shares the palette with it rather than the rules

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in landing.html');

createRoot(root).render(
  <React.StrictMode>
    <Landing />
  </React.StrictMode>,
);
