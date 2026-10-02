import { Identity } from '@semaphore-protocol/identity';

const STORAGE_PREFIX = 'aia-vote:identity:';

/**
 * Prototype mock-KYC EPIC format, mirrored from
 * `backend/src/kyc/mockProvider.ts` (`MOCK_EPIC_PATTERN`). Client-side only
 * so an obvious typo never reaches the server.
 */
export const MOCK_EPIC_PATTERN = /^[A-Z]{2,3}\/[0-9]{2}\/[0-9]{3}\/[0-9]{6}$/;

export function isValidMockEpic(value: string): boolean {
  return MOCK_EPIC_PATTERN.test(value.trim());
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    const ls = window.localStorage;
    if (!ls) throw new Error('localStorage unavailable');
    const probe = 'aia-vote:probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return memoryStorage();
  }
}

/**
 * In-memory fallback for SSR, private browsing, or environments without
 * `localStorage`. Survives the session but not a reload — the register step
 * already treats a re-registration as already-done, so nothing breaks.
 */
const memoryFallback = new Map<string, string>();

function memoryStorage(): Storage {
  return {
    get length(): number {
      return memoryFallback.size;
    },
    clear: (): void => {
      memoryFallback.clear();
    },
    getItem: (key: string): string | null => memoryFallback.get(key) ?? null,
    key: (index: number): string | null => [...memoryFallback.keys()][index] ?? null,
    removeItem: (key: string): void => {
      memoryFallback.delete(key);
    },
    setItem: (key: string, value: string): void => {
      memoryFallback.set(key, value);
    }
  };
}

export interface CreatedIdentity {
  commitment: string;
  identityExport: string;
}

/**
 * Creates a fresh Semaphore identity. The trapdoor never leaves this
 * function except inside `identityExport`, which the caller must store
 * locally (demo only) — it is never sent to any server.
 */
export function createVotingIdentity(): CreatedIdentity & { identity: Identity } {
  const identity = new Identity();
  return { identity, commitment: identity.commitment.toString(), identityExport: identity.export() };
}

/** Restores an identity from a stored export; null only for unusable input. */
export function importVotingIdentity(identityExport: string): { identity: Identity; commitment: string } | null {
  try {
    if (!identityExport) return null;
    const identity = Identity.import(identityExport);
    return { identity, commitment: identity.commitment.toString() };
  } catch {
    return null;
  }
}

/**
 * Demo-only device storage for the identity export, keyed per election.
 * Lets a voter who registered during Registration phase cast their ballot
 * from the same device once Voting opens. Never synced anywhere.
 */
export function saveIdentityExport(electionId: string, identityExport: string): void {
  storage()?.setItem(`${STORAGE_PREFIX}${electionId}`, identityExport);
}

export function loadIdentityExport(electionId: string): string | null {
  return storage()?.getItem(`${STORAGE_PREFIX}${electionId}`) ?? null;
}

export function loadStoredCommitment(electionId: string): string | null {
  const exported = loadIdentityExport(electionId);
  if (!exported) return null;
  return importVotingIdentity(exported)?.commitment ?? null;
}

export function clearIdentityExport(electionId: string): void {
  storage()?.removeItem(`${STORAGE_PREFIX}${electionId}`);
}

/** Maximum archived voters kept per election on a shared device. */
export const MAX_ARCHIVED_VOTERS = 8;

export interface ArchivedVoter {
  key: string;
  identityExport: string;
  savedAt: number;
  commitment: string | null;
}

let archiveSeq = 0;

function archivePrefix(electionId: string): string {
  return `${STORAGE_PREFIX}${electionId}:archived:`;
}

/**
 * Shared-device support: parks the active voter so another family member can
 * register on the same browser. The archived export stays on this device
 * only. Returns the archive key, or null when no voter is active.
 */
export function archiveIdentityExport(electionId: string): string | null {
  const store = storage();
  const active = loadIdentityExport(electionId);
  if (!store || !active) return null;
  const key = `${archivePrefix(electionId)}${Date.now()}-${archiveSeq++}`;
  store.setItem(key, active);
  store.removeItem(`${STORAGE_PREFIX}${electionId}`);
  // Evict oldest beyond the cap so a kiosk cannot fill storage unboundedly.
  const overflow = listArchivedExports(electionId).slice(MAX_ARCHIVED_VOTERS);
  for (const entry of overflow) store.removeItem(entry.key);
  return key;
}

export function listArchivedExports(electionId: string): ArchivedVoter[] {
  const store = storage();
  if (!store) return [];
  const prefix = archivePrefix(electionId);
  const out: ArchivedVoter[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const identityExport = store.getItem(key);
    if (!identityExport) continue;
    const [timestamp = ''] = key.slice(prefix.length).split('-');
    out.push({
      key,
      identityExport,
      savedAt: Number(timestamp) || 0,
      commitment: importVotingIdentity(identityExport)?.commitment ?? null
    });
  }
  // Keys embed `<epochMs>-<sequence>`, so lexicographic order is newest-first.
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/**
 * Makes an archived voter active again. The archive entry is consumed (it
 * becomes the active export) so the same voter never appears twice.
 */
export function restoreArchivedExport(electionId: string, key: string): string | null {
  const store = storage();
  if (!store) return null;
  const identityExport = store.getItem(key);
  if (!identityExport || !key.startsWith(archivePrefix(electionId))) return null;
  const parsed = importVotingIdentity(identityExport);
  if (!parsed) return null;
  store.removeItem(key);
  store.setItem(`${STORAGE_PREFIX}${electionId}`, identityExport);
  return parsed.commitment;
}

/** Removes the active export and every archived one (tests + fresh starts). */
export function clearElectionIdentities(electionId: string): void {
  const store = storage();
  if (!store) return;
  store.removeItem(`${STORAGE_PREFIX}${electionId}`);
  for (const entry of listArchivedExports(electionId)) store.removeItem(entry.key);
}

/** Short display form of a decimal commitment (full value stays in title). */
export function shortCommitment(commitment: string): string {
  return commitment.length <= 12 ? commitment : `${commitment.slice(0, 6)}…${commitment.slice(-4)}`;
}
