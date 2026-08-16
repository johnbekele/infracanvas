import type { ArchitectureIr } from '@infracanvas/core';
import { apiFetch } from './client';
import type { CopilotMessage } from '@/lib/copilot/types';

export interface CopilotTranscript {
  messages: CopilotMessage[];
}

export interface AcceptProposalResult {
  ir: ArchitectureIr;
  irDigest: string;
}

export const copilotApi = {
  async getTranscript(experimentId: string): Promise<CopilotTranscript> {
    return apiFetch<CopilotTranscript>(`/experiments/${experimentId}/copilot`);
  },

  async acceptProposal(experimentId: string, proposalId: string): Promise<AcceptProposalResult> {
    return apiFetch<AcceptProposalResult>(
      `/experiments/${experimentId}/copilot/proposals/${proposalId}/accept`,
      { method: 'POST' }
    );
  },

  async rejectProposal(experimentId: string, proposalId: string): Promise<void> {
    await apiFetch<void>(`/experiments/${experimentId}/copilot/proposals/${proposalId}/reject`, {
      method: 'POST',
    });
  },
};
