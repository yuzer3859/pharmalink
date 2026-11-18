/**
 * Work 140: a short two-note chime for a new prescription request, made with the Web Audio API so
 * there is no sound file to load. Browsers allow it once the person has interacted with the page
 * (signing in counts); where sound is blocked or unsupported it does nothing.
 */
let context: AudioContext | null = null;

export function playChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    context ??= new Ctx();
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime;
    [880, 1318.5].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const t = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch {
    // No sound is not an error: the banner and the badge still show.
  }
}
