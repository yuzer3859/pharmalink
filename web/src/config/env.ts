const configuredBackendUrl = import.meta.env.VITE_API_BASE_URL?.trim();

export const API_BASE_URL = (configuredBackendUrl || 'http://localhost:3000').replace(/\/+$/, '');

/** Work 150: the customer app, which serves the product pictures shipped with it (`/products/…`). */
export const CUSTOMER_APP_URL = (import.meta.env.VITE_CUSTOMER_APP_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
