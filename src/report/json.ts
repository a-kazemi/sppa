/** Stable JSON envelope for both commands. Safe to pipe into other tools. */

const SCHEMA_VERSION = 1;

export interface JsonEnvelope<T> {
  tool: 'sppa';
  schemaVersion: number;
  command: string;
  generatedAt: string;
  site: string;
  result: T;
}

export function toJsonEnvelope<T>(command: string, site: string, result: T): JsonEnvelope<T> {
  return {
    tool: 'sppa',
    schemaVersion: SCHEMA_VERSION,
    command,
    generatedAt: new Date().toISOString(),
    site,
    result,
  };
}

export function renderJson<T>(envelope: JsonEnvelope<T>): string {
  return JSON.stringify(envelope, null, 2);
}
