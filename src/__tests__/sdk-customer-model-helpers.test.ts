import { instanceOfVehicleSummary } from '../../packages/sdk-customer/src/models/VehicleSummary';

describe('sdk-customer model helpers: VehicleSummary', () => {
  it('accepts valid partial vehicle summaries', () => {
    expect(instanceOfVehicleSummary({})).toBe(true);
    expect(
      instanceOfVehicleSummary({
        vehicleId: 'veh-123',
        vin: '1HGCM82633A004352',
        licensePlate: 'ABC123',
        make: 'Honda',
        model: 'Accord',
        year: 2024,
      }),
    ).toBe(true);
  });

  it('rejects non-object values and arrays', () => {
    expect(instanceOfVehicleSummary(null as unknown as object)).toBe(false);
    expect(instanceOfVehicleSummary([] as unknown as object)).toBe(false);
    expect(instanceOfVehicleSummary('vehicle' as unknown as object)).toBe(false);
  });

  it('rejects objects with incorrectly typed fields', () => {
    expect(instanceOfVehicleSummary({ vehicleId: 123 } as unknown as object)).toBe(false);
    expect(instanceOfVehicleSummary({ year: '2024' } as unknown as object)).toBe(false);
    expect(instanceOfVehicleSummary({ vin: true } as unknown as object)).toBe(false);
  });
});
