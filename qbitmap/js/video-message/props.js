// Single source of truth for the popup prop shape.
//
// Previously the same 15-18 field literal was reconstructed in map-layer.js,
// search-inbox.js, and cleanup.js (deep-link handler) with subtly different
// fields each time — aiDescriptionLang was missing from two of the three,
// and placeName from one. New popup features had to remember to update
// every copy. This helper keeps them in lockstep.

/**
 * Map a raw video_messages row (as returned by the backend) to the props
 * object that openMessagePopup expects. Safe to call with partial rows;
 * every optional field gets a sane empty-string / 0 default.
 *
 * @param {object} msg raw DB row (snake_case)
 * @returns {object} popup props (camelCase)
 */
export function buildMessagePopupProps(msg) {
  return {
    messageId: msg.message_id,
    senderId: msg.sender_id,
    senderName: msg.sender_name,
    senderAvatar: msg.sender_avatar,
    recipientId: msg.recipient_id,
    durationMs: msg.duration_ms,
    mimeType: msg.mime_type,
    mediaType: msg.media_type || 'video',
    isRead: msg.is_read,
    createdAt: msg.created_at,
    viewCount: msg.view_count || 0,
    likeCount: msg.like_count || 0,
    liked: msg.liked ? 'true' : 'false',
    description: msg.description || '',
    aiDescription: msg.ai_description || '',
    aiDescriptionLang: msg.ai_description_lang || '',
    tags: JSON.stringify(msg.tags || []),
    thumbnailPath: msg.thumbnail_path || '',
    placeName: msg.place_name || ''
  };
}
