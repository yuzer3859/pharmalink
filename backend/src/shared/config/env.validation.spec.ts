import 'reflect-metadata';
import { EnvironmentVariables, validateEnv } from './env.validation';

/**
 * `PORT` boot-time validation, through the real `validateEnv` path.
 *
 * Regression for the staging rehearsal (Work 57): `PORT = 3000;` had no type annotation, so its
 * decorator metadata type was `Object`, implicit conversion left the environment string alone,
 * and `@IsInt` rejected every value — even `PORT=3000`. Environment variables are always strings.
 */
describe('PORT environment validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'access-secret-0123456789',
    JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
    MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };

  it('declares a numeric metadata type, so implicit conversion applies', () => {
    expect(Reflect.getMetadata('design:type', EnvironmentVariables.prototype, 'PORT')).toBe(Number);
  });

  it('converts and accepts the string form an environment variable always has', () => {
    const config = validateEnv({ ...base, PORT: '3000' });
    expect(config.PORT).toBe(3000);
    expect(typeof config.PORT).toBe('number');
    expect(validateEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(validateEnv({ ...base, PORT: '0' }).PORT).toBe(0);
  });

  it('defaults to 3000 when PORT is omitted', () => {
    const config = validateEnv(base);
    expect(config.PORT).toBe(3000);
    expect(typeof config.PORT).toBe('number');
  });

  it.each([
    ['non-numeric', 'abc'],
    ['fractional', '3000.5'],
    ['negative', '-1'],
  ])('rejects a %s value (%s)', (_label, value) => {
    expect(() => validateEnv({ ...base, PORT: value })).toThrow(/Invalid environment configuration: .*PORT/);
  });
});
