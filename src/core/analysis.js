import {AnalysisError,SparseBuilder,SkylineLDLT,lowestModes,dot,norm,axpy,cross} from './linalg.js';
import {DOFS,LOCAL_DOFS,localAxes,frameMatrices,uniformLoad,pointLoad,mat12Vec,globalToLocal,localToGlobal,sectionForces,memberDisplacement} from './elements.js';
import {validateModel,position,GRAVITY} from './model.js';

const addMapped=(out,map,value)=>{for(const [i,c]of map)out[i]+=c*value;};
const evalMap=(map,x)=>{let r=0;for(const [i,c]of map)r+=c*x[i];return r;};
function combineMaps(terms) {const a=new Map();for(const [map,mul]of terms)for(const [i,v]of map)a.set(i,(a.get(i)||0)+v*mul);return [...a].filter(([,v])=>Math.abs(v)>1e-14);}
function addMappedMatrix(builder,A,B) {
  for(let r=0;r<12;r++)for(let s=0;s<12;s++) {
    const v=A[r*12+s];if(!v)continue;
    for(const [i,ci]of B[r])for(const [j,cj]of B[s])builder.add(i,j,ci*cj*v);
  }
}
function makeConstraints(model) {
  const labels=[],nodeMaps=[],diaph=new Map(),nodes=new Map(model.nodes.map(n=>[n.id,n]));
  const newDof=label=>{labels.push(label);return labels.length-1;};
  for(const d of model.diaphragms) {
    const cx=d.nodes.reduce((s,id)=>s+nodes.get(id).x,0)/d.nodes.length,cy=d.nodes.reduce((s,id)=>s+nodes.get(id).y,0)/d.nodes.length;
    const master=[newDof(`${d.id}:UX`),newDof(`${d.id}:UY`),newDof(`${d.id}:RZ`)];
    for(const id of d.nodes)diaph.set(id,{cx,cy,master});
  }
  for(const n of model.nodes) {
    const d=diaph.get(n.id),maps=Array.from({length:6},()=>[]);
    for(let k=0;k<6;k++) {
      if(d&&[0,1,5].includes(k)) {
        maps[k]=k===0?[[d.master[0],1],[d.master[2],-(n.y-d.cy)]]:k===1?[[d.master[1],1],[d.master[2],n.x-d.cx]]:[[d.master[2],1]];
        maps[k]=maps[k].filter(([,c])=>Math.abs(c)>1e-14);
      }else if(!n.support[k])maps[k]=[[newDof(`${n.id}:${DOFS[k]}`),1]];
    }
    nodeMaps.push(maps);
  }
  return {labels,nodeMaps,newDof};
}
function gatherLoads(model,elements,nodeIndex,nodeMaps,n) {
  const cases={};for(const c of model.cases)cases[c.id]={id:c.id,F:new Float64Array(n),nodal:new Float64Array(model.nodes.length*6),members:{}};
  const members=new Map(elements.map(e=>[e.id,e]));
  const memberData=(c,id)=>c.members[id]??(c.members[id]={q:[0,0,0],points:[],f:new Float64Array(12)});
  for(const c of model.cases)if(c.selfWeight)for(const e of elements) {
    const data=memberData(cases[c.id],e.id),q=globalToLocal(e.R,[0,0,-GRAVITY*e.material.density*e.section.A*c.selfWeight]);
    for(let k=0;k<3;k++)data.q[k]+=q[k];
  }
  for(const load of model.loads) {
    const c=cases[load.case];
    if(load.type==='nodal') {
      const index=nodeIndex.get(load.node);for(let k=0;k<6;k++){addMapped(c.F,nodeMaps[index][k],load.value[k]);c.nodal[index*6+k]+=load.value[k];}
    }else {
      const e=members.get(load.element),data=memberData(c,load.element),v=load.system==='local'?load.value:globalToLocal(e.R,load.value);
      if(load.type==='udl')for(let k=0;k<3;k++)data.q[k]+=v[k];
      else data.points.push({position:load.position,value:[...v]});
    }
  }
  for(const c of Object.values(cases))for(const e of elements) {
    const data=memberData(c,e.id);data.f=uniformLoad(data.q,e.L);
    for(const p of data.points)axpy(data.f,pointLoad(p.value,p.position,e.L),1);
    for(let k=0;k<12;k++)addMapped(c.F,e.B[k],data.f[k]);
  }
  return cases;
}
export function assemble(model,onProgress=()=>{}) {
  const warnings=validateModel(model);
  if(!model.nodes.length||!model.elements.length)throw new AnalysisError('Add joints and frame members before analysis.');
  const connected=new Set(model.elements.flatMap(e=>[e.i,e.j]));
  for(const n of model.nodes)if(!connected.has(n.id))throw new AnalysisError(`Joint ${n.id} is disconnected. Connect it to a frame or delete it.`);
  onProgress({stage:'Mapping DOFs and constraints'});
  const {labels,nodeMaps,newDof}=makeConstraints(model),nodeIndex=new Map(model.nodes.map((n,i)=>[n.id,i]));
  const sections=new Map(model.sections.map(s=>[s.id,s])),materials=new Map(model.materials.map(m=>[m.id,m]));
  const elements=[];
  for(const e of model.elements) {
    const i=nodeIndex.get(e.i),j=nodeIndex.get(e.j),a=position(model.nodes[i]),b=position(model.nodes[j]),{L,R}=localAxes(a,b,e.roll||0);
    const section=sections.get(e.section),material=materials.get(section.material),{K,M}=frameMatrices(L,section,material);
    if([...K,...M].some(v=>!Number.isFinite(v)))throw new AnalysisError(`Frame ${e.id} produced a nonfinite stiffness or mass coefficient. Review units and magnitudes.`);
    const B=[];
    for(let k=0;k<12;k++) {
      const end=k<6?i:j,group=k%6<3?0:3,axis=k%3;
      B.push(e.releases?.[k]?[[newDof(`${e.id}:${k<6?'I':'J'} released ${LOCAL_DOFS[k%6]}`),1]]:combineMaps([0,1,2].map(t=>[nodeMaps[end][group+t],R[axis][t]])));
    }
    elements.push({id:e.id,i,j,a,b,L,R,section,material,K,M,B,releases:e.releases||Array(12).fill(false)});
  }
  const n=labels.length,Kb=new SparseBuilder(n),Mb=new SparseBuilder(n),influence=Array.from({length:3},()=>new Float64Array(n));let totalMass=0;
  onProgress({stage:'Assembling sparse stiffness and mass',dofs:n});
  for(const e of elements) {
    addMappedMatrix(Kb,e.K,e.B);addMappedMatrix(Mb,e.M,e.B);totalMass+=e.material.density*e.section.A*e.L;
    for(let dir=0;dir<3;dir++) {
      const rigid=new Float64Array(12);for(let k=0;k<3;k++)rigid[k]=rigid[k+6]=e.R[k][dir];
      const force=mat12Vec(e.M,rigid);for(let k=0;k<12;k++)addMapped(influence[dir],e.B[k],force[k]);
    }
  }
  model.nodes.forEach((node,index)=>{
    const mass=node.mass||0;totalMass+=mass;
    for(let k=0;k<6;k++) {
      const v=k<3?mass:(node.massInertia?.[k-3]||0),map=nodeMaps[index][k];
      for(const [i,a]of map)for(const [j,b]of map)Mb.add(i,j,a*b*v);
      if(k<3)addMapped(influence[k],map,mass);
    }
  });
  const cases=gatherLoads(model,elements,nodeIndex,nodeMaps,n),active=[],inactive=[];
  for(let i=0;i<n;i++) {
    const d=Kb.diagonal(i);
    if(d===0) {
      if(Mb.diagonal(i)!==0||Object.values(cases).some(c=>c.F[i]!==0))throw new AnalysisError(`Unrestrained DOF ${labels[i]} has no stiffness but carries load or mass.`,{dof:labels[i]});
      inactive.push(labels[i]);
    }else active.push(i);
  }
  if(inactive.length)warnings.push(`${inactive.length} exactly zero-stiffness, zero-mass, unforced DOFs were excluded: ${inactive.slice(0,10).join(', ')}${inactive.length>10?' …':''}. No artificial stiffness was added.`);
  const inverse=new Int32Array(n).fill(-1);active.forEach((v,i)=>inverse[v]=i);
  const remap=map=>map.filter(([i])=>inverse[i]>=0).map(([i,v])=>[inverse[i],v]);
  for(const maps of nodeMaps)for(let k=0;k<6;k++)maps[k]=remap(maps[k]);
  for(const e of elements)for(let k=0;k<12;k++)e.B[k]=remap(e.B[k]);
  for(const c of Object.values(cases))c.F=Float64Array.from(active,i=>c.F[i]);
  const K=Kb.finish(active),M=Mb.finish(active);
  return {model,K,M,nodeMaps,elements,cases,labels:active.map(i=>labels[i]),influence:influence.map(f=>Float64Array.from(active,i=>f[i])),totalMass,warnings,
    stats:{joints:model.nodes.length,frames:elements.length,physicalDOFs:model.nodes.length*6,activeDOFs:active.length,internalDOFs:elements.reduce((s,e)=>s+e.releases.filter(Boolean).length,0),excludedDOFs:inactive.length,totalMass}};
}
function physicalDisplacement(asm,x) {
  const u=new Float64Array(asm.model.nodes.length*6);
  asm.nodeMaps.forEach((maps,i)=>maps.forEach((map,k)=>u[i*6+k]=evalMap(map,x)));return u;
}
function addEndToGlobal(array,e,local,factor=1) {
  for(let end=0;end<2;end++)for(let group=0;group<2;group++) {
    const v=localToGlobal(e.R,Array.from(local.slice(end*6+group*3,end*6+group*3+3)));
    for(let k=0;k<3;k++)array[(end?e.j:e.i)*6+group*3+k]+=v[k]*factor;
  }
}
function resultant(nodes,forces) {
  const f=[0,0,0],m=[0,0,0];
  nodes.forEach((node,i)=>{const p=Array.from(forces.slice(i*6,i*6+3)),c=cross(position(node),p);for(let k=0;k<3;k++){f[k]+=p[k];m[k]+=forces[i*6+3+k]+c[k];}});return [...f,...m];
}
function recover(asm,c,x,residual) {
  const {model,elements}=asm,u=physicalDisplacement(asm,x),balance=Float64Array.from(c.nodal,v=>-v),applied=Float64Array.from(c.nodal),members={};let maxDisplacement=0;
  for(let i=0;i<model.nodes.length;i++)maxDisplacement=Math.max(maxDisplacement,Math.hypot(u[i*6],u[i*6+1],u[i*6+2]));
  for(const e of elements) {
    const data=c.members[e.id],localU=Float64Array.from(e.B,map=>evalMap(map,x)),end=mat12Vec(e.K,localU);axpy(end,data.f,-1);
    addEndToGlobal(balance,e,end);addEndToGlobal(applied,e,data.f);
    const stations=[];for(let k=0;k<=20;k++)stations.push(k/20);for(const p of data.points){stations.push(Math.max(0,p.position-1e-8),p.position);}stations.sort((a,b)=>a-b);
    const diagram=new Float64Array(stations.length*7),curve=new Float64Array(21*3);
    stations.forEach((t,k)=>{diagram[k*7]=t;diagram.set(sectionForces(end,data.q,data.points,t*e.L,e.L),k*7+1);});
    for(let k=0;k<=20;k++) {
      const d=localToGlobal(e.R,memberDisplacement(localU,k/20,e.L,e.section,e.material,data.q,data.points));curve.set(d,k*3);maxDisplacement=Math.max(maxDisplacement,norm(d));
    }
    members[e.id]={endForces:end,localU,q:data.q,points:data.points,diagram,curve};
  }
  const reactions=new Float64Array(balance.length),constraints=new Float64Array(balance.length);
  model.nodes.forEach((node,i)=>node.support.forEach((fixed,k)=>{if(fixed)reactions[i*6+k]=balance[i*6+k];else constraints[i*6+k]=balance[i*6+k];}));
  const appliedResultant=resultant(model.nodes,applied),reactionResultant=resultant(model.nodes,reactions),equilibrium=appliedResultant.map((v,i)=>v+reactionResultant[i]);
  return {id:c.id,u,reactions,constraintForces:constraints,members,maxDisplacement,residual,appliedResultant,reactionResultant,equilibrium};
}
function combine(asm,comb,solutions) {
  const n=asm.K.n,c={id:comb.id,F:new Float64Array(n),nodal:new Float64Array(asm.model.nodes.length*6),members:{}},x=new Float64Array(n);
  for(const e of asm.elements)c.members[e.id]={q:[0,0,0],points:[],f:new Float64Array(12)};
  for(const [id,factor]of Object.entries(comb.factors)) {
    axpy(x,solutions[id],factor);const source=asm.cases[id];axpy(c.F,source.F,factor);axpy(c.nodal,source.nodal,factor);
    for(const e of asm.elements) {
      const target=c.members[e.id],data=source.members[e.id];axpy(target.f,data.f,factor);
      for(let k=0;k<3;k++)target.q[k]+=data.q[k]*factor;
      for(const p of data.points)target.points.push({position:p.position,value:p.value.map(v=>v*factor)});
    }
  }
  const r=asm.K.mul(x);axpy(r,c.F,-1);return recover(asm,c,x,norm(r)/Math.max(norm(c.F),1));
}
export function analyze(model,options={},onProgress=()=>{}) {
  const start=performance.now(),asm=assemble(model,onProgress);onProgress({stage:'Factoring equilibrated skyline matrix',dofs:asm.K.n});
  const factor=asm.K.n?new SkylineLDLT(asm.K,asm.labels):null;
  const results={},solutions={};
  for(const c of Object.values(asm.cases)) {
    onProgress({stage:'Solving static case '+c.id});
    const solved=factor?factor.solveRefined(c.F):{x:new Float64Array(0),residual:0};solutions[c.id]=solved.x;results[c.id]=recover(asm,c,solved.x,solved.residual);
  }
  for(const comb of model.combinations)results[comb.id]=combine(asm,comb,solutions);
  const modes=[];let modalError=null;
  if(options.modal??model.settings?.modal??true) {
    try {
      if(!factor)throw new AnalysisError('No free DOFs are available for modal analysis.');
      if(!(asm.totalMass>0))throw new AnalysisError('No positive mass source is present. Define material density or joint masses.');
      onProgress({stage:'Solving generalized eigenproblem'});
      const requestedModes=options.modes??model.settings?.modes??6;
      const eig=lowestModes(asm.K,asm.M,factor,requestedModes,{onProgress});
      if(eig.length<requestedModes)asm.warnings.push(`Only ${eig.length} finite positive-mass modes are available in the resolved mass subspace (${requestedModes} requested).`);
      for(let i=0;i<eig.length;i++) {
        const e=eig[i],u=physicalDisplacement(asm,e.x);let imax=0;
        for(let j=0;j<u.length;j++)if(j%6<3&&Math.abs(u[j])>Math.abs(u[imax]))imax=j;
        if(u[imax]<0){for(let j=0;j<u.length;j++)u[j]=-u[j];for(let j=0;j<e.x.length;j++)e.x[j]=-e.x[j];}
        const members={};let maxDisplacement=0;
        for(const element of asm.elements) {
          const localU=Float64Array.from(element.B,map=>evalMap(map,e.x)),curve=new Float64Array(63);
          for(let j=0;j<=20;j++) {const v=localToGlobal(element.R,memberDisplacement(localU,j/20,element.L,element.section,element.material));curve.set(v,j*3);maxDisplacement=Math.max(maxDisplacement,norm(v));}
          members[element.id]={localU,curve};
        }
        const effectiveMass=asm.influence.map(b=>dot(e.x,b)**2),participation=effectiveMass.map(v=>v/asm.totalMass);
        modes.push({number:i+1,lambda:e.lambda,frequency:Math.sqrt(e.lambda)/(2*Math.PI),period:2*Math.PI/Math.sqrt(e.lambda),u,members,maxDisplacement,participation,effectiveMass,residual:e.residual,iterations:e.iterations});
      }
    }catch(error){modalError=error.message;asm.warnings.push('MODAL: '+error.message);}
  }
  const stats={...asm.stats,...factor?.stats,elapsedMs:performance.now()-start};
  if(stats.minPivot<1e-8)asm.warnings.push(`Very small scaled pivot ${stats.minPivot.toExponential(3)}: review support and stiffness contrasts. This is not a condition-number estimate.`);
  return {schema:'stratum-results',version:1,static:results,modes,modalError,stats,warnings:asm.warnings,completedAt:new Date().toISOString()};
}
