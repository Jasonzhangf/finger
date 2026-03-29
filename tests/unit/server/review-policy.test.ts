import { describe, expect, it } from 'vitest';
import {
  getActiveReviewPolicy,
  setActiveReviewPolicy,
  shouldAutoReviewDispatch,
} from '../../../src/server/orchestration/review-policy.js';

describe('review-policy', () => {
  it('默认关闭自动 reviewer dispatch', () => {
    setActiveReviewPolicy({ enabled: false, dispatchReviewMode: 'off' });
    expect(shouldAutoReviewDispatch()).toBe(false);
    expect(getActiveReviewPolicy()).toEqual({ enabled: false, dispatchReviewMode: 'off' });
  });

  it('enabled=true 但 dispatchReviewMode=off 时不自动 review', () => {
    setActiveReviewPolicy({ enabled: true, dispatchReviewMode: 'off' });
    expect(shouldAutoReviewDispatch()).toBe(false);
  });

  it('enabled=true 且 dispatchReviewMode=always 时自动 review', () => {
    setActiveReviewPolicy({ enabled: true, dispatchReviewMode: 'always' });
    expect(shouldAutoReviewDispatch()).toBe(true);
  });
});

