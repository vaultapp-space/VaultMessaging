// ============================================================
// Vault — Web Audio API Call Ringtone Synthesizer
// Zero external assets dependency. Programmatic dials and chimes.
// ============================================================

let audioCtx = null;
let currentSounds = [];

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

  // Outgoing call: two oscillators (440Hz and 480Hz) pulsing together
  let active = true;

  const playPulse = () => {
    if (!active) return;
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

    // Pulse repeats every 3 seconds
    setTimeout(() => {
      if (active) playPulse();
    }, 3000);
  };

  playPulse();

  return {
    stop: () => {
      active = false;
      stopCallSounds();
    }
  };
}

export function playIncomingCallSound() {
  stopCallSounds();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  // Incoming call: sweet synthesized melody
  let active = true;
  const notes = [
    { f: 523.25, d: 0.15 }, // C5
    { f: 659.25, d: 0.15 }, // E5
    { f: 783.99, d: 0.15 }, // G5
    { f: 1046.50, d: 0.3 }  // C6
  ];

  const playMelody = () => {
    if (!active) return;
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

    // Repeat melody loop every 2.5 seconds
    setTimeout(() => {
      if (active) playMelody();
    }, 2500);
  };

  playMelody();

  return {
    stop: () => {
      active = false;
      stopCallSounds();
    }
  };
}

export function stopCallSounds() {
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
