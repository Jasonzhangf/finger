import { describe, it, expect } from 'vitest';
import {
  validateUserSettings,
  loadLedgerSettings,
  getContextWindow,
  getCompressTokenThreshold,
  type UserSettings,
  type LedgerSettings,
} from '../../../src/core/user-settings.js';

/**
 * Helper: build minimal valid settings with optional ledger overrides
 */
function buildSettings(ledgerOverrides?: Partial<LedgerSettings>): UserSettings {
  return {
    version: '1.0',
    updated_at: new Date().toISOString(),
    aiProviders: {
      default: 'test',
      providers: {
        test: {
          name: 'test',
          base_url: 'http://localhost:1234/v1',
          wire_api: 'http',
          env_key: 'TEST_KEY',
          model: 'test-model',
          enabled: true,
        },
      },
    },
    preferences: {
      defaultModel: 'test-model',
      maxTokens: 256000,
      temperature: 0.7,
      thinkingEnabled: true,
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
      verbosity: 'medium',
      webSearch: 'live',
    },
    ui: {
      theme: 'dark',
      language: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    },
    ledger: ledgerOverrides ? { ...{ contextWindow: 262144, compressTokenThreshold: 222822 }, ...ledgerOverrides } : undefined as unknown as LedgerSettings,
  } as unknown as UserSettings;
}

describe('user-settings ledger configuration', () => {
  describe('validateUserSettings ledger validation', () => {
    it('should add default ledger settings when ledger is missing', () => {
      const settings = buildSettings(); // no ledger field
      validateUserSettings(settings);
      expect(settings.ledger).toBeDefined();
      expect(settings.ledger.contextWindow).toBe(262144);
      expect(settings.ledger.compressTokenThreshold).toBe(222822);
    });

    it('should auto-calculate compressTokenThreshold when only contextWindow is set', () => {
      const settings = buildSettings({ contextWindow: 128000 });
      // Delete compressTokenThreshold to test auto-calculation
      delete (settings as any).ledger.compressTokenThreshold;
      validateUserSettings(settings);
      expect(settings.ledger.contextWindow).toBe(128000);
      expect(settings.ledger.compressTokenThreshold).toBe(Math.floor(128000 * 0.85)); // 108800
    });

    it('should preserve custom ledger settings', () => {
      const settings = buildSettings({ contextWindow: 100000, compressTokenThreshold: 80000 });
      validateUserSettings(settings);
      expect(settings.ledger.contextWindow).toBe(100000);
      expect(settings.ledger.compressTokenThreshold).toBe(80000);
    });

    it('should reject non-positive contextWindow', () => {
      const settings = buildSettings({ contextWindow: -100, compressTokenThreshold: 200 });
      expect(() => validateUserSettings(settings)).toThrow('ledger.contextWindow must be a positive number');
    });

    it('should reject non-positive compressTokenThreshold', () => {
      const settings = buildSettings({ contextWindow: 128000, compressTokenThreshold: 0 });
      expect(() => validateUserSettings(settings)).toThrow('ledger.compressTokenThreshold must be a positive number');
    });

    it('should reject non-number contextWindow', () => {
      const settings = buildSettings({ contextWindow: 'invalid' as any, compressTokenThreshold: 200 });
      expect(() => validateUserSettings(settings)).toThrow('ledger.contextWindow must be a positive number');
    });
  });

  describe('loadLedgerSettings', () => {
    it('should return ledger settings from defaults', () => {
      // Note: this reads from actual ~/.finger/config/user-settings.json
      // If it doesn't have ledger, defaults will be applied
      const ledger = loadLedgerSettings();
      expect(ledger.contextWindow).toBeGreaterThan(0);
      expect(ledger.compressTokenThreshold).toBeGreaterThan(0);
      expect(ledger.compressTokenThreshold).toBeLessThanOrEqual(ledger.contextWindow);
    });
  });

  describe('getContextWindow', () => {
    it('should return a positive number', () => {
      const ctxWindow = getContextWindow();
      expect(typeof ctxWindow).toBe('number');
      expect(ctxWindow).toBeGreaterThan(0);
    });
  });

  describe('getCompressTokenThreshold', () => {
    it('should return threshold less than or equal to context window', () => {
      const threshold = getCompressTokenThreshold();
      const ctxWindow = getContextWindow();
      expect(threshold).toBeLessThanOrEqual(ctxWindow);
      expect(threshold).toBeGreaterThan(0);
    });
  });

  describe('LedgerSettings interface contract', () => {
    it('should require contextWindow and compressTokenThreshold as numbers', () => {
      const valid: LedgerSettings = {
        contextWindow: 262144,
        compressTokenThreshold: 222822,
      };
      expect(typeof valid.contextWindow).toBe('number');
      expect(typeof valid.compressTokenThreshold).toBe('number');
    });
  });
});
