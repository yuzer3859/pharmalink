import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  configErrorMessage,
  createAdminConfigService,
  flagKeyProblem,
  formatConfigValue,
  normalizeFlagKey,
  parseConfigInput,
} from './adminConfig.service';
import type { SessionRequest } from './auth.service';

const of = (valueType: 'BOOLEAN' | 'INTEGER' | 'DECIMAL' | 'STRING' | 'JSON', extra: Partial<{ min: number; max: number; allowed: string[] }> = {}) => ({
  valueType,
  min: extra.min ?? null,
  max: extra.max ?? null,
  allowed: extra.allowed ?? null,
});

describe('parseConfigInput', () => {
  it('booleans: exactly true or false', () => {
    expect(parseConfigInput(of('BOOLEAN'), 'true')).toEqual({ ok: true, value: true });
    expect(parseConfigInput(of('BOOLEAN'), ' false ')).toEqual({ ok: true, value: false });
    expect(parseConfigInput(of('BOOLEAN'), 'yes').ok).toBe(false);
  });

  it('integers: whole numbers within min and max', () => {
    const setting = of('INTEGER', { min: 1, max: 60 });
    expect(parseConfigInput(setting, '30')).toEqual({ ok: true, value: 30 });
    expect(parseConfigInput(setting, '2.5')).toEqual({ ok: false, error: 'Enter a whole number.' });
    expect(parseConfigInput(setting, '0')).toEqual({ ok: false, error: 'Must be at least 1.' });
    expect(parseConfigInput(setting, '61')).toEqual({ ok: false, error: 'Must be at most 60.' });
    expect(parseConfigInput(setting, '').ok).toBe(false);
    expect(parseConfigInput(setting, '1e3').ok).toBe(false);
  });

  it('decimals: numbers within the range', () => {
    expect(parseConfigInput(of('DECIMAL', { max: 100 }), '12.5')).toEqual({ ok: true, value: 12.5 });
    expect(parseConfigInput(of('DECIMAL', { max: 100 }), '100.01').ok).toBe(false);
    expect(parseConfigInput(of('DECIMAL'), 'abc').ok).toBe(false);
  });

  it('strings: non-empty, and one of the allowed values when the catalogue lists them', () => {
    expect(parseConfigInput(of('STRING'), ' hello ')).toEqual({ ok: true, value: 'hello' });
    expect(parseConfigInput(of('STRING'), '  ').ok).toBe(false);
    const enumSetting = of('STRING', { allowed: ['PHOTO', 'SIGNATURE'] });
    expect(parseConfigInput(enumSetting, 'PHOTO')).toEqual({ ok: true, value: 'PHOTO' });
    expect(parseConfigInput(enumSetting, 'OTP')).toEqual({ ok: false, error: 'Must be one of: PHOTO, SIGNATURE.' });
  });

  it('JSON: anything that parses', () => {
    expect(parseConfigInput(of('JSON'), '{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parseConfigInput(of('JSON'), '{a:1}').ok).toBe(false);
  });

  it('JSON with allowed values: a list of distinct allowed names (Work 82)', () => {
    const list = of('JSON', { allowed: ['A', 'B'] });
    expect(parseConfigInput(list, '["A", "B"]')).toEqual({ ok: true, value: ['A', 'B'] });
    expect(parseConfigInput(list, '[]')).toEqual({ ok: true, value: [] });
    expect(parseConfigInput(list, '["C"]').ok).toBe(false);
    expect(parseConfigInput(list, '["A", "A"]').ok).toBe(false);
    expect(parseConfigInput(list, '{"A": true}').ok).toBe(false);
    expect(parseConfigInput(of('JSON', { allowed: [] }), '["A"]')).toEqual({ ok: false, error: 'No values are allowed yet; enter [].' });
  });
});

describe('formatConfigValue', () => {
  it('round-trips through parseConfigInput', () => {
    expect(formatConfigValue('INTEGER', 30)).toBe('30');
    expect(formatConfigValue('BOOLEAN', false)).toBe('false');
    expect(formatConfigValue('STRING', null)).toBe('');
    const json = { a: [1, 2] };
    expect(parseConfigInput(of('JSON'), formatConfigValue('JSON', json))).toEqual({ ok: true, value: json });
  });
});

describe('adminConfigService', () => {
  it('reads settings, history and flags; publishes, rolls back and toggles at the right paths', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminConfigService(request as unknown as SessionRequest);

    await svc.list();
    expect(request).toHaveBeenLastCalledWith('/admin/config', { method: 'GET' });
    await svc.history('orders', 'cancel window');
    expect(request).toHaveBeenLastCalledWith('/admin/config/orders/cancel%20window/history', { method: 'GET' });
    await svc.update('orders', 'cancelWindowMinutes', 'INTEGER', 15, '  Ops request ');
    expect(request).toHaveBeenLastCalledWith('/admin/config/orders/cancelWindowMinutes', {
      method: 'PUT',
      body: { valueType: 'INTEGER', value: 15, reason: 'Ops request' },
    });
    await svc.rollback('orders', 'cancelWindowMinutes', 3, '   ');
    expect(request).toHaveBeenLastCalledWith('/admin/config/orders/cancelWindowMinutes/rollback', { method: 'POST', body: { toVersion: 3 } });
    await svc.flags();
    expect(request).toHaveBeenLastCalledWith('/admin/feature-flags', { method: 'GET' });
    await svc.toggleFlag('cod.enabled', false);
    expect(request).toHaveBeenLastCalledWith('/admin/feature-flags/cod.enabled', { method: 'PUT', body: { enabled: false } });
  });

  it('never sends an actor or version of its own', async () => {
    const request = vi.fn().mockResolvedValue({});
    await createAdminConfigService(request as unknown as SessionRequest).update('a', 'b', 'BOOLEAN', true);
    const body = request.mock.calls[0][1].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['value', 'valueType']);
  });
});

describe('configErrorMessage', () => {
  it('maps permission and unknown-setting errors, and passes validation messages through', () => {
    expect(configErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'f')).toMatch(/not allowed/);
    expect(configErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'), 'f')).toMatch(/not governable/);
    expect(configErrorMessage(new ApiError(400, 'CONFIG_VALIDATION_FAILED', 'Must be at most 60'), 'f')).toBe('Must be at most 60');
    expect(configErrorMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});

describe('feature flag keys (the server rule)', () => {
  it('normalizes like the server: trimmed and lower-cased', () => {
    expect(normalizeFlagKey('  COD_Payments ')).toBe('cod_payments');
  });

  it('accepts a lowercase identifier and refuses everything else', () => {
    expect(flagKeyProblem('cod_payments')).toBeNull();
    expect(flagKeyProblem(' COD_Payments ')).toBeNull();
    expect(flagKeyProblem('   ')).toMatch(/Enter a key/);
    expect(flagKeyProblem('1st_flag')).toMatch(/starting with a letter/);
    expect(flagKeyProblem('cod-payments')).toMatch(/underscores/);
    expect(flagKeyProblem('cod payments')).toMatch(/underscores/);
    expect(flagKeyProblem('a'.repeat(101))).toMatch(/At most 100/);
  });

  it('refuses a key that already exists, so adding never silently toggles one', () => {
    expect(flagKeyProblem('COD_PAYMENTS', ['cod_payments'])).toMatch(/already exists/);
  });
});

describe('createFlag', () => {
  it('PUTs the normalized key with the initial state, and the description only when given', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminConfigService(request as unknown as SessionRequest);
    await svc.createFlag(' COD_Payments ', false, '  Cash on delivery at checkout ');
    expect(request).toHaveBeenLastCalledWith('/admin/feature-flags/cod_payments', {
      method: 'PUT',
      body: { enabled: false, description: 'Cash on delivery at checkout' },
    });
    await svc.createFlag('beta', true, '   ');
    expect(request).toHaveBeenLastCalledWith('/admin/feature-flags/beta', { method: 'PUT', body: { enabled: true } });
  });
});
