import { useState } from 'react'
import { Pill } from 'lucide-react'
import { cn } from '../lib/utils'
import { safeImageUrl } from '../catalog/images'

/**
 * Work 147: a product picture that fades in once loaded, zooms gently on hover when `zoom` is set
 * (inside a `group`), and falls back to a soft placeholder when there is no picture or it fails to
 * load. Decorative by default (`alt=""`): the product's name is always written next to it.
 */
export default function ProductImage({ src, alt = '', className, zoom = false, eager = false, iconSize = 'h-8 w-8' }) {
  const url = safeImageUrl(src)
  const [state, setState] = useState(url ? 'loading' : 'none')
  return (
    <div className={cn('relative overflow-hidden bg-gradient-to-br from-brand-50 to-accent-50 dark:from-brand-900/30 dark:to-accent-700/20', className)}>
      {(state === 'none' || state === 'error') && (
        <div className="absolute inset-0 grid place-items-center text-brand-500/70" data-testid="image-placeholder">
          <Pill className={iconSize} aria-hidden="true" />
        </div>
      )}
      {state === 'loading' && <div className="skeleton absolute inset-0 rounded-none" aria-hidden="true" />}
      {url && state !== 'error' && (
        <img
          src={url}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
          className={cn(
            'h-full w-full object-cover transition-all duration-700 ease-out',
            state === 'ready' ? 'scale-100 opacity-100' : 'scale-105 opacity-0',
            zoom && 'group-hover:scale-110',
          )}
        />
      )}
    </div>
  )
}
