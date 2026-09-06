/** Tiny build-time bundler for this project's deliberately limited ES-module syntax.
 * No npm dependencies. The maintainable source remains native modules; this creates
 * an optional portable HTML with an embedded worker and embedded verification suite.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const normalize=(parent,target)=>relative(root,resolve(root,dirname(parent),target)).split(sep).join('/');
async function bundle(entry){
  const modules=new Map();
  async function visit(id){
    if(modules.has(id))return;modules.set(id,'');
    let source=await readFile(resolve(root,id),'utf8');const dependencies=[],exports=[];
    source=source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/gm,(_,names,path)=>{const dep=normalize(id,path);dependencies.push(dep);return `const {${names}}=__require(${JSON.stringify(dep)});`;});
    source=source.replace(/\bimport\(['"]([^'"]+)['"]\)/g,(_,path)=>{const dep=normalize(id,path);dependencies.push(dep);return `Promise.resolve(__require(${JSON.stringify(dep)}))`;});
    source=source.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s+)(?:(async)\s+)?(function|class|const|let|var)\s+(\w+)/g,(_,async,kind,name)=>{exports.push(name);return (async?'async ':'')+kind+' '+name;});
    source=source.replace(/import\.meta\.url/g,'document.baseURI');
    if(/^\s*(?:import\s+[^.(]|export\s+(?:function|class|const|let|var))/m.test(source))throw new Error('Unsupported module syntax in '+id);
    modules.set(id,source+`\nmodule.exports={${exports.join(',')}};`);for(const dep of dependencies)await visit(dep);
  }
  await visit(entry);
  return `(function(){'use strict';const __modules={${[...modules].map(([id,source])=>JSON.stringify(id)+':(module,__require)=>{\n'+source+'\n}').join(',\n')}};const __cache={};function __require(id){if(__cache[id])return __cache[id].exports;const module={exports:{}};__cache[id]=module;if(!__modules[id])throw new Error('Missing module '+id);__modules[id](module,__require);return module.exports;}__require(${JSON.stringify(entry)});})();`;
}
const worker=await bundle('src/analysis-worker.js'),app=await bundle('src/app.js');
const css=await readFile(resolve(root,'styles.css'),'utf8'),svg=await readFile(resolve(root,'assets/favicon.svg'),'utf8');
let html=await readFile(resolve(root,'index.html'),'utf8');
html=html.replace('href="assets/favicon.svg"','href="data:image/svg+xml,'+encodeURIComponent(svg)+'"').replace('<link rel="stylesheet" href="styles.css">','<style>'+css+'</style>');
const script='globalThis.STRATUM_WORKER_SOURCE='+JSON.stringify(worker)+';\n'+app;
html=html.replace('<script type="module" src="src/app.js"></script>','<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script>');
await mkdir(resolve(root,'dist'),{recursive:true});
await writeFile(resolve(root,'dist/stratum-frame.html'),html);
await writeFile(resolve(root,'dist/app.bundle.js'),app);await writeFile(resolve(root,'dist/worker.bundle.js'),worker);
console.log(`Built dist/stratum-frame.html (${(Buffer.byteLength(html)/1024).toFixed(1)} KiB). No external runtime dependencies.`);
