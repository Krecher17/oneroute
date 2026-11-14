import 'maplibre-gl/dist/maplibre-gl.css';
import './legacy/legacy.css';
import './styles/app.css';
import { createRoot } from 'react-dom/client';
import { i18nReady } from './i18n';
import { initSentry } from './lib/sentry';
import { installApiBase } from './lib/network';
import { App } from './App';

initSentry();
installApiBase();
// Render once the saved language is loaded, so the first screen is already in the right language.
void i18nReady.then(() => createRoot(document.getElementById('root')!).render(<App />));
