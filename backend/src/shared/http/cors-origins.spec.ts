import { DEFAULT_WEB_ORIGINS, parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  it('defaults to the operations portal and customer app dev origins', () => {
    expect(parseCorsOrigins(undefined)).toEqual(['http://localhost:5173', 'http://localhost:5174']);
    expect(parseCorsOrigins('  ')).toEqual([...DEFAULT_WEB_ORIGINS]);
  });

  it('uses only the configured origins when WEB_ORIGIN is set', () => {
    expect(parseCorsOrigins('https://app.example.test, https://ops.example.test ,')).toEqual([
      'https://app.example.test',
      'https://ops.example.test',
    ]);
    expect(parseCorsOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it('refuses a wildcard', () => {
    expect(() => parseCorsOrigins('*')).toThrow(/explicit origins/);
    expect(() => parseCorsOrigins('https://app.example.test,*')).toThrow(/explicit origins/);
  });
});
