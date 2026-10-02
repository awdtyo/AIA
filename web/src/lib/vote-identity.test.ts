import { describe, expect, it } from 'vitest';

import {
  archiveIdentityExport,
  clearElectionIdentities,
  clearIdentityExport,
  createVotingIdentity,
  importVotingIdentity,
  isValidMockEpic,
  listArchivedExports,
  loadIdentityExport,
  loadStoredCommitment,
  MAX_ARCHIVED_VOTERS,
  restoreArchivedExport,
  saveIdentityExport,
  shortCommitment
} from './vote-identity';

describe('isValidMockEpic', () => {
  it('accepts the documented SS/DD/DDD/DDDDDD shape', () => {
    expect(isValidMockEpic('WB/12/345/678901')).toBe(true);
    expect(isValidMockEpic('  KER/01/002/000003  ')).toBe(true);
  });

  it('rejects typos before they reach the server', () => {
    expect(isValidMockEpic('')).toBe(false);
    expect(isValidMockEpic('wb/12/345/678901')).toBe(false);
    expect(isValidMockEpic('WB-12-345-678901')).toBe(false);
    expect(isValidMockEpic('WB/1/345/678901')).toBe(false);
  });
});

describe('voting identity storage', () => {
  it('round-trips create -> save -> load with the same commitment', () => {
    const created = createVotingIdentity();
    expect(created.commitment).toMatch(/^\d+$/);

    saveIdentityExport('42', created.identityExport);
    expect(loadIdentityExport('42')).toBe(created.identityExport);
    expect(loadStoredCommitment('42')).toBe(created.commitment);

    const restored = importVotingIdentity(created.identityExport);
    expect(restored?.commitment).toBe(created.commitment);
  });

  it('returns null for empty or missing exports', () => {
    expect(importVotingIdentity('')).toBeNull();
    expect(loadStoredCommitment('no-such-election')).toBeNull();
  });

  it('clears stored identities per election', () => {
    saveIdentityExport('44', createVotingIdentity().identityExport);
    clearIdentityExport('44');
    expect(loadIdentityExport('44')).toBeNull();
  });
});

describe('shared-device voter archive', () => {
  it('parks the active voter and restores it by key', () => {
    clearElectionIdentities('50');
    const created = createVotingIdentity();
    saveIdentityExport('50', created.identityExport);

    const key = archiveIdentityExport('50');
    expect(key).toMatch(/archived/);
    expect(loadIdentityExport('50')).toBeNull();

    const archived = listArchivedExports('50');
    expect(archived).toHaveLength(1);
    expect(archived[0]?.commitment).toBe(created.commitment);

    expect(restoreArchivedExport('50', archived[0]?.key ?? '')).toBe(created.commitment);
    expect(loadIdentityExport('50')).toBe(created.identityExport);
    expect(listArchivedExports('50')).toHaveLength(0);
  });

  it('returns null when there is nothing to archive or restore', () => {
    clearElectionIdentities('51');
    expect(archiveIdentityExport('51')).toBeNull();
    expect(restoreArchivedExport('51', 'no-such-key')).toBeNull();
  });

  it('caps the archive so a kiosk cannot grow storage unboundedly', () => {
    clearElectionIdentities('52');
    for (let i = 0; i < MAX_ARCHIVED_VOTERS + 3; i++) {
      saveIdentityExport('52', createVotingIdentity().identityExport);
      archiveIdentityExport('52');
    }
    expect(listArchivedExports('52')).toHaveLength(MAX_ARCHIVED_VOTERS);
  });

  it('shortens commitments for display without losing them', () => {
    expect(shortCommitment('123456789012345')).toBe('123456…2345');
    expect(shortCommitment('short')).toBe('short');
  });
});
