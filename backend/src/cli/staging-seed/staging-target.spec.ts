import { databaseNameOf, STAGING_DATABASE_NAME, stagingTargetRefusal } from './staging-target';

const STAGING_URL = `postgresql://pharmalink:pw@postgres:5432/${STAGING_DATABASE_NAME}?schema=public`;

describe('stagingTargetRefusal (Work 80)', () => {
  it('accepts the staging database before and after the live check', () => {
    expect(stagingTargetRefusal({ nodeEnv: 'development', databaseUrl: STAGING_URL, currentDatabase: null })).toBeNull();
    expect(
      stagingTargetRefusal({ nodeEnv: 'development', databaseUrl: STAGING_URL, currentDatabase: STAGING_DATABASE_NAME }),
    ).toBeNull();
  });

  it.each(['production', 'PRODUCTION', ' production '])('refuses NODE_ENV=%p', (nodeEnv) => {
    expect(stagingTargetRefusal({ nodeEnv, databaseUrl: STAGING_URL, currentDatabase: null })).toMatch(/production/);
  });

  it('refuses the test environment', () => {
    expect(stagingTargetRefusal({ nodeEnv: 'test', databaseUrl: STAGING_URL, currentDatabase: null })).toMatch(/test/);
  });

  it.each([
    ['postgresql://u:p@h:5432/pharmalink?schema=public', /"pharmalink"/],
    ['postgresql://u:p@h:5432/pharmalink_staging_copy', /"pharmalink_staging_copy"/],
    ['postgresql://u:p@h:5432/pharmalink_e2e', /"pharmalink_e2e"/],
    ['mysql://u:p@h/pharmalink_staging', /not a PostgreSQL URL/],
    ['', /not set/],
  ])('refuses DATABASE_URL %p', (databaseUrl, expected) => {
    expect(stagingTargetRefusal({ nodeEnv: 'development', databaseUrl, currentDatabase: null })).toMatch(expected);
  });

  it('refuses when the live connection reached a different database than the URL names', () => {
    expect(
      stagingTargetRefusal({ nodeEnv: 'development', databaseUrl: STAGING_URL, currentDatabase: 'postgres' }),
    ).toMatch(/reached the database "postgres"/);
  });

  it('never echoes credentials or the host in a refusal', () => {
    const refusal = stagingTargetRefusal({
      nodeEnv: 'development',
      databaseUrl: 'postgresql://secret-user:secret-pass@db.internal:5432/other',
      currentDatabase: null,
    });
    expect(refusal).not.toMatch(/secret|db\.internal/);
  });

  it('reads the database name only', () => {
    expect(databaseNameOf(STAGING_URL)).toBe(STAGING_DATABASE_NAME);
    expect(databaseNameOf('postgres://h/x%20y')).toBe('x y');
    expect(databaseNameOf('not a url')).toBeNull();
  });
});
