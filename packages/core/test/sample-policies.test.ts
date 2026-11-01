import {expect,test} from 'vitest';
import {resolve} from 'node:path';
import {defaultConfig} from '../src/config.js';
import {readPolicies} from '../src/policies.js';
test('同梱sample-vaultも読取専用で有効な空方針を返す',async()=>{const b=await readPolicies(defaultConfig(resolve('sample-vault'),resolve('.ctx-state/sample-policy-test')),'context-hub');expect(b.global).toEqual([]);expect(b.project).toEqual([]);});
