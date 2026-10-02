'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { api, ApiError } from '@/lib/api';
import {
  createVotingIdentity,
  importVotingIdentity,
  isValidMockEpic,
  loadIdentityExport,
  saveIdentityExport,
  shortCommitment,
  type ArchivedVoter
} from '@/lib/vote-identity';

export interface RegisterResult {
  txHash: string | null;
  alreadyRegistered: boolean;
}

function StepError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">
      {message}
    </p>
  );
}

/**
 * Step 1 — mock KYC. Collects a prototype EPIC, exchanges it for a
 * short-lived kycToken that lives in memory only (never stored or logged).
 */
export function KycStep({
  electionId,
  onVerified
}: {
  electionId: string;
  onVerified: (kycToken: string) => void;
}) {
  const t = useTranslations();
  const [epic, setEpic] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!isValidMockEpic(epic)) {
      setError(t('vote.epicInvalid'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const session = await api.startKyc(electionId);
      const token = await api.completeKyc(session.sessionId, epic.trim());
      onVerified(token.kycToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('vote.stepError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-labelledby="kyc-heading">
      <h3 id="kyc-heading" className="text-base font-bold text-navy-900">
        {t('vote.kycTitle')}
      </h3>
      <p className="prose-civic mt-1 text-sm">{t('vote.kycBody')}</p>
      <label htmlFor="mock-epic" className="mt-3 block text-sm font-semibold text-navy-900">
        {t('vote.epicLabel')}
      </label>
      <input
        id="mock-epic"
        name="mockEpic"
        autoComplete="off"
        placeholder={t('vote.epicPlaceholder')}
        aria-describedby="mock-epic-hint"
        value={epic}
        onChange={(event) => setEpic(event.target.value)}
        className="mt-1 w-full rounded-md border border-navy-200 px-3 py-2 text-base"
      />
      <p id="mock-epic-hint" className="mt-1 text-sm text-ink-muted">
        {t('vote.epicHint')}
      </p>
      <StepError message={error} />
      <button type="submit" disabled={pending} className="btn-primary mt-3">
        {pending ? t('vote.kycPending') : t('vote.kycButton')}
      </button>
    </form>
  );
}

/**
 * Step 2 — Semaphore identity. Creates (or resumes) the voter's anonymous
 * identity; the export is kept on this device only.
 */
export function IdentityStep({
  electionId,
  onCreated
}: {
  electionId: string;
  onCreated: (commitment: string) => void;
}) {
  const t = useTranslations();
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const stored = mounted ? loadIdentityExport(electionId) : null;

  function create(): void {
    setError(null);
    try {
      const created = createVotingIdentity();
      saveIdentityExport(electionId, created.identityExport);
      onCreated(created.commitment);
    } catch {
      setError(t('vote.stepError'));
    }
  }

  function resume(): void {
    setError(null);
    const parsed = stored ? importVotingIdentity(stored) : null;
    if (!parsed) {
      setError(t('vote.stepError'));
      return;
    }
    onCreated(parsed.commitment);
  }

  return (
    <div aria-labelledby="identity-heading">
      <h3 id="identity-heading" className="text-base font-bold text-navy-900">
        {t('vote.identityTitle')}
      </h3>
      <p className="prose-civic mt-1 text-sm">{t('vote.identityBody')}</p>
      <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {t('vote.identityBackup')}
      </p>
      <StepError message={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={create} className="btn-primary">
          {t('vote.identityCreate')}
        </button>
        {stored ? (
          <button type="button" onClick={resume} className="btn-secondary">
            {t('vote.identityContinue')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Shared-device voter switcher. A household may vote several family members
 * from one browser: each keeps their own anonymous identity, parked here
 * while another is active. Switching never deletes — the outgoing voter is
 * archived first by the parent.
 */
export function VoterSwitcher({
  activeCommitment,
  archived,
  onUseArchived,
  onStartOver
}: {
  activeCommitment: string | null;
  archived: ArchivedVoter[];
  onUseArchived: (key: string) => void;
  onStartOver: () => void;
}) {
  const t = useTranslations();
  const [confirming, setConfirming] = useState(false);

  if (!activeCommitment && archived.length === 0) return null;

  return (
    <div aria-labelledby="voter-switcher-heading" className="rounded-md border border-navy-200 p-3">
      <h3 id="voter-switcher-heading" className="text-base font-bold text-navy-900">
        {t('vote.voterTitle')}
      </h3>
      {activeCommitment ? (
        <p className="mt-1 text-sm text-ink">
          {t('vote.currentVoter')}:{' '}
          <code className="break-all font-mono" title={activeCommitment}>
            {shortCommitment(activeCommitment)}
          </code>
        </p>
      ) : null}
      {archived.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {archived.map((entry) => (
            <li key={entry.key} className="flex flex-wrap items-center gap-2 text-sm">
              <code
                className="break-all font-mono text-ink-muted"
                title={entry.commitment ?? entry.key}
              >
                {entry.commitment ? shortCommitment(entry.commitment) : '…'}
              </code>
              <button type="button" className="btn-secondary" onClick={() => onUseArchived(entry.key)}>
                {t('vote.useVoter')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!confirming ? (
        <button type="button" className="btn-secondary mt-3" onClick={() => setConfirming(true)}>
          {t('vote.startOver')}
        </button>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-ink">{t('vote.startOverConfirm')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setConfirming(false);
                onStartOver();
              }}
            >
              {t('vote.startOverYes')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
              {t('vote.startOverNo')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
/**
 * Step 3 — anonymous registration. Sends only the kycToken, electionId and
 * identity commitment; the backend stores just an eligibility hash.
 */
export function RegisterStep({
  electionId,
  kycToken,
  commitment,
  onDone
}: {
  electionId: string;
  kycToken: string;
  commitment: string;
  onDone: (result: RegisterResult) => void;
}) {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const { txHash } = await api.register({ kycToken, electionId, identityCommitment: commitment });
      onDone({ txHash, alreadyRegistered: false });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onDone({ txHash: null, alreadyRegistered: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : t('vote.stepError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div aria-labelledby="register-heading">
      <h3 id="register-heading" className="text-base font-bold text-navy-900">
        {t('vote.registerTitle')}
      </h3>
      <p className="prose-civic mt-1 text-sm">{t('vote.registerBody')}</p>
      <p className="mt-2 text-sm text-ink-muted">{t('vote.commitmentLabel')}</p>
      <code className="mt-1 block break-all rounded-md bg-slate-100 px-3 py-2 text-sm">{commitment}</code>
      <StepError message={error} />
      <button type="button" onClick={() => void submit()} disabled={pending} className="btn-primary mt-3">
        {pending ? t('vote.registerPending') : t('vote.registerButton')}
      </button>
    </div>
  );
}
