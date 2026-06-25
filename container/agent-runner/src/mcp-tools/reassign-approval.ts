/**
 * `reassign_approval` MCP tool.
 *
 * Lets the agent ask the host to re-send a pending approval card to the
 * next available admin (skipping anyone already notified), or to a specific
 * admin. Fire-and-forget: the tool writes a system action to messages_out
 * and the host processes it via the registered `reassign_approval` delivery
 * action.
 *
 * Use when:
 *   - The admin who received the original card is unavailable.
 *   - You want to route the approval to a specific admin.
 *   - You received a "no response" notification and want to escalate.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const reassignApproval: McpToolDefinition = {
  tool: {
    name: 'reassign_approval',
    description:
      'Re-send a pending approval card to the next available admin, or to a specific admin. ' +
      'Use when the original approver is unavailable or unresponsive. Fire-and-forget — ' +
      'you will be notified of the result via a system message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        approval_id: {
          type: 'string',
          description: 'The approval ID to reassign (from the original approval request).',
        },
        to_user_id: {
          type: 'string',
          description:
            'Optional: specific admin user ID to reassign to (e.g. "telegram:123456"). ' +
            'If omitted, the host auto-picks the next eligible admin who has not yet been notified.',
        },
      },
      required: ['approval_id'],
    },
  },
  async handler(args) {
    const approvalId = args.approval_id as string | undefined;
    if (!approvalId) return err('approval_id is required');

    const toUserId = args.to_user_id as string | undefined;

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'reassign_approval',
        approval_id: approvalId,
        ...(toUserId ? { to_user_id: toUserId } : {}),
      }),
    });

    log(`reassign_approval: ${requestId} → approvalId=${approvalId}${toUserId ? ` to=${toUserId}` : ''}`);
    return ok(
      `Reassignment request submitted for approval ${approvalId}. ` +
        `You will be notified when the card has been re-delivered${toUserId ? ` to ${toUserId}` : ''}.`,
    );
  },
};

registerTools([reassignApproval]);
