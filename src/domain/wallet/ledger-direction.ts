/**
 * Direção de um lançamento no ledger.
 *
 * Invariantes:
 *  - Espelha o CHECK `direction IN ('DEBIT','CREDIT')` de wallet_ledger_entries.
 *  - CREDIT soma ao saldo e DEBIT subtrai (ck_ledger_balanced no banco).
 *  - Um ROLLBACK lança na direção INVERSA da transação revertida
 *    (`invertDirection`), o que desfaz exatamente o efeito dela.
 */
export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
