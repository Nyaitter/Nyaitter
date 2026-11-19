'use strict';

const config = require('../config');
const { trustRank } = require('../utils/reputationPolicy');
const { canViewPost } = require('../utils/postVisibility');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { isImposter, getImposterMetadata } = require('./ImposterService');
const policy = config.reputation;
const locks = new WeakMap();

async function serialized(db,key,run) {
  let map=locks.get(db); if (!map) { map=new Map(); locks.set(db,map); }
  const previous=map.get(key) || Promise.resolve();
  const task=previous.catch(()=>{}).then(run); map.set(key,task);
  try { return await task; } finally { if (map.get(key)===task) map.delete(key); }
}

function event(key,userId,dimension,amount,successes=0,day=new Date().toISOString().slice(0,10),metadata={}) {
  return {key,userId:Number(userId),dimension,amount,successes,day,cap:policy.dailyCaps[dimension],metadata};
}

async function effectivePolicy(db,principal) {
  const profile=await db.getReputationProfile(principal.id);
  const rank=trustRank(profile,policy);
  return {rank,...policy.trust[rank],profile,exempt:principal.admin===true || principal.guest===true || principal.isBot===true || principal.isApp===true};
}

async function enforceAccess(req,res,principal) {
  // The general rate limiter may already have resolved the effective policy
  // for this principal earlier in the same request; reuse it instead of
  // issuing a second identical reputation profile lookup.
  const cached = req.trustPolicy && req.trustPolicyPrincipalId === principal.id ? req.trustPolicy : null;
  const effective=cached || await effectivePolicy(req.app.locals.dbAdapter,principal);
  req.trustPolicy=effective;
  req.trustPolicyPrincipalId=principal.id;
  if (principal.admin === true) return true;
  const { requestFeatures, hasFeatureAccess } = require('../utils/featureAccess');
  const features = requestFeatures(req, config.server.apiEndpoint);
  if (!hasFeatureAccess(policy, effective.rank, features)) {
    res.status(403).json({ error: '現在のアカウント状態ではこの機能を利用できません' });
    return false;
  }
  return true;
}

const trustDescriptions = {
  Trusted:'継続して信頼できる活動が確認されています。',Reliable:'安定した良い活動が確認されています。',
  Credible:'信頼できる活動が増えています。',Neutral:'標準の状態です。新しい利用者もここから始まります。',
  Questionable:'確認された問題により一部の利用を制限しています。',Suspicious:'確認された問題の繰り返しにより利用を制限しています。',
  Banned:'閲覧のみ利用できます。',
};
const featureLabels={write:'投稿・反応',posts:'投稿',polls:'アンケート',notes:'ノート作成・評価',uploads:'アップロード',dm:'メッセージ送信',call:'通話',spaces:'スペース',groups:'グループ'};
const publicSupportPercent=rules=>Number(((policy.notes.publicRatio-rules.publicRatioReduction)*100).toFixed(2));
const noteBenefits=rules=>rules.disabledFeatures.includes('notes')?[]:[
  `公開時の「参考になる」評価の基準は${publicSupportPercent(rules)}%です`,
  rules.dailyNotes===null?'ノートは1日に何件でも作成できます':`ノートは1日${rules.dailyNotes}件まで作成できます`,
  `ノートの評価が${rules.ratingWeight}倍の重みで反映されます`,
  rules.noteVisibility===1?'閲覧できる投稿の公開前のノートをすべて確認できます':rules.noteVisibility>0?'公開前に見られるノートの範囲が広がります':'公開前のノートは一部が表示されます',
  ...(rules.publicBonus>0?[`作成したノートが公開されると、信頼スコアに${rules.publicBonus}点が追加されます`]:[]),
];
const noteRestrictions=['自分のノートは評価できません','同じ投稿にノートを作成できるのは一度だけです',`1つの投稿に作成できるノートは全員で${policy.notes.maxNotesPerPost}件までです`,'公開前のノートの閲覧範囲は、見る人の信頼ランクで広がります','公開後も、投稿の公開範囲やブロックによる閲覧制限は変わりません','反応していない投稿の公開前のノートは通知されません'];
const rateLimitLabels={general:'全体の操作',auth:'ログイン・認証',postWrite:'投稿',profileUpdate:'プロフィールの変更',dmSend:'メッセージ送信',upload:'アップロード',notification:'通知の確認',reportCreate:'通報',reportAction:'通報への対応',verificationApplication:'認証の申請'};

async function getStatus(db,userId) {
  const profile=await db.getReputationProfile(userId);
  const trustRanks=['Trusted','Reliable','Credible','Neutral','Questionable','Suspicious','Banned'].map(rank=>{
    const rules=policy.trust[rank];
    const { hasFeatureAccess } = require('../utils/featureAccess');
    const features=Object.entries(featureLabels).map(([feature,label])=>({label,allowed:hasFeatureAccess(policy,rank,feature==='write'?['write']:['write',feature])}));
    const limits=config.rateLimit.enabled?Object.entries(rateLimitLabels).filter(([name])=>Number.isFinite(config.rateLimit[name]?.max)).map(([name,label])=>{
      const limit=config.rateLimit[name];
      const max=name==='auth'?limit.max:rules.rateLimits?.[name] ?? Math.max(1,Math.floor(limit.max*rules.rateMultiplier));
      const seconds=Math.round(limit.windowMs/1000);
      return `${label}: ${seconds%60===0?`${seconds/60}分`:`${seconds}秒`}あたり${max}回まで`;
    }):[];
    const queue=features.find(f=>f.label===featureLabels.write).allowed?[rules.queuePriority>0?'混雑時も投稿が優先して送信されます':rules.queuePriority<0?'混雑時は投稿の送信をお待ちいただくことがあります':'投稿は通常の順番で送信されます']:[];
    return {rank,label:`${rank} User`,description:trustDescriptions[rank],requirements:rules.minScore>0?[`信頼スコア${rules.minScore}点以上`]:[],benefits:[...features.filter(f=>f.allowed).map(f=>`${f.label}を利用できます`),...queue, ...limits, ...noteBenefits(rules)],restrictions:[...features.filter(f=>!f.allowed).map(f=>`${f.label}は利用できません`),...noteRestrictions,'短時間に操作が集中すると、一時的に利用が制限されることがあります']};
  });
  const category=(ranks,rank)=>({...ranks.find(r=>r.rank===rank),ranks});
  return {trust:category(trustRanks,trustRank(profile,policy))};
}

async function independenceContext(db,ids) {
  const wanted=new Set(ids.map(Number));
  const [snapshot,imposters]=await Promise.all([db.getReputationContext([...wanted]),db.getImposterUsers()]);
  const edges=new Set(snapshot.edges.flatMap(([a,b])=>[`${a}:${b}`,`${b}:${a}`]));
  for (const user of imposters) {
    const metadata=getImposterMetadata(user);if (!metadata) continue;
    const operators=[...new Set([Number(user.id),metadata.parent_id,...metadata.members.map(m=>m.user_id)].filter(id=>wanted.has(id)))];
    for (const a of operators) for (const b of operators) if (a!==b) edges.add(`${a}:${b}`);
  }
  return {byId:new Map(snapshot.users.filter(Boolean).map(u=>[Number(u.id),u])),profiles:snapshot.profiles,edges};
}

// 反応者の信頼スコアが minTrust からこの幅だけ下がるまで、重みを直線的に割り引く。
const REACTOR_TRUST_SPAN=100;

function reactorWeight(user,profile,rules) {
  const ageDays=(Date.now()-new Date(user.created_at || user.createdAt).getTime())/86400000;
  if (!Number.isFinite(ageDays)) return 0;
  const ageFactor=rules.minAgeDays>0?Math.min(1,Math.max(0,ageDays)/rules.minAgeDays):1;
  const score=Number(profile?.trust?.score || 0);
  const trustFactor=Math.min(1,Math.max(0,1+(score-rules.minTrust)/REACTOR_TRUST_SPAN));
  return ageFactor*trustFactor;
}

// 反応の証拠量。関係のある反応者はひとかたまりとして数え、人数に対する増分を逓減させる。
async function positivePostEvidence(db,authorId,ids) {
  const {byId,profiles,edges}=await independenceContext(db,[...ids,authorId]);
  const author=byId.get(authorId);
  const weights=new Map();
  for (const uid of ids.map(Number)) {
    const user=byId.get(uid);
    if (!user || user.freeze || isImposter(user)) continue;
    if (trustRank(profiles[uid] || {},policy)==='Banned') continue;
    if ((user.block || []).map(Number).includes(authorId) || (author?.block || []).map(Number).includes(uid)) continue;
    const weight=reactorWeight(user,profiles[uid] || {},policy.positivePost);
    if (weight>0) weights.set(uid,weight);
  }
  const parent=new Map([...weights.keys()].map(uid=>[uid,uid]));
  const find=(x)=>{while (parent.get(x)!==x) {parent.set(x,parent.get(parent.get(x)));x=parent.get(x);} return x;};
  const link=(a,b)=>{if (weights.has(a) && weights.has(b)) parent.set(find(a),find(b));};
  for (const pair of edges) {const [a,b]=pair.split(':').map(Number); link(a,b);}
  const blockSets=new Map([...weights.keys()].map(uid=>[uid,new Set((byId.get(uid)?.block || []).map(Number))]));
  const weightedIds=[...weights.keys()];
  for (let i=0;i<weightedIds.length;i++) for (let j=i+1;j<weightedIds.length;j++) {
    if (blockSets.get(weightedIds[i]).has(weightedIds[j]) || blockSets.get(weightedIds[j]).has(weightedIds[i])) link(weightedIds[i],weightedIds[j]);
  }
  const clusters=new Map();
  for (const [uid,weight] of weights) {
    const root=find(uid);
    if (!clusters.has(root)) clusters.set(root,[]);
    clusters.get(root).push(weight);
  }
  let evidence=0;
  for (const members of clusters.values()) {
    members.sort((a,b)=>b-a);
    members.forEach((weight,index)=>{evidence+=weight/(index+1);});
  }
  return evidence;
}

async function syncPostTrust(db,postId) {
  return serialized(db,`post:${postId}`,async()=>{
    const post=await db.getPostById(postId);
    if (!post) {await db.replaceReputationEvents(`post-trust:${postId}`,[]);return;}
    const authorId=Number(post.userId ?? post.user_id);
    const day=new Date(post.createdAt || post.created_at || Date.now()).toISOString().slice(0,10);
    const notes=await db.listNotesByPost(postId);
    const moderated=(await db.getReputationEvidence(authorId,`moderation-post:${postId}:`)).some(e=>e.amount<0);
    let amount=0;
    if (notes.some(n=>n.status==='public')) amount=moderated?0:policy.penalties.publicNote;
    else if (!moderated && !post.lock && !post.groupId && !post.group_id && !(post.scheduledAt ?? post.scheduled_at)) {
      const ids=await db.listPositivePostUsers(postId,policy.notes.maxRatings);
      const visible=[];
      for (const uid of ids) if (uid!==authorId && await canViewPost(db,post,uid)) visible.push(uid);
      if (visible.length) {
        const evidence=await positivePostEvidence(db,authorId,visible);
        const {award,halfSaturation}=policy.positivePost;
        if (evidence>0) amount=award*evidence/(evidence+halfSaturation);
      }
    }
    await db.replaceReputationEvents(`post-trust:${postId}`,amount?[event('post',authorId,'trust',amount,0,day)]:[]);
  });
}

function reportRules() {
  return {...policy.penalties,cap:policy.dailyCaps.trust};
}

async function syncReport(db,report) {
  const result=await db.syncReportReputation(Number(report.id),{rules:reportRules()});
  if (result.postId) await syncPostTrust(db,result.postId);
}

async function cancelPostEvents(db,postId,notes=[]) {
  for (const note of notes) await db.replaceReputationEvents(`note:${note.id}`,note.status==='rejected'?[event('writer',note.userId,'trust',-2,0,new Date(note.createdAt).toISOString().slice(0,10)),event('rejected',note.userId,'trust',policy.penalties.rejectedNote,0,new Date(note.createdAt).toISOString().slice(0,10))]:[]);
  await db.replaceReputationEvents(`post-trust:${postId}`,[]);
}

async function retractReportTrust(db,{reportId,userId,targetKind,targetId,reporterId,adminId,reason}) {
  const result=await require('./ModLogService').operation(db,'admin',adminId,'report_trust_retract','report',reportId,()=>db.syncReportReputation(Number(reportId),{rules:reportRules(),retract:true,expected:{userId,targetKind,targetId,reporterId},adminId:Number(adminId),reason}),'failure');
  if (result.postId) await syncPostTrust(db,result.postId);
}

module.exports={policy,event,serialized,effectivePolicy,enforceAccess,getStatus,independenceContext,positivePostEvidence,syncPostTrust,syncReport,cancelPostEvents,retractReportTrust};
