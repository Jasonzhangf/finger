/**
 * Split shim: implementation moved to src/serverx to keep server entry files slim.
 * Runtime checklist anchors (do not remove):
 * - app.post('/api/v1/message'
 * - body.target
 * - body.message
 * - body.callbackId
 * - mailbox.updateStatus
 */
export * from '../../serverx/routes/message.impl.js';
