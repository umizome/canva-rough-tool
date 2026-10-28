// 1つの投稿（プロジェクト）について、構成案 → 絵コンテ生成 → 画像書き出し → 動画化メモ を順に進める。
import { config, readJsonConfig } from './config.js';
import { db, getProject, updateProject, getVariant, getVariants, updateVariant } from './db.js';
import { canvaFor } from './canva.js';
import { makePlan, makeVideoMemo, buildCanvaBrief } from './claude.js';
import { mockCanva, mockPlan, mockMemo } from './mock.js';

const svc = (userId) => (config.mock
  ? { canva: mockCanva(), makePlan: mockPlan, makeVideoMemo: mockMemo }
  : { canva: canvaFor(userId), makePlan, makeVideoMemo });

export function getDirections() {
  return readJsonConfig('directions.json').directions;
}
export function getDirection(id) {
  return getDirections().find((d) => d.id === id) || getDirections()[0];
}

// 生成は1件ずつ順番に処理する（Canva の回数制限とクレジットを守るため）
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function friendly(e) {
  if (e?.code === 'login_required') return 'Canva のログインが切れました。右上の「Canvaにログイン」からログインし直して、作り直してください。';
  return e?.message || String(e);
}

async function runVariantInner(variantId) {
  const v = getVariant(variantId);
  const project = getProject(v.project_id);
  const brief = JSON.parse(project.brief_json);
  const plan = JSON.parse(project.plan_json);
  const direction = getDirection(v.direction_id);
  const { canva, makeVideoMemo: memoFn } = svc(project.user_id);

  try {
    updateVariant(variantId, { status: 'generating', error: null });
    const designId = await canva.createStoryboard(buildCanvaBrief(brief, plan, direction));
    updateVariant(variantId, { status: 'exporting', design_id: designId });

    const info = await canva.readDesign(designId);
    const images = await canva.exportPages(designId);
    updateVariant(variantId, {
      status: 'memo',
      edit_url: info.editUrl,
      view_url: info.viewUrl,
      page_count: info.pageCount || images.length,
      design_text: info.text,
      images_json: JSON.stringify(images),
      images_at: new Date().toISOString(),
    });

    const memo = await memoFn({ brief, plan, direction, designText: info.text, pageCount: info.pageCount || images.length });
    updateVariant(variantId, { status: 'done', memo_json: JSON.stringify(memo) });
  } catch (e) {
    console.error(`[variant ${variantId}]`, e);
    updateVariant(variantId, { status: 'error', error: friendly(e) });
  }
}

function settleProject(projectId) {
  const vs = getVariants(projectId);
  const busy = vs.some((v) => !['done', 'error'].includes(v.status));
  if (busy) return;
  const allError = vs.length && vs.every((v) => v.status === 'error');
  updateProject(projectId, { status: allError ? 'error' : 'done', error: allError ? vs[0].error : null });
}

export function startProject(projectId) {
  return enqueue(async () => {
    const project = getProject(projectId);
    const brief = JSON.parse(project.brief_json);
    const { makePlan: planFn } = svc(project.user_id);
    try {
      updateProject(projectId, { status: 'planning', error: null });
      const plan = await planFn(brief);
      updateProject(projectId, { status: 'generating', plan_json: JSON.stringify(plan), title: plan.title || project.title });
    } catch (e) {
      console.error(`[project ${projectId}]`, e);
      updateProject(projectId, { status: 'error', error: friendly(e) });
      db.prepare("UPDATE variants SET status = 'error', error = ? WHERE project_id = ?").run('構成案を作れなかったため中止しました。', projectId);
      return;
    }
    for (const v of getVariants(projectId)) {
      await runVariantInner(v.id);
    }
    settleProject(projectId);
  });
}

export function retryVariant(variantId) {
  const v = getVariant(variantId);
  updateVariant(variantId, { status: 'queued', error: null, design_id: null, images_json: null, memo_json: null, edit_url: null, view_url: null, commented_at: null });
  updateProject(v.project_id, { status: 'generating' });
  return enqueue(async () => {
    const project = getProject(v.project_id);
    if (!project.plan_json) {
      updateVariant(variantId, { status: 'error', error: '構成案がないため作り直せません。新しく作成してください。' });
    } else {
      await runVariantInner(variantId);
    }
    settleProject(v.project_id);
  });
}

/** 画像URLは約11時間で切れるので、古ければ書き出し直す */
export async function refreshImages(variantId) {
  const v = getVariant(variantId);
  if (!v?.design_id) return v;
  const age = v.images_at ? Date.now() - Date.parse(v.images_at) : Infinity;
  if (age < 9 * 60 * 60 * 1000) return v;
  const project = getProject(v.project_id);
  const images = await svc(project.user_id).canva.exportPages(v.design_id);
  updateVariant(variantId, { images_json: JSON.stringify(images), images_at: new Date().toISOString() });
  return getVariant(variantId);
}

export async function commentIntents(variantId) {
  const v = getVariant(variantId);
  const project = getProject(v.project_id);
  const plan = JSON.parse(project.plan_json);
  const memo = v.memo_json ? JSON.parse(v.memo_json) : null;
  const { canva } = svc(project.user_id);
  const lines = plan.pages.map((p, i) => {
    const m = memo?.pages?.[i];
    const anim = m ? `／動き：${m.seconds}秒・文字は${m.text_animation}・切り替え${m.transition}` : '';
    return `【${i + 1}ページ目：${p.role}】${p.intent}${anim}`;
  });
  await canva.comment(v.design_id, `ラフの意図（SNS動画ラフ生成ツールより）\n${lines.join('\n')}\n\n気になる点はこのデザインにコメントしてください。`);
  updateVariant(variantId, { commented_at: new Date().toISOString() });
}

// 再起動で中断された処理を「エラー」にしておく
export function recoverInterrupted() {
  const msg = 'アプリが再起動したため中断しました。「作り直す」を押してください。';
  db.prepare("UPDATE variants SET status = 'error', error = ? WHERE status NOT IN ('done', 'error')").run(msg);
  db.prepare("UPDATE projects SET status = 'error', error = ? WHERE status IN ('queued', 'planning')").run(msg);
  db.prepare("UPDATE projects SET status = 'done' WHERE status = 'generating'").run();
}
