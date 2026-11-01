'use strict';

// Process-local alarm, not a durable outbox. Never include exception text or payloads.
let writeFailures = 0;
let lastWriteFailureAt = null;
function health() { return { writeFailures, lastWriteFailureAt }; }

async function record(db, actorType, actorId, action, targetType, targetId, result) {
  try {
    await db.createModLog({ actorType, actorId: actorId == null ? null : String(actorId), action, targetType, targetId: String(targetId), result });
  } catch (_) {
    writeFailures += 1;
    lastWriteFailureAt = new Date().toISOString();
    console.error(`[mod-log] 監査記録欠落: writeFailures=${writeFailures}`);
    return false;
  }
  return true;
}

async function operation(db, actorType, actorId, action, targetType, targetId, run, falseResult = 'skipped') {
  let value;
  try {
    value = await run();
  } catch (error) {
    await record(db, actorType, actorId, action, targetType, targetId, 'failure');
    throw error;
  }
  await record(db, actorType, actorId, action, targetType, targetId, value ? 'success' : falseResult);
  return value;
}

module.exports = { record, operation, health };
