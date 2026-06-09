/**
 * Qode Telemetry — Shared telemetry and analytics infrastructure.
 */

export class TelemetryClient {
  readonly enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }
}
