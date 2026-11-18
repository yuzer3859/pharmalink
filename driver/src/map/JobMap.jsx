import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/**
 * Work 141: the map of where the driver is heading, ride-app style. It shows the destination (the
 * pharmacy until pickup, then the customer) and the driver's own position when the device shares it,
 * framed so both are in view. Tiles are OpenStreetMap's; the "Directions" button beside it opens
 * Google Maps for turn-by-turn navigation when this map is not precise enough.
 *
 * Plain Leaflet rather than a React wrapper: one map per screen, created once and updated in place.
 */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

function pin(kind) {
  const color = kind === 'pickup' ? '#0f766e' : '#d97706'
  const glyph = kind === 'pickup' ? '+' : '⌂'
  return L.divIcon({
    className: '',
    iconSize: [36, 44],
    iconAnchor: [18, 42],
    html: `<div style="position:relative;width:36px;height:44px">
      <div style="position:absolute;left:0;top:0;width:36px;height:36px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};box-shadow:0 2px 6px rgba(0,0,0,.35)"></div>
      <div style="position:absolute;left:0;top:0;width:36px;height:36px;display:grid;place-items:center;color:#fff;font:700 18px/1 system-ui">${glyph}</div>
    </div>`,
  })
}

const ME = L.divIcon({
  className: '',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  html: '<div style="width:22px;height:22px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px rgba(37,99,235,.25)"></div>',
})

export default function JobMap({ target, me, label }) {
  const el = useRef(null)
  const map = useRef(null)
  const targetMarker = useRef(null)
  const meMarker = useRef(null)
  const framed = useRef('')

  useEffect(() => {
    if (!el.current || map.current) return undefined
    map.current = L.map(el.current, { zoomControl: false, attributionControl: true }).setView([target.lat, target.lng], 15)
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map.current)
    L.control.zoom({ position: 'bottomright' }).addTo(map.current)
    return () => {
      map.current?.remove()
      map.current = null
      targetMarker.current = null
      meMarker.current = null
      framed.current = ''
    }
    // Created once; the effects below keep it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!map.current) return
    const icon = pin(target.kind)
    if (!targetMarker.current) targetMarker.current = L.marker([target.lat, target.lng], { icon, title: label }).addTo(map.current)
    else targetMarker.current.setLatLng([target.lat, target.lng]).setIcon(icon)
  }, [target.lat, target.lng, target.kind, label])

  useEffect(() => {
    if (!map.current) return
    if (me) {
      if (!meMarker.current) meMarker.current = L.marker([me.lat, me.lng], { icon: ME, title: 'You', zIndexOffset: 1000 }).addTo(map.current)
      else meMarker.current.setLatLng([me.lat, me.lng])
    } else if (meMarker.current) {
      meMarker.current.remove()
      meMarker.current = null
    }
    // Frame the destination (and the driver, once known) when the destination changes or the driver
    // first appears; after that the driver can pan and zoom freely.
    const key = `${target.kind}:${target.lat},${target.lng}:${me ? 'me' : ''}`
    if (framed.current === key) return
    framed.current = key
    if (me) map.current.fitBounds(L.latLngBounds([me.lat, me.lng], [target.lat, target.lng]), { padding: [48, 48], maxZoom: 16 })
    else map.current.setView([target.lat, target.lng], 15)
  }, [me?.lat, me?.lng, target.lat, target.lng, target.kind])

  return <div ref={el} className="h-full w-full" role="img" aria-label={`Map: ${label}`} />
}
