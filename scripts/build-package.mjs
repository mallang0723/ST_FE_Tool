import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { PACKAGE_VERSION } from '../shared/contracts/index.mjs';
const destination = path.resolve('release/damso-tools-'+PACKAGE_VERSION);
await fs.rm(destination,{recursive:true,force:true});
await fs.mkdir(destination,{recursive:true});
for(const [source,target]of [['dist','extension/dist'],['manifest.json','extension/manifest.json'],['video','extension/video'],['integration','integration'],['docker','docker'],['README.md','README.md'],['LICENSE','LICENSE'],['docs','docs']]) {
    await fs.cp(source,path.join(destination,target),{recursive:true});
}
await build({entryPoints:['server/index.mjs'],outfile:path.join(destination,'server/index.mjs'),bundle:true,platform:'node',format:'esm',target:'node20',sourcemap:false});
await fs.copyFile('integration/early-bridge.js',path.join(destination,'server/early-bridge.js'));
await build({entryPoints:['installer/index.mjs'],outfile:path.join(destination,'install.mjs'),bundle:true,platform:'node',format:'esm',target:'node20',sourcemap:false,banner:{js:"import { createRequire as damsoCreateRequire } from 'node:module'; const require = damsoCreateRequire(import.meta.url);"}});
for(const source of ['src','server','shared','integration','installer','scripts','tests','package.json','package-lock.json','vite.config.mjs','manifest.json','vendor','video','docs','docker','README.md','LICENSE','eslint.config.mjs','.gitignore']) {
    await fs.cp(source,path.join(destination,'source',source),{recursive:true});
}
await fs.writeFile(path.join(destination,'version.json'),JSON.stringify({name:'담소 도구함',version:PACKAGE_VERSION,upstreamCommit:'2f3a221e00dd713baba45e1f857d093141593c09',hostVersions:['1.18.0','1.19.0']},null,2));
execFileSync('python3',['-c',`import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(str(root)+'.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file(): z.write(p,p.relative_to(root.parent))
`,destination]);
console.log('통합 ZIP: '+destination+'.zip');
