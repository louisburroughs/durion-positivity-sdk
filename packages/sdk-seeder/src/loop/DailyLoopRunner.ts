import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import { CustomerPool } from '../support/CustomerPool';
import { ReferenceCache } from '../support/ReferenceCache';
import { SeederRandom } from '../support/SeederRandom';
import { CustomerEventSimulator } from './CustomerEventSimulator';
import { InventoryMaintenanceSimulator } from './InventoryMaintenanceSimulator';
import { ShiftSimulator } from './ShiftSimulator';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DailyLoopRunner {
  private readonly random: SeederRandom;
  private readonly customerPool: CustomerPool;

  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
    private readonly refs: ReferenceCache,
  ) {
    this.random = new SeederRandom(config.seed);
    this.customerPool = new CustomerPool();
  }

  async run(): Promise<void> {
    const shift = new ShiftSimulator(this.config, this.auth, this.refs);
    const inventory = new InventoryMaintenanceSimulator(this.config, this.auth, this.refs);
    const simulator = new CustomerEventSimulator(
      this.config,
      this.auth,
      this.refs,
      this.random,
      this.customerPool,
    );

    for (let day = 1; day <= this.config.days; day += 1) {
      await this.auth.refreshIfNeeded();
      console.log(`[Day ${day}/${this.config.days}] Virtual day starting — real time: ${new Date().toISOString()}`);

      await shift.clockIn();

      const numCustomers = this.random.int(
        this.config.minCustomersPerDay,
        this.config.maxCustomersPerDay,
      );
      let completed = 0;
      let declined = 0;
      let errors = 0;

      for (let customerIndex = 1; customerIndex <= numCustomers; customerIndex += 1) {
        const status = await simulator.simulate(day, customerIndex);
        const customerId = simulator.lastCustomerId ?? 'unknown';
        console.log(`[Day ${day}] Customer ${customerIndex}/${numCustomers}: ${status} — ${customerId}`);

        if (status === 'completed') {
          completed += 1;
        } else if (status === 'declined') {
          declined += 1;
        } else if (status === 'error') {
          errors += 1;
        }
      }

      await shift.clockOut();
      await shift.approveTimeEntries();

      if (day % 7 === 0) {
        await inventory.runCycleCount();
      }

      if (day % 30 === 0) {
        await inventory.runMonthlyRestock();
      }

      console.log(
        `[Day ${day}] Complete — ${completed} workorders, ${declined} declined, ${errors} errors. Sleeping ${this.config.sleepBetweenDaysMs}ms.`,
      );

      if (day < this.config.days) {
        await sleep(this.config.sleepBetweenDaysMs);
      }
    }
  }
}
