import { describe, expect, test } from 'vitest';
import {
  Canceled,
  CodeRejected,
  CodeTimeout,
  CodeUnavailable,
  ProtocolError,
  QueryRejected,
  RouteNotFound,
  TargetNotAllowed,
  Timeout,
  isRetryable,
  queryErrorForCode,
} from '../src/astral/index.js';

// isRetryable is true only for the causes a repeat can cure: the next hop was
// unreachable (7) or the query was not answered in time.
describe('isRetryable', () => {
  test('unavailable and timeout are retryable', () => {
    expect(isRetryable(new QueryRejected(CodeUnavailable))).toBe(true);
    expect(isRetryable(new QueryRejected(CodeTimeout))).toBe(true);
    expect(isRetryable(new Timeout('timeout'))).toBe(true);
    expect(isRetryable(queryErrorForCode('timeout'))).toBe(true);
  });

  test('a missing route, a refusal and a policy block are not', () => {
    expect(isRetryable(new QueryRejected(CodeRejected))).toBe(false);
    expect(isRetryable(new QueryRejected(9))).toBe(false);
    expect(isRetryable(new RouteNotFound())).toBe(false);
    expect(isRetryable(queryErrorForCode('route_not_found'))).toBe(false);
    expect(isRetryable(new TargetNotAllowed('target_not_allowed'))).toBe(false);
    expect(isRetryable(new Canceled('canceled'))).toBe(false);
    expect(isRetryable(new ProtocolError('bad'))).toBe(false);
    expect(isRetryable(new Error('other'))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
