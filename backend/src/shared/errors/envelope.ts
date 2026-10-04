import { ErrorCode } from './error-codes';

/** Standard response envelope used for EVERY API response (success and error). */
export interface ResponseMeta {
  requestId: string;
  timestamp: string;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  error: null;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  success: false;
  data: null;
  error: ErrorBody;
  meta: ResponseMeta;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function buildMeta(requestId: string): ResponseMeta {
  return { requestId, timestamp: new Date().toISOString() };
}

export function successEnvelope<T>(data: T, requestId: string): SuccessEnvelope<T> {
  return { success: true, data, error: null, meta: buildMeta(requestId) };
}

export function errorEnvelope(error: ErrorBody, requestId: string): ErrorEnvelope {
  return { success: false, data: null, error, meta: buildMeta(requestId) };
}
