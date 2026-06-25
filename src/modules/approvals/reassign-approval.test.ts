/**
 * Tests for reassignApproval — re-deliver a pending approval card to the
 * next available admin, skipping already-notified ones.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { setDeliveryAdapter } from '../../delivery.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-reassign-approval' };
});

const TEST_DIR = '/tmp/nanoclaw-test-reassign-approval';

function now(): string {
  return new Date().toISOString();
}

async function mountMockAdapter(channelType: string): Promise<{ delivered: OutboundMessage[] }> {
  const delivered: OutboundMessage[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return `msg-${Date.now()}`;
    },
    async setTyping() {},
  };
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));

  // Also wire a delivery adapter that calls through to the channel adapter
  setDeliveryAdapter({
    async deliver(ct, platformId, _threadId, _kind, _content) {
      await adapter.deliver(platformId, null, { kind: 'text', text: '' } as never);
      return `pm-${Date.now()}`;
    },
  });

  return { delivered };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reassignApproval', () => {
  it('returns error for unknown approval id', async () => {
    const { reassignApproval } = await import('./primitive.js');
    const result = await reassignApproval({ approvalId: 'no-such-approval' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it('returns error for already-resolved approval', async () => {
    const { reassignApproval } = await import('./primitive.js');
    createPendingApproval({
      approval_id: 'appr-done',
      session_id: 'sess-1',
      request_id: 'appr-done',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install',
      options_json: '[]',
      status: 'approved',
    });

    const result = await reassignApproval({ approvalId: 'appr-done' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already approved/i);
  });

  it('returns error when no admins are configured', async () => {
    const { reassignApproval } = await import('./primitive.js');
    createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-1',
      request_id: 'appr-1',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install',
      options_json: '[]',
    });

    const result = await reassignApproval({ approvalId: 'appr-1' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no owner or admin/i);
  });

  it('auto-picks next admin skipping already-notified, updates notified_approver_ids', async () => {
    await mountMockAdapter('telegram');
    upsertUser({ id: 'telegram:111', kind: 'telegram', display_name: null, created_at: now() });
    upsertUser({ id: 'telegram:222', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'telegram:111', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'telegram:222', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    createPendingApproval({
      approval_id: 'appr-2',
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      request_id: 'appr-2',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install',
      options_json: JSON.stringify([
        { label: 'Approve', value: 'approve' },
        { label: 'Reject', value: 'reject' },
      ]),
      notified_approver_ids: JSON.stringify(['telegram:111']),
    });

    const { reassignApproval } = await import('./primitive.js');
    const result = await reassignApproval({ approvalId: 'appr-2' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('telegram:222');

    // notified list should now include both
    const updated = getPendingApproval('appr-2');
    const notified = JSON.parse(updated!.notified_approver_ids!);
    expect(notified).toContain('telegram:111');
    expect(notified).toContain('telegram:222');
  });

  it('returns error when all admins have already been notified', async () => {
    await mountMockAdapter('telegram');
    upsertUser({ id: 'telegram:111', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'telegram:111', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    createPendingApproval({
      approval_id: 'appr-3',
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      request_id: 'appr-3',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install',
      options_json: '[]',
      notified_approver_ids: JSON.stringify(['telegram:111']),
    });

    const { reassignApproval } = await import('./primitive.js');
    const result = await reassignApproval({ approvalId: 'appr-3' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no reachable admin remaining/i);
  });

  it('reassigns to explicit toUserId when provided', async () => {
    await mountMockAdapter('telegram');
    upsertUser({ id: 'telegram:111', kind: 'telegram', display_name: null, created_at: now() });
    upsertUser({ id: 'telegram:333', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'telegram:111', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'telegram:333', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    createPendingApproval({
      approval_id: 'appr-4',
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      request_id: 'appr-4',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install',
      options_json: JSON.stringify([
        { label: 'Approve', value: 'approve' },
        { label: 'Reject', value: 'reject' },
      ]),
      notified_approver_ids: JSON.stringify(['telegram:111']),
    });

    const { reassignApproval } = await import('./primitive.js');
    const result = await reassignApproval({ approvalId: 'appr-4', toUserId: 'telegram:333' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('telegram:333');

    const updated = getPendingApproval('appr-4');
    expect(updated?.approver_user_id).toBe('telegram:333');
  });

  it('returns error when explicit toUserId is not an admin', async () => {
    upsertUser({ id: 'telegram:stranger', kind: 'telegram', display_name: null, created_at: now() });
    upsertUser({ id: 'telegram:admin', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'telegram:admin', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    createPendingApproval({
      approval_id: 'appr-5',
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      request_id: 'appr-5',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install',
      options_json: '[]',
    });

    const { reassignApproval } = await import('./primitive.js');
    const result = await reassignApproval({ approvalId: 'appr-5', toUserId: 'telegram:stranger' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not have admin privilege/i);
  });
});
