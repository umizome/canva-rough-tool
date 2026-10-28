// SNS動画ラフ — 画面（外部ライブラリなし）
const $app = document.getElementById('app');
const $account = document.getElementById('account');
const $nav = document.getElementById('nav');
const $banner = document.getElementById('banner');

const CREDIT_PER_VARIANT = 2; // 検証で 1回の生成 ≒ AIクレジット 2%
const PLATFORMS = { instagram: 'Instagram リール', tiktok: 'TikTok', youtube: 'YouTube ショート', facebook: 'Facebook リール' };
const STATUS = {
  queued: '順番待ち',
  generating: 'Canva AI が絵コンテを作成中（1分ほど）',
  exporting: '画像を書き出し中',
  memo: '動画化メモを作成中',
  done: '完成',
  error: 'エラー',
};

let me = null;
let pollTimer = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^(https?:|data:image\/)/.test(String(u || '')) ? esc(u) : '#');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-requested-with': 'fetch', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await loadMe();
    route();
    throw new Error(data.error || 'Canva にログインしてください。');
  }
  if (!res.ok) throw new Error(data.error || `エラーが発生しました（${res.status}）`);
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

function dirName(id) {
  return me?.directions.find((d) => d.id === id)?.name || id;
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- account ----------
async function loadMe() {
  me = await fetch('/api/me').then((r) => r.json());
  const user = me.user?.loggedIn ? me.user : null;
  $nav.hidden = !user;
  if (user) {
    $account.innerHTML = `<span>${esc(user.displayName || '（名前未設定）')}</span><button class="btn small ghost" id="logout">ログアウト</button>`;
    document.getElementById('logout').onclick = async () => {
      await api('POST', '/api/logout');
      await loadMe();
      location.hash = '#/';
      route();
    };
  } else {
    $account.innerHTML = '';
  }
  const notes = [];
  if (me.mock) notes.push('モックモードで動いています。Canva と Claude にはつながらず、見本の絵コンテが出ます。');
  else if (!me.claudeReady) notes.push('Claude API のキーが設定されていません。.env の ANTHROPIC_API_KEY を入れて再起動してください。');
  $banner.hidden = !notes.length;
  $banner.textContent = notes.join(' ');
}

// ---------- views ----------
function viewWelcome(params) {
  const err = params.get('login_error');
  $app.innerHTML = `
    <section class="welcome">
      <div>
        <h1>企画の言葉から、<br>SNS動画のラフを3案。</h1>
        <p class="lead">伝えたいことを入れると、Canva AI が縦型の絵コンテを作り、Canvaで動画にするための「動画化メモ」を添えます。完成品ではなく、話し合いと校正のための叩き台です。</p>
        <ol>
          <li>投稿の目的と伝えたい一言を入れる</li>
          <li>見た目の違う絵コンテが3案できる（3〜4ページ）</li>
          <li>選んだ案をCanvaで開き、メモどおりに動きと秒数を付けてMP4に</li>
        </ol>
        ${err ? `<p class="alert error">${esc(err)}</p>` : ''}
        <p style="margin-top:24px"><a class="btn primary big" href="/auth/login">Canvaにログインして始める</a></p>
        <p class="muted">団体のCanvaアカウント（NPOプログラムのチーム）でログインしてください。</p>
      </div>
      <div class="phones" aria-hidden="true">
        <div class="phone"><i class="h"></i><i></i><i class="img"></i><i></i></div>
        <div class="phone"><i class="h"></i><i class="img"></i><i></i><i></i></div>
        <div class="phone"><i class="h"></i><i></i><i></i><i class="img"></i></div>
      </div>
    </section>`;
}

function viewName() {
  $app.innerHTML = `
    <div class="card" style="max-width:480px;margin:40px auto">
      <h2>はじめに、お名前を教えてください</h2>
      <p class="muted">履歴で「誰が作ったラフか」を表示するために使います。</p>
      <form id="name-form" class="stack">
        <input class="input" name="displayName" maxlength="40" placeholder="例：菅原" required autofocus>
        <button class="btn primary">保存して始める</button>
      </form>
    </div>`;
  document.getElementById('name-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/me', { displayName: new FormData(e.target).get('displayName') });
      await loadMe();
      route();
    } catch (err) { toast(err.message); }
  };
}

async function viewNew(params) {
  let prefill = {};
  const from = params.get('from');
  if (from) {
    try { prefill = (await api('GET', `/api/projects/${encodeURIComponent(from)}`)).brief; } catch { /* 無視 */ }
  }
  const dirs = me.directions;
  const checked = new Set(prefill.directionIds || dirs.slice(0, 3).map((d) => d.id));
  $app.innerHTML = `
    <h1>新しいラフを作る</h1>
    <p class="lead">分かる範囲で大丈夫です。書いていない日時や数字をAIが作ることはありません。</p>
    <form id="brief" class="form-grid">
      <div class="card">
        <label class="field">
          <span class="field-label">何の投稿か<span class="req">必須</span></span>
          <input class="input" name="purpose" maxlength="200" required placeholder="例：11月の地域清掃ボランティアの参加者募集" value="${esc(prefill.purpose)}">
        </label>
        <label class="field">
          <span class="field-label">届けたい相手</span>
          <input class="input" name="audience" maxlength="200" placeholder="例：地域に住む20〜40代、子ども連れの家族" value="${esc(prefill.audience)}">
        </label>
        <label class="field">
          <span class="field-label">一番伝えたい一言<span class="req">必須</span></span>
          <input class="input" name="message" maxlength="100" required placeholder="例：この川、きれいにしませんか？" value="${esc(prefill.message)}">
          <span class="field-hint">そのまま1ページ目のテロップになることが多いです。</span>
        </label>
        <label class="field">
          <span class="field-label">入れたい情報</span>
          <textarea class="textarea" name="details" maxlength="600" placeholder="例：11月23日（日）9:00〜11:00／みどり川河川敷／軍手・ゴミ袋は用意／去年は120人で300袋／参加無料／プロフィールのリンクから申し込み">${esc(prefill.details)}</textarea>
          <span class="field-hint">日時・場所・実績・申し込み方法など。スラッシュ区切りでOK。</span>
        </label>
        <div class="row" style="margin-top:18px;gap:28px">
          <div>
            <span class="field-label">ページ数</span>
            <div class="seg">
              ${[3, 4].map((n) => `<label><input type="radio" name="pageCount" value="${n}" ${(prefill.pageCount || 4) === n ? 'checked' : ''}>${n}ページ</label>`).join('')}
            </div>
          </div>
          <label>
            <span class="field-label">投稿先</span>
            <select class="select" name="platform">
              ${Object.entries(PLATFORMS).map(([k, v]) => `<option value="${k}" ${prefill.platform === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
      <div class="side-sticky">
        <div class="card">
          <span class="field-label">見た目の方向性</span>
          <p class="muted" style="margin:0 0 10px">選んだ数だけ案ができます（最大3つ）。</p>
          <div class="dir-list">
            ${dirs.map((d) => `
              <label class="dir">
                <input type="checkbox" name="directionIds" value="${esc(d.id)}" ${checked.has(d.id) ? 'checked' : ''}>
                <div><strong>${esc(d.name)}</strong><span>${esc(d.summary || '')}</span></div>
              </label>`).join('')}
          </div>
          <div class="cost" id="cost"></div>
          <p id="form-error" class="alert error" hidden style="margin-top:12px"></p>
          <button class="btn primary big" style="width:100%;margin-top:14px" id="submit">ラフを作る</button>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('brief');
  const boxes = [...form.querySelectorAll('input[name=directionIds]')];
  const updateCost = () => {
    const n = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => { b.disabled = !b.checked && n >= 3; });
    document.getElementById('cost').innerHTML = n
      ? `<b>${n}案</b>を作ります。CanvaのAIクレジット：約<b>${n * CREDIT_PER_VARIANT}%</b>（1案あたり約${CREDIT_PER_VARIANT}%）。所要時間は${n}〜${n * 2}分ほどです。`
      : '方向性を1つ以上選んでください。';
  };
  boxes.forEach((b) => b.addEventListener('change', updateCost));
  updateCost();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = document.getElementById('submit');
    const errEl = document.getElementById('form-error');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = '送信中…';
    try {
      const { id } = await api('POST', '/api/projects', {
        purpose: fd.get('purpose'),
        audience: fd.get('audience'),
        message: fd.get('message'),
        details: fd.get('details'),
        pageCount: Number(fd.get('pageCount')),
        platform: fd.get('platform'),
        directionIds: fd.getAll('directionIds'),
      });
      location.hash = `#/p/${id}`;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'ラフを作る';
    }
  };
}

function statusHtml(status) {
  const busy = !['done', 'error'].includes(status);
  return `<span class="status ${esc(status)}">${busy ? '<span class="spinner"></span>' : ''}${esc(STATUS[status] || status)}</span>`;
}

function pagesHtml(v, plan) {
  const n = v.pageCount || plan?.pages.length || 4;
  const cls = n === 3 ? 'pages n3' : 'pages';
  if (v.images.length) {
    return `<div class="${cls}">${v.images.map((src, i) => `
      <figure class="page">
        <a href="${safeUrl(src)}" target="_blank" rel="noopener"><img src="${safeUrl(src)}" alt="${i + 1}ページ目" loading="lazy"></a>
        <figcaption>${i + 1}${plan?.pages[i] ? ` ${esc(plan.pages[i].role)}` : ''}</figcaption>
      </figure>`).join('')}</div>`;
  }
  const busy = !['done', 'error'].includes(v.status);
  return `<div class="${cls}">${Array.from({ length: n }, (_, i) => `
    <figure class="page"><div class="ph ${busy ? 'skeleton' : ''}">${busy ? '' : '—'}</div><figcaption>${i + 1}</figcaption></figure>`).join('')}</div>`;
}

function memoHtml(v, plan) {
  const m = v.memo;
  if (!m) return '';
  return `
    <details class="memo" open>
      <summary>動画化メモ（合計${esc(m.total_seconds)}秒）</summary>
      <ol class="memo-list">
        ${m.pages.map((p, i) => `
          <li>
            <div class="memo-p"><span class="memo-n">${esc(p.page)}</span><b>${esc(plan?.pages[i]?.role || p.role)}</b><span class="memo-sec">${esc(p.seconds)}秒</span></div>
            <dl>
              <dt>文字</dt><dd>${esc(p.text_animation)}</dd>
              <dt>写真</dt><dd>${esc(p.visual_animation)}</dd>
              <dt>切替</dt><dd>${esc(p.transition)}</dd>
              <dt>検索</dt><dd>${(p.search_keywords || []).map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</dd>
            </dl>
            ${p.tip ? `<div class="memo-tip">${esc(p.tip)}</div>` : ''}
          </li>`).join('')}
      </ol>
      <div class="memo-foot">BGM：${esc(m.bgm?.mood)} ${(m.bgm?.search_keywords || []).map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</div>
    </details>`;
}

function memoText(v, plan) {
  const m = v.memo;
  const lines = [`【動画化メモ】${dirName(v.directionId)}案（合計${m.total_seconds}秒）`];
  m.pages.forEach((p, i) => {
    lines.push(`${p.page}ページ目（${plan?.pages[i]?.role || p.role}）${p.seconds}秒`);
    lines.push(`  文字：${p.text_animation}／写真：${p.visual_animation}／切り替え：${p.transition}`);
    lines.push(`  Canvaで検索：${(p.search_keywords || []).join('、')}`);
    if (p.tip) lines.push(`  コツ：${p.tip}`);
  });
  lines.push(`BGM：${m.bgm?.mood}（検索：${(m.bgm?.search_keywords || []).join('、')}）`);
  if (v.editUrl) lines.push(`Canva：${v.editUrl}`);
  return lines.join('\n');
}

async function viewProject(id) {
  let project;
  try {
    project = await api('GET', `/api/projects/${encodeURIComponent(id)}`);
  } catch (e) {
    $app.innerHTML = `<p class="alert error">${esc(e.message)}</p>`;
    return;
  }
  const mine = project.userId === me.user.id;
  const plan = project.plan;
  const b = project.brief;

  $app.innerHTML = `
    <div class="project-head">
      <div>
        <h1>${esc(project.title || b.message)}</h1>
        <div class="chips">
          <span class="chip">${esc(PLATFORMS[b.platform] || b.platform)}</span>
          <span class="chip">${esc(b.pageCount)}ページ</span>
          <span class="chip">作成：${esc(project.owner || '—')}・${esc(fmtDate(project.createdAt))}</span>
        </div>
      </div>
      <div class="row">
        <a class="btn" href="#/?from=${esc(project.id)}">この内容で新しく作る</a>
      </div>
    </div>
    ${project.status === 'planning' || project.status === 'queued' ? `<div class="card">${statusHtml('generating').replace(esc(STATUS.generating), '構成案を作成中')}</div>` : ''}
    ${project.status === 'error' && !plan ? `<p class="alert error">${esc(project.error)}</p>` : ''}
    ${plan ? `
      <details class="card no-print" ${project.variants.every((v) => v.status !== 'done') ? 'open' : ''}>
        <summary><h2 style="display:inline">構成案</h2> <span class="muted">— 3案とも同じ構成で、見た目だけ変えています</span></summary>
        <table class="plan" style="margin-top:12px">
          <thead><tr><th></th><th>役割</th><th>テロップ</th><th>絵のイメージ</th><th>ねらい</th></tr></thead>
          <tbody>${plan.pages.map((p, i) => `
            <tr><td class="num">${i + 1}</td><td>${esc(p.role)}</td><td><strong>${esc(p.headline)}</strong>${p.subtext ? `<div class="muted">${esc(p.subtext)}</div>` : ''}</td><td>${esc(p.visual)}</td><td>${esc(p.intent)}</td></tr>`).join('')}
          </tbody>
        </table>
      </details>` : ''}
    <div class="variants">
      ${project.variants.map((v) => `
        <article class="card variant" data-variant="${esc(v.id)}">
          <div class="variant-head">
            <h3>${esc(dirName(v.directionId))}</h3>
            ${statusHtml(v.status)}
          </div>
          ${v.error ? `<p class="alert error">${esc(v.error)}</p>` : ''}
          ${pagesHtml(v, plan)}
          <div class="actions">
            ${v.editUrl ? `<a class="btn primary" href="${safeUrl(v.editUrl)}" target="_blank" rel="noopener">Canvaで開く</a>` : ''}
            ${mine && v.status === 'done' ? `<button class="btn" data-act="comment">${v.commentedAt ? '✓ 校正用コメント済み' : '校正用にコメント'}</button>` : ''}
          </div>
          <div class="actions sub">
            ${v.memo ? '<button class="btn small" data-act="copy">メモをコピー</button><button class="btn small" data-act="print">メモを印刷・PDF</button>' : ''}
            ${mine && ['done', 'error'].includes(v.status) ? '<button class="btn small ghost" data-act="retry">作り直す</button>' : ''}
          </div>
          ${memoHtml(v, plan)}
        </article>`).join('')}
    </div>
    <section class="card howto no-print">
      <h2>Canvaで動画にする手順</h2>
      <ol>
        <li>「Canvaで開く」で絵コンテを開く。素材を替えたいページは、メモの検索キーワードでCanvaの素材を探して差し替え。</li>
        <li>文字や写真を選び、上部の「アニメート」からメモの動きを付ける。</li>
        <li>画面下のページ一覧で各ページの表示秒数をメモどおりに変え、ページの間の「＋」横から切り替えを付ける。</li>
        <li>BGMは左メニューの「素材」→「オーディオ」でメモのキーワードを検索。</li>
        <li>「共有」→「ダウンロード」→ ファイルの種類「MP4動画」。ファイル名に「DRAFT」を付けると、ラフが完成品と混ざりません。</li>
      </ol>
      <p class="muted">校正：「校正用にコメント」でページの意図がCanvaのコメントに入ります。Canvaの「共有」から校正者を招待し、指摘はCanva上のコメントで集めてください。</p>
    </section>`;

  $app.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const vid = btn.closest('[data-variant]').dataset.variant;
      const v = project.variants.find((x) => x.id === vid);
      const act = btn.dataset.act;
      if (act === 'copy') {
        await navigator.clipboard.writeText(memoText(v, plan));
        toast('動画化メモをコピーしました');
      } else if (act === 'print') {
        document.body.dataset.print = vid;
        btn.closest('.variant').classList.add('printing');
        window.print();
        delete document.body.dataset.print;
        btn.closest('.variant').classList.remove('printing');
      } else if (act === 'comment') {
        if (v.commentedAt && !confirm('すでにコメント済みです。もう一度コメントしますか？')) return;
        btn.disabled = true;
        try {
          await api('POST', `/api/variants/${vid}/comment`);
          toast('Canvaのデザインにページの意図をコメントしました');
          viewProject(id);
        } catch (e) { toast(e.message); btn.disabled = false; }
      } else if (act === 'retry') {
        if (!confirm(`「${dirName(v.directionId)}」の案を作り直します。CanvaのAIクレジットを約${CREDIT_PER_VARIANT}%使います。よろしいですか？`)) return;
        btn.disabled = true;
        try { await api('POST', `/api/variants/${vid}/retry`); viewProject(id); } catch (e) { toast(e.message); btn.disabled = false; }
      }
    };
  });

  // 画像URLの期限（約11時間）が近い案は書き出し直す
  if (mine) {
    for (const v of project.variants) {
      const age = v.imagesAt ? Date.now() - Date.parse(v.imagesAt) : 0;
      if (v.status === 'done' && age > 9 * 3600 * 1000) {
        api('POST', `/api/variants/${v.id}/refresh-images`).then(() => viewProject(id)).catch(() => {});
        break;
      }
    }
  }

  const busy = !['done', 'error'].includes(project.status) || project.variants.some((v) => !['done', 'error'].includes(v.status));
  clearTimeout(pollTimer);
  if (busy) {
    pollTimer = setTimeout(() => { if (location.hash === `#/p/${id}`) viewProject(id); }, 3000);
  }
}

async function viewHistory(params) {
  const scope = params.get('scope') === 'mine' ? 'mine' : 'all';
  const q = params.get('q') || '';
  $app.innerHTML = `
    <h1>履歴</h1>
    <p class="lead">チームで作ったラフの一覧です。「この内容で新しく作る」から、過去の投稿を下敷きにできます。</p>
    <form class="history-tools" id="hform">
      <input class="input" name="q" placeholder="キーワードで探す" value="${esc(q)}">
      <div class="seg">
        <label><input type="radio" name="scope" value="all" ${scope === 'all' ? 'checked' : ''}>チーム全員</label>
        <label><input type="radio" name="scope" value="mine" ${scope === 'mine' ? 'checked' : ''}>自分</label>
      </div>
      <button class="btn">検索</button>
    </form>
    <div class="list" id="list"><p class="muted">読み込み中…</p></div>`;
  const form = document.getElementById('hform');
  const go = () => {
    const fd = new FormData(form);
    location.hash = `#/history?scope=${fd.get('scope')}&q=${encodeURIComponent(fd.get('q') || '')}`;
  };
  form.onsubmit = (e) => { e.preventDefault(); go(); };
  form.querySelectorAll('input[name=scope]').forEach((r) => { r.onchange = go; });

  try {
    const { items } = await api('GET', `/api/projects?scope=${scope}&q=${encodeURIComponent(q)}`);
    document.getElementById('list').innerHTML = items.length
      ? items.map((p) => `
        <a class="card item" href="#/p/${esc(p.id)}">
          <div>
            <div class="item-title">${esc(p.title || p.brief.message)}</div>
            <div class="item-meta">${esc(p.owner || '—')}・${esc(fmtDate(p.createdAt))}・${esc(PLATFORMS[p.brief.platform] || '')}・${esc(p.brief.purpose)}</div>
          </div>
          <div class="item-meta">${p.status === 'done' || p.status === 'error' ? `${p.doneCount}/${p.variantCount}案 完成` : '作成中…'}</div>
        </a>`).join('')
      : '<p class="empty">まだラフがありません。</p>';
  } catch (e) {
    document.getElementById('list').innerHTML = `<p class="alert error">${esc(e.message)}</p>`;
  }
}

// ---------- router ----------
function route() {
  clearTimeout(pollTimer);
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  window.scrollTo(0, 0);

  if (!me.user?.loggedIn) return viewWelcome(params);
  if (!me.user.displayName) return viewName();

  $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active',
    (a.dataset.nav === 'history' && path.startsWith('/history')) || (a.dataset.nav === 'new' && path === '/')));

  let m;
  if ((m = path.match(/^\/p\/([\w-]+)$/))) return viewProject(m[1]);
  if (path === '/history') return viewHistory(params);
  return viewNew(params);
}

window.addEventListener('hashchange', route);
await loadMe();
route();
