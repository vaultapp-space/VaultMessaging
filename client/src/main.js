import './app.css'
import App from './App.svelte'
import { mount } from 'svelte'


const app = mount(App, {
  target: document.getElementById('app'),
})

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker registered successfully:', reg.scope))
      .catch(err => console.error('Service Worker registration failed:', err));
  });
}

// Suppress the browser's automatic "Add to Home Screen" / install mini-infobar.
// There's no in-app install button today, so there's nothing constructive for
// the deferred prompt to do — this just stops it popping up unprompted.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
});

export default app
