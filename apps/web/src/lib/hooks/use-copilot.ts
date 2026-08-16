import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Edge, Node } from 'reactflow';
import {
  irToCanvas,
  type ArchitectureIr,
  type CanvasGraph,
  type ServiceNodeData,
} from '@infracanvas/core';

import { copilotApi } from '@/lib/api/copilot';
import { startTurn } from '@/lib/copilot/sse-client';
import type { CopilotMessage } from '@/lib/copilot/types';
import { CONTAINER_DEFAULT_SIZE } from '@/lib/designer/containment';
import { useCopilotStore } from '@/lib/stores/copilot-store';
import { useDesignerStore } from '@/lib/stores/designer-store';

const Z_INDEX: Record<string, number> = {
  'vpc-environment': -4,
  'availability-zone': -3,
  'public-subnet': -2,
  'private-subnet': -2,
  'ecs-cluster': -1,
  'eks-cluster': -1,
};

function flowTypeFor(serviceId: string): string {
  if (serviceId === 'vpc-environment') return 'vpcEnvironment';
  if (serviceId === 'public-subnet' || serviceId === 'private-subnet') return 'subnet';
  if (serviceId in CONTAINER_DEFAULT_SIZE) return 'cluster';
  return 'serviceNode';
}

/**
 * Project an IR document onto the designer store's legacy node shape.
 * Migrating the store to `IrNodeData` is #12; until then accept reloads through
 * this adapter so the canvas still shows what `experiments.ir` holds.
 */
export function canvasFromIr(ir: ArchitectureIr): {
  nodes: Node<ServiceNodeData>[];
  edges: Edge[];
  name: string;
} {
  const graph: CanvasGraph = irToCanvas(ir);
  const nodes: Node<ServiceNodeData>[] = graph.nodes.map((node) => {
    const serviceId = node.data.service.serviceId;
    const params = node.data.params as unknown as Record<string, string | number | boolean>;
    const flowNode: Node<ServiceNodeData> = {
      id: node.id,
      type: flowTypeFor(serviceId),
      position: node.position,
      ...(node.parentNode ? { parentNode: node.parentNode, extent: 'parent' as const } : {}),
      data: {
        serviceId,
        serviceName: node.data.service.serviceName,
        shortName: node.data.service.shortName,
        color: node.data.service.color,
        category: node.data.service.category,
        properties: params ?? {},
        nodeType:
          serviceId in CONTAINER_DEFAULT_SIZE
            ? (serviceId as ServiceNodeData['nodeType'])
            : 'service',
        parentId: node.parentNode,
      },
    };
    if (node.style) {
      Object.assign(flowNode, {
        style: node.style,
        width: node.style.width,
        height: node.style.height,
        zIndex: Z_INDEX[serviceId] ?? -1,
      });
    }
    return flowNode;
  });

  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: 'deletable',
  }));

  return { nodes, edges, name: graph.meta.name };
}

export function useCopilot(experimentId: string | null) {
  const isOpen = useCopilotStore((s) => s.isOpen);
  const streamingMessageId = useCopilotStore((s) => s.streamingMessageId);
  const refusal = useCopilotStore((s) => s.refusal);
  const loadTranscript = useCopilotStore((s) => s.loadTranscript);
  const applyEvent = useCopilotStore((s) => s.applyEvent);
  const decideProposal = useCopilotStore((s) => s.decideProposal);
  const setRefusal = useCopilotStore((s) => s.setRefusal);
  const loadDesign = useDesignerStore((s) => s.loadDesign);

  const abortRef = useRef<AbortController | null>(null);

  const transcriptQuery = useQuery({
    queryKey: ['copilot', experimentId],
    queryFn: async () => {
      if (!experimentId) return { messages: [] as CopilotMessage[] };
      return copilotApi.getTranscript(experimentId);
    },
    enabled: Boolean(experimentId) && isOpen,
  });

  useEffect(() => {
    if (transcriptQuery.data?.messages) {
      loadTranscript(transcriptQuery.data.messages);
    }
  }, [transcriptQuery.data, loadTranscript]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!experimentId || !text.trim()) return;
      if (streamingMessageId) return;
      if (refusal?.code === 'no_llm_credential') return;

      const trimmed = text.trim();
      const userMessage: CopilotMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        toolCalls: [],
        citations: [],
        proposal: null,
        status: 'complete',
        unverifiedCitations: 0,
      };

      const prior = useCopilotStore.getState().messages;
      loadTranscript([...prior, userMessage]);
      setRefusal(null);

      const controller = new AbortController();
      abortRef.current = controller;

      await startTurn(
        experimentId,
        trimmed,
        {
          onEvent: (event) => applyEvent(event),
          onRefusal: (r) => {
            setRefusal({ code: r.code, message: r.message });
            loadTranscript(prior);
          },
          onClose: (finish) => {
            abortRef.current = null;
            if (finish === 'cancelled') {
              const id = useCopilotStore.getState().streamingMessageId;
              if (id) {
                applyEvent({
                  kind: 'done',
                  seq: Number.MAX_SAFE_INTEGER,
                  finish: 'cancelled',
                  inputTokens: 0,
                  outputTokens: 0,
                  toolCalls: 0,
                  unverifiedCitations:
                    useCopilotStore.getState().messages.find((m) => m.id === id)
                      ?.unverifiedCitations ?? 0,
                });
              }
            }
          },
        },
        controller.signal
      );
    },
    [experimentId, streamingMessageId, refusal?.code, loadTranscript, setRefusal, applyEvent]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const accept = useCallback(
    async (proposalId: string) => {
      if (!experimentId) return;
      const before = useCopilotStore.getState().messages;
      const target = before.find((m) => m.proposal?.proposalId === proposalId)?.proposal;
      if (!target || target.decision !== 'pending') return;

      const result = await copilotApi.acceptProposal(experimentId, proposalId);
      const { nodes, edges, name } = canvasFromIr(result.ir);
      loadDesign(nodes, edges, name, experimentId);
      decideProposal(proposalId, 'accepted');
    },
    [experimentId, loadDesign, decideProposal]
  );

  const reject = useCallback(
    async (proposalId: string) => {
      if (!experimentId) return;
      const target = useCopilotStore
        .getState()
        .messages.find((m) => m.proposal?.proposalId === proposalId)?.proposal;
      if (!target || target.decision !== 'pending') return;

      // Reject must not touch the designer store — only the proposal decision.
      await copilotApi.rejectProposal(experimentId, proposalId);
      decideProposal(proposalId, 'rejected');
    },
    [experimentId, decideProposal]
  );

  return {
    isStreaming: streamingMessageId !== null,
    refusal,
    isLoadingTranscript: transcriptQuery.isLoading,
    send,
    stop,
    accept,
    reject,
  };
}
