import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import { CustomerPool } from '../support/CustomerPool';
import { Logger } from '../support/Logger';
import { ReferenceCache } from '../support/ReferenceCache';
import { SeederRandom } from '../support/SeederRandom';
import { VirtualClock } from '../support/VirtualClock';
import { CustomerEventSimulator } from './CustomerEventSimulator';
import { InventoryMaintenanceSimulator } from './InventoryMaintenanceSimulator';
import { ShiftSimulator } from './ShiftSimulator';

/**
 * Returns the start-of-day (midnight UTC) for a given Date.
 */
function startOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export class DailyLoopRunner {
  private readonly random: SeederRandom;
  private readonly customerPool: CustomerPool;

  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
    private readonly refs: ReferenceCache,
    private readonly virtualClock: VirtualClock,
    private readonly logger: Logger,
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

    // Fetch initial virtual time from backend — this is day 1's baseline
    let currentVT = await this.virtualClock.getCurrentVirtualTime();
    this.logger.setVirtualTime(currentVT);
    this.logger.setScale(this.virtualClock.getLastScale());

    for (let day = 1; day <= this.config.days; day += 1) {
      const dayStart = startOfDayUTC(currentVT);
      this.logger.setDay(day, this.config.days);
      this.logger.daySeparator();

      // Refresh auth token
      await this.auth.refreshIfNeeded();

      // Refresh virtual time at start of each day's work
      currentVT = await this.virtualClock.getCurrentVirtualTime();
      this.logger.setVirtualTime(currentVT);

      this.logger.setPhase('SHIFT-IN');
      this.logger.info(`Virtual day starting — VT date: ${currentVT.toISOString().slice(0, 10)}`);

      await shift.clockIn();
      this.logger.info('Employees clocked in');

      this.logger.setPhase('CUSTOMER');
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
        const customerName = simulator.lastCustomerName ?? 'unknown';

        // Refresh VT after each customer for accurate logging
        currentVT = await this.virtualClock.getCurrentVirtualTime();
        this.logger.setVirtualTime(currentVT);

        this.logger.info(`Customer ${customerIndex}/${numCustomers}: ${status} — ${customerName} (${customerId})`);

        if (status === 'completed') {
          completed += 1;
        } else if (status === 'declined') {
          declined += 1;
        } else if (status === 'error') {
          errors += 1;
        }
      }

      this.logger.setPhase('SHIFT-OUT');
      await shift.clockOut();
      await shift.approveTimeEntries();
      this.logger.info('Shift ended, time entries approved');

      if (day % 7 === 0) {
        this.logger.setPhase('MAINTENANCE');
        await inventory.runCycleCount();
        this.logger.info('Weekly cycle count completed');
      }

      if (day % 30 === 0) {
        this.logger.setPhase('MAINTENANCE');
        await inventory.runMonthlyRestock(currentVT);
        this.logger.info('Monthly restock completed');
      }

      this.logger.setPhase('COMPLETE');
      currentVT = await this.virtualClock.getCurrentVirtualTime();
      this.logger.setVirtualTime(currentVT);
      this.logger.info(
        `Day done — ${completed} workorders, ${declined} declined, ${errors} errors`,
      );

      // Wait for backend virtual time to cross into the next calendar day
      if (day < this.config.days) {
        this.logger.setPhase('WAIT');
        this.logger.info(`Waiting for backend clock to reach next day (${dayStart.toISOString().slice(0, 10)} → next)...`);
        currentVT = await this.virtualClock.waitForNextDay(dayStart);
        this.logger.setVirtualTime(currentVT);
      }
    }

    this.logger.daySeparator();
    this.logger.setPhase('COMPLETE');
    this.logger.info(`All ${this.config.days} virtual days completed.`);
  }
}
