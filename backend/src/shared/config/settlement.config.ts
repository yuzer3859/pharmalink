import { registerAs } from '@nestjs/config';

/**
 * Work 97: when a pharmacy's settlement statement is generated automatically (owner's decision,
 * 2026-11-07). A statement is generated when either trigger is met, whichever comes first:
 *
 *  - **amount:** the pharmacy's unsettled payable has reached `autoRunMinAmount` santim;
 *  - **period:** `autoRunPeriodDays` days have passed since the pharmacy's last statement (or,
 *    for its first, since its oldest unsettled posting).
 *
 * `0` switches a trigger off; with both at `0` nothing is generated automatically, and finance
 * runs statements by hand as before. Generating a statement moves no money: approval and payout
 * still need two finance officers (maker-checker, NFR-SEC-06).
 *
 * Both are editable at runtime through Module 16's system configuration (`settlement.*`).
 */
export const SETTLEMENT_AUTO_RUN_MIN_AMOUNT_ENV = 'SETTLEMENT_AUTO_RUN_MIN_AMOUNT';
export const SETTLEMENT_AUTO_RUN_PERIOD_DAYS_ENV = 'SETTLEMENT_AUTO_RUN_PERIOD_DAYS';

/** 10,000 ETB in santim. */
export const DEFAULT_SETTLEMENT_AUTO_RUN_MIN_AMOUNT = 1_000_000;
export const MIN_SETTLEMENT_AUTO_RUN_MIN_AMOUNT = 0;
/** The widest a money column holds (2^31 − 1 santim). */
export const MAX_SETTLEMENT_AUTO_RUN_MIN_AMOUNT = 2_147_483_647;

/** Weekly. */
export const DEFAULT_SETTLEMENT_AUTO_RUN_PERIOD_DAYS = 7;
export const MIN_SETTLEMENT_AUTO_RUN_PERIOD_DAYS = 0;
/** A quarter: a pharmacy is never left unpaid longer than that by the period trigger. */
export const MAX_SETTLEMENT_AUTO_RUN_PERIOD_DAYS = 92;

/** The runtime configuration keys (`IConfigPort.get`). */
export const SETTLEMENT_AUTO_RUN_MIN_AMOUNT_KEY = 'settlement.autoRunMinAmount';
export const SETTLEMENT_AUTO_RUN_PERIOD_DAYS_KEY = 'settlement.autoRunPeriodDays';

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return Number(raw);
}

export function readSettlementAutoRunMinAmount(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, SETTLEMENT_AUTO_RUN_MIN_AMOUNT_ENV, DEFAULT_SETTLEMENT_AUTO_RUN_MIN_AMOUNT);
}

export function readSettlementAutoRunPeriodDays(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, SETTLEMENT_AUTO_RUN_PERIOD_DAYS_ENV, DEFAULT_SETTLEMENT_AUTO_RUN_PERIOD_DAYS);
}

export const settlementConfig = registerAs('settlement', () => ({
  autoRunMinAmount: readSettlementAutoRunMinAmount(),
  autoRunPeriodDays: readSettlementAutoRunPeriodDays(),
}));
