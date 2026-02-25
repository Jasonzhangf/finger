import { describe, it, expect, beforeEach } from 'vitest';
import { ntpTime } from '../../../src/core/ntp-time.js';

describe('NtpTimeProvider', () => {
  beforeEach(() => {
    // Reset offset to 0 before each test
    ntpTime.setOffset(0);
  });

  describe('getCorrectedTime', () => {
    it('should return time info with all fields', () => {
      const time = ntpTime.getCorrectedTime();
      
      expect(time).toHaveProperty('utc');
      expect(time).toHaveProperty('local');
      expect(time).toHaveProperty('tz');
      expect(time).toHaveProperty('nowMs');
      expect(time).toHaveProperty('ntpOffsetMs');
      
      expect(time.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(typeof time.nowMs).toBe('number');
      expect(typeof time.ntpOffsetMs).toBe('number');
    });

    it('should return current timestamp in milliseconds', () => {
      const time = ntpTime.getCorrectedTime();
      const now = Date.now();
      
      // Should be within 1 second of current time (accounting for NTP offset)
      expect(Math.abs(time.nowMs - now)).toBeLessThan(1000);
    });
  });

  describe('getRawTime', () => {
    it('should return uncorrected time', () => {
      const rawTime = ntpTime.getRawTime();
      const now = Date.now();
      
      // Raw time should be exactly current time (within test execution time)
      expect(Math.abs(rawTime.nowMs - now)).toBeLessThan(100);
    });
  });

  describe('setOffset', () => {
    it('should set NTP offset', () => {
      const testOffset = 12345;
      ntpTime.setOffset(testOffset);
      
      const time = ntpTime.getCorrectedTime();
      expect(time.ntpOffsetMs).toBe(testOffset);
      
      // Reset to zero
      ntpTime.setOffset(0);
    });
  });

  describe('getOffset', () => {
    it('should return current offset', () => {
      expect(ntpTime.getOffset()).toBe(0);
      
      ntpTime.setOffset(5000);
      expect(ntpTime.getOffset()).toBe(5000);
      
      ntpTime.setOffset(0);
    });
  });
});
