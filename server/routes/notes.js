'use strict';

const api = require('../utils/ApiRegistry');
const { requireAuth } = require('../middleware/auth');
const notesService = require('../services/CommunityNoteService');
const { policy } = require('../services/ReputationService');
const { rankOf } = require('../utils/reputationPolicy');
const { canViewPost } = require('../utils/postVisibility');

const router = api.createRouter({
  tag: 'notes',
  basePath: '',
  description: 'コミュニティノート API',
});

function getDbAdapter(req) {
  return req.app.locals.dbAdapter;
}

function safeParsePositiveInt(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const MAX_SOURCES = 10;
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_SOURCE_TITLE_LENGTH = 300;

function normalizeSources(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const url = String(item?.url || item || '').trim();
    const title = item?.title != null ? String(item.title).trim().slice(0, MAX_SOURCE_TITLE_LENGTH) : '';
    if (!url || url.length > MAX_SOURCE_URL_LENGTH || !isHttpsSourceUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

// 理由コードは文字列・{code}・{side, code} のいずれの形式でも受け付ける。
function reasonCode(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object' && typeof item.code === 'string') return item.code.trim();
  return '';
}

function normalizeReasonCodes(input, allowed) {
  const codes = [];
  for (const item of Array.isArray(input) ? input : []) {
    const code = reasonCode(item);
    if (!code || !allowed.has(code) || codes.includes(code)) continue;
    codes.push(code);
    if (codes.length >= 3) break;
  }
  return codes;
}

// 内部文言（環境変数名など）は利用者向け応答に含めない。
function publicErrorMessage(error, fallback) {
  if (error?.code === 'NOTE_EVALUATION_KEY_MISSING') return 'ノート機能の設定が不足しています';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (!message || message.includes('NOTE_EVALUATION_HMAC_SECRET')) return fallback;
  return message;
}

function isHttpsSourceUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

const evaluateNote = notesService.evaluate;

router.post({path:'/notes/:noteId/re-evaluate',summary:'管理者によるノート再判定',auth:'admin'},requireAuth,async(req,res)=>{
  if (!req.user.admin) return res.status(403).json({error:'管理者権限が必要です'});
  const id=safeParsePositiveInt(req.params.noteId); if (!id) return res.status(400).json({error:'無効なノートIDです'});
  try {
    // 監査記録は operation 側に一本化する（evaluate 側の audit 記録と二重にしない）。
    const note=await require('../services/ModLogService').operation(getDbAdapter(req),'admin',req.user.id,'note_evaluation','note',id,()=>evaluateNote(id,getDbAdapter(req)));
    if (note && ['limited','review'].includes(note.status)) {
      try { await notesService.distributeEngaged(getDbAdapter(req),note); }
      catch (error) { console.error('[notes] re-evaluate distribution error:',error.message); }
    }
    return note?res.json({note:notesService.publicNote(note)}):res.status(404).json({error:'ノートが見つかりません'});
  } catch(error) { console.error('[notes] re-evaluate:',error.message); return res.status(503).json({error:'再判定できませんでした'}); }
});

// ノート作成
router.post({
  path: '/posts/:postId/notes',
  summary: 'コミュニティノートの作成',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const postId = safeParsePositiveInt(req.params.postId);
  if (!postId) {
    return res.status(400).json({ error: '無効な投稿IDです' });
  }

  const db = getDbAdapter(req);
  const body = req.body || {};

  const content = typeof body.content === 'string' ? body.content : '';
  const contentLen = [...content].length;
  if (contentLen < 1 || contentLen > 1000) {
    return res.status(400).json({ error: 'content は 1〜1000 文字で指定してください' });
  }

  const sources = normalizeSources(body.sources);

  // 作成理由は note_reason_tag_defs の side='create' のコードのみ許可する
  // (コード側に許可リストを持たない)。
  let reasons = [];
  try {
    const rawReasons = Array.isArray(body.reasons) ? body.reasons : [];
    if (rawReasons.length > 0) {
      const defs = await db.listNoteReasonTagDefs({ side: 'create' });
      const allowed = new Set((Array.isArray(defs) ? defs : []).map((def) => String(def.code)));
      reasons = normalizeReasonCodes(rawReasons, allowed);
    }
  } catch (error) {
    console.error('[notes] create reason validation error:', error.message);
  }

  try {
    const post = await db.getPostById(postId);
    if (!post || !await canViewPost(db,post,req.user.id)) return res.status(404).json({error:'投稿が見つかりません'});
    const profile = await db.getReputationProfile(req.user.id);
    const writerRank = rankOf(profile.writer,policy.writer);

    // アダプタ間で reasons の受け取り形が異なるため、コード文字列に正規化して渡す
    // (side は定義テーブルを情報源とするため 'create' 固定)。
    const note = await db.createNote({
      postId,
      userId: req.user.id,
      content,
      sources,
      reasons: reasons.map((code) => ({ side: 'create', code })),
      status: 'limited',
      dailyLimit: policy.writer[writerRank].dailyNotes,
      postLimit: policy.notes.maxNotesPerPost,
    });

    // 作成の成否と配布の成否は分離する。配布の失敗で作成済みノートを失敗扱いにしない。
    try {
      await notesService.distributeEngaged(db,note);
    } catch (error) {
      console.error('[notes] create distribution error:', error.message);
    }

    return res.status(201).json({ note:notesService.publicNote(note) });
  } catch (error) {
    console.error('[notes] create error:', error.message);
    return res.status(error.statusCode || error.status || 400).json({ error: publicErrorMessage(error, 'ノートの作成に失敗しました') });
  }
});

// ノート一覧
router.get({
  path: '/posts/:postId/notes',
  summary: 'コミュニティノート一覧の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const postId = safeParsePositiveInt(req.params.postId);
  if (!postId) {
    return res.status(400).json({ error: '無効な投稿IDです' });
  }

  const db = getDbAdapter(req);
  try {
    const post = await db.getPostById(postId);
    if (!post || !await canViewPost(db,post,req.user.id)) return res.status(404).json({error:'投稿が見つかりません'});
    const notes = await db.listNotesByPost(postId, req.user.id);

    const filtered = [];
    for (const note of notes) {
      if (await notesService.canRead(db,note,req.user.id,post)) filtered.push({...notesService.publicNote(note),eligible:true});
    }

    return res.json({ notes: filtered, eligible: filtered.some(n=>n.status==='limited' || n.status==='review') });
  } catch (error) {
    console.error('[notes] list error:', error.message);
    return res.status(500).json({ error: 'ノートの取得に失敗しました' });
  }
});

// ノート一括取得（タイムライン表示時の投稿ごとの取得を1リクエストにまとめる）
// 意味は投稿ごとの一覧取得と同一で、閲覧できない・存在しない投稿は
// missing_post_ids に分けて返す。
const MAX_BULK_POST_IDS = 50;

router.post({
  path: '/notes/bulk',
  summary: 'コミュニティノートの一括取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const rawIds = Array.isArray(req.body?.post_ids) ? req.body.post_ids : (Array.isArray(req.body?.postIds) ? req.body.postIds : null);
  if (!rawIds) {
    return res.status(400).json({ error: 'post_ids は配列で指定してください' });
  }
  const postIds = [...new Set(rawIds.map((value) => safeParsePositiveInt(value)).filter((value) => value !== null))];
  if (postIds.length === 0) {
    return res.status(400).json({ error: 'post_ids に有効な投稿IDがありません' });
  }
  if (postIds.length > MAX_BULK_POST_IDS) {
    return res.status(400).json({ error: `post_ids は最大${MAX_BULK_POST_IDS}件までです` });
  }

  const db = getDbAdapter(req);
  try {
    const notesByPost = {};
    const missingPostIds = [];
    for (const postId of postIds) {
      const post = await db.getPostById(postId);
      if (!post || !await canViewPost(db, post, req.user.id)) {
        missingPostIds.push(postId);
        continue;
      }
      const notes = await db.listNotesByPost(postId, req.user.id);
      const filtered = [];
      for (const note of notes) {
        if (await notesService.canRead(db, note, req.user.id, post)) filtered.push({ ...notesService.publicNote(note), eligible: true });
      }
      notesByPost[postId] = {
        notes: filtered,
        eligible: filtered.some((n) => n.status === 'limited' || n.status === 'review'),
      };
    }
    return res.json({ notes_by_post: notesByPost, missing_post_ids: missingPostIds });
  } catch (error) {
    console.error('[notes] bulk list error:', error.message);
    return res.status(500).json({ error: 'ノートの取得に失敗しました' });
  }
});

// 評価理由タグ定義
router.get({
  path: '/notes/reason-tags',
  summary: 'コミュニティノートの評価理由タグ定義の取得',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const db = getDbAdapter(req);
  const side = typeof req.query.side === 'string' ? req.query.side.trim() : '';
  if (side && !['create', 'positive', 'negative'].includes(side)) {
    return res.status(400).json({ error: 'side は create / positive / negative のいずれかで指定してください' });
  }
  try {
    const defs = await db.listNoteReasonTagDefs(side ? { side } : {});
    const tags = (Array.isArray(defs) ? defs : []).map((def) => ({
      code: def.code,
      side: def.side,
      label: def.label,
      description: def.description ?? null,
      sortOrder: Number(def.sortOrder ?? 0) || 0,
    }));
    return res.json({ tags });
  } catch (error) {
    console.error('[notes] reason tags error:', error.message);
    return res.status(500).json({ error: '評価理由タグの取得に失敗しました' });
  }
});

// 評価
router.post({
  path: '/notes/:noteId/ratings',
  summary: 'コミュニティノートの評価',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const noteId = safeParsePositiveInt(req.params.noteId);
  if (!noteId) {
    return res.status(400).json({ error: '無効なノートIDです' });
  }

  const db = getDbAdapter(req);
  const body = req.body || {};
  const helpful = typeof body.helpful === 'boolean' ? body.helpful : (body.helpful === 'true' ? true : (body.helpful === 'false' ? false : null));
  if (helpful === null) {
    return res.status(400).json({ error: 'helpful は true/false で指定してください' });
  }

  try {
    const note = await db.getNote(noteId, req.user.id);
    if (!note) {
      return res.status(404).json({ error: 'ノートが見つかりません' });
    }
    if (!await notesService.canRead(db,note,req.user.id)) return res.status(404).json({error:'ノートが見つかりません'});
    if (Number(note.userId) === Number(req.user.id)) {
      return res.status(400).json({ error: '自分のノートは評価できません' });
    }
    const post=await db.getPostById(note.postId);
    if (Number(post?.userId ?? post?.user_id)===Number(req.user.id)) return res.status(403).json({error:'対象投稿の作者は評価できません'});

    const requestedReasons = Array.isArray(body.reasons) ? body.reasons : [];
    const side = helpful ? 'positive' : 'negative';
    let savedReasons = [];
    try {
      const defs = await db.listNoteReasonTagDefs({ side });
      const allowed = new Set((Array.isArray(defs) ? defs : []).map((def) => String(def.code)));
      savedReasons = normalizeReasonCodes(requestedReasons, allowed);
    } catch (error) {
      console.error('[notes] reason tag validation error:', error.message);
    }

    const profile=await db.getReputationProfile(req.user.id);
    const reviewerRank=rankOf(profile.reviewer,policy.reviewer);
    if (note.status==='public' && !await db.getNoteDistribution(note.id,req.user.id)) await db.upsertNoteDistribution({noteId:note.id,userId:req.user.id,tier:0,notified:false});
    let summary;
    for (let attempt=0;attempt<3;attempt++) {
      const admission=await notesService.captureVoteRelations(db,note,req.user.id,post);
      try {
        summary=await db.rateNote({ noteId,userId:req.user.id,helpful,weight:policy.reviewer[reviewerRank].weight,maxRatings:policy.notes.maxRatings,
          expectedRatingVersion:admission.ratingVersion,relationManifest:admission.relationManifest });
        break;
      } catch (error) {
        if (error.code!=='NOTE_VOTE_CONFLICT' || attempt===2) throw error;
      }
    }
    if (summary.myRating===null) return res.status(429).json({error:'評価受付上限に達しました'});
    await db.saveNoteRatingReasons({ noteId, userId: req.user.id, codes: savedReasons });
    try { await evaluateNote(noteId, db); }
    catch (error) {
      console.error('[notes] evaluation pending:',error.message);
      return res.status(202).json({ ...summary,reasons:savedReasons,evaluationPending:true });
    }
    return res.json({ ...summary, reasons: savedReasons });
  } catch (error) {
    console.error('[notes] rate error:', error.message);
    return res.status(400).json({ error: publicErrorMessage(error, '評価に失敗しました') });
  }
});

// 削除
router.delete({
  path: '/notes/:noteId',
  summary: 'コミュニティノートの削除',
  auth: 'required',
}, requireAuth, async (req, res) => {
  const noteId = safeParsePositiveInt(req.params.noteId);
  if (!noteId) {
    return res.status(400).json({ error: '無効なノートIDです' });
  }

  const db = getDbAdapter(req);
  try {
    const note = await db.getNote(noteId, req.user.id);
    if (!note) {
      return res.status(404).json({ error: 'ノートが見つかりません' });
    }
    if (Number(note.userId) !== Number(req.user.id) && !req.user.admin) {
      return res.status(403).json({ error: '削除権限がありません' });
    }
    if (req.user.admin===true) {
      await require('../services/ModLogService').operation(db,'admin',req.user.id,'note_delete_processing','note',noteId,()=>notesService.deleteNote(db,note,{retract:true,adminId:req.user.id}));
    } else {
      await notesService.deleteNote(db,note,{retract:false});
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('[notes] delete error:', error.message);
    return res.status(500).json({ error: 'ノートの削除に失敗しました' });
  }
});

router.evaluateNote = evaluateNote;
router.normalizeReasonCodes = normalizeReasonCodes;
router.normalizeSources = normalizeSources;
module.exports = router;
module.exports.evaluateNote = evaluateNote;
module.exports.normalizeReasonCodes = normalizeReasonCodes;
module.exports.normalizeSources = normalizeSources;
