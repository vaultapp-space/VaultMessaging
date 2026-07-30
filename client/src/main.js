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

export default app
