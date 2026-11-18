/**
 * Work 141: the sound (and vibration) when a delivery offer appears, as in ride-hailing apps.
 * Made with the Web Audio API, so there is no sound file. Browsers only let a page play sound after
 * the person has touched it, so `unlockSound()` runs on the "Go online" tap; where sound is still
 * blocked or unsupported, nothing plays and the offer card shows as usual.
 */
let context = null

function audioContext() {
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext ?? window.webkitAudioContext) : undefined
  if (!Ctx) return null
  context ??= new Ctx()
  return context
}

/** Call from a tap, so later offers can sound. */
export function unlockSound() {
  try {
    const ctx = audioContext()
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined)
  } catch {
    // No sound is not an error.
  }
}

/** Three rising notes, twice, and a buzz where the phone can vibrate. */
export function playOfferAlert() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200])
    const ctx = audioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    const notes = [660, 880, 1100]
    for (let rep = 0; rep < 2; rep += 1) {
      notes.forEach((frequency, i) => {
        const t = ctx.currentTime + rep * 0.7 + i * 0.14
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.value = frequency
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t)
        osc.stop(t + 0.3)
      })
    }
  } catch {
    // No sound is not an error.
  }
}

/** The offers not seen at the last check: the ones that should sound. */
export function newOfferIds(seen, offers) {
  return (offers ?? []).map((o) => o.offerId).filter((id) => !seen.has(id))
}
