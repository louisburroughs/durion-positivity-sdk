import { refusedDecisions } from './acceleratedPorts';

describe('refusedDecisions', () => {
  it('is empty when every entry asked about was approved', () => {
    const response = {
      results: [
        { timeEntryId: 'te-1', success: true, message: 'Time entry approved' },
        { timeEntryId: 'te-2', success: true },
      ],
    };

    expect(refusedDecisions(response, ['te-1', 'te-2'])).toEqual([]);
  });

  it('names the entries a 200 batch refused, with their codes', () => {
    const response = {
      results: [
        { timeEntryId: 'te-1', success: true },
        { timeEntryId: 'te-2', success: false, errorCode: 'ENTRY_NOT_PENDING', message: 'not pending' },
      ],
    };

    expect(refusedDecisions(response, ['te-1', 'te-2'])).toEqual(['te-2 (ENTRY_NOT_PENDING: not pending)']);
  });

  it('counts an entry with no result as refused', () => {
    expect(refusedDecisions({ results: [] }, ['te-1'])).toEqual(['te-1 (no result)']);
    expect(refusedDecisions({}, ['te-1'])).toEqual(['te-1 (no result)']);
  });
});
