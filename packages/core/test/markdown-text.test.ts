import { expect, test } from 'vitest';
import { clipText, inlineText, listText, nowText } from '../src/markdown-text.js';

test('一覧の行の無害化は、リンク・コード・HTMLの記法を無効にし、バックスラッシュで打ち消せない', () => {
  expect(listText('a|b\nc')).toBe('a b c');
  expect(listText('[資料](https://example.com)')).toBe('\\[資料\\](https://example.com)');
  // 本文の「\」で、角括弧の無効化を打ち消せない。
  expect(listText('\\[資料\\](https://example.com)')).toBe('\\\\\\[資料\\\\\\](https://example.com)');
  expect(listText('末尾の\\')).toBe('末尾の\\\\');
  // コードの範囲を作らせない（範囲の中では、足した「\」がそのまま表示される）。
  expect(listText('`C:\\tmp` と `Array<string>`')).toBe('\\`C:\\\\tmp\\` と \\`Array&lt;string>\\`');
  expect(listText('<img src=x> と <!-- 印 -->')).toBe('&lt;img src=x> と &lt;!-- 印 -->');
  // NOWの行は本文の記法を保ち、改行とHTMLコメントの開始だけを無効にする。
  expect(nowText('[a](b)\n\n`c` <b> <!-- d')).toBe('[a](b) `c` <b> &lt;!-- d');
  expect(inlineText('a|b\\[c]')).toBe('a|b\\[c]');
});

test('長い本文は、切ってから無害化する（足した記号の途中で切らない）', () => {
  expect(clipText('短い[本文]', 10)).toBe('短い\\[本文\\]');
  expect(clipText(`${'あ'.repeat(9)}[続き]`, 10)).toBe(`${'あ'.repeat(9)}\\[…`);
  expect(clipText(`${'あ'.repeat(9)}\\続き`, 10)).toBe(`${'あ'.repeat(9)}\\\\…`);
  expect(clipText(`${'あ'.repeat(9)}<b>`, 10)).toBe(`${'あ'.repeat(9)}&lt;…`);
  // 絵文字などを途中で切らない。
  expect(clipText('😀'.repeat(11), 10)).toBe(`${'😀'.repeat(10)}…`);
  expect(clipText('a|b', 10, text => text)).toBe('a|b');
});
