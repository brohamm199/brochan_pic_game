// Tiny synthesized sound effects (no audio files needed).
const Sfx = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('wp-muted') === '1'; } catch {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, { type = 'sine', vol = 0.18, slide = 0 } = {}) {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  return {
    unlock: ac,
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('wp-muted', muted ? '1' : '0'); } catch {}
      return muted;
    },
    join() { tone(660, 0, 0.12, { type: 'triangle' }); tone(990, 0.08, 0.16, { type: 'triangle' }); },
    start() { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.09, 0.22, { type: 'square', vol: 0.08 })); },
    newPhoto() { tone(300, 0, 0.25, { type: 'sawtooth', vol: 0.06, slide: 500 }); },
    lock() { tone(1200, 0, 0.06, { type: 'square', vol: 0.05 }); },
    tick(urgent) { tone(urgent ? 1000 : 800, 0, 0.07, { type: 'square', vol: 0.06 }); },
    reveal() {
      tone(392, 0, 0.18, { type: 'triangle' });
      tone(523, 0.12, 0.18, { type: 'triangle' });
      tone(784, 0.24, 0.45, { type: 'triangle', vol: 0.22 });
    },
    whoosh() { tone(200, 0, 0.35, { type: 'sine', vol: 0.08, slide: 900 }); },
    fanfare() {
      const notes = [523, 523, 523, 659, 784, 659, 784, 1046];
      const times = [0, 0.15, 0.3, 0.45, 0.7, 0.95, 1.1, 1.3];
      notes.forEach((f, i) => tone(f, times[i], i === notes.length - 1 ? 0.8 : 0.18, { type: 'square', vol: 0.07 }));
    },
  };
})();
