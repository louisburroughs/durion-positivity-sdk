import { SeederRandom } from './SeederRandom';

const MAX_POOL_SIZE = 200;
const REPEAT_PROBABILITY = 0.4;

export class CustomerPool {
  private pool: string[] = [];

  add(partyId: string): void {
    this.pool.push(partyId);
    if (this.pool.length > MAX_POOL_SIZE) {
      this.pool.shift();
    }
  }

  pickExisting(random: SeederRandom): string {
    return random.pickOne(this.pool);
  }

  shouldRepeat(random: SeederRandom): boolean {
    return random.chance(REPEAT_PROBABILITY);
  }

  get size(): number {
    return this.pool.length;
  }
}
