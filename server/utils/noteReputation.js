'use strict';

function noteIdFromScope(scope) {
  return /^note:[1-9]\d*$/.test(scope) ? Number(scope.slice(5)) : null;
}

function reviewerGroup(event) {
  const metadata=typeof event.metadata==='string'?JSON.parse(event.metadata):event.metadata;
  return `${event.userId}:${metadata.authorId}:${event.day}`;
}

function splitNoteEvents(scope,events) {
  const noteId=noteIdFromScope(scope);
  if (noteId===null) return {noteId,events,candidates:[]};
  const candidates=[];
  for (const event of events) {
    if (!String(event.key).startsWith('reviewer:')) continue;
    const metadata=JSON.parse(event.metadata);
    const authorId=Number(metadata.authorId);
    const ratedAt=new Date(metadata.ratedAt);
    if (!Number.isSafeInteger(authorId) || authorId<=0 || !Number.isFinite(ratedAt.getTime())) throw new Error('Invalid reviewer outcome candidate');
    candidates.push({...event,noteId,authorId,ratedAt:ratedAt.toISOString(),metadata:JSON.stringify({...metadata,noteId,sourceScope:scope,ratedAt:ratedAt.toISOString()})});
  }
  return {noteId,events:events.filter(e=>!String(e.key).startsWith('reviewer:')),candidates};
}

function compareCandidates(a,b) {
  return a.ratedAt.localeCompare(b.ratedAt) || a.noteId-b.noteId;
}

function isTrustBasis(event,scope) {
  const metadata=typeof event.metadata==='string'?JSON.parse(event.metadata):event.metadata;
  return event.dimension==='trust' && (event.amount<=0 || !scope.startsWith('note:') || metadata?.independentWriter===true);
}

function trustBasisQuery(dialect) {
  if (!['postgres','sqlite'].includes(dialect)) throw new Error('Invalid reputation database dialect');
  const pg=dialect==='postgres';
  const user=pg?'$1':'?1'; const scope=pg?'$2::text':'?2'; const least=pg?'LEAST':'MIN';
  const independent=pg?"metadata::jsonb->'independentWriter'='true'::jsonb":"json_type(metadata,'$.independentWriter')='true'";
  return `WITH daily AS (
    SELECT day,SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS positive,
      SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) AS negative,SUM(successes) AS successes,
      SUM(CASE WHEN cap=-1 AND amount>0 THEN amount ELSE 0 END) AS uncapped_positive,
      SUM(CASE WHEN cap=-1 THEN successes ELSE 0 END) AS uncapped_successes,
      COALESCE((SELECT d.cap FROM reputation_daily d WHERE d.user_id=${user} AND d.dimension='trust' AND d.day=reputation_events.day),-1) AS cap
    FROM reputation_events WHERE user_id=${user} AND dimension='trust' AND (${scope} IS NULL OR scope<>${scope})
      AND (amount<=0 OR scope NOT LIKE 'note:%' OR ${independent}) GROUP BY day
  ), totals AS (
    SELECT (CASE WHEN cap=-1 THEN positive ELSE ${least}(positive-uncapped_positive,cap)+uncapped_positive END)+negative AS score,
      CASE WHEN cap=-1 THEN successes ELSE ${least}(successes-uncapped_successes,${pg?'FLOOR(cap)':'CAST(cap AS INTEGER)'})+uncapped_successes END AS successes
    FROM daily
  ) SELECT 'trust' AS dimension,COALESCE(SUM(score),0) AS score,COALESCE(SUM(successes),0) AS successes,
    COALESCE(SUM(CASE WHEN score>0 THEN 1 ELSE 0 END),0) AS positive_days FROM totals`;
}

module.exports={noteIdFromScope,reviewerGroup,splitNoteEvents,compareCandidates,isTrustBasis,trustBasisQuery};
