'use strict';

const crypto=require('crypto');
const {canViewPost}=require('../utils/postVisibility');
const {hasBlockRelationship,blocksUser}=require('../utils/blockRelationship');
const {rankOf}=require('../utils/reputationPolicy');
const {createNotificationIfAllowed}=require('./NotificationDeliveryService');
const reputation=require('./ReputationService');
const {policy,event,serialized}=reputation;
const noteEvaluation=require('../utils/noteEvaluation');
const sharedGroupRelevance=0.2;

function batchRelevance(userId,authorId,context) {
  if(context.relevanceByUser?.has(Number(userId)))return Number(context.relevanceByUser.get(Number(userId)));
  const first=new Set(context.followingByUser.get(Number(userId))||[]);
  const second=new Set(context.followingByUser.get(Number(authorId))||[]);
  const union=new Set([...first,...second]);
  return (union.size?[...first].filter(id=>second.has(id)).length/union.size:0)
    +(context.sharedUserIds.has(Number(userId))?sharedGroupRelevance:0);
}

function sample(note,userId,selectionKey=String(userId)) {
  const bytes=crypto.createHash('sha256').update(`notes-v1:${note.distributionKey || `${note.postId}:${note.userId}`}:${selectionKey}`).digest();
  return bytes.readUInt32BE(0)/0x100000000;
}

async function relevance(db,userId,authorId) {
  const [a,b,shared]=await Promise.all([db.getUserFollows(userId),db.getUserFollows(authorId),db.getSharedGroupMembership(userId,authorId)]);
  const first=new Set(a.map(Number)); const second=new Set(b.map(Number)); const union=new Set([...first,...second]);
  return (union.size?[...first].filter(id=>second.has(id)).length/union.size:0)+(shared.total>0?sharedGroupRelevance:0);
}

async function writeDistributions(db,rows) {
  if(!rows.length)return;
  if(typeof db.upsertNoteDistributions==='function')return db.upsertNoteDistributions(rows);
  for(const row of rows)await db.upsertNoteDistribution(row);
}

async function cachedValue(cache,key,load) {
  if(!cache)return load();
  if(!cache.has(key))cache.set(key,Promise.resolve().then(load));
  return cache.get(key);
}

async function canRead(db,note,userId,post=null) {
  const uid=Number(userId);
  if (!note || !Number.isSafeInteger(uid) || uid<=0) return false;
  post ||= await db.getPostById(note.postId);
  if (!await db.getUserById(uid)) return false;
  if (!post || !await canViewPost(db,post,userId) || await hasBlockRelationship(db,userId,note.userId)) return false;
  if (Number(note.userId)===Number(userId) || note.status==='public') return true;
  const rated=(await db.getRatingsSummary(note.id,userId)).myRating!==null;
  if (note.status==='rejected') return rated;
  if (!['limited','review'].includes(note.status)) return false;
  if (rated) return true;
  const engaged=(await db.listEngagedUsersByPost(note.postId)).map(Number).includes(uid);
  if (await computeNoteRelevance(db,note,uid,engaged)) return true;
  // 通知の最低一人選択も、保存済みシードではなく現在の閲覧条件から再計算する。
  if (!engaged) return false;
  try {
    return (await selectEngagedCandidates(db,note,post)).some(candidate=>candidate.uid===uid);
  } catch (error) {
    // 選択キーが未設定なら候補を判定できないため、安全側（閲覧不可）に倒す。
    if (error.code==='NOTE_EVALUATION_KEY_MISSING') return false;
    throw error;
  }
}

async function computeNoteRelevance(db,note,userId,engaged=false,review=null,selectionKey=null,cache=null) {
  if (review == null) review = ['review','public'].includes(note.status);
  if (Number(userId)===Number(note.userId)) return false;
  const profile=await cachedValue(cache?.profiles,Number(userId),()=>db.getReputationProfile(userId));
  const coverage=policy.reviewerVisibility[rankOf(profile.reviewer,policy.reviewer)];
  const baseRate=engaged?(review?policy.notes.reviewEngagedRate:policy.notes.engagedRate):(review?policy.notes.reviewIncidentalRate:policy.notes.incidentalRate);
  const rate=baseRate+(1-baseRate)*coverage;
  selectionKey ||= (await db.getNoteSelectionKeys([userId]))[userId];
  if (!selectionKey || sample(note,userId,selectionKey)>=rate) return false;
  const limit=review?policy.notes.reviewRelevanceLimit:policy.notes.relevanceLimit;
  const maxRelevance=1+sharedGroupRelevance;
  const authorId=Number(note.userId);
  const followsUser=await cachedValue(cache?.follows,Number(userId),()=>db.getUserFollows(userId));
  const followsAuthor=await cachedValue(cache?.follows,authorId,()=>db.getUserFollows(authorId));
  const shared=await cachedValue(cache?.shared,`${Number(userId)}:${authorId}`,()=>db.getSharedGroupMembership(userId,authorId));
  const first=new Set(followsUser.map(Number)),second=new Set(followsAuthor.map(Number)),union=new Set([...first,...second]);
  const score=(union.size?[...first].filter(id=>second.has(id)).length/union.size:0)+(shared.total>0?sharedGroupRelevance:0);
  return score<=limit+(maxRelevance-limit)*coverage;
}

const selected = computeNoteRelevance;

async function selectEngagedCandidates(db,note,post) {
  const postAuthor=Number(post.userId ?? post.user_id);
  const review=note.status==='review';
  const rate=review?policy.notes.reviewEngagedRate:policy.notes.engagedRate;
  const relevanceLimit=review?policy.notes.reviewRelevanceLimit:policy.notes.relevanceLimit;
  const candidateKey=process.env.NOTE_EVALUATION_HMAC_SECRET;
  if (typeof candidateKey!=='string'||Buffer.byteLength(candidateKey)<32) {
    const error=new Error('NOTE_EVALUATION_HMAC_SECRET は32バイト以上で設定してください');error.code='NOTE_EVALUATION_KEY_MISSING';throw error;
  }
  const selectionKey=crypto.createHmac('sha256',candidateKey).update('nyaitter:community-note-distribution-candidates:v1').digest();
  const excluded=[postAuthor,Number(note.userId)];
  let ids=[];
  if (typeof db.listEngagedUsersByPostPage==='function') {
    let afterUserId=0;
    while (true) {
      const page=await db.listEngagedUsersByPostPage(note.postId,{afterUserId,limit:500});
      if (!Array.isArray(page)||page.length===0) break;
      const eligible=page.map(Number).filter(id=>id!==postAuthor&&id!==Number(note.userId));
      const pageSample=noteEvaluation.sampleNoteCandidates({candidateIds:eligible,excludedIds:excluded,limit:policy.notes.maxCandidates,selectionKey,noteKey:`note:${Number(note.id)}:engaged-distribution`});
      ids=noteEvaluation.sampleNoteCandidates({candidateIds:[...ids,...pageSample],excludedIds:excluded,limit:policy.notes.maxCandidates,selectionKey,noteKey:`note:${Number(note.id)}:engaged-distribution`});
      afterUserId=Number(page[page.length-1]);
      if (page.length<500) break;
    }
  } else {
    const all=(await db.listEngagedUsersByPost(note.postId)).map(Number).filter(id=>id!==postAuthor&&id!==Number(note.userId));
    ids=noteEvaluation.sampleNoteCandidates({candidateIds:all,excludedIds:excluded,limit:policy.notes.maxCandidates,selectionKey,noteKey:`note:${Number(note.id)}:engaged-distribution`});
  }
  const keys=await db.getNoteSelectionKeys(ids);
  const candidates=[];
  const pageSize=100;
  for(let offset=0;offset<ids.length;offset+=pageSize){
    const batch=ids.slice(offset,offset+pageSize);
    const context=typeof db.getNoteRelevanceContext==='function'?await db.getNoteRelevanceContext([...batch,postAuthor],Number(note.userId)):null;
    const usersById=new Map((context?.users||[]).map(user=>[Number(user.id),user]));
    const postAuthorUser=usersById.get(postAuthor);
    const simplePublicPost=!post.groupId&&!post.group_id&&!post.lock&&!post.scheduledAt&&!post.scheduled_at&&!postAuthorUser?.settings?.lock;
    for (const uid of batch) {
      const user=usersById.get(uid);
      let viewable=false,blockedFromNoteAuthor=false,rel;
      if(context&&user){
        blockedFromNoteAuthor=blocksUser(user,note.userId)||blocksUser(usersById.get(Number(note.userId)),uid);
        if(simplePublicPost)viewable=!blocksUser(user,postAuthor)&&!blocksUser(postAuthorUser,uid);
        else viewable=await canViewPost(db,post,uid);
        rel=batchRelevance(uid,Number(note.userId),context);
      }else{
        viewable=await canViewPost(db,post,uid);
        blockedFromNoteAuthor=await hasBlockRelationship(db,uid,note.userId);
        rel=await relevance(db,uid,note.userId);
      }
      if (!user && context || !viewable || blockedFromNoteAuthor) continue;
      const selectionKey=keys[uid];if(!selectionKey)continue;
      const sampleScore=sample(note,uid,selectionKey);
      candidates.push({uid,selectionKey,sampleScore,rel,pass:sampleScore<rate&&rel<=relevanceLimit});
    }
  }
  // 候補が1人でもいる場合、0人配布にならないように安定選択で少なくとも1人を選ぶ。
  // ただしフォールバックでも関連度上限は尊重し、上限内の候補がいなければ配布しない。
  let chosen=candidates.filter(c=>c.pass);
  if (chosen.length===0) {
    const withinLimit=candidates.filter(c=>c.rel<=relevanceLimit)
      .sort((a,b)=>a.rel-b.rel || a.sampleScore-b.sampleScore || a.uid-b.uid);
    chosen=withinLimit.slice(0,1);
  } else {
    // deterministic stable ordering
    chosen=chosen.sort((a,b)=>a.sampleScore-b.sampleScore || a.rel-b.rel || a.uid-b.uid);
    const k=Math.max(1,Math.ceil(candidates.length*rate));
    chosen=chosen.slice(0,k);
  }
  return chosen;
}

async function captureVoteRelations(db,note,userId,post) {
  const initialReview=await db.getNoteReviewData(note.id);
  if (!initialReview) throw new Error('投票状態が取得できません');
  const postAuthorId=Number(post.userId ?? post.user_id);
  const user=Number(userId);
  const evidence=await db.getNoteVoteEvidence(note.id);
  if (!evidence || evidence.version!==initialReview.version) { const error=new Error('投票状態が同時に変更されました');error.code='NOTE_VOTE_CONFLICT';throw error; }
  const admissions=evidence.admissions.map(row=>({
    userId:Number(row.userId ?? row.user_id), revision:Number(row.revision), admittedAt:row.admittedAt ?? row.admitted_at, legacy:Boolean(row.legacy),
    relationManifest:row.relationManifest ?? row.relation_manifest ?? null,
  }));
  const own=admissions.filter(row=>row.userId===user&&!row.legacy).sort((a,b)=>b.revision-a.revision)[0];
  const previousManifest=admissions.filter(row=>row.relationManifest).sort((a,b)=>(b.relationManifest.coveredUserIds?.length||0)-(a.relationManifest.coveredUserIds?.length||0)||String(b.admittedAt||'').localeCompare(String(a.admittedAt||'')))[0]?.relationManifest;
  if (own?.relationManifest&&previousManifest) return {ratingVersion:initialReview.version,relationManifest:previousManifest};

  const previousUsers=[...new Set(admissions.filter(row=>!row.legacy&&row.relationManifest).map(row=>row.userId))];
  const covered=new Set([Number(note.userId),postAuthorId,...previousUsers,user]);
  const ids=[...covered].sort((a,b)=>a-b);
  const context=await reputation.independenceContext(db,ids);
  if (ids.some(id=>!context.byId.has(id))) throw new Error('関係情報の完全性を確認できません');
  const edges=new Map();
  for (const [a,b] of previousManifest?.edges || []) edges.set(`${Math.min(a,b)}:${Math.max(a,b)}`,[Math.min(a,b),Math.max(a,b)]);
  const isNewUser=!previousManifest || !previousManifest.coveredUserIds.includes(user);
  if (isNewUser) {
    for (const other of ids) {
      if (other===user) continue;
      const first=context.byId.get(user),second=context.byId.get(other);
      const related=context.edges.has(`${user}:${other}`)||context.edges.has(`${other}:${user}`)
        ||(first.block||[]).map(Number).includes(other)||(second.block||[]).map(Number).includes(user);
      if (related) edges.set(`${Math.min(user,other)}:${Math.max(user,other)}`,[Math.min(user,other),Math.max(user,other)]);
    }
  }
  const normalizedEdges=[...edges.values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const version=crypto.createHash('sha256').update(JSON.stringify([Number(note.id),ids,normalizedEdges])).digest('hex');
  const finalReview=await db.getNoteReviewData(note.id);
  if (!finalReview || finalReview.version!==initialReview.version) {
    const error=new Error('投票状態が同時に変更されました');error.code='NOTE_VOTE_CONFLICT';throw error;
  }
  return {ratingVersion:initialReview.version,relationManifest:{basis:'admission-evidence',complete:true,version,evidenceRef:`note:${Number(note.id)}:relations:${version}`,coveredUserIds:ids,edges:normalizedEdges}};
}

function evidenceError(message) {
  const error=new Error(message);error.code='NOTE_VOTE_EVIDENCE_INCOMPLETE';return error;
}

function noteEvaluationKey() {
  const secret=process.env.NOTE_EVALUATION_HMAC_SECRET;
  if (typeof secret!=='string'||Buffer.byteLength(secret)<32) {
    const error=new Error('NOTE_EVALUATION_HMAC_SECRET は32バイト以上で設定してください');error.code='NOTE_EVALUATION_KEY_MISSING';throw error;
  }
  return crypto.createHmac('sha256',secret).update('nyaitter:community-note-independent-voters:v1').digest();
}

async function summarizeNoteEvidence(db,note,post) {
  const data=await db.getNoteVoteEvidence(note.id);
  if (!data || !Number.isSafeInteger(data.version) || !Array.isArray(data.ratings) || !Array.isArray(data.admissions)) throw evidenceError('投票証跡を一括取得できません');
  if (!data.ratings.length) {
    // 票が0件でも過去の reputation イベントを巻き戻せるよう、空の集計として扱う。
    return {data,summary:{count:0,helpfulCount:0,ratio:0,weightedRatio:0,selectedUserIds:[]},snapshot:{votes:[]},empty:true};
  }
  if (data.ratings.length>policy.notes.maxRatings) throw evidenceError('受付票数が設定上限を超えています');
  const noteAuthorId=Number(note.userId),postAuthorId=Number(post.userId ?? post.user_id);
  const latestAdmissions=new Map();
  for (const row of data.admissions) {
    const userId=Number(row.userId ?? row.user_id),revision=Number(row.revision);
    if (!Number.isSafeInteger(userId)||!Number.isSafeInteger(revision)||revision<1) throw evidenceError('受付証跡の改訂番号が不正です');
    const previous=latestAdmissions.get(userId);
    if (!previous||revision>previous.revision) latestAdmissions.set(userId,{...row,userId,revision});
    else if (revision===previous.revision) throw evidenceError('受付証跡の改訂番号が重複しています');
  }
  const ratings=[...data.ratings].sort((a,b)=>Number(a.userId)-Number(b.userId));
  const admissions=[];
  for (const row of ratings) {
    const userId=Number(row.userId),admission=latestAdmissions.get(userId);
    if (!admission||admission.legacy||admission.authorized!==true||!admission.evidenceRef
      || Number(row.revision)!==admission.revision||row.castAt!==admission.admittedAt
      || Number(row.weight)!==Number(admission.weight)) throw evidenceError('legacy票または不足・不一致の受付証跡があります');
    admissions.push({userId,noteId:Number(note.id),revision:admission.revision,authorized:true,admittedAt:admission.admittedAt,evidenceRef:admission.evidenceRef});
  }
  const coveredIds=[...ratings.map(row=>Number(row.userId)),noteAuthorId,postAuthorId];
  const relationRows=data.admissions.map(row=>({manifest:row.relationManifest ?? row.relation_manifest,admittedAt:row.admittedAt ?? row.admitted_at})).filter(row=>row.manifest)
    .sort((a,b)=>(b.manifest.coveredUserIds?.length||0)-(a.manifest.coveredUserIds?.length||0)||String(b.admittedAt||'').localeCompare(String(a.admittedAt||'')));
  const relations=relationRows[0]?.manifest;
  if (!relations||relations.basis!=='admission-evidence'||relations.complete!==true||!Array.isArray(relations.coveredUserIds)
    || coveredIds.some(id=>!relations.coveredUserIds.includes(id))) throw evidenceError('関係manifestのcoverageが現行票を網羅していません');
  const sourceVersion=crypto.createHash('sha256').update(JSON.stringify([data.version,relations.version,admissions.map(row=>[row.userId,row.revision,row.evidenceRef])])).digest('hex');
  let snapshot,summary;
  try {
    snapshot=noteEvaluation.createVoteSnapshot({noteId:Number(note.id),noteAuthorId,postAuthorId,ratingVersion:data.version,sourceVersion,capturedAt:new Date().toISOString(),
      ratings:ratings.map(row=>({userId:Number(row.userId),helpful:row.helpful,weight:Number(row.weight),revision:Number(row.revision),castAt:row.castAt})),
      admissions,relations,revocations:[]});
    summary=noteEvaluation.summarizeIndependentVotes(snapshot,{selectionKey:noteEvaluationKey(),noteKey:`note:${Number(note.id)}`,maxWeight:policy.notes.maxWeight});
  } catch (error) {
    if (error.code==='NOTE_EVALUATION_KEY_MISSING') throw error;
    throw evidenceError('受付証跡snapshotの検証に失敗しました');
  }
  return {data,summary,snapshot};
}

// claim は通知作成の直前に取得する。作成に失敗したら claim を解放し、次回の評価で再送できるようにする。
// 解放はアダプタが release 系メソッドを持つ場合に限られるため、無い場合は失敗をログに残す。
async function notifyWithClaim(db,{claim,release,payload}) {
  if (!await claim()) return false;
  try {
    await createNotificationIfAllowed(db,payload);
    return true;
  } catch (error) {
    console.error('[notes] notification failed:',error.message);
    if (release) {
      try { await release(); } catch (releaseError) { console.error('[notes] notification claim release failed:',releaseError.message); }
    }
    return false;
  }
}

async function distributeEngaged(db,note) {
  const post=await db.getPostById(note.postId); if (!post) return;
  const review=note.status==='review';
  const candidates=await selectEngagedCandidates(db,note,post);
  const existingRows=typeof db.getNoteDistributionStates==='function'
    ? await db.getNoteDistributionStates(note.id,candidates.map(candidate=>candidate.uid))
    : await db.listNoteDistributionsByNote(note.id);
  const existing=new Set(existingRows.map(row=>Number(row.userId??row.user_id)));
  const fresh=candidates.filter(candidate=>!existing.has(candidate.uid));
  const distributions=fresh.map(candidate=>({noteId:Number(note.id),userId:candidate.uid,tier:review?2:1,notified:false}));
  await writeDistributions(db,distributions);
  for (const c of fresh) {
    const uid=c.uid;
    await notifyWithClaim(db,{
      claim:()=>db.claimNoteNotification(note.id,uid),
      release:typeof db.releaseNoteNotification==='function'?()=>db.releaseNoteNotification(note.id,uid):null,
      payload:{userId:uid,type:'community_note',fromUserId:note.userId,postId:note.postId,message:'コミュニティノートへの評価をお願いします。'},
    });
  }
}

async function distributeTimeline(db,postIds,userId) {
  if (!userId || !postIds.length) return;
  const notes=await db.listNotesForPosts(postIds.slice(0,100));
  if (!notes.length) return;
  const key=(await db.getNoteSelectionKeys([userId]))[userId];
  const posts=new Map((await db.getPostsByIds(postIds)).map(p=>[Number(p.id),p]));
  const engaged=new Map();
  const bulkExisting=typeof db.listNoteDistributionsByUser==='function';
  const existing=new Set(bulkExisting
    ? (await db.listNoteDistributionsByUser(userId)).map(row=>Number(row.noteId??row.note_id))
    : []);
  const relevanceCache={profiles:new Map(),follows:new Map(),shared:new Map()};
  const additions=[];
  const distribute=async()=>{
    const rows=additions.splice(0,additions.length);
    await writeDistributions(db,rows);
  };
  for (const note of notes) {
    if (!['limited','review'].includes(note.status) || Number(note.userId)===Number(userId)) continue;
    const post=posts.get(Number(note.postId));
    if (!post || !await canViewPost(db,post,userId) || await hasBlockRelationship(db,userId,note.userId)) continue;
    if (existing.has(Number(note.id)) || (!bulkExisting && await db.getNoteDistribution(note.id,userId))) continue;
    if (!engaged.has(note.postId)) engaged.set(note.postId,new Set((await db.listEngagedUsersByPost(note.postId)).map(Number)));
    const isEngaged=engaged.get(note.postId).has(Number(userId));
    if (Number(post.userId ?? post.user_id)===Number(userId)) continue;
    if (await computeNoteRelevance(db,note,userId,isEngaged,note.status==='review',key,relevanceCache)) {
      additions.push({noteId:Number(note.id),userId:Number(userId),tier:isEngaged?1:0,notified:false});existing.add(Number(note.id));
      if(additions.length>=500)await distribute();
    }
  }
  await distribute();
}

async function evaluate(noteId,db,audit=null) {
  return serialized(db,`note:${noteId}`,async()=>{
    for (let attempt=0;attempt<3;attempt++) {
      const note=await db.getNote(noteId); if (!note) return null;
      const post=await db.getPostById(note.postId); if (!post) return null;
      const postAuthor=Number(post.userId ?? post.user_id);
      const {data,summary,snapshot,empty=false}=await summarizeNoteEvidence(db,note,post);
      const count=summary.count,helpful=summary.helpfulCount,ratio=summary.ratio,weighted=summary.weightedRatio;
      const votes=snapshot.votes.filter(vote=>summary.selectedUserIds.includes(vote.userId));
      const dist=await db.listNoteDistributionsByNote(noteId);
      const quorum=Math.max(policy.notes.minReviewVotes,Math.ceil(dist.length*policy.notes.quorumRate));
      const profile=await db.getReputationProfile(note.userId,{excludeScope:`note:${note.id}`});
      const basis=await db.getWriterQualificationProfile(note.userId,{excludeScope:`note:${note.id}`});
      const writerRank=rankOf(basis.writer,policy.writer); const reviewerRank=rankOf(profile.reviewer,policy.reviewer);
      const publicRatio=policy.notes.publicRatio-policy.writer[writerRank].publicRatioReduction;
      let status='limited';
      // 公開は割合優先の仕様に基づき、quorum ではなく minPublicSample を最低標本とする意図的な非対称（却下・審査は quorum 必須）。
      if (count>=quorum && (1-ratio)>=policy.notes.rejectRatio && (1-weighted)>=policy.notes.rejectRatio) status='rejected';
      else if (count>=policy.notes.minPublicSample && ratio>=publicRatio && weighted>=publicRatio) status='public';
      else if (count>=quorum && ratio>=policy.notes.reviewRatio && weighted>=policy.notes.reviewRatio) status='review';
      else if (note.status==='review' || note.status==='public') status='review';
      // 票が全て消えた場合は根拠がないため、公開・審査の状態を保持しない。
      if (empty) status='limited';
      const day=new Date(note.createdAt).toISOString().slice(0,10);
      const events=[];
      if (status==='public') events.push(event('writer',note.userId,'writer',2+policy.reviewer[reviewerRank].writerBonus,1,day,{independentWriter:count>=policy.notes.minPublicSample && ratio>=policy.notes.publicRatio && weighted>=policy.notes.publicRatio}));
      if (status==='rejected') {
        events.push(event('writer',note.userId,'writer',-2,0,day));
        events.push(event('rejected',note.userId,'trust',policy.penalties.rejectedNote,0,day));
      }
      for (const rating of votes) {
        const uid=Number(rating.userId);
        // 後続一致判定も公開/却下と同じ独立集合に限定し、重み付き比率で測る。
        const laterVotes=votes.filter(r=>Number(r.userId)!==uid && Date.parse(r.castAt)>Date.parse(rating.castAt));
        if (laterVotes.length<policy.notes.minLaterVotes) continue;
        const weightOf=r=>Math.min(policy.notes.maxWeight,Number(r.weight)||1);
        const totalWeight=laterVotes.reduce((sum,r)=>sum+weightOf(r),0);
        if (!totalWeight) continue;
        const agreement=laterVotes.reduce((sum,r)=>sum+(r.helpful?weightOf(r):0),0)/totalWeight;
        if (agreement<policy.notes.laterRatio && agreement>1-policy.notes.laterRatio) continue;
        const correct=Boolean(rating.helpful)===(agreement>=policy.notes.laterRatio);
        const ratingDay=new Date(rating.castAt).toISOString().slice(0,10);
        events.push(event(`reviewer:${uid}`,uid,'reviewer',correct?1:-1,correct?1:0,ratingDay,{authorId:Number(note.userId),noteId:Number(note.id),day:ratingDay,ratedAt:rating.castAt}));
      }
      let applied;
      try {
        applied=await db.replaceReputationEvents(`note:${noteId}`,events,{noteId:Number(noteId),version:data.version,status,stage:status==='public'?3:status==='review'?2:1,penalty:policy.notes.penalty});
      } catch (error) {
        if (audit) await require('./ModLogService').record(db,'admin',audit.adminId,'note_re_evaluate','note',noteId,'failure');
        throw error;
      }
      if (!applied) continue;
      if (audit) await require('./ModLogService').record(db,'admin',audit.adminId,'note_re_evaluate','note',noteId,'success');
      // 評価の確定後は配布・通知の失敗を評価自体の失敗にしない。
      if (status==='public') {
        const ids=[...new Set(snapshot.votes.map(r=>Number(r.userId)))];
        const existing=new Set(dist.map(row=>Number(row.userId??row.user_id)));
        const rows=ids.filter(uid=>!existing.has(uid)).map(uid=>({noteId:Number(noteId),userId:uid,tier:0,notified:false}));
        try { await writeDistributions(db,rows); } catch (error) { console.error('[notes] public distribution failed:',error.message); }
      }
      if (status==='review' && note.status!=='review') {
        try { await distributeEngaged(db,{...note,status}); } catch (error) { console.error('[notes] distribution failed:',error.message); }
      }
      if (status==='rejected') {
        // 理由の集計は claim の前に行い、集計の失敗で claim だけが消費されないようにする。
        // 集計対象は独立集合に揃える（アダプタ側が第2引数に対応する場合に有効）。
        let reasons=null;
        try { reasons=await db.listNoteNegativeReasons(note.id,summary.selectedUserIds); }
        catch (error) { console.error('[notes] negative reasons failed:',error.message); }
        if (reasons) {
          const reasonList=Array.isArray(reasons)?reasons:[];
          await notifyWithClaim(db,{
            claim:()=>db.claimReputationNotice(`note-rejected:${note.id}`),
            release:typeof db.releaseReputationNotice==='function'?()=>db.releaseReputationNotice(`note-rejected:${note.id}`):null,
            payload:{userId:note.userId,type:'note_rate',fromUserId:null,postId:note.postId,message:`ノートは独立した評価により却下されました。${reasonList.length?`主な理由: ${reasonList.join('・')}`:'評価理由の指定はありません。'}`},
          });
        }
      }
      await reputation.syncPostTrust(db,note.postId);
      require('../utils/serialize').invalidateImmutablePostCache(note.postId);
      require('../utils/TimelineCacheManager').clear();
      return await db.getNote(noteId);
    }
    throw new Error('評価が同時に変更されました。再度お試しください');
  });
}

async function deleteNote(db,note,{retract=false,adminId=null}={}) {
  const day=new Date(note.createdAt).toISOString().slice(0,10);
  const retained=note.status==='rejected' && !retract?[event('writer',note.userId,'writer',-2,0,day),event('rejected',note.userId,'trust',policy.penalties.rejectedNote,0,day)]:[];
  let removed=false;
  for (let attempt=0;attempt<3;attempt++) {
    const data=await db.getNoteReviewData(note.id);if (!data) {
      if (adminId != null) await require('./ModLogService').record(db,'admin',adminId,'delete_note','note',note.id,'skipped');
      return false;
    }
    let applied;
    try {
      applied=await db.replaceReputationEvents(`note:${note.id}`,retained,{noteId:Number(note.id),version:data.version,status:'deleted',stage:1,penalty:policy.notes.penalty});
    } catch (error) {
      if (adminId != null) await require('./ModLogService').record(db,'admin',adminId,'delete_note','note',note.id,'failure');
      throw error;
    }
    if (applied) {removed=true;break;}
  }
  if (!removed) {
    if (adminId != null) await require('./ModLogService').record(db,'admin',adminId,'delete_note','note',note.id,'failure');
    throw new Error('評価が同時に変更されました。再度お試しください');
  }
  if (adminId != null) await require('./ModLogService').record(db,'admin',adminId,'delete_note','note',note.id,'success');
  await db.deleteNoteDistribution(note.id);
  await reputation.syncPostTrust(db,note.postId);
  require('../utils/serialize').invalidateImmutablePostCache(note.postId);
  require('../utils/TimelineCacheManager').clear();
  return true;
}

function publicNote(note) {
  if (!note) return note;
  const {distributionKey,...value}=note;
  return value;
}

module.exports={sample,relevance,canRead,selected,computeNoteRelevance,captureVoteRelations,summarizeNoteEvidence,selectEngagedCandidates,distributeEngaged,distributeTimeline,evaluate,deleteNote,publicNote};
