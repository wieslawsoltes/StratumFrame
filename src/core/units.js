/** All persisted and solved values are SI. Parsing is dimension-checked; no eval. */
const units={
  m:['length',1],mm:['length',1e-3],cm:['length',1e-2],ft:['length',0.3048],in:['length',0.0254],
  m2:['area',1],mm2:['area',1e-6],cm2:['area',1e-4],in2:['area',0.0254**2],ft2:['area',0.3048**2],
  m4:['inertia',1],mm4:['inertia',1e-12],cm4:['inertia',1e-8],in4:['inertia',0.0254**4],
  N:['force',1],kN:['force',1e3],MN:['force',1e6],lbf:['force',4.4482216152605],kip:['force',4448.2216152605],
  Nm:['moment',1],kNm:['moment',1e3],Nmm:['moment',1e-3],'kip-ft':['moment',1355.8179483314],
  'N/m':['lineLoad',1],'kN/m':['lineLoad',1e3],'N/mm':['lineLoad',1e3],'kip/ft':['lineLoad',14593.9029372064],
  Pa:['stress',1],kPa:['stress',1e3],MPa:['stress',1e6],GPa:['stress',1e9],psi:['stress',6894.757293168],ksi:['stress',6894757.293168],
  kg:['mass',1],t:['mass',1000],lbm:['mass',0.45359237],'kg/m3':['density',1],
  rad:['angle',1],deg:['angle',Math.PI/180], 'kgm2':['massInertia',1]
};
function clean(s){return s.replace(/\s/g,'').replace(/²/g,'2').replace(/⁴/g,'4').replace(/³/g,'3').replace(/\^/g,'').replace(/·/g,'');}
export function quantity(text,dimension,defaultUnit) {
  if(typeof text==='number')text=String(text);
  const match=String(text).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i);
  if(!match)throw new Error(`Invalid ${dimension} quantity: “${text}”.`);
  const value=Number(match[1]),suffix=clean(match[2]||defaultUnit||'');
  if(!Number.isFinite(value))throw new Error('A finite quantity is required.');
  if(dimension==='dimensionless') {if(suffix)throw new Error('This field is dimensionless.');return value;}
  if(!units[suffix] || units[suffix][0]!==dimension) throw new Error(`Expected ${dimension}; “${suffix}” is not a compatible unit.`);
  return value*units[suffix][1];
}
export const displaySystems={
  SI:{name:'kN, m',length:'m',force:'kN',moment:'kNm',lineLoad:'kN/m',stress:'MPa',area:'m2',inertia:'m4',mass:'kg',angle:'rad'},
  MM:{name:'N, mm',length:'mm',force:'N',moment:'Nmm',lineLoad:'N/mm',stress:'MPa',area:'mm2',inertia:'mm4',mass:'kg',angle:'rad'},
  US:{name:'kip, ft',length:'ft',force:'kip',moment:'kip-ft',lineLoad:'kip/ft',stress:'ksi',area:'ft2',inertia:'in4',mass:'lbm',angle:'rad'}
};
export const unitFactor=u=>units[clean(u)]?.[1]??1;
export function formatValue(value,dimension,system='SI',digits=3) {
  const u=displaySystems[system][dimension],v=value/unitFactor(u);
  return Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:digits,minimumFractionDigits:0}):'—';
}
