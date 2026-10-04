const configuredBackendUrl = import.meta.env.VITE_API_BASE_URL?.trim();

export const API_BASE_URL = (configuredBackendUrl || 'http://localhost:3000').replace(/\/+$/, '');
