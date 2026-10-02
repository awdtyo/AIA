import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { VoteFlow } from './vote-flow';
import { elections } from '@/test/fixtures';
import { clearElectionIdentities, createVotingIdentity, saveIdentityExport } from '@/lib/vote-identity';
import { jsonResponse, renderWithI18n } from '@/test/render';

const fetchMock = vi.fn();

const votingElection = elections[0];
const registrationElection = elections[1];
const finalizedElection = elections[2];
if (!votingElection || !registrationElection || !finalizedElection) {
  throw new Error('test fixtures are missing an election');
}

describe('VoteFlow', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    for (const id of ['1', '2', '3', '9']) clearElectionIdentities(id);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces loading instead of a blank screen', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));

    renderWithI18n(<VoteFlow electionId="1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading election…');
  });

  it('shows the ballot candidates when voting is open', async () => {
    fetchMock.mockResolvedValue(jsonResponse(votingElection));

    renderWithI18n(<VoteFlow electionId="1" />);

    expect(await screen.findByRole('heading', { name: /Cast your vote/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your ballot' })).toBeInTheDocument();
    for (const candidate of votingElection.candidates) {
      expect(screen.getByText(candidate)).toBeInTheDocument();
    }
  });

  it('offers the secret ballot when this device registered', async () => {
    const created = createVotingIdentity();
    saveIdentityExport('1', created.identityExport);
    fetchMock.mockImplementation((url: unknown) => {
      const target = String(url);
      if (target.includes('/group')) {
        return Promise.resolve(jsonResponse({ members: [created.commitment] }));
      }
      return Promise.resolve(jsonResponse(votingElection));
    });

    renderWithI18n(<VoteFlow electionId="1" />);

    expect(await screen.findByRole('heading', { name: 'Choose your candidate' })).toBeInTheDocument();
  });

  it('tells fresh devices that registration is closed during voting', async () => {
    fetchMock.mockResolvedValue(jsonResponse(votingElection));

    renderWithI18n(<VoteFlow electionId="1" />);

    expect(await screen.findByRole('heading', { name: 'Registration is closed' })).toBeInTheDocument();
  });

  it('parks the current voter and starts a blank journey for the next', async () => {
    const created = createVotingIdentity();
    saveIdentityExport('2', created.identityExport);
    fetchMock.mockResolvedValue(jsonResponse(registrationElection));

    renderWithI18n(<VoteFlow electionId="2" />);

    expect(await screen.findByRole('heading', { name: 'Voters on this device' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Register a different voter' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, start over' }));

    // Parked voter is offered back; the wizard restarts at KYC.
    expect(await screen.findByRole('button', { name: 'Use this voter' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1 · Check eligibility' })).toBeInTheDocument();
  });

  it('brings a parked voter back without losing them', async () => {
    const created = createVotingIdentity();
    saveIdentityExport('2', created.identityExport);
    fetchMock.mockImplementation((url: unknown) => {
      const target = String(url);
      if (target.includes('/kyc/start')) {
        return Promise.resolve(jsonResponse({ sessionId: 's-1', redirectUrl: '/mock' }));
      }
      if (target.includes('/kyc/complete')) {
        return Promise.resolve(jsonResponse({ kycToken: 'tok-1' }));
      }
      if (target.includes('/register')) {
        return Promise.resolve(jsonResponse({ txHash: `0x${'ab'.repeat(32)}` }));
      }
      return Promise.resolve(jsonResponse(registrationElection));
    });

    renderWithI18n(<VoteFlow electionId="2" />);

    // Complete a registration, park it via start-over, then resume it.
    await userEvent.type(await screen.findByLabelText('Mock EPIC'), 'WB/12/345/678901');
    await userEvent.click(screen.getByRole('button', { name: 'Verify identity' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create voting identity' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Register anonymously' }));
    await screen.findByText('Registered. Come back to this page once the Voting phase opens.');

    await userEvent.click(screen.getByRole('button', { name: 'Register a different voter' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, start over' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use this voter' }));

    expect(screen.getByRole('heading', { name: '1 · Check eligibility' })).toBeInTheDocument();
  });
  it('explains registration-phase elections and hides the ballot', async () => {
    fetchMock.mockResolvedValue(jsonResponse(registrationElection));

    renderWithI18n(<VoteFlow electionId="2" />);

    expect(await screen.findByRole('heading', { name: 'Registration is open' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your ballot' })).not.toBeInTheDocument();
  });

  it('points finalized elections at turnout', async () => {
    fetchMock.mockResolvedValue(jsonResponse(finalizedElection));

    renderWithI18n(<VoteFlow electionId="3" />);

    expect(await screen.findByRole('heading', { name: 'Voting is not open' })).toBeInTheDocument();
    expect(screen.getByText(/Finalized/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View turnout' })).toHaveAttribute(
      'href',
      '/en/turnout/3'
    );
  });

  it('reports unknown elections and retries on failure', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'x', message: 'gone' } }, 404))
      .mockResolvedValueOnce(jsonResponse(votingElection));

    renderWithI18n(<VoteFlow electionId="9" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not find what you were looking for.'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Your ballot' })).toBeInTheDocument();
  });
});
