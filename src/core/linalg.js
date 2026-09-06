/** Float64 linear algebra. No regularization or artificial support stiffness. */
export class AnalysisError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'AnalysisError'; this.details = details; }
}
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export const norm = a => Math.sqrt(dot(a, a));
export function axpy(y, x, a) { for (let i = 0; i < y.length; i++) y[i] += a * x[i]; return y; }
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const sub = (a, b) => a.map((v, i) => v-b[i]);
export const add = (a, b) => a.map((v, i) => v+b[i]);
export const scale = (a, t) => a.map(v => v*t);
export const unit = a => { const n = norm(a); if (n < 1e-14) throw new AnalysisError('Cannot normalize a zero-length vector.'); return scale(a, 1/n); };

/** Full symmetric CSR storage: assembly deliberately preserves both triangles. */
export class SparseBuilder {
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
export class CSR {
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
export class SkylineLDLT {
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
export function jacobiEigen(input,n,tol=1e-13,maxSweeps=100) {
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
export function lowestModes(K,M,factor,count=6,{tolerance=1e-8,maxIterations=160,onProgress=()=>{}}={}) {
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
