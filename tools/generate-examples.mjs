/** Generate editable example inputs and independently computed reference summaries. */
import {writeFile,mkdir} from 'node:fs/promises';
import {createBuilding} from '../src/core/model.js';
import {analyze} from '../src/core/analysis.js';
import {beam} from '../tests/benchmarks.mjs';
const root=new URL('../examples/',import.meta.url);
await mkdir(root,{recursive:true});
const atrium=createBuilding();
const cantilever=beam({segments:12});cantilever.name='Cantilever · 3 m · tip force';cantilever.grids={x:[0,1,2,3],y:[0]};cantilever.settings={modal:true,modes:6};cantilever.loads=[{id:'TIP',case:'TEST',type:'nodal',node:'N12',value:[0,0,-12000,0,0,0]}];
const fixed=beam();fixed.name='Fixed-fixed beam · uniform load';fixed.nodes[1].support=Array(6).fill(true);fixed.grids={x:[0,3],y:[0]};fixed.loads=[{id:'UDL',case:'TEST',type:'udl',element:'E0',system:'global',value:[0,0,-4000]}];
const released=structuredClone(fixed);released.name='End-released beam · uniform load';released.elements[0].releases[4]=released.elements[0].releases[10]=true;
const tipMass=beam({density:0});tipMass.name='Massless cantilever · 100 kg tip mass';tipMass.grids={x:[0,3],y:[0]};tipMass.nodes[1].mass=100;tipMass.settings={modal:true,modes:6};tipMass.loads=[{id:'TIP',case:'TEST',type:'nodal',node:'N1',value:[0,0,-1000,0,0,0]}];
const examples=[['atrium-six-story',atrium],['cantilever-tip-force',cantilever],['fixed-fixed-udl',fixed],['released-end-udl',released],['tip-mass-modes',tipMass]];
const references={generatedAt:new Date().toISOString(),runtime:process.version,note:'Computed reference summaries, not preloaded application results. Recompute with this script.',models:{}};
for(const [name,model] of examples){
  await writeFile(new URL(name+'.stratum.json',root),JSON.stringify(model,null,2));
  const r=analyze(model);
  references.models[name]={stats:r.stats,frequencies:r.modes.map(m=>m.frequency),modalResiduals:r.modes.map(m=>m.residual),warnings:r.warnings,modalError:r.modalError,static:Object.fromEntries(Object.entries(r.static).map(([id,s])=>[id,{maxSampledDisplacementM:s.maxDisplacement,relativeResidual:s.residual,appliedResultant:s.appliedResultant,reactionResultant:s.reactionResultant,equilibrium:s.equilibrium}]))};
}
await writeFile(new URL('reference-summary.json',root),JSON.stringify(references,null,2));
console.log('Wrote five editable example projects and computed reference-summary.json.');
