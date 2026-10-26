import { describe, expect, it } from 'vitest';
import { describeWeeklyHours, parseOpeningHours } from './opening-hours';

const read = (t: string) => {
  const w = parseOpeningHours(t);
  return w ? describeWeeklyHours(w) : null;
};

describe('parseOpeningHours', () => {
  it('reads the way people write opening hours', () => {
    expect(read('Mon-Fri 8:30-17:30, closed weekends')).toBe('Mon-Fri 08:30-17:30; closed otherwise');
    expect(read('Monday to Friday 9am - 5.30pm')).toBe('Mon-Fri 09:00-17:30; closed otherwise');
    expect(read('Mon-Fri 9-5; Sat 9-12')).toBe('Mon-Fri 09:00-17:00; Sat 09:00-12:00; closed otherwise');
    expect(read('Weekdays 08:00-12:00, 13:00-17:00, Saturday 10am-2pm, Sunday closed')).toBe(
      'Mon-Fri 08:00-12:00, 13:00-17:00; Sat 10:00-14:00; closed otherwise',
    );
    expect(read('Open daily from 7 to 11pm')).toBe('Mon-Sun 07:00-23:00; closed otherwise');
    expect(read('Mon, Wed & Fri 9-1')).toBe('Mon 09:00-13:00; Wed 09:00-13:00; Fri 09:00-13:00; closed otherwise');
  });

  it('gives up (a person decides) on anything it cannot read for certain', () => {
    expect(parseOpeningHours('normal hours but later on Thursdays')).toBeNull();
    expect(parseOpeningHours('Mon-Fri')).toBeNull();
    expect(parseOpeningHours('Mon-Fri 9-5, Mon 6-8')).toBeNull(); // Monday twice
    expect(parseOpeningHours('Mon-Fri 9-5 except bank holidays')).toBeNull();
    expect(parseOpeningHours('Fri-Mon 9-5')).toBeNull(); // backwards range
    expect(parseOpeningHours('Mon 17-9')).toBeNull();
    expect(parseOpeningHours('closed')).toBeNull();
    expect(parseOpeningHours('')).toBeNull();
  });
});
