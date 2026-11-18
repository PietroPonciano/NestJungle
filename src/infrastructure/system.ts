import type { Clock, IdGenerator } from '../application/ports/system';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUID v7 nativo do Bun: ordenável por tempo, bom para índices B-tree. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
