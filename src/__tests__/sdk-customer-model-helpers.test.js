"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const VehicleSummary_1 = require("../../packages/sdk-customer/src/models/VehicleSummary");
describe('sdk-customer model helpers: VehicleSummary', () => {
    it('accepts valid partial vehicle summaries', () => {
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)({})).toBe(true);
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)({
            vehicleId: 'veh-123',
            vin: '1HGCM82633A004352',
            licensePlate: 'ABC123',
            make: 'Honda',
            model: 'Accord',
            year: 2024,
        })).toBe(true);
    });
    it('rejects non-object values and arrays', () => {
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)(null)).toBe(false);
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)([])).toBe(false);
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)('vehicle')).toBe(false);
    });
    it('rejects objects with incorrectly typed fields', () => {
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)({ vehicleId: 123 })).toBe(false);
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)({ year: '2024' })).toBe(false);
        expect((0, VehicleSummary_1.instanceOfVehicleSummary)({ vin: true })).toBe(false);
    });
});
