// モックモード（npm run mock）用の偽物の Canva と Claude。
// API キーや Canva ログインなしで、画面の流れを確認できる。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const designs = new Map();

const COLORS = {
  pop: ['#FFD54F', '#2E7D32'],
  trust: ['#1F3A5F', '#FFFFFF'],
  emotional: ['#F8C8B8', '#5D4037'],
};

function svgPage(page, i, dir) {
  const [bg, fg] = COLORS[dir] || ['#E0E0E0', '#222'];
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960">
<rect width="540" height="960" fill="${bg}"/>
<rect x="40" y="420" width="460" height="400" rx="24" fill="${fg}" opacity="0.12"/>
<text x="270" y="640" font-size="28" text-anchor="middle" fill="${fg}" opacity="0.6">（写真：${esc(page.visual).slice(0, 18)}…）</text>
<text x="270" y="130" font-size="22" text-anchor="middle" fill="${fg}" opacity="0.7">${i + 1} / ${esc(page.role)}</text>
<text x="270" y="250" font-size="46" font-weight="bold" text-anchor="middle" fill="${fg}">${esc(page.headline)}</text>
<text x="270" y="320" font-size="26" text-anchor="middle" fill="${fg}">${esc(page.subtext)}</text>
<text x="270" y="910" font-size="20" text-anchor="middle" fill="${fg}" opacity="0.5">MOCK — Canva にはつながっていません</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export function mockCanva() {
  return {
    async createStoryboard(brief) {
      await sleep(1500);
      const id = `DMOCK${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 11);
      const pages = [...brief.matchAll(/(\d+)ページ目（(.+?)）：テロップ「(.+?)」(?:／(.+?))? ／ 絵：(.+)/g)].map((m) => ({
        role: m[2], headline: m[3], subtext: m[4] || '', visual: m[5],
      }));
      const dir = brief.includes('紺') ? 'trust' : brief.includes('エモーショナル') ? 'emotional' : 'pop';
      designs.set(id, { pages, dir });
      return id;
    },
    async readDesign(id) {
      const d = designs.get(id) || { pages: [] };
      return {
        title: '（モック）絵コンテ',
        pageCount: d.pages.length,
        editUrl: 'https://www.canva.com/',
        viewUrl: 'https://www.canva.com/',
        text: d.pages.map((p) => `${p.headline}\n${p.subtext}`).join('\n'),
      };
    },
    async exportPages(id) {
      await sleep(500);
      const d = designs.get(id) || { pages: [] };
      return d.pages.map((p, i) => svgPage(p, i, d.dir));
    },
    async comment() { await sleep(300); return { ok: true }; },
    async listToolNames() { return ['(mock)']; },
  };
}

export async function mockPlan(brief) {
  await sleep(800);
  const roles = brief.pageCount === 3 ? ['つかみ', '内容', '呼びかけ'] : ['つかみ', '内容', '共感', '呼びかけ'];
  return {
    title: brief.message.slice(0, 20),
    pages: roles.map((role, i) => ({
      role,
      headline: i === 0 ? brief.message.slice(0, 15) : i === roles.length - 1 ? 'プロフィールから申し込み' : `${role}のテロップ`,
      subtext: i === 1 ? (brief.details || '').slice(0, 30) : '',
      visual: `${brief.purpose}の${role}を表す写真`,
      intent: `${role}で見る人の関心を引く`,
    })),
  };
}

export async function mockMemo({ plan }) {
  await sleep(600);
  const pages = plan.pages.map((p, i) => ({
    page: i + 1,
    role: p.role,
    seconds: i === 0 ? 4 : 5,
    text_animation: ['タイプライター', '上昇', 'ポップ', 'フェード'][i % 4],
    visual_animation: i % 2 ? 'パン' : 'ゆっくりズーム',
    transition: i === plan.pages.length - 1 ? 'なし' : 'ディゾルブ',
    search_keywords: ['ボランティア 笑顔', '地域 屋外'],
    tip: i === 0 ? '最初の1秒で文字が出るようにする' : '',
  }));
  return {
    pages,
    bgm: { mood: '明るいアコースティック、テンポ速め', search_keywords: ['ウクレレ 明るい'] },
    total_seconds: pages.reduce((s, p) => s + p.seconds, 0),
  };
}
