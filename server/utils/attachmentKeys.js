'use strict';

function createAttachmentReplacementMap(replacements) {
  const replacementMap = new Map();
  for (const replacement of Array.isArray(replacements) ? replacements : []) {
    const sourceKey = typeof replacement?.sourceKey === 'string' ? replacement.sourceKey : null;
    const destinationKey = typeof replacement?.destinationKey === 'string' ? replacement.destinationKey : null;
    if (!sourceKey || !destinationKey) continue;
    replacementMap.set(sourceKey, {
      destinationKey,
      url: replacement.url ?? null,
    });
  }
  return replacementMap;
}

function rewriteAttachmentReferences(attachments, replacements) {
  const replacementMap = replacements instanceof Map
    ? replacements
    : createAttachmentReplacementMap(replacements);
  if (!Array.isArray(attachments) || replacementMap.size === 0) {
    return { attachments: Array.isArray(attachments) ? attachments : [], changed: false };
  }

  let changed = false;
  const rewritten = attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return attachment;
    const sourceKey = typeof attachment.id === 'string'
      ? attachment.id
      : (typeof attachment.key === 'string' ? attachment.key : null);
    const replacement = sourceKey ? replacementMap.get(sourceKey) : null;
    if (!replacement) return attachment;

    changed = true;
    const next = { ...attachment };
    if (typeof attachment.id === 'string') next.id = replacement.destinationKey;
    if (typeof attachment.key === 'string') next.key = replacement.destinationKey;
    if (Object.prototype.hasOwnProperty.call(next, 'url')) next.url = replacement.url;
    return next;
  });

  return { attachments: rewritten, changed };
}

module.exports = {
  createAttachmentReplacementMap,
  rewriteAttachmentReferences,
};
