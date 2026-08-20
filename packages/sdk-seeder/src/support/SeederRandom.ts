import { Faker, en } from '@faker-js/faker';

export class SeederRandom {
  private readonly faker: Faker;

  constructor(seed?: number) {
    this.faker = new Faker({ locale: [en] });
    if (seed !== undefined) {
      this.faker.seed(seed);
    }
  }

  firstName(): string {
    return this.faker.person.firstName();
  }

  lastName(): string {
    return this.faker.person.lastName();
  }

  email(first: string, last: string): string {
    return this.faker.internet.email({ firstName: first, lastName: last });
  }

  phone(): string {
    return this.faker.phone.number({ style: 'national' });
  }

  vin(): string {
    return this.faker.vehicle.vin();
  }

  vehicleYear(): number {
    return this.faker.number.int({ min: 2008, max: 2024 });
  }

  vehicleMake(): string {
    return this.faker.vehicle.manufacturer();
  }

  vehicleModel(): string {
    return this.faker.vehicle.model();
  }

  price(min: number, max: number): number {
    return this.faker.number.float({ min, max, fractionDigits: 2 });
  }

  int(min: number, max: number): number {
    return this.faker.number.int({ min, max });
  }

  pickOne<T>(arr: T[]): T {
    return this.faker.helpers.arrayElement(arr);
  }

  pickN<T>(arr: T[], n: number): T[] {
    return this.faker.helpers.arrayElements(arr, n);
  }

  chance(probability: number): boolean {
    return this.faker.datatype.boolean({ probability });
  }

  licensePlate(): string {
    return this.faker.string.alphanumeric(7).toUpperCase();
  }

  base64(length: number): string {
    return Buffer.from(this.faker.string.alphanumeric(length), 'utf8').toString('base64');
  }

  sentence(): string {
    return this.faker.lorem.sentence();
  }
}
