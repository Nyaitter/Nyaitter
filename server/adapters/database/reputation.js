'use strict';

const {noteIdFromScope,reviewerGroup,splitNoteEvents,compareCandidates,isTrustBasis,trustBasisQuery}=require('../../utils/noteReputation');

function normalizeEvents(events) {
  if (!Array.isArray(events) || events.length > 1000) throw new Error('Invalid reputation events');
  return events.map(e => {
    if (!['trust', 'ban'].includes(e.dimension) || !Number.isSafeInteger(e.userId) || e.userId <= 0
      || !Number.isFinite(e.amount) || Math.abs(e.amount) > 100 || !(e.cap === null || e.cap === -1 || (Number.isFinite(e.cap) && e.cap >= 0 && e.cap <= 100))
      || ![0, 1].includes(e.successes || 0) || !/^\d{4}-\d{2}-\d{2}$/.test(e.day) || !e.key) throw new Error('Invalid reputation event');
    // SQLのNOT NULL列では、JSONの「上限なし」を-1で保存する。
    return { ...e, cap: e.cap === null ? -1 : e.cap, successes: e.successes || 0, metadata: JSON.stringify(e.metadata || {}) };
  });
}

// 同じ利用者・日付の枠はまとめて適用し、無制限区分の総得点が途中状態に依存しないようにする。
function sortOrdered(events) {
  return events.map((event,index)=>({event,index})).sort((a,b)=>`${a.event.dimension}:${a.event.day}:${a.event.userId}`.localeCompare(`${b.event.dimension}:${b.event.day}:${b.event.userId}`) || a.index-b.index).map(item=>item.event);
}

function profileFromRows(rows) {
  const result = {};
  for (const r of rows || []) result[r.dimension] = { score: Number(r.score), successes: Number(r.successes), positiveDays: Number(r.positive_days || 0) };
  return result;
}

function reputationProfileQuery(dialect, multiple = false, excludeScope = false) {
  if (!['postgres', 'sqlite'].includes(dialect)) throw new Error('Invalid reputation database dialect');
  const least = dialect === 'postgres' ? 'LEAST' : 'MIN';
  const positive = `CASE WHEN cap=-1 THEN positive ELSE ${least}(positive-uncapped_positive,cap)+uncapped_positive END`;
  const successes = `CASE WHEN cap=-1 THEN successes ELSE ${least}(successes-uncapped_successes,${dialect === 'postgres' ? 'FLOOR(cap)' : 'CAST(cap AS INTEGER)'})+uncapped_successes END`;
  if (excludeScope) {
    if (multiple) throw new Error('Scope exclusion requires a single user');
    const user = dialect === 'postgres' ? '$1' : '?1';
    const scope = dialect === 'postgres' ? '$2' : '?2';
    const sourceScope=dialect==='postgres'?"metadata::jsonb->>'sourceScope'":"json_extract(metadata,'$.sourceScope')";
    return `WITH excluded AS (
      SELECT dimension,day,SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS positive,
        SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) AS negative,SUM(successes) AS successes,
        SUM(CASE WHEN cap=-1 AND amount>0 THEN amount ELSE 0 END) AS uncapped_positive,
        SUM(CASE WHEN cap=-1 THEN successes ELSE 0 END) AS uncapped_successes
      FROM reputation_events WHERE user_id=${user} AND (scope=${scope} OR (scope LIKE 'reviewer-outcome:%' AND ${sourceScope}=${scope})) GROUP BY dimension,day
    ), external_daily AS (
      SELECT d.user_id,d.dimension,d.cap,d.positive-COALESCE(e.positive,0) AS positive,
        d.negative-COALESCE(e.negative,0) AS negative,d.successes-COALESCE(e.successes,0) AS successes,
        d.uncapped_positive-COALESCE(e.uncapped_positive,0) AS uncapped_positive,
        d.uncapped_successes-COALESCE(e.uncapped_successes,0) AS uncapped_successes
      FROM reputation_daily d LEFT JOIN excluded e ON e.dimension=d.dimension AND e.day=d.day
      WHERE d.user_id=${user}
    ) SELECT user_id,dimension,SUM((${positive})+negative) AS score,
      SUM(${successes}) AS successes,
      SUM(CASE WHEN positive>0 AND (${positive})+negative>0 THEN 1 ELSE 0 END) AS positive_days
      FROM external_daily GROUP BY user_id,dimension`;
  }
  const filter = dialect === 'postgres'
    ? (multiple ? 'p.user_id=ANY($1::int[])' : 'p.user_id=$1')
    : (multiple ? 'p.user_id IN (SELECT value FROM json_each(?))' : 'p.user_id=?');
  return `SELECT p.user_id,p.dimension,p.score,p.successes,
    (SELECT COUNT(*) FROM reputation_daily d WHERE d.user_id=p.user_id AND d.dimension=p.dimension
      AND d.positive>0 AND (CASE WHEN d.cap=-1 THEN d.positive ELSE ${least}(d.positive-d.uncapped_positive,d.cap)+d.uncapped_positive END)+d.negative>0) AS positive_days
    FROM reputation_profiles p WHERE ${filter}`;
}

function sqliteReputationStatements(db, scope, input, evaluation) {
  const {noteId,events,candidates}=splitNoteEvents(scope,normalizeEvents(input));
  const guard = evaluation ? ' AND EXISTS(SELECT 1 FROM community_notes WHERE id=? AND rating_version=?)' : '';
  const args = evaluation ? [evaluation.noteId, evaluation.version] : [];
  const statements = [db.prepare(`DELETE FROM reputation_events WHERE scope=?${guard}`).bind(scope, ...args)];
  if (noteId!==null) {
    statements.push(db.prepare(`DELETE FROM reviewer_outcome_candidates WHERE note_id=?${guard}`).bind(noteId,...args));
    for (const e of candidates) statements.push(db.prepare(`INSERT INTO reviewer_outcome_candidates(note_id,user_id,author_id,day,rated_at,amount,successes,cap,metadata)
      SELECT ?,?,?,?,?,?,?,?,? WHERE 1=1${guard}`).bind(noteId,e.userId,e.authorId,e.day,e.ratedAt,e.amount,e.successes,e.cap,e.metadata,...args));
  }
  for (const e of events) statements.push(db.prepare(`INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata)
    SELECT ?,?,?,?,?,?,?,?,? WHERE 1=1${guard}`).bind(scope,e.key,e.userId,e.dimension,e.amount,e.successes,e.day,e.cap,e.metadata,...args));
  if (evaluation) {
    statements.push(db.prepare('UPDATE community_notes SET status=?,stage=?,published_at=CASE WHEN ?=\'public\' THEN COALESCE(published_at,?) ELSE published_at END,updated_at=? WHERE id=? AND rating_version=?')
      .bind(evaluation.status,evaluation.stage,evaluation.status,new Date().toISOString(),new Date().toISOString(),...args));
    statements.push(db.prepare(`UPDATE posts SET recommendation_penalty=MIN(1,?*(SELECT COUNT(*) FROM community_notes WHERE post_id=posts.id AND status='public')) WHERE id=(SELECT post_id FROM community_notes WHERE id=? AND rating_version=?)`)
      .bind(evaluation.penalty,...args));
    if (evaluation.status==='deleted') statements.push(db.prepare('DELETE FROM community_notes WHERE id=? AND rating_version=?').bind(...args));
  }
  return statements;
}

function installMemory(Adapter) {
  const reassignUserId=Adapter.prototype.reassignUserId;
  if (reassignUserId) Adapter.prototype.reassignUserId=async function(userId) {
    const previousId=Number(userId);const user=await reassignUserId.call(this,userId);
    if (!user) return user;
    for (const [key,e] of [...(this.reviewerOutcomeCandidates || [])]) {
      if (e.userId!==previousId && e.authorId!==previousId) continue;
      this.reviewerOutcomeCandidates.delete(key);
      if (e.userId===previousId) e.userId=Number(user.id);
      if (e.authorId===previousId) e.authorId=Number(user.id);
      e.metadata=JSON.stringify({...JSON.parse(e.metadata),authorId:e.authorId});
      this.reviewerOutcomeCandidates.set(`${e.noteId}:${e.userId}`,e);
    }
    for (const [scope,events] of [...(this.reputationEvents || [])]) {
      if (!scope.startsWith('reviewer-outcome:')) continue;
      for (const e of events) {const metadata=JSON.parse(e.metadata);if (Number(metadata.authorId)===previousId) e.metadata=JSON.stringify({...metadata,authorId:Number(user.id)});}
      if (events.length) {this.reputationEvents.delete(scope);this.reputationEvents.set(`reviewer-outcome:${reviewerGroup(events[0])}`,events);}
    }
    return user;
  };
  Adapter.prototype.refreshReviewerOutcomesForNote = async function(noteId) {
    this.reviewerOutcomeCandidates ||= new Map();
    const groups=new Set();
    for (const e of this.reviewerOutcomeCandidates.values()) if (e.noteId===Number(noteId)) groups.add(reviewerGroup(e));
    for (const e of this.reputationEvents?.get(`note:${Number(noteId)}`) || []) if (String(e.key).startsWith('reviewer:')) groups.add(reviewerGroup(e));
    // 保存済みの代表も対象に含め、このノートが取り下げられた枠を別のノートへ移す。
    for (const [group,winner] of this.reviewerOutcomeClaims || []) if (Number(winner)===Number(noteId)) groups.add(group);
    return this.refreshReviewerOutcomes([...groups]);
  };
  Adapter.prototype.refreshReviewerOutcomes = async function(groups) {
    for (const group of groups) {
      const [userId,authorId,day]=group.split(':');
      await this.replaceReputationEvents(`reviewer-outcome:${group}`,this.reviewerOutcomeEvents(userId,authorId,day));
    }
  };
  Adapter.prototype.reviewerOutcomeEvents = function(userId,authorId,day) {
    const group=`${Number(userId)}:${Number(authorId)}:${day}`;
    const winner=[...this.reviewerOutcomeCandidates?.values() || []].filter(e=>reviewerGroup(e)===group).sort(compareCandidates)[0];
    if (!winner) {this.reviewerOutcomeClaims?.delete(group);return [];}
    if (!this.users.has(Number(userId)) || !this.users.has(Number(authorId))) {this.reviewerOutcomeClaims?.delete(group);return [];}
    this.reviewerOutcomeClaims?.set(group,winner.noteId);
    return [{...winner,key:'outcome',metadata:JSON.parse(winner.metadata)}];
  };
  require('./reportReputation').installMemory(Adapter);
  Adapter.prototype.getReputationDisplayContext = async function(ids) {
    const profiles = {};
    for (const id of ids) profiles[id] = structuredClone(this.reputationProfiles?.get(Number(id)) || {});
    return { users: await this.getUsersByIds(ids), profiles };
  };
  const limited=(value,cap)=>cap===-1?value:Math.min(value,cap);
  const scoreOf=d=>limited(d.positive-(d.uncappedPositive || 0),d.cap)+(d.uncappedPositive || 0)+d.negative;
  const successesOf=d=>limited(d.successes-(d.uncappedSuccesses || 0),Math.floor(d.cap))+(d.uncappedSuccesses || 0);
  const deleteNote=Adapter.prototype.deleteNote;
  Adapter.prototype.deleteNote=async function(noteId) {
    const removed=await deleteNote.call(this,noteId);
    if (removed || !this.communityNotes.has(Number(noteId))) {
      this.reviewerOutcomeCandidates ||= new Map();
      for (const [key,e] of this.reviewerOutcomeCandidates) if (e.noteId===Number(noteId)) this.reviewerOutcomeCandidates.delete(key);
      await this.replaceReputationEvents(`note:${noteId}`,(this.reputationEvents?.get(`note:${noteId}`) || []).filter(e=>!String(e.key).startsWith('reviewer:') && e.amount<=0).map(e=>({...e,metadata:JSON.parse(e.metadata)})));
      await this.refreshReviewerOutcomesForNote(noteId);
    }
    return removed;
  };
  const deleteAccount=Adapter.prototype.deleteAccount;
  Adapter.prototype.deleteAccount=async function(userId) {
    const uid=Number(userId);const ownedPosts=[...this.posts.values()].filter(p=>Number(p.userId)===uid).map(p=>Number(p.id));
    const ownedNotes=[...this.communityNotes.values()].filter(n=>Number(n.userId)===uid || ownedPosts.includes(Number(n.postId)));
    const removed=await deleteAccount.call(this,userId);if (!removed) return removed;
    for (const note of ownedNotes) await this.deleteNote(note.id);
    for (const [scope,events] of this.reputationEvents || []) await this.replaceReputationEvents(scope,events.filter(e=>e.userId!==uid && !ownedPosts.some(id=>scope===`post-trust:${id}`)).map(e=>({...e,metadata:JSON.parse(e.metadata)})));
    this.reputationProfiles?.delete(uid);this.noteSelectionKeys?.delete(uid);
    this.noteCreationDaysByUser.delete(uid);
    for (const index of [this.likedUserIdsByPost,this.starredUserIdsByPost,this.noteRatingUsersByNote,this.noteDistributionUsersByNote]) for (const ids of index.values()) ids.delete(uid);
    for (const [key,row] of this.noteRatingReasons) if (row.userId===uid) this.noteRatingReasons.delete(key);
    for (const key of [...(this.reputationDaily?.keys() || [])]) if (key.startsWith(`${uid}:`)) this.reputationDaily.delete(key);
    for (const [key,row] of [...this.noteRatings,...this.noteDistributions]) if (row.userId===uid) {this.noteRatings.delete(key);this.noteDistributions.delete(key);}
    for (const [key,row] of this.noteCreationClaims || []) if (row.userId===uid) this.noteCreationClaims.delete(key);
    for (const key of this.reviewerOutcomeClaims?.keys() || []) if (key.startsWith(`${uid}:`) || key.split(':')[1]===String(uid)) this.reviewerOutcomeClaims.delete(key);
    return removed;
  };
  Adapter.prototype.getNoteSelectionKeys = async function(ids) {
    this.noteSelectionKeys ||= new Map();const out={};
    for (const id of ids.map(Number)) if (this.users.has(id)) {if (!this.noteSelectionKeys.has(id)) this.noteSelectionKeys.set(id,globalThis.crypto.randomUUID());out[id]=this.noteSelectionKeys.get(id);}
    return out;
  };
  Adapter.prototype.claimReviewerOutcome = async function(userId,authorId,day,noteId) {
    return this.reviewerOutcomeClaims?.get(`${userId}:${authorId}:${day}`)===Number(noteId);
  };
  Adapter.prototype.getReputationContext = async function(ids) {
    const wanted=new Set(ids.map(Number)); const edges=[]; const groups=new Map(); const profiles={};
    for (const uid of wanted) {
      profiles[uid]=await this.getReputationProfile(uid);
      for (const other of this.followingIdsByUser.get(uid) || []) if (wanted.has(other)) edges.push([uid,other]);
      for (const groupId of this.groupIdsByUser.get(uid) || []) {
        const m=this.groupMemberships.get(`${groupId}:${uid}`); if (m?.status!=='active') continue;
        if (!groups.has(groupId)) groups.set(groupId,[]); groups.get(groupId).push(uid);
      }
    }
    for (const members of groups.values()) for (const a of members) for (const b of members) if (a!==b) edges.push([a,b]);
    return {users:await Promise.all(ids.map(id=>this.getUserById(id))),profiles,edges};
  };
  Adapter.prototype.claimNoteNotification = async function(noteId,userId) {
    const row=this.noteDistributions.get(`${Number(noteId)}:${Number(userId)}`);
    if (!row || row.notified || row.tier===0) return false;
    row.notified=true; return true;
  };
  Adapter.prototype.releaseNoteNotification = async function(noteId,userId) {
    const row=this.noteDistributions.get(`${Number(noteId)}:${Number(userId)}`);
    if (!row || !row.notified) return false;
    row.notified=false; return true;
  };
  Adapter.prototype.claimReputationNotice = async function(key) {
    this.reputationNoticeClaims ||= new Set();
    if (this.reputationNoticeClaims.has(key)) return false;
    this.reputationNoticeClaims.add(key); return true;
  };
  Adapter.prototype.releaseReputationNotice = async function(key) {
    if (!this.reputationNoticeClaims) return false;
    return this.reputationNoticeClaims.delete(key);
  };
  Adapter.prototype.listNoteNegativeReasons = async function(noteId,userIds) {
    const allowed=Array.isArray(userIds)?new Set(userIds.map(Number)):null;
    const counts=new Map();
    for (const r of this.noteRatingReasons.values()) {
      if (Number(r.noteId)!==Number(noteId) || (allowed && !allowed.has(Number(r.userId))) || this.noteRatings.get(`${Number(noteId)}:${Number(r.userId)}`)?.helpful!==false) continue;
      counts.set(r.code,(counts.get(r.code)||0)+1);
    }
    return [...counts].sort((a,b)=>b[1]-a[1]).map(([code])=>this.noteReasonTagDefs.get(code)?.label).filter(Boolean).slice(0,3);
  };
  Adapter.prototype.getReputationEvidence = async function(userId,prefix) {
    return [...(this.reputationEvents || new Map()).entries()].filter(([scope])=>scope.startsWith(prefix)).flatMap(([scope,events])=>events.filter(e=>e.userId===Number(userId)).map(e=>({...e,scope,metadata:JSON.parse(e.metadata)})));
  };
  Adapter.prototype.getReputationProfile = async function(userId,{excludeScope=null}={}) {
    const uid=Number(userId);
    if (excludeScope!==null) {
      const dailyRows=new Map();
      for (const [key,daily] of this.reputationDaily || []) if (key.startsWith(`${uid}:`)) dailyRows.set(key,{...daily});
      const excluded=[...(this.reputationEvents?.get(excludeScope) || [])];
      for (const [scope,events] of this.reputationEvents || []) if (scope.startsWith('reviewer-outcome:')) excluded.push(...events.filter(e=>JSON.parse(e.metadata).sourceScope===excludeScope));
      for (const e of excluded) {
        if (e.userId!==uid) continue;
        const daily=dailyRows.get(`${uid}:${e.dimension}:${e.day}`);
        if (!daily) continue;
        daily.positive-=Math.max(e.amount,0);daily.negative-=Math.min(e.amount,0);daily.successes-=e.successes;
        if (e.cap===-1) {daily.uncappedPositive=(daily.uncappedPositive || 0)-Math.max(e.amount,0);daily.uncappedSuccesses=(daily.uncappedSuccesses || 0)-e.successes;}
      }
      const profile={};
      for (const [key,daily] of dailyRows) {
        const dimension=key.split(':')[1];
        const total=profile[dimension] ||= {score:0,successes:0,positiveDays:0};
        const score=scoreOf(daily);
        total.score+=score;total.successes+=successesOf(daily);
        if (daily.positive>0 && score>0) total.positiveDays++;
      }
      return profile;
    }
    const profile=structuredClone(this.reputationProfiles?.get(uid) || {});
    for (const total of Object.values(profile)) total.positiveDays=0;
    for (const [key,daily] of this.reputationDaily || []) {
      if (!key.startsWith(`${uid}:`) || daily.positive<=0 || scoreOf(daily)<=0) continue;
      const dimension=key.split(':')[1];
      if (profile[dimension]) profile[dimension].positiveDays++;
    }
    return profile;
  };
  Adapter.prototype.getTrustBasisProfile = async function(userId,{excludeScope=null}={}) {
    const days=new Map();
    for (const [scope,events] of this.reputationEvents || []) {
      if (scope===excludeScope) continue;
      for (const e of events) {
        if (e.userId!==Number(userId) || !isTrustBasis(e,scope)) continue;
        const row=days.get(e.day) || {positive:0,negative:0,successes:0,uncappedPositive:0,uncappedSuccesses:0,cap:-1};
        row.positive+=Math.max(0,e.amount);row.negative+=Math.min(0,e.amount);row.successes+=e.successes;
        if (e.cap===-1) {row.uncappedPositive+=Math.max(0,e.amount);row.uncappedSuccesses+=e.successes;}
        else row.cap=row.cap===-1?e.cap:Math.min(row.cap,e.cap);
        days.set(e.day,row);
      }
    }
    const trust={score:0,successes:0,positiveDays:0};
    for (const row of days.values()) {const score=scoreOf(row);trust.score+=score;trust.successes+=successesOf(row);if (score>0) trust.positiveDays++;}
    return {trust};
  };
  Adapter.prototype.replaceReputationEvents = async function(scope, input, evaluation = null) {
    const {noteId,events,candidates}=splitNoteEvents(scope,normalizeEvents(input));
    if (evaluation && (!this.communityNotes.has(Number(evaluation.noteId)) || (this.communityNotes.get(Number(evaluation.noteId)).ratingVersion || 0) !== evaluation.version)) return false;
    this.reputationEvents ||= new Map(); this.reputationDaily ||= new Map(); this.reputationProfiles ||= new Map();

    const update = (e, sign) => {
      const key = `${e.userId}:${e.dimension}:${e.day}`;
      const daily = this.reputationDaily.get(key) || { positive: 0, negative: 0, successes: 0, cap: e.cap };
      const oldScore = scoreOf(daily);
      const oldWins = successesOf(daily);
      daily.positive += sign*Math.max(e.amount,0); daily.negative += sign*Math.min(e.amount,0); daily.successes += sign*e.successes;
      if (e.cap===-1) {daily.uncappedPositive=(daily.uncappedPositive || 0)+sign*Math.max(e.amount,0);daily.uncappedSuccesses=(daily.uncappedSuccesses || 0)+sign*e.successes;}
      else if (daily.cap===-1 && sign===1) daily.cap=e.cap;
      this.reputationDaily.set(key,daily);
      const profile = this.reputationProfiles.get(e.userId) || {};
      const total = profile[e.dimension] || { score: 0, successes: 0 };
      total.score += scoreOf(daily)-oldScore;
      total.successes += successesOf(daily)-oldWins;
      profile[e.dimension] = total; this.reputationProfiles.set(e.userId,profile);
    };
    const replace=(key,rows)=>{
      for (const e of sortOrdered(this.reputationEvents.get(key) || [])) update(e,-1);
      for (const e of sortOrdered(rows)) update(e,1);
      this.reputationEvents.set(key,rows);
    };
    replace(scope,events);
    if (noteId!==null) {
      this.reviewerOutcomeCandidates ||= new Map();this.reviewerOutcomeClaims ||= new Map();
      const groups=new Set();
      for (const [key,e] of this.reviewerOutcomeCandidates) if (e.noteId===noteId) {groups.add(reviewerGroup(e));this.reviewerOutcomeCandidates.delete(key);}
      for (const e of candidates) {groups.add(reviewerGroup(e));this.reviewerOutcomeCandidates.set(`${noteId}:${e.userId}`,e);}
      for (const group of groups) {
        const winner=[...this.reviewerOutcomeCandidates.values()].filter(e=>reviewerGroup(e)===group).sort(compareCandidates)[0];
        replace(`reviewer-outcome:${group}`,winner?[{...winner,key:'outcome'}]:[]);
        if (winner) this.reviewerOutcomeClaims.set(group,winner.noteId);else this.reviewerOutcomeClaims.delete(group);
      }
    }
    if (evaluation) {
      const note = this.communityNotes.get(Number(evaluation.noteId));
      note.status=evaluation.status; note.stage=evaluation.stage; note.updatedAt=new Date();
      if (note.status==='public') note.publishedAt ||= new Date();
      const post = this.posts.get(Number(note.postId));
      if (post) post.recommendation_penalty=Math.min(1,[...(this.noteIdsByPost.get(Number(note.postId)) || [])].filter(id=>this.communityNotes.get(id)?.status==='public').length*evaluation.penalty);
      if (evaluation.status==='deleted') await this.deleteNote(evaluation.noteId);
    }
    return true;
  };
  Adapter.prototype.getNoteReviewData = async function(noteId) {
    const note = this.communityNotes.get(Number(noteId));
    if (!note) return null;
    return { version: note.ratingVersion || 0, ratings: [...(this.noteRatingUsersByNote.get(Number(noteId)) || [])].map(uid=>this.noteRatings.get(`${Number(noteId)}:${uid}`)).filter(Boolean).map(r => ({ ...r })).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt) || a.userId-b.userId) };
  };
  Adapter.prototype.listNotesForPosts = async function(ids) {
    return ids.map(Number).flatMap(pid=>[...(this.noteIdsByPost.get(pid) || [])]).map(id=>this.communityNotes.get(id)).filter(Boolean).map(n => this._formatNote(n,this._getNoteRatingSummary(n.id)));
  };
  Adapter.prototype.listPositivePostUsers = async function(postId,limit=200) {
    const ids = new Set([...(this.likedUserIdsByPost.get(Number(postId)) || []),...(this.starredUserIdsByPost.get(Number(postId)) || [])]);
    return [...ids].sort((a,b)=>a-b).slice(0,limit);
  };
}

function installPostgres(Adapter) {
  require('./reportReputation').installPostgres(Adapter);
  Adapter.prototype.getReputationDisplayContext = async function(ids) {
    const [users, result] = await Promise.all([this.getUsersByIds(ids), this.pool.query('SELECT user_id,dimension,score,successes FROM reputation_profiles WHERE user_id=ANY($1::int[])', [ids])]);
    const profiles = {};
    for (const row of result.rows) (profiles[Number(row.user_id)] ||= {})[row.dimension] = profileFromRows([row])[row.dimension];
    return { users, profiles };
  };
  Adapter.prototype.getNoteSelectionKeys = async function(ids) {
    await this.pool.query('INSERT INTO note_selection_identities(user_id) SELECT id FROM users WHERE id=ANY($1::int[]) ON CONFLICT DO NOTHING',[ids]);
    return Object.fromEntries((await this.pool.query('SELECT user_id,selection_key FROM note_selection_identities WHERE user_id=ANY($1::int[])',[ids])).rows.map(r=>[Number(r.user_id),r.selection_key]));
  };
  Adapter.prototype.claimReviewerOutcome = async function(userId,authorId,day,noteId) {
    return Number((await this.pool.query('SELECT note_id FROM reviewer_outcome_claims WHERE user_id=$1 AND author_id=$2 AND day=$3',[Number(userId),Number(authorId),day])).rows[0]?.note_id)===Number(noteId);
  };
  Adapter.prototype.getReputationContext = async function(ids) {
    const [users,profiles,edges]=await Promise.all([this.getUsersByIds(ids),this.pool.query(reputationProfileQuery('postgres',true),[ids]),this.pool.query(`SELECT follower_id AS a,following_id AS b FROM follows WHERE follower_id=ANY($1::int[]) AND following_id=ANY($1::int[]) UNION SELECT a.user_id,b.user_id FROM group_memberships a JOIN group_memberships b ON a.group_id=b.group_id WHERE a.user_id=ANY($1::int[]) AND b.user_id=ANY($1::int[]) AND a.status='active' AND b.status='active'`,[ids])]);
    const byUser={}; for (const row of profiles.rows) {byUser[row.user_id] ||= {};Object.assign(byUser[row.user_id],profileFromRows([row]));}
    return {users,profiles:byUser,edges:edges.rows.map(r=>[Number(r.a),Number(r.b)])};
  };
  Adapter.prototype.claimNoteNotification = async function(noteId,userId) {
    return (await this.pool.query('UPDATE note_distribution SET notified=TRUE WHERE note_id=$1 AND user_id=$2 AND NOT notified AND tier<>0 RETURNING note_id',[Number(noteId),Number(userId)])).rowCount>0;
  };
  Adapter.prototype.releaseNoteNotification = async function(noteId,userId) {
    return (await this.pool.query('UPDATE note_distribution SET notified=FALSE WHERE note_id=$1 AND user_id=$2 AND notified RETURNING note_id',[Number(noteId),Number(userId)])).rowCount>0;
  };
  Adapter.prototype.claimReputationNotice = async function(key) {
    return (await this.pool.query('INSERT INTO reputation_notice_claims(notice_key) VALUES($1) ON CONFLICT DO NOTHING',[key])).rowCount>0;
  };
  Adapter.prototype.releaseReputationNotice = async function(key) {
    return (await this.pool.query('DELETE FROM reputation_notice_claims WHERE notice_key=$1',[key])).rowCount>0;
  };
  Adapter.prototype.listNoteNegativeReasons = async function(noteId,userIds) {
    if (Array.isArray(userIds)) {
      const {rows}=await this.pool.query(`SELECT d.label_ja,COUNT(*) AS total FROM note_rating_reasons r JOIN note_reason_tag_defs d ON d.code=r.code JOIN note_ratings v ON v.note_id=r.note_id AND v.user_id=r.user_id WHERE r.note_id=$1 AND r.user_id=ANY($2::int[]) AND NOT v.helpful AND d.side='negative' GROUP BY d.label_ja ORDER BY total DESC,d.label_ja LIMIT 3`,[Number(noteId),userIds.map(Number)]);
      return rows.map(r=>r.label_ja);
    }
    const {rows}=await this.pool.query(`SELECT d.label_ja,COUNT(*) AS total FROM note_rating_reasons r JOIN note_reason_tag_defs d ON d.code=r.code JOIN note_ratings v ON v.note_id=r.note_id AND v.user_id=r.user_id WHERE r.note_id=$1 AND NOT v.helpful AND d.side='negative' GROUP BY d.label_ja ORDER BY total DESC,d.label_ja LIMIT 3`,[Number(noteId)]);
    return rows.map(r=>r.label_ja);
  };
  Adapter.prototype.getReputationEvidence = async function(userId,prefix) {
    const {rows}=await this.pool.query('SELECT scope,event_key,dimension,amount,successes,day,metadata FROM reputation_events WHERE user_id=$1 AND left(scope,length($2::text))=$2::text ORDER BY scope',[Number(userId),prefix]);
    return rows.map(r=>({...r,metadata:JSON.parse(r.metadata)}));
  };
  Adapter.prototype.getReputationProfile = async function(userId,{excludeScope=null}={}) {
    const args=excludeScope===null?[Number(userId)]:[Number(userId),excludeScope];
    return profileFromRows((await this.pool.query(reputationProfileQuery('postgres',false,excludeScope!==null),args)).rows);
  };
  Adapter.prototype.getTrustBasisProfile = async function(userId,{excludeScope=null}={}) {
    return profileFromRows((await this.pool.query(trustBasisQuery('postgres'),[Number(userId),excludeScope])).rows);
  };
  Adapter.prototype.replaceReputationEvents = async function(scope,input,evaluation=null) {
    const {noteId,events,candidates}=splitNoteEvents(scope,normalizeEvents(input));
    return this._withTransaction(async client => {
      await client.query('INSERT INTO reputation_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
      await client.query('SELECT scope FROM reputation_scopes WHERE scope=$1 FOR UPDATE',[scope]);
      if (evaluation) {
        const { rows }=await client.query('SELECT rating_version FROM community_notes WHERE id=$1 FOR UPDATE',[evaluation.noteId]);
        if (Number(rows[0]?.rating_version)!==evaluation.version) return false;
      }
      const previous=(await client.query('SELECT DISTINCT user_id FROM reputation_events WHERE scope=$1',[scope])).rows.map(r=>Number(r.user_id));
      const priorCandidates=noteId===null?[]:(await client.query('SELECT user_id FROM reviewer_outcome_candidates WHERE note_id=$1',[noteId])).rows.map(r=>Number(r.user_id));
      for (const uid of [...new Set([...previous,...priorCandidates,...events.map(e=>e.userId),...candidates.map(e=>e.userId)])].sort((a,b)=>a-b)) await client.query('SELECT pg_advisory_xact_lock(19710,$1)',[uid]);
      await client.query('DELETE FROM reputation_events WHERE scope=$1',[scope]);
      if (noteId!==null) {
        await client.query('DELETE FROM reviewer_outcome_candidates WHERE note_id=$1',[noteId]);
        for (const e of candidates) await client.query('INSERT INTO reviewer_outcome_candidates(note_id,user_id,author_id,day,rated_at,amount,successes,cap,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[noteId,e.userId,e.authorId,e.day,e.ratedAt,e.amount,e.successes,e.cap,e.metadata]);
      }
      for (const e of events) await client.query('INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[scope,e.key,e.userId,e.dimension,e.amount,e.successes,e.day,e.cap,e.metadata]);
      if (evaluation) {
        await client.query(`UPDATE community_notes SET status=$2,stage=$3,published_at=CASE WHEN $2='public' THEN COALESCE(published_at,NOW()) ELSE published_at END,updated_at=NOW() WHERE id=$1`,[evaluation.noteId,evaluation.status,evaluation.stage]);
        await client.query(`UPDATE posts SET recommendation_penalty=LEAST(1::real,$2::real*(SELECT COUNT(*) FROM community_notes WHERE post_id=posts.id AND status='public')) WHERE id=(SELECT post_id FROM community_notes WHERE id=$1)`,[evaluation.noteId,evaluation.penalty]);
        if (evaluation.status==='deleted') {
          await client.query('DELETE FROM community_notes WHERE id=$1',[evaluation.noteId]);
        }
      }
      return true;
    });
  };
  Adapter.prototype.getNoteReviewData = async function(noteId) {
    const { rows }=await this.pool.query(`SELECT n.rating_version,r.user_id,r.helpful,r.created_at,r.updated_at,r.weight FROM community_notes n LEFT JOIN note_ratings r ON r.note_id=n.id WHERE n.id=$1 ORDER BY r.created_at,r.user_id`,[Number(noteId)]);
    return rows.length ? { version:Number(rows[0].rating_version),ratings:rows.filter(r=>r.user_id!=null).map(r=>({userId:Number(r.user_id),helpful:r.helpful,createdAt:r.created_at,updatedAt:r.updated_at,weight:Number(r.weight)})) } : null;
  };
  Adapter.prototype.listNotesForPosts = async function(ids) {
    const {rows}=await this.pool.query('SELECT * FROM community_notes WHERE post_id=ANY($1::int[])', [ids.map(Number)]);
    return Promise.all(rows.map(row=>this._formatNote(row,{helpfulCount:0,totalRatingCount:0,myRating:null},[])));
  };
  Adapter.prototype.listPositivePostUsers = async function(postId,limit=200) {
    return (await this.pool.query('SELECT user_id FROM likes WHERE post_id=$1 UNION SELECT user_id FROM stars WHERE post_id=$1 ORDER BY user_id LIMIT $2',[Number(postId),limit])).rows.map(r=>Number(r.user_id));
  };
}

function installD1(Adapter) {
  Adapter.prototype.getReputationDisplayContext = async function(ids) {
    const batches = [];
    for (let offset = 0; offset < ids.length; offset += 500) batches.push(await this._write('/reputation/context', { ids: ids.slice(offset, offset + 500), displayOnly: true }));
    return { users: batches.flatMap(batch => batch.users), profiles: Object.assign({}, ...batches.map(batch => batch.profiles)) };
  };
  Adapter.prototype.getNoteSelectionKeys = async function(ids) {return this._write('/reputation/selection-keys',{ids});};
  Adapter.prototype.claimReviewerOutcome = async function(userId,authorId,day,noteId) {return this._write('/reputation/claim-reviewer-outcome',{userId,authorId,day,noteId});};
  Adapter.prototype.getReputationContext = async function(ids) { return this._write('/reputation/context',{ids}); };
  Adapter.prototype.claimNoteNotification = async function(noteId,userId) { return this._write('/reputation/claim-note-notification',{noteId:Number(noteId),userId:Number(userId)}); };
  Adapter.prototype.releaseNoteNotification = async function(noteId,userId) { return this._write('/reputation/release-note-notification',{noteId:Number(noteId),userId:Number(userId)}); };
  Adapter.prototype.claimReputationNotice = async function(key) { return this._write('/reputation/claim-notice',{key}); };
  Adapter.prototype.releaseReputationNotice = async function(key) { return this._write('/reputation/release-notice',{key}); };
  Adapter.prototype.listNoteNegativeReasons = async function(noteId,userIds) { const query=Array.isArray(userIds)?`?userIds=${encodeURIComponent(userIds.map(Number).join(','))}`:''; return this._read(`/community-notes/${Number(noteId)}/negative-reasons${query}`,{cacheSeconds:0}); };
  Adapter.prototype.getReputationEvidence = async function(userId,prefix) { return this._read(`/reputation/${Number(userId)}/evidence?prefix=${encodeURIComponent(prefix)}`,{cacheSeconds:0}); };
  Adapter.prototype.getReputationProfile = async function(userId,{excludeScope=null}={}) {
    const query=excludeScope===null?'':`?excludeScope=${encodeURIComponent(excludeScope)}`;
    return this._read(`/reputation/${Number(userId)}${query}`,{cacheSeconds:0});
  };
  Adapter.prototype.getTrustBasisProfile = async function(userId,{excludeScope=null}={}) {
    const query=excludeScope===null?'':`&excludeScope=${encodeURIComponent(excludeScope)}`;
    return this._read(`/reputation/${Number(userId)}?trustBasis=1${query}`,{cacheSeconds:0});
  };
  Adapter.prototype.replaceReputationEvents = async function(scope,events,evaluation=null) {
    normalizeEvents(events);
    return this._write('/reputation/events',{scope,events,evaluation});
  };
  Adapter.prototype.getNoteReviewData = async function(noteId) { return this._read(`/community-notes/${Number(noteId)}/review-data`,{cacheSeconds:0}); };
  Adapter.prototype.listNotesForPosts = async function(ids) { return this._write('/community-notes/by-posts',{ids:ids.map(Number)}); };
  Adapter.prototype.listPositivePostUsers = async function(postId,limit=200) { return this._read(`/posts/${Number(postId)}/positive-users?limit=${limit}`,{cacheSeconds:0}); };
  Adapter.prototype.syncReportReputation = async function(reportId,options) {
    try { return await this._write('/reputation/report',{...options,reportId:Number(reportId)}); }
    catch (error) { if ([400,404,409].includes(error.status)) error.statusCode=error.status; throw error; }
  };
}

module.exports = { installMemory,installPostgres,installD1,normalizeEvents,profileFromRows,reputationProfileQuery,sqliteReputationStatements,trustBasisQuery };
