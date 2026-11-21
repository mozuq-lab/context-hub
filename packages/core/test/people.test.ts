import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { packet, workflowSetup } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { setProjectStatus } from '../src/project-status.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { runCycle } from '../src/cycle.js';
import { doctor } from '../src/doctor.js';
import { ingest, intakeErrorSchema, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { hash, markdown, parseMarkdown } from '../src/storage.js';
import { buildPerson, findMention, inspectPeople, mentionExcerpt, normalizePersonDefinition, peopleIndexPath, personDefinitionPath, personPagePath, personTerms, readPersonChanges, rebuildPeople, setPerson, PersonDefinitionError } from '../src/people.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const at = (iso: string) => ({ occurredAt: iso, receivedAt: iso });

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール', keywords: ['集約'] });
  await addProject(config, { id: 'blog', title: 'ブログ', keywords: ['記事'] });
  const meeting = await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-10T01:00:00Z'), text: '打ち合わせ。田中さんと料金表を確認した。' });
  const summary = await capture(config, { source: 'cli', kind: 'work-summary', project: 'blog', ...at('2026-11-12T01:00:00Z'), text: '## 次の一手\n- [確認済み] Tanakaさんに公開日を返事する\n- [確認済み] 下書きを見直す' });
  const loose = await capture(config, { source: 'cli', ...at('2026-11-15T01:00:00Z'), text: '田中さんから電話。来週また話す。' });
  const other = await capture(config, { source: 'cli', ...at('2026-11-16T01:00:00Z'), text: '佐藤さんと昼食' });
  await organize(config, new MockLlm());
  await setPerson(config, { personId: 'tanaka', action: 'add', name: '田中さん', aliases: ['田中', 'Tanaka'], source: 'cli' });
  return { config, vault, meeting, summary, loose, other };
}

test('名前・呼び名は全角・半角と大文字・小文字をそろえて探し、英数字の呼び名は語の途中に一致しない', () => {
  const terms = personTerms({ name: '田中さん', aliases: ['Ken'] });
  expect(findMention('きのうＫＥＮと話した', terms)).toEqual({ start: 3, end: 6 });
  expect(findMention('Kenjiと話した', terms)).toBeUndefined();
  expect(findMention('ken-san と話した', terms)).toEqual({ start: 0, end: 3 });
  expect(findMention('昼に田中さんと会う', terms)).toEqual({ start: 2, end: 6 });
  // 和文は語の区切りがないため、含まれていれば一致とする。
  expect(findMention('タナカ田中さん', personTerms({ name: '田中', aliases: [] }))).toEqual({ start: 3, end: 5 });
  // 半角の濁点・半濁点は直前の文字とまとめてそろえる。
  expect(findMention('ｶﾞｯｷｰと会った', personTerms({ name: 'ガッキー', aliases: [] }))).toEqual({ start: 0, end: 5 });
  expect(findMention('昨日ｾﾊﾞｽﾁｬﾝから', personTerms({ name: 'ｾﾊﾞｽﾁｬﾝ', aliases: [] }))).toEqual({ start: 2, end: 9 });
  expect(findMention('ジョージ', personTerms({ name: 'ｼﾞｮｰｼﾞ', aliases: [] }))).toEqual({ start: 0, end: 4 });
  const text = `${'あ'.repeat(40)}田中さん${'い'.repeat(70)}`;
  expect(mentionExcerpt(text, findMention(text, terms)!)).toBe(`…${'あ'.repeat(30)}田中さん${'い'.repeat(60)}…`);
});

test('1文字の名前と、名前と同じ呼び名・重複は受け付けない', () => {
  expect(() => normalizePersonDefinition({ name: '田', aliases: [] })).toThrow(PersonDefinitionError);
  expect(() => normalizePersonDefinition({ name: '田中', aliases: [' 中 '] })).toThrow(PersonDefinitionError);
  expect(normalizePersonDefinition({ name: ' 田中 ', aliases: ['田中', 'ＴＡＮＡＫＡ', 'tanaka', ''] })).toEqual({ name: '田中', aliases: ['ＴＡＮＡＫＡ'] });
});

test('名前が出てくる記録と、名前が出てくる未完了の次の一手を人ごとに集める', async () => {
  const { config, vault, meeting, summary, loose, other } = await fixture();
  const text = await buildPerson(config, 'tanaka');
  expect(text).toContain('# 田中さん');
  expect(text).toContain('呼び名: 田中、Tanaka');
  expect(text).toContain('最後に出てきた日: 2026-11-15 / 記録 3件 / 未完了の項目 1件');
  expect(text).toMatch(/\[ブログ\]\(\.\.\/\.\.\/10_projects\/blog\/NOW\.md\) 次の一手: Tanakaさんに公開日を返事する/);
  expect(text.slice(text.indexOf('## 未完了'), text.indexOf('## 関わった'))).not.toContain('下書きを見直す');
  expect(text).toContain('- [集約ツール](../../10_projects/hub/NOW.md)（1件）');
  expect(text).toContain('- プロジェクト未定（1件）');
  expect(text).toContain(`[${meeting.inputId}](../../${meeting.path})`);
  expect(text).toContain(`[${summary.inputId}]`);
  expect(text).toContain(`11-15 メモ — 田中さんから電話。来週また話す。 — [${loose.inputId}]`);
  expect(text).not.toContain(other.inputId);
  expect(text.indexOf(loose.inputId)).toBeLessThan(text.indexOf(meeting.inputId));
  const writes = await rebuildPeople(config);
  expect(writes.filter(w => w.written).map(w => w.path).sort()).toEqual([peopleIndexPath, personPagePath('tanaka')]);
  const page = parseMarkdown((await vault.read(personPagePath('tanaka')))!);
  expect(page.meta).toMatchObject({ person: 'tanaka', records: 3, open_items: 1, last_seen: '2026-11-15T01:00:00Z', verified: false });
  expect(await vault.read(peopleIndexPath)).toContain('| [田中さん](tanaka/SUMMARY.md) | 2026-11-15 | 3 | 1 |');
  // 同じ内容なら書き直さない。
  expect((await rebuildPeople(config)).some(w => w.written)).toBe(false);
});

test('完了した次の一手・完了したプロジェクトの項目は載せず、休止中のプロジェクトの項目には印を付ける', async () => {
  const { config, vault } = await fixture();
  const projectHash = hash((await vault.read('10_projects/blog/project.md'))!);
  await setProjectStatus(config, { projectId: 'blog', status: 'paused', expectedHash: projectHash, source: 'cli' });
  expect(await buildPerson(config, 'tanaka')).toContain('（休止中のプロジェクト）');
  await setProjectStatus(config, { projectId: 'blog', status: 'done', expectedHash: hash((await vault.read('10_projects/blog/project.md'))!), source: 'cli' });
  expect(await buildPerson(config, 'tanaka')).toContain('未完了の項目 0件');
});

test('訂正で名前が消えたメモは外れ、秘密情報らしい文字列は抜粋で伏せる', async () => {
  const { config, loose } = await fixture();
  await capture(config, { source: 'cli', ...at('2026-11-17T01:00:00Z'), text: '田中さんに渡すキー sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' });
  await correctInput(config, loose.inputId, { source: 'cli', text: '電話があった。来週また話す。', occurredAt: '2026-11-15T02:00:00Z' });
  await organize(config, new MockLlm());
  const text = await buildPerson(config, 'tanaka');
  expect(text).not.toContain(loose.inputId);
  expect(text).toContain('[伏せ字:');
  expect(text).not.toContain('sk-ant-api03');
});

test('人を変更・外すときは確認したハッシュに結び付け、外すと手で変えていない画面も消す', async () => {
  const { config, vault } = await fixture();
  await rebuildPeople(config);
  const raw = (await vault.read(personDefinitionPath('tanaka')))!;
  await expect(setPerson(config, { personId: 'tanaka', action: 'edit', name: '田中さん', aliases: ['田中'], expectedHash: '0'.repeat(64), source: 'cli' })).rejects.toMatchObject({ reason: { code: 'person-changed' } });
  await expect(setPerson(config, { personId: 'tanaka', action: 'add', name: '田中さん', source: 'cli' })).rejects.toMatchObject({ reason: { code: 'person-exists' } });
  await expect(setPerson(config, { personId: 'sato', action: 'add', name: '佐藤さん', aliases: ['tanaka'], source: 'cli' })).rejects.toMatchObject({ reason: { code: 'person-overlap', person_id: 'tanaka' } });
  await setPerson(config, { personId: 'tanaka', action: 'edit', name: '田中さん', aliases: ['田中'], expectedHash: hash(raw), source: 'cli' });
  expect((await inspectPeople(vault)).people).toEqual([{ id: 'tanaka', name: '田中さん', aliases: ['田中'] }]);
  expect(await buildPerson(config, 'tanaka')).not.toContain('返事する');
  const edited = (await vault.read(personDefinitionPath('tanaka')))!;
  await setPerson(config, { personId: 'tanaka', action: 'remove', expectedHash: hash(edited), source: 'cli' });
  expect(await vault.read(personDefinitionPath('tanaka'))).toBeUndefined();
  expect(await vault.read(personPagePath('tanaka'))).toBeUndefined();
  expect((await readPersonChanges(vault)).map(c => c.action)).toEqual(['add', 'edit', 'remove']);
  await rebuildPeople(config);
  expect(await vault.read(peopleIndexPath)).toBeUndefined();
});

test('名前を変えると見出しも変え、変更のない変更・呼び名を省いた変更は受け付けない', async () => {
  const { config, vault } = await fixture();
  const raw = (await vault.read(personDefinitionPath('tanaka')))!;
  await expect(setPerson(config, { personId: 'tanaka', action: 'edit', name: '田中さん', aliases: ['田中', 'Tanaka'], expectedHash: hash(raw), source: 'cli' })).rejects.toMatchObject({ reason: { code: 'person-unchanged' }, message: '名前・呼び名に変更がありません。' });
  await expect(setPerson(config, { personId: 'tanaka', action: 'edit', name: '田中部長', expectedHash: hash(raw), source: 'cli' })).rejects.toThrow('呼び名の全体');
  await setPerson(config, { personId: 'tanaka', action: 'edit', name: '田中部長', aliases: ['田中', 'Tanaka'], expectedHash: hash(raw), source: 'cli' });
  const edited = parseMarkdown((await vault.read(personDefinitionPath('tanaka')))!);
  expect(edited.text).toMatch(/^# 田中部長\n/);
  expect(edited.text).not.toContain('# 田中さん');
});

test('登録の依頼を記録した後に外していれば、同じ依頼の再送で登録を戻さない', async () => {
  const { config, vault } = await workflowSetup(roots);
  const request = { personId: 'suzuki', action: 'add' as const, name: '鈴木さん', aliases: [], source: 'intake', sourceEventId: 'REQ-1' };
  await setPerson(config, request);
  const raw = (await vault.read(personDefinitionPath('suzuki')))!;
  await setPerson(config, { personId: 'suzuki', action: 'remove', expectedHash: hash(raw), source: 'cli' });
  await expect(setPerson(config, request)).resolves.toMatchObject({ deduped: true });
  expect(await vault.read(personDefinitionPath('suzuki'))).toBeUndefined();
  // 記録した直後（定義の書き込み前）に止まった場合は、同じ依頼の再送で回復する。
  await setPerson(config, { ...request, personId: 'sato', name: '佐藤さん', sourceEventId: 'REQ-2' });
  await vault.remove(personDefinitionPath('sato'));
  await expect(setPerson(config, { ...request, personId: 'sato', name: '佐藤さん', sourceEventId: 'REQ-2' })).resolves.toMatchObject({ deduped: true });
  expect(await vault.read(personDefinitionPath('sato'))).toBeDefined();
  // 変更記録が1件でも読めなければ重複を確かめられないため止める。直す場所が分かるよう、依頼の失敗とdoctorに記録のパスを示す。
  const [broken] = await vault.files('90_system/people');
  await vault.write(broken!, '{');
  await expect(setPerson(config, { ...request, personId: 'ito', name: '伊藤さん', sourceEventId: 'REQ-3' })).rejects.toThrow(broken!);
  expect((await doctor(config)).issues).toContain(`人の定義の変更記録が不正です: ${broken}`);
});

test('手で書き換えた画面は上書きせず、HOMEとdoctorで示す。読めない定義も示す', async () => {
  const { config, vault } = await fixture();
  await rebuildPeople(config);
  await vault.write(personPagePath('tanaka'), (await vault.read(personPagePath('tanaka')))! + '\n手で書いた行\n');
  await vault.write(personDefinitionPath('x'), markdown({ id: 'x', name: '中' , aliases: [] }, ''));
  const writes = await rebuildPeople(config);
  expect(writes).toContainEqual({ path: personPagePath('tanaka'), written: false, stopped: true });
  expect(await vault.read(personPagePath('tanaka'))).toContain('手で書いた行');
  const issues = (await doctor(config)).issues.join('\n');
  expect(issues).toContain(`人ごとの見返しの更新が止まっています（手で変更されています）: ${personPagePath('tanaka')}`);
  expect(issues).toContain(`人の定義が不正です: ${personDefinitionPath('x')}`);
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('人ごとの見返し（1人）: [PEOPLE.md](40_people/PEOPLE.md)');
  expect(home).toContain('人ごとの見返しの更新が止まっています');
  expect(home).toContain(`[人の定義を確かめてください](${personDefinitionPath('x')})`);
});

test('人を登録していなければ何も作らず、cycleで人ごとの画面を作る', async () => {
  const { config, vault } = await workflowSetup(roots);
  await capture(config, { source: 'cli', ...at('2026-11-10T01:00:00Z'), text: '田中さんと話した' });
  const first = await runCycle(config, new MockLlm());
  expect(first.people).toBeUndefined();
  expect(await vault.files('40_people')).toEqual([]);
  expect(await vault.read('HOME.md')).not.toContain('人ごとの見返し');
  await setPerson(config, { personId: 'tanaka', action: 'add', name: '田中さん', source: 'cli' });
  const second = await runCycle(config, new MockLlm());
  expect(second.people).toEqual(expect.arrayContaining([{ path: personPagePath('tanaka'), written: true }]));
  expect(await vault.read('HOME.md')).toContain('人ごとの見返し（1人）');
});

test('アプリからの登録・変更・外す依頼を受け付け、受け付けられない依頼は理由付きで記録する', async () => {
  const { config, vault } = await workflowSetup(roots);
  const add = { operation: 'person-definition', person_id: 'person-01jabcdefghjkmnpqrstvwxyz0', action: 'add', name: '鈴木さん', aliases: ['鈴木'], confirmed: true };
  await packet(config, { ...add, person_hash: '0'.repeat(64) }, '');
  expect((await ingest(config)).rejected).toBe(1);
  await rm(await vault.path('90_system/intake-errors'), { recursive: true, force: true });
  for (const p of await vault.files('Input')) await rm(await vault.path(p));
  await packet(config, add, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await inspectPeople(vault)).people).toEqual([{ id: add.person_id, name: '鈴木さん', aliases: ['鈴木'] }]);
  expect(await readIntakeReceipts(config)).toMatchObject([{ operation: 'person-definition', result: { personId: add.person_id, action: 'add', deduped: false } }]);
  // 重なる名前の登録は、理由を記録して再試行しない。
  await packet(config, { ...add, person_id: 'suzuki2', name: '鈴木' }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const errors = await Promise.all((await vault.files('90_system/intake-errors')).map(async p => intakeErrorSchema.parse(JSON.parse((await vault.read(p))!))));
  expect(errors).toMatchObject([{ status: 'error', reason: { code: 'person-overlap', person_id: add.person_id } }]);
  expect(errors[0]!.code).toContain('登録済みの人');
  expect((await ingest(config)).rejected).toBe(0);
  const raw = (await vault.read(personDefinitionPath(add.person_id)))!;
  await packet(config, { operation: 'person-definition', person_id: add.person_id, action: 'edit', person_hash: hash(raw), name: '鈴木さん', aliases: ['鈴木', 'Suzuki'], confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  const edited = (await vault.read(personDefinitionPath(add.person_id)))!;
  await packet(config, { operation: 'person-definition', person_id: add.person_id, action: 'remove', person_hash: hash(edited), confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await inspectPeople(vault)).people).toEqual([]);
  expect((await doctor(config)).issues.join(' ')).not.toMatch(/受付記録が不正|人の定義/);
});

test('本人が追加した行動は記録に数えず、名前が出てくれば未完了の次の一手として載せる', async () => {
  const { config, vault } = await fixture();
  const added = await capture(config, { source: 'cli', kind: 'action', project: 'hub', ...at('2026-11-17T01:00:00Z'), text: '田中さんに見積もりを送る' });
  const text = await buildPerson(config, 'tanaka');
  expect(text).toContain('記録 3件 / 未完了の項目 2件');
  expect(text).toMatch(/\[集約ツール\]\(\.\.\/\.\.\/10_projects\/hub\/NOW\.md\) 次の一手: 田中さんに見積もりを送る/);
  expect(text).not.toContain('undefined');
  expect(text.slice(text.indexOf('## 関わった'))).not.toContain(added.inputId);
  await rebuildPeople(config);
  expect(parseMarkdown((await vault.read(personPagePath('tanaka')))!).meta).toMatchObject({ records: 3, open_items: 2 });
});
