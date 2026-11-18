/** Relógio e gerador de ids injetáveis: o domínio recebe datas e ids prontos. */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUID v7 (ordenável por tempo; bom para índices B-tree). */
  next(): string;
}
