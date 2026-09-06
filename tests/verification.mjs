import {runBenchmarks} from './benchmarks.mjs';
import {writeFile} from 'node:fs/promises';
const tests=runBenchmarks();
const report={suite:'Stratum Frame analytical verification',timestamp:new Date().toISOString(),runtime:process.version,passed:tests.filter(t=>t.passed).length,total:tests.length,tests};
console.table(tests.map(t=>({test:t.name,status:t.passed?'PASS':'FAIL',error:t.relativeError??t.error??''})));
await writeFile(new URL('../docs/verification-results.json',import.meta.url),JSON.stringify(report,null,2));
if(tests.some(t=>!t.passed))process.exitCode=1;
