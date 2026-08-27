import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import mammoth from 'mammoth';
import { ArrowLeft, ArrowRight, Check, CheckCircle, ChevronRight, Download, FileText, KeyRound, LockKeyhole, Menu, Plus, Printer, Settings2, Sparkles, Upload, X } from 'lucide-react';
import { assertPublicHttps, endpointFor, errorMessage } from './aiErrors';
import { readSseContent } from './aiStream';
import { loadOriginalDocx, saveOriginalDocx } from './originalDocx';
import { patchOriginalDocx } from './patchDocx';
import '../styles/resume.css';

type Fact = { id: string; title: string; detail: string; sourceText?: string; category: string; confirmed: boolean };
type Suggestion = { id: string; factId: string; requirement: string; originalText: string; suggestedText: string; rationale: string; status: 'pending' | 'accepted' | 'rejected' };
type Analysis = { summary: string; coverage: string[]; gaps: string[] };
type StoredState = { facts: Fact[]; company: string; jobTitle: string; description: string; suggestions: Suggestion[]; analysis: Analysis | null };

const LOCAL_STATE_KEY = 'resume-modifier-local-state-v2';
const LOCAL_CONFIG_KEY = 'resume-modifier-ai-config-v1';
const SESSION_KEY = 'resume-modifier-ai-key-v1';
const JD_MIN_CHARS = 30;
const OVERVIEW_PROMPT = '中文求职匹配助手。只依据给定事实，禁止编造。先从 JD 抽出必选关键词与职责用语，再对照事实。只输出 JSON：{"summary":"不超过70字，点出对齐了哪些岗位用语","coverage":["已覆盖的JD要求，尽量使用JD原词，最多5条"],"gaps":["事实中没有的JD要求，最多5条"]}。';
const REWRITE_PROMPT = '你是中文简历投递改写助手，标准是岗位关键词对齐。原则：不编造、不补经历，只把真实经历里和本岗位相关的部分用 JD 原词说清楚。允许：把 JD 中的技能、职责、方法论、领域用语自然写进已有句子；同一事实换成本岗位更贴的表述；优先改写已覆盖必选要求的句子。禁止：添加事实里没有的技能、证书、职位、项目或数字；把缺口写成已经具备；为堆关键词而重复同一词；概括 originalText。originalText 必须是 sourceText 或简历里连续出现的原文。suggestedText 仅替换该句，长度接近原文，可读优先于关键词密度。rationale 先写植入了哪些 JD 原词，再写为何仍忠实于原事实。只输出 JSON：{"suggestions":[{"factId":"事实ID","requirement":"对应JD原句或原词","originalText":"必须是原文连续片段","suggestedText":"含岗位原词的投递表述","rationale":"植入关键词：…；忠实说明：…"}]}。最多5条，只给改了用语且仍真实的句子。';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
function setRoute(path: string) { window.location.hash = path; }
function scrollToSection(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function BrandMark() { return <a className="rs-brand" href="#/resume" aria-label="简历优化首页"><span className="rs-brand__mark">R</span><span>简历优化</span></a>; }
function parseStored<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } }
function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character); }
function extractJson(content: string) { const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content; const start = fenced.indexOf('{'); const end = fenced.lastIndexOf('}'); if (start < 0 || end < start) throw new Error('模型没有返回可读取的 JSON，请重试。'); return JSON.parse(fenced.slice(start, end + 1)); }
function detailFromBody(text: string) {
  const trimmed = text.trim();
  if (/<\s*html[\s>]|gateway time-?out/i.test(trimmed)) return '模型生成时间过长，转发网关超时。';
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 180);
    if (parsed.error && typeof parsed.error === 'object') {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 180);
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 180);
  } catch { /* keep body slice */ }
  return trimmed.slice(0, 180);
}
function functionGateway() {
  const anon = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (anon) {
    headers.apikey = anon;
    headers.Authorization = `Bearer ${anon}`;
  }
  return { url: '/sb-api/functions/v1/proxyChat', headers };
}

async function callAi(baseUrl: string, apiKey: string, model: string, system: string, user: string, maxTokens = 2048) {
  const targetUrl = endpointFor(baseUrl);
  assertPublicHttps(targetUrl);
  const { url, headers } = functionGateway();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targetUrl, apiKey, model, maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
  } catch (error) {
    throw new Error(errorMessage(error, '无法连上模型转发服务。'));
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const text = await response.text();
    const detail = detailFromBody(text);
    throw new Error(`模型接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  if (contentType.includes('event-stream')) return readSseContent(response);
  const text = await response.text();
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown };
  if (data.error) throw new Error(detailFromBody(text) || '模型接口返回错误。');
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('接口未返回 OpenAI 兼容的文本结果。');
  return content;
}

function jobContext(company: string, jobTitle: string, description: string, facts: Fact[]) {
  const compact = facts.map((fact) => ({ id: fact.id, title: fact.title, detail: fact.detail, sourceText: fact.sourceText ?? fact.detail, category: fact.category }));
  return `目标公司：${company || '未填写'}\n目标岗位：${jobTitle || 'AI 产品经理'}\n\n岗位 JD：\n${description.trim()}\n\n已确认事实：\n${JSON.stringify(compact)}`;
}

function parseSuggestionItems(raw: unknown, validIds: Set<string>): Suggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).flatMap((item: unknown): Suggestion[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const factId = String(value.factId ?? '');
    const requirement = String(value.requirement ?? '').trim();
    const originalText = String(value.originalText ?? '').trim();
    const suggestedText = String(value.suggestedText ?? '').trim();
    const rationale = String(value.rationale ?? '').trim();
    return validIds.has(factId) && requirement && originalText && suggestedText && rationale
      ? [{ id: createId(), factId, requirement, originalText, suggestedText, rationale, status: 'pending' }]
      : [];
  });
}

function safeFileStem(name: string) {
  return name.replace(/\.docx$/i, '').replace(/[\\/:*?"<>|]/g, '-') || '简历投递版';
}

function matchReportConditions(baseUrl: string, model: string, apiKey: string, description: string, confirmedCount: number) {
  return [
    { id: 'config', ok: Boolean(baseUrl.trim() && model.trim() && apiKey.trim()), label: '已填写接口地址、模型名称和 API Key' },
    { id: 'facts', ok: confirmedCount > 0, label: '至少确认 1 条真实事实' },
    { id: 'jd', ok: description.trim().length >= JD_MIN_CHARS, label: `职位描述不少于 ${JD_MIN_CHARS} 字` },
  ];
}

function replacementGroups(accepted: Suggestion[], facts: Fact[]) {
  return accepted.map((item) => {
    const fact = facts.find((value) => value.id === item.factId);
    const needles = [...new Set([item.originalText, fact?.sourceText, fact?.detail].map((value) => String(value ?? '').trim()).filter((value) => value.length >= 4))];
    return { needles, to: item.suggestedText };
  });
}

function MatchGate({ items, ready }: { items: ReturnType<typeof matchReportConditions>; ready: boolean }) {
  return (
    <ol className="rs-gate" aria-label="匹配报告生成条件">
      {items.map((item) => (
        <li key={item.id} data-ok={String(item.ok)}>
          <b>{item.ok ? '已满足' : '未满足'}</b>
          <span>{item.label}</span>
        </li>
      ))}
      <li data-ok={String(ready)}>
        <b>{ready ? '可生成' : '待点击'}</b>
        <span>三项齐备后点击「分析岗位匹配」。报告不会自动生成。</span>
      </li>
    </ol>
  );
}

function PublicPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="resume-app resume-public"><nav className="rs-nav-pill" aria-label="简历优化导航"><BrandMark /><div className="rs-nav-pill__links" data-open={menuOpen}><button type="button" className="rs-nav-link" onClick={() => scrollToSection('workflow')}>工作方式</button><button type="button" className="rs-nav-link" onClick={() => scrollToSection('privacy')}>本地模式</button><button type="button" className="rs-text-link" onClick={() => setRoute('#/resume/workspace')}>进入工作台</button></div><button type="button" className="rs-menu" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Menu size={18} /></button></nav><main><section className="rs-hero"><div className="rs-hero__copy"><p className="rs-micro-label">个人求职工作台 / AI 产品经理</p><h1>把经历，<span>对准</span>岗位。</h1><p className="rs-hero__lede">在浏览器本地管理简历材料，填入你自己的模型 Key，生成可逐条审阅的岗位改写建议。</p><div className="rs-hero__actions"><button type="button" className="rs-button rs-button--primary" onClick={() => setRoute('#/resume/workspace')}>开始一份申请 <ArrowRight size={16} /></button><button type="button" className="rs-button rs-button--quiet" onClick={() => scrollToSection('privacy')}>查看本地模式 <ChevronRight size={16} /></button></div><p className="rs-privacy-note"><LockKeyhole size={14} />不登录、不使用项目云数据库；Key 仅保留在当前浏览器标签页。</p></div><div className="rs-apparatus" aria-label="本地简历修改流程示意"><div className="rs-apparatus__callout rs-apparatus__callout--a">浏览器本地</div><div className="rs-apparatus__callout rs-apparatus__callout--b">你的模型接口</div><div className="rs-apparatus__callout rs-apparatus__callout--c">可审阅建议</div><div className="rs-apparatus__chamber"><span className="rs-apparatus__filament" /><span className="rs-apparatus__line" /><span className="rs-apparatus__line" /><span className="rs-apparatus__line" /><span className="rs-apparatus__stamp">LOCAL / AI</span></div></div></section><section id="workflow" className="rs-flow-section"><p className="rs-section-intro">从 Word 抽取事实，确认后粘贴 JD，模型只为你重排和改写已有信息。</p><ol className="rs-steps"><li><span>1.0</span><h2>导入母版</h2><p>Word 在浏览器里读取，不上传到项目云端。</p></li><li><span>2.0</span><h2>填入模型 Key</h2><p>支持 OpenAI 兼容的 https 接口；请求经边缘函数转发。</p></li><li><span>3.0</span><h2>写回原 Word</h2><p>采纳后把句子填进你导入的母版，再下载或打印。</p></li></ol></section><section id="privacy" className="rs-showcase"><div className="rs-showcase__head"><div><p className="rs-micro-label">无账号 · 无项目云数据</p><h2>你的 Key，由你自己带来。</h2></div><button type="button" className="rs-button rs-button--quiet" onClick={() => setRoute('#/resume/workspace')}>配置模型 <KeyRound size={16} /></button></div><div className="rs-browser"><div className="rs-browser__top"><span>本地工作台</span><span>OpenAI compatible</span><span>无云端记录</span></div><div className="rs-browser__body"><aside><b>设置</b><button type="button" className="is-active">接口地址</button><button type="button">模型名称</button><button type="button">API Key</button></aside><div className="rs-browser__report"><div className="rs-report-title"><p>数据留存方式</p><span>当前浏览器</span></div><div className="rs-evidence-row"><span>API Key</span><div><b>只保留在会话内存</b><p>关闭标签页即清除</p></div><CheckCircle size={18} /></div><div className="rs-evidence-row"><span>简历数据</span><div><b>浏览器本地存储</b><p>可随时在浏览器清除</p></div><CheckCircle size={18} /></div></div></div></div></section></main><footer className="rs-footer"><p>先确认事实，再调整表达。</p><div><BrandMark /><span>仅供你自己的求职工作流使用</span></div></footer></div>;
}

function WorkspacePage() {
  const saved = parseStored<StoredState>(LOCAL_STATE_KEY, { facts: [], company: '', jobTitle: 'AI 产品经理', description: '', suggestions: [], analysis: null });
  const config = parseStored<{ baseUrl: string; model: string }>(LOCAL_CONFIG_KEY, { baseUrl: '', model: '' });
  const [facts, setFacts] = useState<Fact[]>(saved.facts); const [company, setCompany] = useState(saved.company); const [jobTitle, setJobTitle] = useState(saved.jobTitle); const [description, setDescription] = useState(saved.description); const [suggestions, setSuggestions] = useState<Suggestion[]>(saved.suggestions); const [analysis, setAnalysis] = useState<Analysis | null>(saved.analysis); const [baseUrl, setBaseUrl] = useState(config.baseUrl); const [model, setModel] = useState(config.model); const [apiKey, setApiKey] = useState(() => sessionStorage.getItem(SESSION_KEY) ?? ''); const [fileName, setFileName] = useState(''); const [factTitle, setFactTitle] = useState(''); const [factDetail, setFactDetail] = useState(''); const [busy, setBusy] = useState<'idle' | 'extracting' | 'analyzing'>('idle');   const [notice, setNotice] = useState(''); const fileRef = useRef<HTMLInputElement>(null); const originalRef = useRef<ArrayBuffer | null>(null);
  const confirmedFacts = useMemo(() => facts.filter((fact) => fact.confirmed), [facts]);
  const reportConditions = useMemo(() => matchReportConditions(baseUrl, model, apiKey, description, confirmedFacts.length), [baseUrl, model, apiKey, description, confirmedFacts.length]);
  const canGenerateReport = reportConditions.every((item) => item.ok);
  useEffect(() => { localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({ facts, company, jobTitle, description, suggestions, analysis })); }, [facts, company, jobTitle, description, suggestions, analysis]);
  useEffect(() => { localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify({ baseUrl, model })); }, [baseUrl, model]);
  useEffect(() => { if (apiKey) sessionStorage.setItem(SESSION_KEY, apiKey); else sessionStorage.removeItem(SESSION_KEY); }, [apiKey]);
  useEffect(() => { void loadOriginalDocx().then((stored) => { if (!stored) return; originalRef.current = stored.buffer; setFileName((current) => current || stored.name); }).catch(() => undefined); }, []);
  const ensureConfig = () => { if (!baseUrl.trim() || !model.trim() || !apiKey.trim()) { setNotice('请先填写接口地址、模型名称和 API Key。'); return false; } return true; };
  const parseWord = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; if (!file.name.toLowerCase().endsWith('.docx')) { setNotice('当前只接收 .docx Word 文件作为母版。'); return; } try { const buffer = await file.arrayBuffer(); originalRef.current = buffer.slice(0); await saveOriginalDocx(file.name, buffer.slice(0)); setFileName(file.name); if (!ensureConfig()) { setNotice('已保存这份 Word 母版。填写接口、模型和 Key 后再导入一次可提取事实，或手动添加事实。采纳后会写回该原文。'); return; } setBusy('extracting'); setNotice(''); const result = await mammoth.extractRawText({ arrayBuffer: buffer }); if (!result.value.trim()) throw new Error('没有从这份 Word 文档读到文字。'); const resumeText = result.value.trim(); const content = await callAi(baseUrl, apiKey, model, '你是中文求职事实核验助手。只从原文抽取可核对事实，禁止补充猜测。只输出 JSON：{"facts":[{"title":"短标题","detail":"忠实概述","sourceText":"原文证据","category":"经历|项目|教育|技能"}]}。条数不设上限，原文有多少可核对事实就抽多少。', `请抽取事实候选：\n\n${resumeText}`, 8000); const parsed = extractJson(content); const candidates = Array.isArray(parsed.facts) ? parsed.facts : []; const normalized = candidates.flatMap((item: unknown): Fact[] => { if (!item || typeof item !== 'object') return []; const value = item as Record<string, unknown>; const title = String(value.title ?? '').trim().slice(0, 80); const detail = String(value.detail ?? '').trim().slice(0, 900); return title && detail ? [{ id: createId(), title, detail, sourceText: String(value.sourceText ?? '').trim().slice(0, 1200), category: String(value.category ?? '经历').trim().slice(0, 40), confirmed: false }] : []; }); if (!normalized.length) { setNotice('模型没有提取到可核对的事实。可直接在下方手动添加。'); return; } setFacts((current) => [...current, ...normalized]); setNotice(`已从 ${file.name} 提取 ${normalized.length} 条候选事实，请逐条勾选确认。原始 Word 不会保存到项目云端。`); } catch (error) { setNotice(errorMessage(error, 'Word 解析或模型调用失败。')); } finally { setBusy('idle'); event.target.value = ''; } };
  const addFact = () => { if (!factTitle.trim() || !factDetail.trim()) { setNotice('请填写事实标题和可核对的事实内容。'); return; } setFacts((current) => [...current, { id: createId(), title: factTitle.trim(), detail: factDetail.trim(), sourceText: factDetail.trim(), category: '手动补充', confirmed: false }]); setFactTitle(''); setFactDetail(''); setNotice('已新增候选事实，确认后才会用于岗位分析。'); };
  const analyze = async () => {
    if (!ensureConfig()) return;
    if (description.trim().length < JD_MIN_CHARS) { setNotice(`请粘贴至少 ${JD_MIN_CHARS} 个字的职位描述。`); return; }
    if (!confirmedFacts.length) { setNotice('请先确认至少一条真实事实。'); return; }
    setBusy('analyzing'); setNotice(''); setAnalysis(null); setSuggestions([]);
    const context = jobContext(company, jobTitle, description, confirmedFacts);
    const validIds = new Set(confirmedFacts.map((fact) => fact.id));
    try {
      const overviewText = await callAi(baseUrl, apiKey, model, OVERVIEW_PROMPT, context, 1500);
      const overview = extractJson(overviewText) as Record<string, unknown>;
      setAnalysis({
        summary: String(overview.summary ?? '').trim().slice(0, 160),
        coverage: Array.isArray(overview.coverage) ? overview.coverage.slice(0, 5).map((item) => String(item).slice(0, 180)) : [],
        gaps: Array.isArray(overview.gaps) ? overview.gaps.slice(0, 5).map((item) => String(item).slice(0, 180)) : [],
      });
      try {
        const rewriteText = await callAi(baseUrl, apiKey, model, REWRITE_PROMPT, context, 2000);
        const rewrite = extractJson(rewriteText) as Record<string, unknown>;
        setSuggestions(parseSuggestionItems(rewrite.suggestions, validIds));
        setNotice('匹配结果已保存在当前浏览器。请逐条采纳或拒绝后再导出。');
      } catch (error) {
        setNotice(`${errorMessage(error, '改写建议未完成。')} 匹配摘要已生成，可再点一次分析生成改写建议。`);
      }
    } catch (error) {
      setNotice(errorMessage(error, '岗位分析失败。'));
    } finally {
      setBusy('idle');
    }
  };
  const resolveOriginal = async () => originalRef.current ?? (await loadOriginalDocx())?.buffer ?? null;
  const exportDocx = async () => {
    const accepted = suggestions.filter((item) => item.status === 'accepted');
    if (!accepted.length) { setNotice('请至少采纳一条改写建议后再导出。'); return; }
    const source = await resolveOriginal();
    if (!source) { setNotice('请先导入同一份 Word 母版，采纳的句子才能写回原文。'); return; }
    try {
      const result = await patchOriginalDocx(source, replacementGroups(accepted, facts));
      if (!result.applied) { setNotice('未能在原 Word 中定位这些句子。请确认导入的是同一份母版，且建议中的原文与简历一致。'); return; }
      downloadBlob(result.blob, `${safeFileStem(fileName)}-投递版.docx`);
      setNotice(result.missed.length ? `已把 ${result.applied} 条写回原 Word；有 ${result.missed.length} 条原文定位失败，那些句子未改。` : `已把 ${result.applied} 条采纳建议写回原 Word 并下载。`);
    } catch (error) {
      setNotice(errorMessage(error, '写回原 Word 失败。'));
    }
  };
  const printPdf = async () => {
    const accepted = suggestions.filter((item) => item.status === 'accepted');
    if (!accepted.length) { setNotice('请至少采纳一条改写建议后再保存 PDF。'); return; }
    const source = await resolveOriginal();
    if (!source) { setNotice('请先导入同一份 Word 母版，保存 PDF 时会按写回后的全文打印。'); return; }
    try {
      const result = await patchOriginalDocx(source, replacementGroups(accepted, facts));
      if (!result.applied) { setNotice('未能在原 Word 中定位这些句子，无法按写回后的全文打印。'); return; }
      const printWindow = window.open('', '_blank', 'noopener,noreferrer');
      if (!printWindow) { setNotice('浏览器阻止了打印窗口，请允许弹窗后重试。'); return; }
      const body = result.text.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');
      printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>投递版简历</title><style>body{font-family:"Microsoft YaHei",sans-serif;max-width:760px;margin:48px auto;line-height:1.75;color:#181818}h1{font-size:28px;margin:0}p{margin:6px 0}@media print{body{margin:20mm}}</style></head><body><h1>${escapeHtml(jobTitle || fileName || '投递版简历')}</h1>${body}<script>window.onload=()=>window.print()</script></body></html>`);
      printWindow.document.close();
      if (result.missed.length) setNotice(`已按写回后的全文打开打印；有 ${result.missed.length} 条原文定位失败，那些句子仍是原稿。`);
    } catch (error) {
      setNotice(errorMessage(error, '写回原 Word 后打印失败。'));
    }
  };
  return <div className="resume-app rs-workspace"><header className="rs-workspace__top"><BrandMark /><div className="rs-workspace__top-actions"><span className="rs-mode-badge">本地模式 · 未登录</span><button type="button" className="rs-icon-button" onClick={() => setRoute('#/resume')} aria-label="返回公开页"><ArrowLeft size={17} /></button></div></header><div className="rs-workspace__notice"><LockKeyhole size={15} />简历和 JD 保存在当前浏览器；API Key 只保留在当前标签页。调用经边缘函数转发到你填写的模型服务商，Key 不写入数据库。</div><main className="rs-workspace__main"><section className="rs-workspace__heading"><div><p className="rs-micro-label">本地工作台 / AI 产品经理</p><h1>新建岗位申请</h1><p>不使用登录、云数据库或项目模型密钥。请先配置你自己的 OpenAI 兼容模型接口。</p></div><button type="button" className="rs-button rs-button--quiet" onClick={() => setRoute('#/resume')}><ArrowLeft size={16} />返回说明页</button></section><section className="rs-model-settings"><div><p className="rs-panel__eyebrow">模型配置</p><h2><Settings2 size={18} />你的接口与 Key</h2><p>Key 不写入本地存储；关闭当前浏览器标签页后会清除。</p></div><div className="rs-model-settings__fields"><label className="rs-field"><span>接口地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com 或 https://api.openai.com/v1" /></label><label className="rs-field"><span>模型名称</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如：deepseek-chat" /></label><label className="rs-field"><span>API Key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="仅保留在当前标签页" /></label></div><small>填写 OpenAI 兼容地址即可，例如 <code>https://api.deepseek.com</code>。文本任务建议模型名 <code>deepseek-v4-flash</code>。请求经边缘函数转发，Key 不写入数据库。</small></section>{notice && <div className="rs-live-note"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button></div>}<div className="rs-workspace__grid"><section className="rs-panel rs-facts-panel"><div className="rs-panel__head"><div><p className="rs-panel__eyebrow">事实库</p><h2>只使用你确认的内容</h2></div><span>{confirmedFacts.length} / {facts.length} 已确认</span></div><label className="rs-upload" onClick={() => fileRef.current?.click()}><Upload size={18} /><span>{fileName || '导入 Word 母版'}</span><small>{busy === 'extracting' ? '正在读取文档并调用你的模型…' : '支持 .docx；原始文件不上传'}</small><input ref={fileRef} type="file" accept=".docx" onChange={parseWord} disabled={busy !== 'idle'} /></label><div className="rs-fact-list">{facts.length ? facts.map((fact) => <label className="rs-fact" key={fact.id}><input type="checkbox" checked={fact.confirmed} onChange={() => setFacts((current) => current.map((item) => item.id === fact.id ? { ...item, confirmed: !item.confirmed } : item))} /><span className="rs-fact__box">{fact.confirmed && <Check size={14} />}</span><span><b>{fact.title}</b><small>{fact.detail}</small></span></label>) : <div className="rs-empty rs-empty--compact"><FileText size={21} /><p>导入 Word 或手动添加第一条真实事实。</p></div>}</div><div className="rs-manual-fact"><input value={factTitle} onChange={(event) => setFactTitle(event.target.value)} placeholder="事实标题，例如：模型评估" /><textarea value={factDetail} onChange={(event) => setFactDetail(event.target.value)} placeholder="只写可核对的真实经历、职责或结果" /><button type="button" className="rs-add-fact" onClick={addFact}><Plus size={16} />新增事实</button></div></section><section className="rs-panel rs-job-panel"><div className="rs-panel__head"><div><p className="rs-panel__eyebrow">岗位信息</p><h2>粘贴完整 JD</h2></div><FileText size={19} /></div><div className="rs-field-row"><label className="rs-field"><span>公司名 <i>可选</i></span><input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="例如：某科技公司" /></label><label className="rs-field"><span>岗位名称</span><input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder="AI 产品经理" /></label></div><label className="rs-field rs-field--textarea"><span>职位描述 <i>必填</i></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="粘贴职责、任职要求与优先条件。系统会把每一条要求映射到已确认事实。" /><small>岗位数据只保存在当前浏览器，不进入项目云端。</small></label><button type="button" className="rs-button rs-button--primary rs-analyze" onClick={() => void analyze()} disabled={busy !== 'idle'}>{busy === 'analyzing' ? '正在生成可审阅建议…' : '分析岗位匹配'} <Sparkles size={16} /></button><p className="rs-analyze-hint">{canGenerateReport ? '条件已齐，点击上方按钮生成匹配报告。' : '匹配报告不会自动出现，先完成下方三项条件。'}</p></section><section className="rs-panel rs-report-panel"><div className="rs-panel__head"><div><p className="rs-panel__eyebrow">匹配报告</p><h2>先看证据，再改写</h2><p className="rs-rewrite-standard">改写标准：岗位关键词对齐。用 JD 原词改写已有句子，不补经历、不编数字。</p></div>{analysis && <span className="rs-ready">已生成</span>}</div>{busy === 'analyzing' && <div className="rs-skeletons"><span /><span /><span /></div>}{!analysis && busy !== 'analyzing' && <div className="rs-empty rs-empty--gate"><Sparkles size={23} /><p>{canGenerateReport ? '条件已齐。点击左侧「分析岗位匹配」，这里才会生成证据、缺口与改写建议。' : '匹配报告只在同时满足下列条件、并点击「分析岗位匹配」后生成。'}</p><MatchGate items={reportConditions} ready={canGenerateReport} /></div>}{analysis && <div className="rs-analysis"><p className="rs-analysis__summary">{analysis.summary || '本次匹配已完成。'}</p><div className="rs-analysis__split"><div><b>已找到证据</b>{analysis.coverage.length ? analysis.coverage.map((item) => <span key={item}><CheckCircle size={13} />{item}</span>) : <span>暂无明确覆盖项</span>}</div><div><b>仍需补充</b>{analysis.gaps.length ? analysis.gaps.map((item) => <span key={item}>{item}</span>) : <span>暂无明确缺口</span>}</div></div><div className="rs-suggestion-list">{suggestions.length ? suggestions.map((item) => <article className={`rs-suggestion rs-suggestion--${item.status}`} key={item.id}><p>对应要求 · {item.requirement}</p><del>{item.originalText}</del><strong>{item.suggestedText}</strong><small>{item.rationale}</small><div><button type="button" className="rs-suggestion__accept" disabled={item.status === 'accepted'} onClick={() => setSuggestions((current) => current.map((value) => value.id === item.id ? { ...value, status: 'accepted' } : value))}><Check size={14} />采纳</button><button type="button" disabled={item.status === 'rejected'} onClick={() => setSuggestions((current) => current.map((value) => value.id === item.id ? { ...value, status: 'rejected' } : value))}>不采用</button></div></article>) : <p className="rs-empty-text">这份 JD 暂未找到足够的可改写事实。请补充真实经历，不会自动编造。</p>}</div>{suggestions.some((item) => item.status === 'accepted') && <div className="rs-export-actions"><button type="button" className="rs-export" onClick={() => void exportDocx()}><Download size={16} />写回原 Word 并下载</button><button type="button" className="rs-export" onClick={() => void printPdf()}><Printer size={16} />按写回后全文打印</button></div>}</div>}</section></div></main></div>;
}

export default function LocalResumeStudio() { const [route, setRouteState] = useState(() => window.location.hash); useEffect(() => { const onHashChange = () => setRouteState(window.location.hash); window.addEventListener('hashchange', onHashChange); return () => window.removeEventListener('hashchange', onHashChange); }, []); return route.startsWith('#/resume/workspace') ? <WorkspacePage /> : <PublicPage />; }
