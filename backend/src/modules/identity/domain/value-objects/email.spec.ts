import { Email } from './email';

describe('Email', () => {
  it('normalizes to lowercase', () => {
    expect(Email.create('User@Example.com').value).toBe('user@example.com');
  });

  it('rejects malformed input', () => {
    expect(() => Email.create('not-an-email')).toThrow();
    expect(() => Email.create('missing@domain')).toThrow();
  });

  it('masks for display', () => {
    expect(Email.create('user@example.com').masked()).toBe('us***@example.com');
  });
});
