import { encodeErrorResult } from 'viem';
import { describe, expect, it } from 'vitest';

import { ecimultisig } from '@/abi/ecimultisig';
import { decodeMultisigRevert, multisigRevertMessageKey } from './multisig-errors';

function revertData(name: 'NotOwner' | 'ThresholdNotMet' | 'AlreadyApproved'): `0x${string}` {
  return encodeErrorResult({ abi: ecimultisig, errorName: name });
}

describe('decodeMultisigRevert', () => {
  it('reads a ready-made errorName off the error chain', () => {
    expect(decodeMultisigRevert({ errorName: 'ThresholdNotMet' })).toBe('ThresholdNotMet');
    expect(
      decodeMultisigRevert({ message: 'execution reverted', cause: { errorName: 'NotOwner' } })
    ).toBe('NotOwner');
  });

  it('decodes raw revert data buried in nested causes', () => {
    const data = revertData('ThresholdNotMet');
    expect(
      decodeMultisigRevert({ message: 'reverted', cause: { cause: { data } } })
    ).toBe('ThresholdNotMet');
  });

  it('prefers the multisig payload when several data blobs are present', () => {
    expect(
      decodeMultisigRevert({ data: '0xdeadbeef', cause: { data: revertData('AlreadyApproved') } })
    ).toBe('AlreadyApproved');
  });

  it('reads viem-style data objects and raw revert payloads', () => {
    expect(
      decodeMultisigRevert({ cause: { data: { abiItem: {}, args: [], errorName: 'AlreadyExecuted' } } })
    ).toBe('AlreadyExecuted');
    expect(decodeMultisigRevert({ cause: { raw: revertData('NotOwner') } })).toBe('NotOwner');
  });

  it('reads viem metaMessages like "Error: ThresholdNotMet()"', () => {
    expect(
      decodeMultisigRevert({ metaMessages: ['Error: ThresholdNotMet()', ''] })
    ).toBe('ThresholdNotMet');
    expect(decodeMultisigRevert({ metaMessages: ['Error: Nope()'] })).toBeNull();
  });

  it('ignores unknown error names and undecodable data', () => {
    expect(decodeMultisigRevert({ errorName: 'SomeOtherError' })).toBeNull();
    expect(decodeMultisigRevert({ data: '0xdeadbeef' })).toBeNull();
    expect(decodeMultisigRevert(null)).toBeNull();
    expect(decodeMultisigRevert(new Error('boom'))).toBeNull();
  });

  it('does not loop on cyclic error objects', () => {
    const cyclic: Record<string, unknown> = { message: 'cycle' };
    cyclic.cause = cyclic;
    expect(decodeMultisigRevert(cyclic)).toBeNull();
  });
});

describe('multisigRevertMessageKey', () => {
  it('maps every known revert to an admin message key', () => {
    expect(multisigRevertMessageKey('NotOwner')).toBe('msNotOwner');
    expect(multisigRevertMessageKey('AlreadyApproved')).toBe('msAlreadyApproved');
    expect(multisigRevertMessageKey('AlreadyExecuted')).toBe('msAlreadyExecuted');
    expect(multisigRevertMessageKey('ThresholdNotMet')).toBe('msThresholdNotMet');
    expect(multisigRevertMessageKey('TxNotFound')).toBe('msTxNotFound');
    expect(multisigRevertMessageKey('ExecutionFailed')).toBe('msExecutionFailed');
    expect(multisigRevertMessageKey('InvalidSetup')).toBe('msInvalidSetup');
  });
});
