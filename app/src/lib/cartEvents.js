// Work 147: tells the top bar that the cart changed (an item added, removed or ordered), so its
// count refreshes without a page reload. A page that has just read the cart passes the item count,
// so the top bar needn't read it again.
const listeners = new Set()

export function onCartChanged(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `count`: the number of items now in the cart, when the caller knows it. */
export function cartChanged(count) {
  for (const listener of listeners) listener(count)
}

/** The number of items in a cart as the API returns it. */
export function cartItemCount(cart) {
  return (cart?.items ?? []).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0)
}
