(function(){'use strict';const __modules={"src/analysis-worker.js":(module,__require)=>{
const {analyze}=__require("src/core/analysis.js");
self.onmessage=event=>{
  const {id,model,options}=event.data;
  try {
    const result=analyze(model,options,progress=>self.postMessage({type:'progress',id,progress}));
    const buffers=new Set();
    function collect(v){if(ArrayBuffer.isView(v))buffers.add(v.buffer);else if(v&&typeof v==='object')for(const value of Object.values(v))collect(value);}
    collect(result);self.postMessage({type:'result',id,result},[...buffers]);
  }catch(error){self.postMessage({type:'error',id,error:{message:error.message,details:error.details,stack:error.stack}});}
};

module.exports={};
},
"src/core/analysis.js":(module,__require)=>{
const {AnalysisError,SparseBuilder,SkylineLDLT,lowestModes,dot,norm,axpy,cross}=__require("src/core/linalg.js");
const {DOFS,LOCAL_DOFS,localAxes,frameMatrices,uniformLoad,pointLoad,mat12Vec,globalToLocal,localToGlobal,sectionForces,memberDisplacement}=__require("src/core/elements.js");
const {validateModel,position,GRAVITY}=__require("src/core/model.js");

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
function assemble(model,onProgress=()=>{}) {
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
function analyze(model,options={},onProgress=()=>{}) {
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

module.exports={assemble,analyze};
},
"src/core/linalg.js":(module,__require)=>{
/** Float64 linear algebra. No regularization or artificial support stiffness. */
class AnalysisError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'AnalysisError'; this.details = details; }
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = a => Math.sqrt(dot(a, a));
function axpy(y, x, a) { for (let i = 0; i < y.length; i++) y[i] += a * x[i]; return y; }
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const sub = (a, b) => a.map((v, i) => v-b[i]);
const add = (a, b) => a.map((v, i) => v+b[i]);
const scale = (a, t) => a.map(v => v*t);
const unit = a => { const n = norm(a); if (n < 1e-14) throw new AnalysisError('Cannot normalize a zero-length vector.'); return scale(a, 1/n); };

/** Full symmetric CSR storage: assembly deliberately preserves both triangles. */
class SparseBuilder {
  constructor(n) { this.n = n; this.rows = Array.from({length:n}, () => new Map()); }
  add(i, j, v) { if (v) this.rows[i].set(j, (this.rows[i].get(j) || 0) + v); }
  diagonal(i) { return this.rows[i].get(i) || 0; }
  finish(active = null) {
    const order = active || Array.from({length:this.n}, (_,i) => i);
    const inverse = new Int32Array(this.n).fill(-1); order.forEach((v,i) => inverse[v] = i);
    const ptr = new Int32Array(order.length+1), cols=[], vals=[];
    for (let i=0;i<order.length;i++) {
      for (const [j,v] of [...this.rows[order[i]]].sort((a,b) => a[0]-b[0])) {
        if (inverse[j] >= 0 && v !== 0) { cols.push(inverse[j]); vals.push(v); }
      }
      ptr[i+1] = cols.length;
    }
    return new CSR(order.length, ptr, Int32Array.from(cols), Float64Array.from(vals));
  }
}
class CSR {
  constructor(n, ptr, col, val) { Object.assign(this,{n,ptr,col,val}); }
  mul(x, out = new Float64Array(this.n)) {
    for (let i=0;i<this.n;i++) { let s=0; for (let p=this.ptr[i];p<this.ptr[i+1];p++) s+=this.val[p]*x[this.col[p]]; out[i]=s; }
    return out;
  }
  diag() { const d=new Float64Array(this.n); for(let i=0;i<this.n;i++) for(let p=this.ptr[i];p<this.ptr[i+1];p++) if(this.col[p]===i) d[i]=this.val[p]; return d; }
  get(i,j) { for(let p=this.ptr[i];p<this.ptr[i+1];p++) if(this.col[p]===j) return this.val[p]; return 0; }
}
function reverseCuthillMcKee(A) {
  const n=A.n, degree=Array.from({length:n},(_,i)=>A.ptr[i+1]-A.ptr[i]-1);
  const seen=new Uint8Array(n), order=[];
  while(order.length<n) {
    let start=-1;
    for(let i=0;i<n;i++) if(!seen[i] && (start<0 || degree[i]<degree[start])) start=i;
    const queue=[start]; seen[start]=1;
    for(let h=0;h<queue.length;h++) {
      const i=queue[h]; order.push(i); const next=[];
      for(let p=A.ptr[i];p<A.ptr[i+1];p++) { const j=A.col[p]; if(j!==i && !seen[j]) {seen[j]=1;next.push(j);} }
      next.sort((a,b)=>degree[a]-degree[b]||a-b); queue.push(...next);
    }
  }
  return Int32Array.from(order.reverse());
}
/** RCM-reordered, diagonally equilibrated skyline LDLᵀ. Positive pivots certify SPD
 * to the declared relative tolerance; a bad pivot stops analysis, never patches it. */
class SkylineLDLT {
  constructor(A, labels=[], pivotTolerance=1e-12) {
    this.A=A; const n=A.n; this.n=n;
    this.perm=reverseCuthillMcKee(A); this.inv=new Int32Array(n);
    this.perm.forEach((old,i)=>this.inv[old]=i);
    const diag=A.diag(); this.scaling=new Float64Array(n);
    for(let i=0;i<n;i++) {
      if(!(diag[i]>0) || !Number.isFinite(diag[i])) throw new AnalysisError(`Zero or invalid stiffness at ${labels[i] || 'DOF '+i}.`,{dof:labels[i],diagonal:diag[i]});
      this.scaling[i]=1/Math.sqrt(diag[i]);
    }
    this.first=Int32Array.from({length:n},(_,i)=>i);
    for(let old=0;old<n;old++) for(let p=A.ptr[old];p<A.ptr[old+1];p++) {
      const i=this.inv[old],j=this.inv[A.col[p]];
      if(j<i && A.val[p]!==0) this.first[i]=Math.min(this.first[i],j);
    }
    this.offset=new Int32Array(n+1);
    for(let i=0;i<n;i++) this.offset[i+1]=this.offset[i]+i-this.first[i]+1;
    if(this.offset[n]>24_000_000) throw new AnalysisError('Skyline profile exceeds the 24 million coefficient safety limit. Reduce model size or bandwidth.');
    this.L=new Float64Array(this.offset[n]); this.D=new Float64Array(n);
    for(let old=0;old<n;old++) for(let p=A.ptr[old];p<A.ptr[old+1];p++) {
      const i=this.inv[old],j=this.inv[A.col[p]];
      if(j<=i) this.L[this.offset[i]+j-this.first[i]]=A.val[p]*this.scaling[old]*this.scaling[A.col[p]];
    }
    let minPivot=Infinity;
    for(let i=0;i<n;i++) {
      const fi=this.first[i], oi=this.offset[i]-fi;
      for(let j=fi;j<i;j++) {
        let v=this.L[oi+j]; const oj=this.offset[j]-this.first[j];
        for(let k=Math.max(fi,this.first[j]);k<j;k++) v-=this.L[oi+k]*this.D[k]*this.L[oj+k];
        this.L[oi+j]=v/this.D[j];
      }
      let d=this.L[oi+i];
      for(let j=fi;j<i;j++) d-=this.L[oi+j]**2*this.D[j];
      if(!Number.isFinite(d) || d<=pivotTolerance) {
        const label=labels[this.perm[i]] || 'DOF '+this.perm[i];
        throw new AnalysisError(`Instability or excessive ill-conditioning near ${label}. Scaled pivot ${d.toExponential(3)}. Check supports, disconnected joints, releases and diaphragms.`,{dof:label,pivot:d,tolerance:pivotTolerance});
      }
      this.D[i]=d; minPivot=Math.min(minPivot,d); this.L[oi+i]=1;
    }
    this.stats={minPivot,profile:this.L.length,nonzeros:A.val.length,bandwidth:Math.max(0,...Array.from(this.first,(v,i)=>i-v))};
  }
  solve(b) {
    const n=this.n, y=new Float64Array(n);
    for(let i=0;i<n;i++) {
      let s=b[this.perm[i]]*this.scaling[this.perm[i]],o=this.offset[i]-this.first[i];
      for(let j=this.first[i];j<i;j++) s-=this.L[o+j]*y[j]; y[i]=s;
    }
    for(let i=0;i<n;i++) y[i]/=this.D[i];
    for(let i=n-1;i>=0;i--) { const o=this.offset[i]-this.first[i]; for(let j=this.first[i];j<i;j++) y[j]-=this.L[o+j]*y[i]; }
    const x=new Float64Array(n); for(let i=0;i<n;i++) x[this.perm[i]]=y[i]*this.scaling[this.perm[i]];
    return x;
  }
  solveRefined(b) {
    const x=this.solve(b); let residual=0;
    for(let k=0;k<3;k++) {
      const r=this.A.mul(x); for(let i=0;i<r.length;i++) r[i]=b[i]-r[i];
      residual=norm(r)/Math.max(norm(b),1);
      if(residual<1e-10) break;
      axpy(x,this.solve(r),1);
    }
    const r=this.A.mul(x); for(let i=0;i<r.length;i++) r[i]-=b[i];
    residual=norm(r)/Math.max(norm(b),1);
    if(!Number.isFinite(residual)||residual>1e-7||x.some(v=>!Number.isFinite(v))) throw new AnalysisError(`Static equilibrium residual ${residual.toExponential(3)} exceeds 1e-7.`,{residual});
    return {x,residual};
  }
}

/** Jacobi rotations for a small, symmetric Rayleigh–Ritz matrix (not global K). */
function jacobiEigen(input,n,tol=1e-13,maxSweeps=100) {
  const a=Float64Array.from(input),v=new Float64Array(n*n); for(let i=0;i<n;i++)v[i*n+i]=1;
  for(let sweep=0;sweep<maxSweeps;sweep++) {
    let off=0,diagonal=0;
    for(let i=0;i<n;i++) {diagonal=Math.max(diagonal,Math.abs(a[i*n+i])); for(let j=i+1;j<n;j++)off=Math.max(off,Math.abs(a[i*n+j]));}
    if(off<=tol*Math.max(diagonal,1e-30)) break;
    for(let p=0;p<n-1;p++) for(let q=p+1;q<n;q++) {
      const apq=a[p*n+q]; if(Math.abs(apq)<=tol*Math.max(diagonal,1e-30))continue;
      const tau=(a[q*n+q]-a[p*n+p])/(2*apq),t=(tau>=0?1:-1)/(Math.abs(tau)+Math.sqrt(1+tau*tau)),c=1/Math.sqrt(1+t*t),s=t*c;
      a[p*n+p]-=t*apq; a[q*n+q]+=t*apq; a[p*n+q]=a[q*n+p]=0;
      for(let k=0;k<n;k++) if(k!==p&&k!==q) {const x=a[k*n+p],y=a[k*n+q];a[k*n+p]=a[p*n+k]=c*x-s*y;a[k*n+q]=a[q*n+k]=s*x+c*y;}
      for(let k=0;k<n;k++) {const x=v[k*n+p],y=v[k*n+q];v[k*n+p]=c*x-s*y;v[k*n+q]=s*x+c*y;}
    }
  }
  const ids=Array.from({length:n},(_,i)=>i).sort((i,j)=>a[i*n+i]-a[j*n+j]);
  return {values:ids.map(i=>a[i*n+i]),vectors:ids.map(i=>Float64Array.from({length:n},(_,j)=>v[j*n+i]))};
}
function mOrthonormalize(X,M) {
  const Q=[],MQ=[];
  for(const x0 of X) {
    const x=Float64Array.from(x0),initialNorm=Math.sqrt(Math.max(0,dot(x,M.mul(x))));
    if(!(initialNorm>0))continue;
    for(let repeat=0;repeat<2;repeat++) for(let i=0;i<Q.length;i++) axpy(x,Q[i],-dot(x,MQ[i]));
    const mx=M.mul(x),len=Math.sqrt(dot(x,mx));
    if(!Number.isFinite(len))throw new AnalysisError('Invalid modal mass norm. Check material density and joint mass.');
    if(!(len>1e-12*initialNorm))continue;
    for(let j=0;j<x.length;j++){x[j]/=len;mx[j]/=len;}
    Q.push(x);MQ.push(mx);
  }
  return Q;
}
/** Deterministic inverse subspace iteration, M-orthogonalization and Ritz extraction.
 * Every accepted eigenpair carries a normwise residual, not just frequency change. */
function lowestModes(K,M,factor,count=6,{tolerance=1e-8,maxIterations=160,onProgress=()=>{}}={}) {
  const n=K.n;let requested=Math.min(n,count),p=Math.min(n,Math.max(requested+5,requested*2));
  let seed=314159265;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296-0.5;};
  const kd=K.diag();
  let Q=mOrthonormalize(Array.from({length:p},()=>Float64Array.from(kd,d=>random()/Math.sqrt(d))),M),modes=[];
  if(!Q.length)throw new AnalysisError('No finite, positive-mass modal subspace is available.');
  p=Q.length;requested=Math.min(requested,p);
  for(let iteration=1;iteration<=maxIterations;iteration++) {
    Q=mOrthonormalize(Q.map(x=>factor.solve(M.mul(x))),M);
    if(Q.length<requested)throw new AnalysisError('The requested modal subspace lost numerical rank. Reduce the mode count or improve the mass/stiffness scaling.');
    p=Q.length;
    const KQ=Q.map(x=>K.mul(x)),small=new Float64Array(p*p);
    for(let i=0;i<p;i++) for(let j=0;j<=i;j++) small[i*p+j]=small[j*p+i]=(dot(Q[i],KQ[j])+dot(Q[j],KQ[i]))/2;
    const eig=jacobiEigen(small,p);
    Q=eig.vectors.map(coeff=>{const x=new Float64Array(n);for(let i=0;i<p;i++)axpy(x,Q[i],coeff[i]);return x;});
    modes=[];
    for(let i=0;i<requested;i++) {
      const x=Q[i],kx=K.mul(x),mx=M.mul(x),lambda=dot(x,kx)/dot(x,mx),r=Float64Array.from(kx,(v,j)=>v-lambda*mx[j]);
      const residual=norm(r)/Math.max(norm(kx)+Math.abs(lambda)*norm(mx),1e-30);
      if(!(lambda>0)) throw new AnalysisError('A non-positive modal eigenvalue was found.');
      modes.push({lambda,x,residual,iterations:iteration});
    }
    if(iteration%8===0)onProgress({stage:'Modal iterations',iteration,residual:Math.max(...modes.map(m=>m.residual))});
    if(modes.every(m=>m.residual<tolerance)) return modes;
  }
  throw new AnalysisError(`Modal solution did not meet the ${tolerance} residual tolerance in ${maxIterations} iterations.`,{residuals:modes.map(m=>m.residual)});
}

module.exports={AnalysisError,dot,norm,axpy,cross,sub,add,scale,unit,SparseBuilder,CSR,SkylineLDLT,jacobiEigen,lowestModes};
},
"src/core/elements.js":(module,__require)=>{
const { AnalysisError, norm, unit, cross, sub, dot }=__require("src/core/linalg.js");
const DOFS=['UX','UY','UZ','RX','RY','RZ'];
const LOCAL_DOFS=['u1','u2','u3','r1','r2','r3'];
function localAxes(a,b,roll=0) {
  const dx=sub(b,a),L=norm(dx); if(L<1e-8)throw new AnalysisError('Frame element length is below 1e-8 m.');
  const x=unit(dx),reference=Math.abs(x[2])<0.95?[0,0,1]:[0,1,0];
  const y0=unit(cross(reference,x)),z0=cross(x,y0),c=Math.cos(roll),s=Math.sin(roll);
  const y=y0.map((v,i)=>v*c+z0[i]*s),z=z0.map((v,i)=>v*c-y0[i]*s);
  return {L,R:[x,y,z]};
}
function block(matrix,indices,values,factor=1,signs=null) {
  const n=indices.length;
  for(let i=0;i<n;i++)for(let j=0;j<n;j++) matrix[indices[i]*12+indices[j]]+=values[i*n+j]*factor*(signs?signs[i]*signs[j]:1);
}
/** 2-node, prismatic, 12-DOF spatial Euler–Bernoulli frame. Local x=i→j.
 * Local y is Z×x (Y×x for near-vertical elements); local z=x×y.
 * G=E/[2(1+nu)]. J is the Saint-Venant torsion constant, not Iy+Iz. */
function frameMatrices(L,section,material) {
  const {A,Iy,Iz,J}=section,{E,nu,density}=material,G=E/(2*(1+nu)),m=density*A*L;
  const K=new Float64Array(144),M=new Float64Array(144);
  block(K,[0,6],[1,-1,-1,1],E*A/L);
  block(K,[3,9],[1,-1,-1,1],G*J/L);
  const kb=[12,6*L,-12,6*L,6*L,4*L*L,-6*L,2*L*L,-12,-6*L,12,-6*L,6*L,2*L*L,-6*L,4*L*L];
  block(K,[1,5,7,11],kb,E*Iz/L**3);
  block(K,[2,4,8,10],kb,E*Iy/L**3,[1,-1,1,-1]);
  block(M,[0,6],[2,1,1,2],m/6);
  block(M,[3,9],[2,1,1,2],density*(Iy+Iz)*L/6);
  const mb=[156,22*L,54,-13*L,22*L,4*L*L,13*L,-3*L*L,54,13*L,156,-22*L,-13*L,-3*L*L,-22*L,4*L*L];
  block(M,[1,5,7,11],mb,m/420);
  block(M,[2,4,8,10],mb,m/420,[1,-1,1,-1]);
  return {K,M};
}
function hermite(t,L) { return [1-3*t*t+2*t**3,L*(t-2*t*t+t**3),3*t*t-2*t**3,L*(-t*t+t**3)]; }
function uniformLoad(q,L) {
  const f=new Float64Array(12);
  for(let d=0;d<3;d++)f[d]=f[d+6]=q[d]*L/2;
  f[5]=q[1]*L*L/12;f[11]=-f[5];f[4]=-q[2]*L*L/12;f[10]=-f[4];return f;
}
function pointLoad(p,t,L) {
  const f=new Float64Array(12),h=hermite(t,L);
  f[0]=p[0]*(1-t);f[6]=p[0]*t;
  [1,5,7,11].forEach((v,i)=>f[v]=p[1]*h[i]);
  [2,4,8,10].forEach((v,i)=>f[v]=p[2]*h[i]*[1,-1,1,-1][i]);
  return f;
}
function mat12Vec(a,x) { const y=new Float64Array(12);for(let i=0;i<12;i++)for(let j=0;j<12;j++)y[i]+=a[i*12+j]*x[j];return y; }
function localToGlobal(R,v) {return [0,1,2].map(i=>R[0][i]*v[0]+R[1][i]*v[1]+R[2][i]*v[2]);}
function globalToLocal(R,v) {return R.map(r=>dot(r,v));}

/** Internal resultants acting on the positive-x cut face of the LEFT segment.
 * N,V2,V3,T,M2,M3 = -f_i minus distributed/point loads to the cut.
 * In particular M3=-f_i5+x*f_i1+∫(x-s)q2(s)ds.
 * End checks: section(0+)=-f_i, section(L-)=+f_j (interior point loads excluded at end).
 */
function sectionForces(end,q,points,x,L) {
  const result=[-end[0]-q[0]*x,-end[1]-q[1]*x,-end[2]-q[2]*x,-end[3],-end[4]-end[2]*x-q[2]*x*x/2,-end[5]+end[1]*x+q[1]*x*x/2];
  for(const p of points) if(x>=p.position*L-1e-12) {
    const a=x-p.position*L; result[0]-=p.value[0];result[1]-=p.value[1];result[2]-=p.value[2];result[4]-=p.value[2]*a;result[5]+=p.value[1]*a;
  }
  return result;
}
/** Cubic FE kinematics + exact fixed-end particular solutions for full-span UDL
 * and interior concentrated forces. Thus fixed/fixed one-element beams display
 * nonzero within-element deflections even when every nodal DOF is constrained. */
function memberDisplacement(localU,t,L,section,material,q=[0,0,0],points=[]) {
  const h=hermite(t,L),x=t*L;
  let u=localU[0]*(1-t)+localU[6]*t;
  let v=h[0]*localU[1]+h[1]*localU[5]+h[2]*localU[7]+h[3]*localU[11];
  let w=h[0]*localU[2]-h[1]*localU[4]+h[2]*localU[8]-h[3]*localU[10];
  u+=q[0]*x*(L-x)/(2*material.E*section.A);
  v+=q[1]*x*x*(L-x)**2/(24*material.E*section.Iz);
  w+=q[2]*x*x*(L-x)**2/(24*material.E*section.Iy);
  for(const p of points) {
    const a=p.position*L,b=L-a;
    u+=p.value[0]*(x<=a?x*b/L:a*(L-x)/L)/(material.E*section.A);
    const fixedShape=x<=a ? b*b*x*x*(3*a*L-(L+2*a)*x)/(6*L**3) : a*a*(L-x)**2*(3*b*L-(L+2*b)*(L-x))/(6*L**3);
    v+=p.value[1]*fixedShape/(material.E*section.Iz);w+=p.value[2]*fixedShape/(material.E*section.Iy);
  }
  return [u,v,w];
}

module.exports={DOFS,LOCAL_DOFS,localAxes,frameMatrices,hermite,uniformLoad,pointLoad,mat12Vec,localToGlobal,globalToLocal,sectionForces,memberDisplacement};
},
"src/core/model.js":(module,__require)=>{
const { AnalysisError, norm, sub }=__require("src/core/linalg.js");
const GRAVITY=9.80665;
function rectangularSection(id,name,b,h,material) {
  const a=Math.max(b,h),c=Math.min(b,h);
  return {id,name,material,b,h,A:b*h,Iy:b*h**3/12,Iz:h*b**3/12,J:a*c**3*(1/3-0.21*(c/a)*(1-c**4/(12*a**4))),shape:'rectangle'};
}
function emptyModel() {
  return {schema:'stratum-frame',version:1,units:'SI',name:'Untitled structure',
    grids:{x:[0,6,12,18],y:[0,6,12]},stories:[{id:'S0',name:'Base',z:0}],
    materials:[{id:'C30',name:'Concrete C30 · elastic',E:30e9,nu:0.2,density:2500},{id:'S355',name:'Steel S355 · elastic',E:200e9,nu:0.3,density:7850}],
    sections:[rectangularSection('C500','C500 × 500',0.5,0.5,'C30'),rectangularSection('B300','B300 × 600',0.3,0.6,'C30'),rectangularSection('B400','B400 × 700',0.4,0.7,'C30')],
    nodes:[],elements:[],diaphragms:[],
    cases:[{id:'DEAD',name:'Dead',selfWeight:1},{id:'LIVE',name:'Live',selfWeight:0},{id:'WINDX',name:'Wind X',selfWeight:0}],
    combinations:[{id:'SERVICE',name:'Service · D + L',factors:{DEAD:1,LIVE:1}},{id:'ULS',name:'Illustrative · 1.2D + 1.6L',factors:{DEAD:1.2,LIVE:1.6}},{id:'LATERAL',name:'Illustrative · D + 0.5L + W',factors:{DEAD:1,LIVE:0.5,WINDX:1}}],
    loads:[],settings:{modes:6,modal:true},notes:'Independent research workbench. Example combinations are illustrative, not code-approved.'};
}
function createBuilding({name='Atrium Office · 6-story frame',stories=6,baysX=3,baysY=2,bayX=6,bayY=6,height=3.4,diaphragms=true}={}) {
  if(!Number.isInteger(stories)||stories<1||stories>16||!Number.isInteger(baysX)||baysX<1||baysX>8||!Number.isInteger(baysY)||baysY<1||baysY>8||Math.min(bayX,bayY,height)<=0)throw new Error('Template dimensions are outside the supported limits (1–16 stories, 1–8 bays).');
  const m=emptyModel();m.name=name;m.grids={x:Array.from({length:baysX+1},(_,i)=>i*bayX),y:Array.from({length:baysY+1},(_,i)=>i*bayY)};
  m.stories=Array.from({length:stories+1},(_,i)=>({id:'S'+i,name:i?'Story '+String(i).padStart(2,'0'):'Base',z:i*height}));
  const ids=new Map();let ni=0,ei=0,li=0;
  const node=(s,x,y)=>ids.get(`${s}/${x}/${y}`);
  for(let s=0;s<=stories;s++)for(let y=0;y<=baysY;y++)for(let x=0;x<=baysX;x++) {
    const id='J'+(++ni);ids.set(`${s}/${x}/${y}`,id);
    m.nodes.push({id,x:x*bayX,y:y*bayY,z:s*height,support:Array(6).fill(s===0),mass:s?1800:0});
  }
  const beam=(a,b,sec)=>{const id='F'+(++ei);m.elements.push({id,i:a,j:b,section:sec,roll:0,releases:Array(12).fill(false)});return id;};
  for(let s=1;s<=stories;s++) {
    const members=[];
    for(let y=0;y<=baysY;y++)for(let x=0;x<=baysX;x++) {
      beam(node(s-1,x,y),node(s,x,y),'C500');
      if(x<baysX)members.push(beam(node(s,x,y),node(s,x+1,y),'B300'));
      if(y<baysY)members.push(beam(node(s,x,y),node(s,x,y+1),'B300'));
      m.loads.push({id:'L'+(++li),case:'WINDX',type:'nodal',node:node(s,x,y),value:[2400*(s/stories),0,0,0,0,0]});
    }
    for(const id of members) for(const [loadCase,value]of [['DEAD',-8000],['LIVE',-5000]])m.loads.push({id:'L'+(++li),case:loadCase,type:'udl',element:id,system:'global',value:[0,0,value]});
    if(diaphragms)m.diaphragms.push({id:'D'+s,name:'D'+s+' · rigid',nodes:m.nodes.filter(n=>Math.abs(n.z-s*height)<1e-8).map(n=>n.id)});
  }
  validateModel(m);return m;
}
const position=n=>[n.x,n.y,n.z];
function uniqueId(model,key,prefix) {const ids=new Set(model[key].map(x=>x.id));let i=1;while(ids.has(prefix+i))i++;return prefix+i;}
const finite=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v))throw new AnalysisError(`${label} must be a finite number.`);};
function unique(items,label){const set=new Set();for(const item of items){if(!item||typeof item.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item.id)||['__proto__','constructor','prototype'].includes(item.id)||set.has(item.id))throw new AnalysisError(`${label} IDs must be unique identifiers (letters, digits, underscore, dot, hyphen; no reserved names).`);if(item.name!==undefined&&typeof item.name!=='string')throw new AnalysisError(`${label} names must be strings.`);set.add(item.id);}return set;}
function validateModel(m) {
  if(!m||m.schema!=='stratum-frame'||m.version!==1||m.units!=='SI')throw new AnalysisError('Unsupported project schema/version or non-SI storage units. Expected stratum-frame v1 with SI values.');
  for(const key of ['nodes','elements','materials','sections','stories','cases','combinations','loads','diaphragms'])if(!Array.isArray(m[key]))throw new AnalysisError(`Missing ${key} collection.`);
  for(const key of ['materials','sections','stories','cases'])if(!m[key].length)throw new AnalysisError(`At least one ${key} definition is required.`);
  if(!m.settings||typeof m.settings.modal!=='boolean')throw new AnalysisError('Analysis settings must include a boolean modal flag.');
  if(m.nodes.length>2000||m.elements.length>6000)throw new AnalysisError('This build accepts up to 2,000 joints and 6,000 frame elements; skyline storage has a separate memory limit.');
  const ns=unique(m.nodes,'Joint'),es=unique(m.elements,'Frame'),ms=unique(m.materials,'Material'),ss=unique(m.sections,'Section'),cs=unique(m.cases,'Load case');
  const combs=unique(m.combinations,'Combination');unique(m.loads,'Load');unique(m.stories,'Story');unique(m.diaphragms,'Diaphragm');
  for(const id of combs)if(cs.has(id))throw new AnalysisError('Load case and combination IDs must be distinct.');
  for(const mat of m.materials) {finite(mat.E,'E');finite(mat.nu,'Poisson ratio');finite(mat.density,'Density');if(mat.E<=0||mat.nu<=-1||mat.nu>=0.5||mat.density<0)throw new AnalysisError(`Invalid elastic material ${mat.id}. E > 0, −1 < nu < 0.5, density ≥ 0 required.`);}
  for(const sec of m.sections){if(!ms.has(sec.material))throw new AnalysisError(`Section ${sec.id} references an unknown material.`);for(const k of ['A','Iy','Iz','J']){finite(sec[k],`${sec.id}.${k}`);if(sec[k]<=0)throw new AnalysisError(`Section ${sec.id}: ${k} must be positive.`);}if(sec.b!==undefined&&(!Number.isFinite(sec.b)||!Number.isFinite(sec.h)||!(sec.b>0)||!(sec.h>0)))throw new AnalysisError('Display section dimensions must be positive.');}
  const coords=new Map();const warnings=[];
  for(const n of m.nodes){for(const k of ['x','y','z'])finite(n[k],`${n.id}.${k}`);if(!Array.isArray(n.support)||n.support.length!==6||n.support.some(v=>typeof v!=='boolean'))throw new AnalysisError(`Joint ${n.id} needs six boolean support flags.`);finite(n.mass??0,`${n.id}.mass`);if(n.mass<0)throw new AnalysisError('Joint mass cannot be negative.');
    if(n.massInertia!==undefined){if(!Array.isArray(n.massInertia)||n.massInertia.length!==3)throw new AnalysisError('Joint rotational inertia must have three values.');for(const v of n.massInertia){finite(v,'Rotational inertia');if(v<0)throw new AnalysisError('Rotational inertia cannot be negative.');}}
    const k=[n.x,n.y,n.z].map(x=>x.toFixed(8)).join('/');if(coords.has(k))warnings.push(`Coincident joints ${coords.get(k)} and ${n.id} are not automatically merged.`);coords.set(k,n.id);
  }
  const nm=new Map(m.nodes.map(n=>[n.id,n])),connections=new Map();
  for(const e of m.elements){if(!ns.has(e.i)||!ns.has(e.j)||!ss.has(e.section))throw new AnalysisError(`Frame ${e.id} has a missing joint or section.`);if(norm(sub(position(nm.get(e.i)),position(nm.get(e.j))))<1e-8)throw new AnalysisError(`Frame ${e.id} has zero length.`);finite(e.roll??0,`${e.id}.roll`);if(e.releases&&(!Array.isArray(e.releases)||e.releases.length!==12||e.releases.some(v=>typeof v!=='boolean')))throw new AnalysisError(`Frame ${e.id} requires 12 boolean release flags.`);const key=[e.i,e.j].sort().join('/');if(connections.has(key))warnings.push(`Overlapping frames ${connections.get(key)} and ${e.id} both contribute stiffness and mass.`);connections.set(key,e.id);}
  for(const c of m.cases)finite(c.selfWeight??0,`${c.id}.selfWeight`);
  for(const c of m.combinations){if(!c.factors||Array.isArray(c.factors)||typeof c.factors!=='object')throw new AnalysisError('A combination needs a case-to-factor object.');for(const [id,f]of Object.entries(c.factors)){if(!cs.has(id))throw new AnalysisError(`Combination ${c.id} references unknown case ${id}. Nested combinations are not supported.`);finite(f,`${c.id}.${id}`);}}
  for(const l of m.loads){if(!cs.has(l.case))throw new AnalysisError(`Load ${l.id} has an unknown case.`);if(!['nodal','udl','point'].includes(l.type))throw new AnalysisError(`Unsupported load type ${l.type}.`);if(!Array.isArray(l.value)||l.value.length!==(l.type==='nodal'?6:3))throw new AnalysisError(`Load ${l.id} has an invalid vector.`);for(const v of l.value)finite(v,`Load ${l.id}`);if(l.type==='nodal'){if(l.system!==undefined&&l.system!=='global')throw new AnalysisError('Joint loads must be expressed in global axes.');if(!ns.has(l.node))throw new AnalysisError(`Load ${l.id} references an unknown joint.`);}else{if(!es.has(l.element))throw new AnalysisError(`Load ${l.id} references an unknown frame.`);if(!['global','local'].includes(l.system))throw new AnalysisError(`Load ${l.id} must specify global or local axes.`);if(l.type==='point'){finite(l.position,'Point-load position');if(l.position<=0||l.position>=1)throw new AnalysisError('Member point loads must lie strictly inside 0 < a/L < 1. Use joint loads at endpoints.');}}}
  const claimed=new Set();
  for(const d of m.diaphragms){if(!Array.isArray(d.nodes)||d.nodes.length<2||new Set(d.nodes).size!==d.nodes.length)throw new AnalysisError(`Diaphragm ${d.id} needs at least two distinct joints.`);let z=null;let spread=0;let first=null;for(const id of d.nodes){const n=nm.get(id);if(!n||claimed.has(id))throw new AnalysisError(`Diaphragm ${d.id} has a missing or multiply-assigned joint.`);if(n.support[0]||n.support[1]||n.support[5])throw new AnalysisError(`Diaphragm ${d.id}: horizontal or RZ restraints on diaphragm joints are not supported. Remove that assignment or support.`);if(z!==null&&Math.abs(z-n.z)>1e-6)throw new AnalysisError(`Diaphragm ${d.id} must be horizontal and coplanar within 1e-6 m.`);z=n.z;claimed.add(id);if(!first)first=n;spread=Math.max(spread,Math.hypot(n.x-first.x,n.y-first.y));}if(spread<1e-8)throw new AnalysisError(`Diaphragm ${d.id} has no in-plane extent.`);}
  const elevations=new Set();for(const s of m.stories){finite(s.z,`${s.id}.elevation`);if(elevations.has(s.z))throw new AnalysisError('Story elevations must be distinct.');elevations.add(s.z);}
  if(!m.grids||!Array.isArray(m.grids.x)||!Array.isArray(m.grids.y))throw new AnalysisError('Grid coordinates are required.');for(const dir of ['x','y']){let last=-Infinity;for(const x of m.grids[dir]){finite(x,'Grid coordinate');if(x<=last)throw new AnalysisError('Grid coordinates must be strictly increasing.');last=x;}}
  if(m.settings?.modes!==undefined&&(!Number.isInteger(m.settings.modes)||m.settings.modes<1||m.settings.modes>24))throw new AnalysisError('Request between 1 and 24 modes.');
  return warnings;
}
function parseProject(text){if(text.length>25_000_000)throw new Error('Project file exceeds 25 MB.');const m=JSON.parse(text);validateModel(m);return m;}

module.exports={GRAVITY,rectangularSection,emptyModel,createBuilding,position,uniqueId,validateModel,parseProject};
}};const __cache={};function __require(id){if(__cache[id])return __cache[id].exports;const module={exports:{}};__cache[id]=module;if(!__modules[id])throw new Error('Missing module '+id);__modules[id](module,__require);return module.exports;}__require("src/analysis-worker.js");})();