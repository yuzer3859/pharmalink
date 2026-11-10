import { useEffect, useRef, useState } from 'react'
import { dataUrlToArtifact } from './proof'

/**
 * Work 122: the customer signs with a finger. On "Use signature" the drawing goes up as a small PNG
 * (white background, well under the artifact limit). A device without canvas support says so.
 */
export default function SignaturePad({ onChange }) {
  const canvasRef = useRef(null)
  const drawing = useRef(false)
  const [drawn, setDrawn] = useState(false)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!ctx) {
      setSupported(false)
      return
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#0f172a'
  }, [])

  const point = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = canvasRef.current.width / rect.width
    const scaleY = canvasRef.current.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  function start(e) {
    const ctx = canvasRef.current?.getContext?.('2d')
    if (!ctx) return
    drawing.current = true
    const p = point(e)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }
  function move(e) {
    if (!drawing.current) return
    const ctx = canvasRef.current.getContext('2d')
    const p = point(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    setDrawn(true)
  }
  function end() {
    drawing.current = false
  }
  function clear() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    setDrawn(false)
    onChange(null)
  }
  function use() {
    onChange(dataUrlToArtifact(canvasRef.current.toDataURL('image/png')))
  }

  if (!supported) return <p className="text-sm text-slate-600">Signing is not available on this device; take a photo instead.</p>
  return (
    <div className="grid gap-2">
      <canvas
        ref={canvasRef}
        width={600}
        height={220}
        aria-label="Signature pad"
        className="h-36 w-full touch-none rounded-lg border border-slate-300 bg-white"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={clear} className="rounded-lg border border-slate-300 py-2 text-sm font-semibold">Clear</button>
        <button type="button" disabled={!drawn} onClick={use} className="rounded-lg bg-slate-800 py-2 text-sm font-semibold text-white disabled:opacity-50">Use signature</button>
      </div>
    </div>
  )
}
