import { decodeErrorResult, type Hex } from 'viem';

import { ecimultisig } from '@/abi/ecimultisig';

/**
 * Custom errors thrown by `ECIMultiSig` (mirrors `contracts/ECIMultiSig.sol`).
 * MetaMask cannot decode these — it shows a generic "transaction failed" — so
 * the admin panel decodes them itself during preflight and explains the real
 * reason inline, before anything is sent to the wallet.
 */
export const MULTISIG_REVERT_NAMES = [
  'NotOwner',
  'AlreadyApproved',
  'AlreadyExecuted',
  'ThresholdNotMet',
  'TxNotFound',
  'ExecutionFailed',
  'InvalidSetup'
] as const;

export type MultisigRevertName = (typeof MULTISIG_REVERT_NAMES)[number];

const KNOWN = new Set<string>(MULTISIG_REVERT_NAMES);

function isHexData(value: unknown): value is Hex {
  return typeof value === 'string' && value.startsWith('0x') && value.length >= 10;
}

const META_MESSAGE_PATTERN = /Error:\s*(\w+)\(\)/;

/**
 * Best-effort extraction of an `ECIMultiSig` custom-error name from a viem
 * simulation/write error. viem wraps reverts several layers deep
 * (`ContractFunctionExecutionError` → `ContractFunctionRevertedError` →
 * `CallExecutionError`), and carries the decoded revert in different places:
 * a ready-made `errorName`, a `data: { errorName }` object, raw revert `data`,
 * or an `Error: Name()` line inside `metaMessages`. This walks the whole
 * `cause` chain checking each shape. Returns `null` when the error is not a
 * recognised multisig revert.
 */
export function decodeMultisigRevert(error: unknown): MultisigRevertName | null {
  const seen = new Set<object>();
  const stack: unknown[] = [error];
  const dataCandidates: Hex[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.errorName === 'string' && KNOWN.has(record.errorName)) {
      return record.errorName as MultisigRevertName;
    }
    // viem puts the decoded revert here: data: { abiItem, args, errorName }.
    const nested = record.data;
    if (nested != null && typeof nested === 'object') {
      const nestedName = (nested as Record<string, unknown>).errorName;
      if (typeof nestedName === 'string' && KNOWN.has(nestedName)) {
        return nestedName as MultisigRevertName;
      }
    }
    for (const key of ['data', 'returnData', 'raw'] as const) {
      if (isHexData(record[key])) dataCandidates.push(record[key]);
    }
    const meta = record.metaMessages;
    if (Array.isArray(meta)) {
      for (const entry of meta) {
        if (typeof entry !== 'string') continue;
        const match = META_MESSAGE_PATTERN.exec(entry);
        if (match?.[1] && KNOWN.has(match[1])) return match[1] as MultisigRevertName;
      }
    }
    if (record.cause !== undefined) stack.push(record.cause);
  }
  for (const data of dataCandidates) {
    try {
      const decoded = decodeErrorResult({ abi: ecimultisig, data });
      if (KNOWN.has(decoded.errorName)) return decoded.errorName as MultisigRevertName;
    } catch {
      // Not a multisig error payload — try the next candidate.
    }
  }
  return null;
}

/** i18n message key (under `admin.*`) describing a decoded revert. */
export function multisigRevertMessageKey(name: MultisigRevertName): string {
  switch (name) {
    case 'NotOwner':
      return 'msNotOwner';
    case 'AlreadyApproved':
      return 'msAlreadyApproved';
    case 'AlreadyExecuted':
      return 'msAlreadyExecuted';
    case 'ThresholdNotMet':
      return 'msThresholdNotMet';
    case 'TxNotFound':
      return 'msTxNotFound';
    case 'ExecutionFailed':
      return 'msExecutionFailed';
    case 'InvalidSetup':
      return 'msInvalidSetup';
  }
}
