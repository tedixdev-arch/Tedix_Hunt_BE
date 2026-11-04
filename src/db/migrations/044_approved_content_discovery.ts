import type { Migration } from './types.js';

export const approvedContentIndexSql = `
CREATE INDEX library_content_approved_latest ON library_content_revisions(content_id,version DESC) WHERE status='approved';
`;
export default {id:'044_approved_content_discovery',async up(client){await client.query(approvedContentIndexSql);}} satisfies Migration;
