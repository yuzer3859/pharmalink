import { useEffect, useId, useRef, useState } from 'react'
import { Search as SearchIcon, TrendingUp } from 'lucide-react'
import ProductImage from './ProductImage'
import { Input } from './ui'
import { cn } from '../lib/utils'
import { SUGGEST_MIN_LENGTH } from '../search/searchService'
import { t } from '../auth/strings'

export const SUGGEST_DEBOUNCE_MS = 150

/**
 * Work 159: the search box with suggestions while typing (Work 158's `GET /search/suggest`).
 * An ARIA combobox: arrow keys move through the list, Enter picks, Escape closes. Suggestions
 * are asked for only after the customer types, and a failure just shows none.
 */
export default function SearchSuggestBox({ value, onChange, onPick, suggest, label, placeholder }) {
  const listId = useId()
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const typed = useRef(false)

  useEffect(() => {
    if (!typed.current) return undefined
    const text = value.trim()
    if (text.length < SUGGEST_MIN_LENGTH) {
      setItems([])
      return undefined
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      suggest(text, { signal: controller.signal })
        .then((found) => {
          setItems(found)
          setActive(-1)
        })
        .catch((error) => error?.code !== 'ABORTED' && setItems([]))
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value, suggest])

  const shown = open && items.length > 0

  function pick(item) {
    setOpen(false)
    setItems([])
    typed.current = false
    onPick(item)
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1))
    } else if (e.key === 'Enter' && shown && active >= 0) {
      e.preventDefault()
      pick(items[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <Input
        type="search"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        icon={SearchIcon}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          typed.current = true
          setOpen(true)
          onChange(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('search.suggestions')}
          className="absolute z-30 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-border bg-surface p-1 shadow-lg"
        >
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${item.id ?? item.text}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Picking happens on mousedown so the box's blur doesn't close the list first.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(item)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2', i === active && 'bg-brand-50')}
            >
              {item.kind === 'QUERY' ? (
                <TrendingUp className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
              ) : (
                <ProductImage src={item.imageUrl} iconSize="h-4 w-4" className="h-9 w-9 shrink-0 rounded-lg" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-fg">{item.text}</span>
                {item.kind === 'QUERY' ? (
                  <span className="block text-caption text-muted">{t('search.suggest.popular')}</span>
                ) : (
                  item.subtitle && <span className="block truncate text-caption text-muted" lang="am">{item.subtitle}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
