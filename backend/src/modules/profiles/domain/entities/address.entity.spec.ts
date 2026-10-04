import { Address } from './address.entity';
import { AddressLabel } from '../enums';

const ADDIS_ABABA = { lat: 9.03, lng: 38.74 };
const OUTSIDE_ETHIOPIA = { lat: -1.286389, lng: 36.817223 }; // Nairobi, Kenya

function validInput(overrides: Partial<Parameters<typeof Address.create>[2]> = {}) {
  return {
    recipientName: 'Abebe Kebede',
    recipientPhone: '+251912345678',
    city: 'Addis Ababa',
    region: 'Addis Ababa',
    lat: ADDIS_ABABA.lat,
    lng: ADDIS_ABABA.lng,
    ...overrides,
  };
}

describe('Address', () => {
  it('creates a valid address with defaults', () => {
    const address = Address.create('addr-1', 'user-1', validInput());
    expect(address.toProps().label).toBe(AddressLabel.HOME);
    expect(address.isDefault).toBe(false);
    expect(address.toProps().isWithinEthiopia).toBe(true);
  });

  it('rejects coordinates outside Ethiopia outright', () => {
    expect(() =>
      Address.create('addr-1', 'user-1', validInput({ lat: OUTSIDE_ETHIOPIA.lat, lng: OUTSIDE_ETHIOPIA.lng })),
    ).toThrow(expect.objectContaining({ code: 'ADDRESS_OUTSIDE_ETHIOPIA' }));
  });

  it('rejects when neither {region+city} nor addressLine is provided', () => {
    expect(() =>
      Address.create(
        'addr-1',
        'user-1',
        validInput({ region: undefined, city: undefined, addressLine: undefined, landmark: 'Near the big tree' }),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('accepts addressLine alone without region/city', () => {
    const address = Address.create(
      'addr-1',
      'user-1',
      validInput({ region: undefined, city: undefined, addressLine: 'Bole road, house 12' }),
    );
    expect(address.toProps().addressLine).toBe('Bole road, house 12');
  });

  it('applyEdits re-validates the geofence when lat/lng change', () => {
    const address = Address.create('addr-1', 'user-1', validInput());
    expect(() => address.applyEdits({ lat: OUTSIDE_ETHIOPIA.lat, lng: OUTSIDE_ETHIOPIA.lng })).toThrow(
      expect.objectContaining({ code: 'ADDRESS_OUTSIDE_ETHIOPIA' }),
    );
  });

  it('applyEdits re-validates the locator rule when clearing addressLine with no region/city', () => {
    const address = Address.create(
      'addr-1',
      'user-1',
      validInput({ region: undefined, city: undefined, addressLine: 'Bole road, house 12' }),
    );
    expect(() => address.applyEdits({ addressLine: null })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('clearDefault throws DEFAULT_ADDRESS_REQUIRED when currently default', () => {
    const address = Address.create('addr-1', 'user-1', validInput());
    address.markDefault();
    expect(() => address.clearDefault()).toThrow(
      expect.objectContaining({ code: 'DEFAULT_ADDRESS_REQUIRED' }),
    );
  });

  it('clearDefault is a no-op when not currently default', () => {
    const address = Address.create('addr-1', 'user-1', validInput());
    expect(() => address.clearDefault()).not.toThrow();
  });

  it('softDelete sets deletedAt', () => {
    const address = Address.create('addr-1', 'user-1', validInput());
    address.softDelete();
    expect(address.deletedAt).not.toBeNull();
  });
});
