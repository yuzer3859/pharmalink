import { useEffect, useState } from 'react'

/** Seconds left on a backend-provided cooldown; `start(n)` restarts it. */
export function useCountdown() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (seconds <= 0) return undefined
    const timer = setTimeout(() => setSeconds((s) => Math.max(0, s - 1)), 1000)
    return () => clearTimeout(timer)
  }, [seconds])
  return [seconds, (next) => setSeconds(Math.max(0, Math.ceil(next || 0)))]
}
