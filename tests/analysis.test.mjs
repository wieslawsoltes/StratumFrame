import test from 'node:test';
import assert from 'node:assert/strict';
import {runBenchmarks} from './benchmarks.mjs';
for(const result of runBenchmarks())test(result.name,()=>assert.equal(result.passed,true,result.error));
