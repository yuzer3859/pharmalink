import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AddressForm } from '../pages/Checkout'

// Work 105: the backend requires an address's map location, so the form asks for it before saving.
function fill() {
  fireEvent.change(screen.getByLabelText('Recipient name'), { target: { value: 'Selam' } })
  fireEvent.change(screen.getByLabelText('Recipient phone'), { target: { value: '+251911000111' } })
  fireEvent.change(screen.getByLabelText('Street and building'), { target: { value: 'Bole Road 12' } })
}

describe('new delivery address (Work 105)', () => {
  it('saves with the shared location', async () => {
    const orders = { addAddress: vi.fn().mockResolvedValue({ id: 'a-1' }) }
    const onSaved = vi.fn()
    render(<AddressForm orders={orders} onSaved={onSaved} locate={() => Promise.resolve({ lat: 8.995, lng: 38.79 })} />)
    fill()
    expect(screen.getByRole('button', { name: 'Save address' }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }))
    await waitFor(() => expect(screen.getByText('Location shared for this address.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'a-1' }))
    expect(orders.addAddress).toHaveBeenCalledWith({
      recipientName: 'Selam', recipientPhone: '+251911000111', city: 'Addis Ababa', addressLine: 'Bole Road 12', lat: 8.995, lng: 38.79,
    })
  })

  it('explains a refused location and does not save', async () => {
    const orders = { addAddress: vi.fn() }
    render(<AddressForm orders={orders} onSaved={() => undefined} locate={() => Promise.resolve(null)} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }))
    await waitFor(() => expect(screen.getByText(/Your location is unavailable/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save address' }).disabled).toBe(true)
    expect(orders.addAddress).not.toHaveBeenCalled()
  })
})
