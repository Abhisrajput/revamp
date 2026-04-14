import { circuitBreaker, ConsecutiveBreaker, handleAll, CircuitBreakerPolicy } from 'cockatiel';

const breakers = new Map<string, CircuitBreakerPolicy>();

/**
 * Get or create a circuit breaker for a provider.
 * One breaker per provider name — tracks consecutive failures.
 * Opens after 3 consecutive failures, half-opens after 30s.
 */
export function getCircuitBreaker(providerName: string): CircuitBreakerPolicy {
  let breaker = breakers.get(providerName);
  if (!breaker) {
    breaker = circuitBreaker(handleAll, {
      halfOpenAfter: 30_000,
      breaker: new ConsecutiveBreaker(3),
    });
    breakers.set(providerName, breaker);
  }
  return breaker;
}

/** Reset all circuit breakers (useful for testing) */
export function resetCircuitBreakers(): void {
  breakers.clear();
}
