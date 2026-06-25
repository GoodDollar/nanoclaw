import type { Migration } from './index.js';

/**
 * `notified_approver_ids` on `pending_approvals`: JSON array of user IDs that
 * have already been sent an approval card for this request. Used by the
 * reassign flow to skip already-notified approvers when picking the next one.
 * NULL on rows created before this migration; treated as an empty list.
 */
export const migration019: Migration = {
  version: 19,
  name: 'approvals-notified-approvers',
  up(db) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN notified_approver_ids TEXT;`);
  },
};
