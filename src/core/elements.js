import { AnalysisError, norm, unit, cross, sub, dot } from './linalg.js';
export const DOFS=['UX','UY','UZ','RX','RY','RZ'];
export const LOCAL_DOFS=['u1','u2','u3','r1','r2','r3'];
export function localAxes(a,b,roll=0) {
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
export function frameMatrices(L,section,material) {
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
export function hermite(t,L) { return [1-3*t*t+2*t**3,L*(t-2*t*t+t**3),3*t*t-2*t**3,L*(-t*t+t**3)]; }
export function uniformLoad(q,L) {
  const f=new Float64Array(12);
  for(let d=0;d<3;d++)f[d]=f[d+6]=q[d]*L/2;
  f[5]=q[1]*L*L/12;f[11]=-f[5];f[4]=-q[2]*L*L/12;f[10]=-f[4];return f;
}
export function pointLoad(p,t,L) {
  const f=new Float64Array(12),h=hermite(t,L);
  f[0]=p[0]*(1-t);f[6]=p[0]*t;
  [1,5,7,11].forEach((v,i)=>f[v]=p[1]*h[i]);
  [2,4,8,10].forEach((v,i)=>f[v]=p[2]*h[i]*[1,-1,1,-1][i]);
  return f;
}
export function mat12Vec(a,x) { const y=new Float64Array(12);for(let i=0;i<12;i++)for(let j=0;j<12;j++)y[i]+=a[i*12+j]*x[j];return y; }
export function localToGlobal(R,v) {return [0,1,2].map(i=>R[0][i]*v[0]+R[1][i]*v[1]+R[2][i]*v[2]);}
export function globalToLocal(R,v) {return R.map(r=>dot(r,v));}

/** Internal resultants acting on the positive-x cut face of the LEFT segment.
 * N,V2,V3,T,M2,M3 = -f_i minus distributed/point loads to the cut.
 * In particular M3=-f_i5+x*f_i1+∫(x-s)q2(s)ds.
 * End checks: section(0+)=-f_i, section(L-)=+f_j (interior point loads excluded at end).
 */
export function sectionForces(end,q,points,x,L) {
  const result=[-end[0]-q[0]*x,-end[1]-q[1]*x,-end[2]-q[2]*x,-end[3],-end[4]-end[2]*x-q[2]*x*x/2,-end[5]+end[1]*x+q[1]*x*x/2];
  for(const p of points) if(x>=p.position*L-1e-12) {
    const a=x-p.position*L; result[0]-=p.value[0];result[1]-=p.value[1];result[2]-=p.value[2];result[4]-=p.value[2]*a;result[5]+=p.value[1]*a;
  }
  return result;
}
/** Cubic FE kinematics + exact fixed-end particular solutions for full-span UDL
 * and interior concentrated forces. Thus fixed/fixed one-element beams display
 * nonzero within-element deflections even when every nodal DOF is constrained. */
export function memberDisplacement(localU,t,L,section,material,q=[0,0,0],points=[]) {
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
