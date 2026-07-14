// ============================================================
// Vault — Web Audio API Call Ringtone Synthesizer
// Zero external assets dependency. Programmatic chimes and tones.
// ============================================================

let audioCtx = null;
let currentSounds = [];
let loopActive = false;
let activeTimeout = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

export function playOutgoingCallSound() {
  stopCallSounds();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  loopActive = true;

  const playPulse = () => {
    if (!loopActive) return;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc1.frequency.value = 440;
    osc2.frequency.value = 480;

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(ctx.destination);

    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.15, ctx.currentTime + 1.2);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.4);

    osc1.start();
    osc2.start();

    osc1.stop(ctx.currentTime + 1.4);
    osc2.stop(ctx.currentTime + 1.4);

    currentSounds.push(osc1, osc2, gainNode);

    activeTimeout = setTimeout(() => {
      if (loopActive) playPulse();
    }, 3000);
  };

  playPulse();
}

export function playIncomingCallSound() {
  stopCallSounds();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  loopActive = true;
  const notes = [
    { f: 523.25, d: 0.15 }, // C5
    { f: 659.25, d: 0.15 }, // E5
    { f: 783.99, d: 0.15 }, // G5
    { f: 1046.50, d: 0.3 }  // C6
  ];

  const playMelody = () => {
    if (!loopActive) return;
    let timeOffset = 0;

    notes.forEach(note => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.value = note.f;

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      gainNode.gain.setValueAtTime(0, ctx.currentTime + timeOffset);
      gainNode.gain.linearRampToValueAtTime(0.12, ctx.currentTime + timeOffset + 0.02);
      gainNode.gain.setValueAtTime(0.12, ctx.currentTime + timeOffset + note.d - 0.05);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + timeOffset + note.d);

      osc.start(ctx.currentTime + timeOffset);
      osc.stop(ctx.currentTime + timeOffset + note.d);

      currentSounds.push(osc, gainNode);
      timeOffset += note.d + 0.05;
    });

    activeTimeout = setTimeout(() => {
      if (loopActive) playMelody();
    }, 2500);
  };

  playMelody();
}

export function stopCallSounds() {
  loopActive = false;
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  currentSounds.forEach(node => {
    try {
      node.disconnect();
    } catch {}
    try {
      node.stop();
    } catch {}
  });
  currentSounds = [];
}
