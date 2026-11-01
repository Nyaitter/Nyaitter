'use strict';

const memoryLocks=new WeakMap();

function fail(message,statusCode=409) {
  const error=new Error(message);error.statusCode=statusCode;throw error;
}

function object(value) {
  if (typeof value==='string') value=JSON.parse(value);
  return value && typeof value==='object' && !Array.isArray(value)?value:{};
}

function reportBasis(row) {
  if (!row) fail('報告が見つかりません',404);
  const snapshot=object(row.targetSnapshot ?? row.target_snapshot);
  const targetKind=row.targetKind ?? row.target_kind;
  const targetId=row.targetId ?? row.target_id;
  const id=Number(row.id);
  if (!Number.isSafeInteger(id) || id<=0 || row.status!=='resolved') fail('確定済みの報告を指定してください');
  const subjectId=Number(snapshot.subjectUser?.id ?? snapshot.user?.id ?? (targetKind==='user'?targetId:null));
  const reporterId=Number(row.reporterUserId ?? row.reporterId ?? row.reporter_user_id);
  const postId=targetKind==='post'?Number(snapshot.post?.id ?? targetId):null;
  const day=new Date(row.createdAt ?? row.created_at).toISOString().slice(0,10);
  const targetScope=subjectId>0?`${postId?'moderation-post':'moderation-user'}:${postId || subjectId}:target`:null;
  return {id,subjectId,reporterId,postId,targetKind,targetId,day,targetScope,resolution:object(row.resolution),
    falseScope:`false-report:${id}`,penaltyScope:`false-report-penalty:${reporterId}`,auditScope:`report-retraction:${id}`};
}

function scopesOf(basis) {
  return [...new Set([basis.targetScope,basis.auditScope,...(basis.reporterId>0?[basis.falseScope,basis.penaltyScope]:[])].filter(Boolean))].sort();
}

function planReport(row,state,options) {
  const basis=reportBasis(row);const {rules,expected={},retract=false}=options;
  if (!rules || !Number.isFinite(rules.approvedReport) || rules.approvedReport>0 || rules.approvedReport < -100
    || !Number.isFinite(rules.falseReports) || rules.falseReports>0 || rules.falseReports < -100
    || !Number.isInteger(rules.falseReportRepeat) || rules.falseReportRepeat<2
    || !(rules.cap===null || Number.isFinite(rules.cap) && rules.cap>=0 && rules.cap<=100)) fail('通報評価の設定が正しくありません',400);
  for (const [key,actual] of Object.entries({userId:basis.subjectId,reporterId:basis.reporterId,targetKind:basis.targetKind,targetId:basis.targetId})) {
    if (expected[key]!=null && String(expected[key])!==String(actual)) fail('報告の対象が保存済みの記録と一致しません');
  }
  if (retract && (!Number.isSafeInteger(options.adminId) || options.adminId<=0 || String(options.reason || '').trim().length<10)) fail('取消理由と管理者を指定してください',400);
  const byScope=new Map();
  for (const entry of state.events) {
    const event={...entry,userId:Number(entry.userId ?? entry.user_id),metadata:object(entry.metadata)};
    if (!byScope.has(entry.scope)) byScope.set(entry.scope,[]);byScope.get(entry.scope).push(event);
  }
  const target=(byScope.get(basis.targetScope) || []).find(e=>e.key==='target' || e.event_key==='target');
  const previous=(byScope.get(basis.falseScope) || []).find(e=>e.key==='evidence' || e.event_key==='evidence');
  if (target && target.userId!==basis.subjectId || previous && previous.userId!==basis.reporterId) fail('報告の実績対象を確認できません');
  const audit=(byScope.get(basis.auditScope) || []).find(e=>e.userId===basis.subjectId || e.userId===basis.reporterId);
  const retraction=basis.resolution.trustRetraction || (audit?{...audit.metadata,at:audit.day}:null)
    || (retract?{adminId:options.adminId,reason:String(options.reason).trim(),at:new Date().toISOString()}:null);
  const withdrawn=Boolean(retraction);
  const writes=[];
  const make=(key,userId,amount,day,metadata={})=>({key,userId,dimension:'trust',amount,successes:0,day,cap:rules.cap,metadata});
  const users=new Set(state.users.map(Number));
  if (basis.targetScope) {
    const ids=new Set((target?.metadata.reportIds || []).map(Number).filter(id=>Number.isSafeInteger(id) && id>0));
    if (!withdrawn && basis.resolution.actionTaken===true && users.has(basis.subjectId)) ids.add(basis.id);else ids.delete(basis.id);
    const day=target?.metadata.day || basis.day;
    writes.push({scope:basis.targetScope,events:ids.size && users.has(basis.subjectId)?[make('target',basis.subjectId,rules.approvedReport,day,{reportIds:[...ids].sort((a,b)=>a-b),day})]:[]});
  }
  if (basis.reporterId>0 && users.has(basis.reporterId)) {
    const targetKey=`${basis.targetKind}:${basis.targetId}`;
    const falseEvidence=!withdrawn && basis.resolution.actionTaken!==true && basis.resolution.falseReport===true && String(basis.resolution.evidence || '').trim().length>=10;
    const retired=withdrawn || previous?.metadata.retracted===true || !falseEvidence && Boolean(previous);
    const day=previous?.metadata.day || previous?.day || basis.day;
    const metadata={target:targetKey,day,moderatorId:basis.resolution.moderatorId,...(retired?{retracted:true}:{})};
    const evidence=previous || falseEvidence?[make('evidence',basis.reporterId,0,day,metadata)]:[];
    writes.push({scope:basis.falseScope,events:evidence});
    const distinct=state.falseCount+(evidence.length && !retired && !state.falseTargetExists?1:0);
    const penalty=(byScope.get(basis.penaltyScope) || [])[0];
    writes.push({scope:basis.penaltyScope,events:distinct>=rules.falseReportRepeat?[make('repeat',basis.reporterId,Math.max(-100,rules.falseReports*(distinct-rules.falseReportRepeat+1)),penalty?.day || basis.day)]:[]});
  }
  if (retract && !audit) {
    const userId=[basis.subjectId,basis.reporterId].find(id=>users.has(id));
    if (userId) writes.push({scope:basis.auditScope,events:[make('audit',userId,0,new Date(retraction.at).toISOString().slice(0,10),retraction)]});
  }
  return {basis,writes,resolution:retraction && !basis.resolution.trustRetraction?{...basis.resolution,trustRetraction:retraction}:null};
}

function falseReportAggregate(dialect) {
  const target=dialect==='postgres'?"metadata::jsonb->>'target'":"json_extract(metadata,'$.target')";
  const active=dialect==='postgres'?"COALESCE(metadata::jsonb->>'retracted','false')<>'true'":"COALESCE(json_extract(metadata,'$.retracted'),0)<>1";
  const slots=dialect==='postgres'?['$1','$2','$3']:['?','?','?'];
  return `SELECT COUNT(DISTINCT ${target}) AS count,COALESCE(MAX(CASE WHEN ${target}=${slots[0]} THEN 1 ELSE 0 END),0) AS target_exists FROM reputation_events WHERE user_id=${slots[1]} AND scope LIKE 'false-report:%' AND scope<>${slots[2]} AND ${active}`;
}

function installMemory(Adapter) {
  Adapter.prototype.syncReportReputation=async function(reportId,options) {
    const previous=memoryLocks.get(this) || Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const row=await this.getModerationReportById(reportId);const basis=reportBasis(row);
      const scopes=new Set(scopesOf(basis));const events=[];const targets=new Set();
      for (const [scope,entries] of this.reputationEvents || []) for (const e of entries) {
        if (scopes.has(scope)) events.push({...e,scope});
        if (scope.startsWith('false-report:') && scope!==basis.falseScope && e.userId===basis.reporterId) {
          const metadata=object(e.metadata);if (!metadata.retracted && metadata.target!=null) targets.add(metadata.target);
        }
      }
      const users=[basis.subjectId,basis.reporterId].filter(id=>this.users.has(id));
      const plan=planReport(row,{events,users,falseCount:targets.size,falseTargetExists:targets.has(`${basis.targetKind}:${basis.targetId}`)},options);
      for (const write of plan.writes) await this.replaceReputationEvents(write.scope,write.events);
      if (plan.resolution) this.moderationReports.get(Number(reportId)).resolution=plan.resolution;
      return {postId:basis.postId,subjectId:basis.subjectId,reporterId:basis.reporterId};
    });
    memoryLocks.set(this,task);
    try {return await task;} finally {if (memoryLocks.get(this)===task) memoryLocks.delete(this);}
  };
}

function installPostgres(Adapter) {
  Adapter.prototype.syncReportReputation=async function(reportId,options) {
    return this._withTransaction(async client=>{
      const row=(await client.query('SELECT * FROM moderation_reports WHERE id=$1 FOR UPDATE',[Number(reportId)])).rows[0];
      const basis=reportBasis(row);const scopes=scopesOf(basis);
      for (const scope of scopes) {
        await client.query('INSERT INTO reputation_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
        await client.query('SELECT scope FROM reputation_scopes WHERE scope=$1 FOR UPDATE',[scope]);
      }
      const ids=[...new Set([basis.subjectId,basis.reporterId].filter(id=>id>0))].sort((a,b)=>a-b);
      for (const uid of ids) await client.query('SELECT pg_advisory_xact_lock(19710,$1)',[uid]);
      const events=(await client.query('SELECT * FROM reputation_events WHERE scope=ANY($1::text[])',[scopes])).rows;
      const users=(await client.query('SELECT id FROM users WHERE id=ANY($1::int[]) FOR KEY SHARE',[ids])).rows.map(r=>Number(r.id));
      const aggregate=(await client.query(falseReportAggregate('postgres'),[`${basis.targetKind}:${basis.targetId}`,basis.reporterId,basis.falseScope])).rows[0];
      const plan=planReport(row,{events,users,falseCount:Number(aggregate.count),falseTargetExists:Number(aggregate.target_exists)>0},options);
      for (const write of plan.writes) {
        await client.query('DELETE FROM reputation_events WHERE scope=$1',[write.scope]);
        for (const e of write.events) await client.query('INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[write.scope,e.key,e.userId,e.dimension,e.amount,e.successes,e.day,e.cap===null?-1:e.cap,JSON.stringify(e.metadata)]);
      }
      if (plan.resolution) await client.query('UPDATE moderation_reports SET resolution=$2::jsonb WHERE id=$1',[basis.id,JSON.stringify(plan.resolution)]);
      return {postId:basis.postId,subjectId:basis.subjectId,reporterId:basis.reporterId};
    });
  };
}

async function applySqlite(db,reportId,options) {
  for (let attempt=0;attempt<5;attempt++) {
    const row=await db.prepare('SELECT * FROM moderation_reports WHERE id=?').bind(Number(reportId)).first();
    const basis=reportBasis(row);const scopes=scopesOf(basis);const encoded=JSON.stringify(scopes);
    await db.batch(scopes.map(scope=>db.prepare('INSERT OR IGNORE INTO reputation_scopes(scope) VALUES(?)').bind(scope)));
    const snapshot=await db.batch([
      db.prepare('SELECT scope,version FROM reputation_scopes WHERE scope IN (SELECT value FROM json_each(?))').bind(encoded),
      db.prepare('SELECT * FROM reputation_events WHERE scope IN (SELECT value FROM json_each(?))').bind(encoded),
      db.prepare('SELECT id FROM users WHERE id IN (?,?)').bind(basis.subjectId,basis.reporterId),
      db.prepare(falseReportAggregate('sqlite')).bind(`${basis.targetKind}:${basis.targetId}`,basis.reporterId,basis.falseScope),
    ]);
    const aggregate=snapshot[3].results[0];
    const plan=planReport(row,{events:snapshot[1].results,users:snapshot[2].results.map(r=>Number(r.id)),falseCount:Number(aggregate.count),falseTargetExists:Number(aggregate.target_exists)>0},options);
    const versions=JSON.stringify(Object.fromEntries(snapshot[0].results.map(r=>[r.scope,r.version])));
    const gate=`report-apply:${globalThis.crypto.randomUUID()}`;
    const guard='EXISTS(SELECT 1 FROM reputation_scopes WHERE scope=?)';
    const statements=[db.prepare(`INSERT INTO reputation_scopes(scope,version) SELECT ?,1 WHERE EXISTS(
      SELECT 1 FROM moderation_reports WHERE id=? AND status=? AND reporter_user_id IS ? AND target_kind=? AND target_id=? AND target_snapshot=? AND resolution IS ? AND created_at=?)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN reputation_scopes current ON current.scope=expected.key WHERE current.scope IS NULL OR current.version<>expected.value)`)
      .bind(gate,basis.id,row.status,row.reporter_user_id,row.target_kind,row.target_id,row.target_snapshot,row.resolution,row.created_at,versions)];
    for (const write of plan.writes) {
      statements.push(db.prepare(`DELETE FROM reputation_events WHERE scope=? AND ${guard}`).bind(write.scope,gate));
      for (const e of write.events) statements.push(db.prepare(`INSERT INTO reputation_events(scope,event_key,user_id,dimension,amount,successes,day,cap,metadata) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`)
        .bind(write.scope,e.key,e.userId,e.dimension,e.amount,e.successes,e.day,e.cap===null?-1:e.cap,JSON.stringify(e.metadata),gate));
    }
    if (plan.resolution) statements.push(db.prepare(`UPDATE moderation_reports SET resolution=? WHERE id=? AND ${guard}`).bind(JSON.stringify(plan.resolution),basis.id,gate));
    statements.push(db.prepare(`UPDATE reputation_scopes SET version=version+1 WHERE scope IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(encoded,gate));
    statements.push(db.prepare('DELETE FROM reputation_scopes WHERE scope=?').bind(gate));
    const results=await db.batch(statements);
    if (!results[0].meta.changes) continue;
    return {postId:basis.postId,subjectId:basis.subjectId,reporterId:basis.reporterId};
  }
  fail('報告が同時に更新されました。再度お試しください');
}

function installD1(Adapter) {
  Adapter.prototype.syncReportReputation=async function(reportId,options) {
    try {return await this._write('/reputation/report',{...options,reportId:Number(reportId)});}
    catch (error) {if ([400,404,409].includes(error.status)) error.statusCode=error.status;throw error;}
  };
}

module.exports={installMemory,installPostgres,installD1,applySqlite,reportBasis,planReport,falseReportAggregate};
