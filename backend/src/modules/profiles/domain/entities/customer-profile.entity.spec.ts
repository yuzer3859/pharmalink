import { CustomerProfile } from './customer-profile.entity';
import { Gender } from '../enums';

describe('CustomerProfile', () => {
  it('createEmpty starts with fullName null', () => {
    const profile = CustomerProfile.createEmpty('profile-1', 'user-1');
    expect(profile.fullName).toBeNull();
    expect(profile.userId).toBe('user-1');
  });

  it('applyEdits updates fullName/gender and reports changed fields', () => {
    const profile = CustomerProfile.createEmpty('profile-1', 'user-1');
    const changed = profile.applyEdits({ fullName: 'Abebe Kebede', gender: Gender.MALE });
    expect(changed).toEqual(['fullName', 'gender']);
    expect(profile.fullName).toBe('Abebe Kebede');
    expect(profile.gender).toBe(Gender.MALE);
  });

  it('rejects a dateOfBirth in the future', () => {
    const profile = CustomerProfile.createEmpty('profile-1', 'user-1');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(() => profile.applyEdits({ dateOfBirth: tomorrow })).toThrow();
  });

  it('rejects a dateOfBirth implying an age over 120 years', () => {
    const profile = CustomerProfile.createEmpty('profile-1', 'user-1');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const tooOld = new Date('1900-01-01T00:00:00.000Z');
    expect(() => profile.applyEdits({ dateOfBirth: tooOld }, now)).toThrow();
  });

  it('accepts a valid past dateOfBirth', () => {
    const profile = CustomerProfile.createEmpty('profile-1', 'user-1');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const dob = new Date('1990-05-01T00:00:00.000Z');
    const changed = profile.applyEdits({ dateOfBirth: dob }, now);
    expect(changed).toEqual(['dateOfBirth']);
    expect(profile.dateOfBirth).toBe(dob);
  });

  it('returns no changed fields and leaves updatedAt untouched for an empty edit set', () => {
    const profile = CustomerProfile.createEmpty('profile-1', 'user-1');
    const before = profile.toProps().updatedAt;
    const changed = profile.applyEdits({});
    expect(changed).toEqual([]);
    expect(profile.toProps().updatedAt).toBe(before);
  });
});
