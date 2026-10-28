// Claude API で「構成案」と「動画化メモ」を作る。返り値はツール呼び出しで JSON に固定する。
import { config, readJsonConfig } from './config.js';

const PLATFORMS = {
  instagram: 'Instagram リール',
  tiktok: 'TikTok',
  youtube: 'YouTube ショート',
  facebook: 'Facebook リール',
};
export const platformName = (id) => PLATFORMS[id] || id;

async function callClaude({ system, user, tool }) {
  if (!config.anthropicApiKey) {
    throw new Error('Claude API のキーが設定されていません。.env の ANTHROPIC_API_KEY を確認してください。');
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Claude API が混み合っています（${res.status}）`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Claude API でエラーが発生しました（${res.status}）：${json.error?.message || ''}`);
    }
    const block = (json.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!block) throw new Error('Claude から構造化された結果を受け取れませんでした。');
    return block.input;
  }
  throw lastError;
}

const PLAN_TOOL = {
  name: 'storyboard_plan',
  description: 'SNS縦型動画ラフの構成案（ページ割り）を記録する',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'この投稿を一覧で見分けるための短い名前（20字以内）' },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'このページの役割（例：つかみ、内容、共感、呼びかけ）' },
            headline: { type: 'string', description: '大きく見せるテロップ。15字以内が目安' },
            subtext: { type: 'string', description: '小さめに添える文字（日時・場所など）。無ければ空文字' },
            visual: { type: 'string', description: '写真・イラストのイメージ。Canva が素材を選ぶ手がかりになる具体的な説明' },
            intent: { type: 'string', description: 'このページで見る人に感じてほしいこと（校正者向けの説明）' },
          },
          required: ['role', 'headline', 'subtext', 'visual', 'intent'],
        },
      },
    },
    required: ['title', 'pages'],
  },
};

export async function makePlan(brief) {
  const system = [
    'あなたはNPOの広報を手伝う、SNS縦型ショート動画の構成作家です。',
    '1ページ＝動画の1カットとして、静止画の絵コンテのページ割りを作ります。あとで人が Canva でアニメーションと表示秒数を付けて短い動画にします。',
    '・テロップはスマホで一瞬で読める短さにする（headline は15字以内が目安）。',
    '・ブリーフにない事実（日時、人数、金額など）は作らない。足りなければその要素を省く。',
    '・最初のページで手を止めさせ、最後のページで行動を呼びかける流れにする。',
  ].join('\n');
  const user = [
    `ページ数：${brief.pageCount}ページ（ちょうどこの数にする）`,
    `目的：${brief.purpose}`,
    `届けたい相手：${brief.audience}`,
    `一番伝えたい一言：${brief.message}`,
    `入れたい情報：${brief.details || '（特になし）'}`,
    `投稿先：${platformName(brief.platform)}`,
  ].join('\n');
  const plan = await callClaude({ system, user, tool: PLAN_TOOL });
  plan.pages = (plan.pages || []).slice(0, brief.pageCount);
  return plan;
}

/** Canva AI に渡す指示文（検証で狙いどおりに出た形式をそのまま使う） */
export function buildCanvaBrief(brief, plan, direction) {
  const lines = [
    `${platformName(brief.platform)}用の縦型（9:16）の絵コンテを${plan.pages.length}ページで作ってください。1ページ＝動画の1カットです。あとでCanvaでページごとにアニメーションと表示秒数を付けて短い動画にします。`,
    `テーマ：${brief.purpose}`,
    `ターゲット：${brief.audience}`,
    `トーン：${direction.style}`,
    'ページ構成：',
    ...plan.pages.map((p, i) => {
      const sub = p.subtext ? `／${p.subtext}` : '';
      return `${i + 1}ページ目（${p.role}）：テロップ「${p.headline}」${sub} ／ 絵：${p.visual}`;
    }),
    '文字はスマホで読める大きさにし、各ページの上下に余白を残してください。テロップの文言は変えずにそのまま使ってください。',
  ];
  return lines.join('\n');
}

const MEMO_TOOL = {
  name: 'video_memo',
  description: '絵コンテを Canva で動画にするための動画化メモを記録する',
  input_schema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            role: { type: 'string' },
            seconds: { type: 'number', description: '表示秒数' },
            text_animation: { type: 'string', description: '文字に付ける Canva のアニメーション名（例：タイプライター、上昇、ポップ、フェード）' },
            visual_animation: { type: 'string', description: '写真・イラストに付けるアニメーション（例：ゆっくりズーム、パン、なし）' },
            transition: { type: 'string', description: '次のページへの切り替え（例：ディゾルブ、スライド、なし）。最後のページは「なし」' },
            search_keywords: { type: 'array', items: { type: 'string' }, description: '素材を差し替えたいときに Canva で検索するキーワード（2〜3個、各2〜3語）' },
            tip: { type: 'string', description: '仕上げのコツを一言（なければ空文字）' },
          },
          required: ['page', 'role', 'seconds', 'text_animation', 'visual_animation', 'transition', 'search_keywords', 'tip'],
        },
      },
      bgm: {
        type: 'object',
        properties: {
          mood: { type: 'string' },
          search_keywords: { type: 'array', items: { type: 'string' } },
        },
        required: ['mood', 'search_keywords'],
      },
    },
    required: ['pages', 'bgm'],
  },
};

export async function makeVideoMemo({ brief, plan, direction, designText, pageCount }) {
  const kw = readJsonConfig('keywords.json');
  const n = pageCount || plan.pages.length;
  const system = [
    'あなたは Canva の動画編集に詳しい、NPO広報のアシスタントです。',
    '静止画の絵コンテに、Canva でアニメーションと表示秒数を付けて短い動画にするための「動画化メモ」を作ります。',
    '・アニメーション名は Canva にある一般的なもの（タイプライター、上昇、ポップ、フェード、パン、ズームなど）から選ぶ。',
    '・検索キーワードは、Canva の素材検索で実際に結果が出そうな短い日本語にする。特定の作品名やブランド名は使わない。',
    `・合計秒数は投稿先に合う長さ（目安15〜25秒）にする。テンポの目安：${direction.tempo}`,
    `・できるだけ使いたい言葉：${kw.preferred.join('、')}`,
    `・使わない言葉：${kw.avoid.join('、')}`,
  ].join('\n');
  const user = [
    `投稿先：${platformName(brief.platform)}`,
    `見た目の方向性：${direction.name}（${direction.style}）`,
    `ページ数：${n}`,
    '構成案：',
    ...plan.pages.map((p, i) => `${i + 1}. ${p.role}「${p.headline}」${p.subtext ? `（${p.subtext}）` : ''} 絵：${p.visual}`),
    '',
    'Canva で実際にできた絵コンテの文字：',
    designText || '（読み取れませんでした）',
  ].join('\n');
  const memo = await callClaude({ system, user, tool: MEMO_TOOL });
  memo.total_seconds = (memo.pages || []).reduce((s, p) => s + Number(p.seconds || 0), 0);
  return memo;
}
