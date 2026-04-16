'use strict';

// Shared access guard for video_messages endpoints.
//
// Public messages (recipient_id = NULL): anyone may view.
// Private messages: only sender or recipient may view.
//
// Previously this 5-line check was copy-pasted in 5 routes, which made it
// easy to forget when a new endpoint was added. Centralise it here.

function assertCanViewMessage(msg, user) {
  if (msg.recipient_id === null) return null;
  const userId = user?.userId;
  if (!userId || (msg.sender_id !== userId && msg.recipient_id !== userId)) {
    return { code: 403, body: { error: 'Access denied' } };
  }
  return null;
}

module.exports = { assertCanViewMessage };
