import { errorEnvelope, successEnvelope } from './envelope';
import { ErrorCode } from './error-codes';

describe('response envelope', () => {
  it('builds a success envelope', () => {
    const env = successEnvelope({ id: 'x' }, 'req-1');
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ id: 'x' });
    expect(env.error).toBeNull();
    expect(env.meta.requestId).toBe('req-1');
    expect(typeof env.meta.timestamp).toBe('string');
  });

  it('builds an error envelope', () => {
    const env = errorEnvelope(
      { code: ErrorCode.NOT_FOUND, message: 'nope' },
      'req-2',
    );
    expect(env.success).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error).toEqual({ code: ErrorCode.NOT_FOUND, message: 'nope' });
    expect(env.meta.requestId).toBe('req-2');
  });
});
