/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     resolves in-memory OneCLI credential approvals.
 *   - An adapter-ready callback that starts the OneCLI manual-approval handler
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops the OneCLI handler cleanly.
 *   - A `reassign_approval` delivery action so agents can request the card
 *     be re-sent to the next available admin via the `reassign_approval` MCP tool.
 *
 * Self-mod flows (install_packages, add_mcp_server) moved out to
 * `src/modules/self-mod/` in PR #7 — they now register delivery actions
 * + approval handlers via this module's public API.
 */
import { onDeliveryAdapterReady, registerDeliveryAction } from '../../delivery.js';
import { registerResponseHandler, onShutdown } from '../../response-registry.js';
import { log } from '../../log.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';
import { notifyAgent, reassignApproval } from './primitive.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent, reassignApproval } from './primitive.js';
export type {
  ApprovalHandler,
  ApprovalHandlerContext,
  RequestApprovalOptions,
  ReassignApprovalOptions,
  ReassignApprovalResult,
} from './primitive.js';

registerResponseHandler(handleApprovalsResponse);

onDeliveryAdapterReady((adapter) => {
  startOneCLIApprovalHandler(adapter);
});

onShutdown(() => {
  stopOneCLIApprovalHandler();
});

// Delivery action: agent-initiated approval reassignment.
// The container writes { action: 'reassign_approval', approval_id, to_user_id? }
// to messages_out. The host picks it up here and re-delivers the card.
registerDeliveryAction('reassign_approval', async (content, session) => {
  const approvalId = content.approval_id as string | undefined;
  if (!approvalId) {
    notifyAgent(session, 'reassign_approval failed: approval_id is required.');
    return;
  }

  // Guard: the approval must belong to this session's agent group.
  const approval = getPendingApproval(approvalId);
  if (!approval) {
    notifyAgent(session, `reassign_approval failed: approval not found: ${approvalId}`);
    return;
  }
  if (approval.session_id) {
    const approvalSession = getSession(approval.session_id);
    if (!approvalSession || approvalSession.agent_group_id !== session.agent_group_id) {
      notifyAgent(session, `reassign_approval failed: approval ${approvalId} does not belong to this agent group.`);
      log.warn('reassign_approval: cross-group attempt blocked', {
        sessionId: session.id,
        approvalId,
        approvalAgentGroupId: approvalSession?.agent_group_id,
      });
      return;
    }
  }

  const toUserId = content.to_user_id as string | undefined;
  const result = await reassignApproval({ approvalId, toUserId, agentGroupId: session.agent_group_id });
  notifyAgent(session, result.message);
});
