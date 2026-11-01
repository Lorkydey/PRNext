import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readArchive} from './verify-npm-artifacts.mjs';
import {isMainModule} from './main-module.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const destination=path.join(root,'packages/prnext/vendor/nft');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Refresh from the exact registry archive, never by copying an arbitrary local
// node_modules tree. Review the new integrity and dependency contract together.
export async function importNftArchive(filename,expectedIntegrity){
  if(typeof expectedIntegrity!=='string'||!/^sha512-[A-Za-z0-9+/=]+$/.test(expectedIntegrity))throw Error('An independently reviewed SHA-512 integrity is required.');
  const bytes=await readFile(filename);
  if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==expectedIntegrity)throw Error('NFT archive integrity mismatch.');
  const archive=readArchive(bytes),metadata=JSON.parse(archive.get('package/package.json').data);
  if(metadata.name!=='@vercel/nft'||metadata.version!=='1.11.0'||metadata.license!=='MIT')throw Error('Unexpected NFT release or license.');
  const files={};
  for(const [name,entry]of archive){
    if(name!=='package/LICENSE'&&!name.startsWith('package/out/'))continue;
    const relative=name.slice('package/'.length);
    if(!/^(?:LICENSE|out\/[\w./-]+\.(?:js|map|ts))$/.test(relative)||relative.split('/').includes('..'))throw Error('Unexpected NFT distribution path.');
    const file=path.join(destination,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,entry.data);files[relative]=hash(entry.data);
  }
  await writeFile(path.join(destination,'package.json'),JSON.stringify({private:true,type:'commonjs'},null,2)+'\n');
  await writeFile(path.join(destination,'upstream.json'),JSON.stringify({name:metadata.name,version:metadata.version,license:metadata.license,integrity:expectedIntegrity,archiveSha256:hash(bytes),files},null,2)+'\n');
  return verifyVendoredNft();
}

export async function verifyVendoredNft(){
  const upstream=JSON.parse(await readFile(path.join(destination,'upstream.json'),'utf8'));
  if(upstream.name!=='@vercel/nft'||upstream.version!=='1.11.0'||!/^sha512-/.test(upstream.integrity)||!upstream.files['LICENSE']||!upstream.files['out/index.js'])throw Error('Incomplete NFT provenance.');
  const actual=[];
  async function visit(directory,prefix=''){
    for(const item of await readdir(directory,{withFileTypes:true})){
      const name=prefix+item.name;
      if(item.isDirectory())await visit(path.join(directory,item.name),name+'/');
      else if(!item.isFile())throw Error('Vendored NFT files must be regular files.');
      else if(!['package.json','upstream.json','README.md'].includes(name))actual.push(name);
    }
  }
  await visit(destination);
  if(JSON.stringify(actual.sort())!==JSON.stringify(Object.keys(upstream.files).sort()))throw Error('Vendored NFT inventory changed.');
  for(const [name,digest]of Object.entries(upstream.files))if(hash(await readFile(path.join(destination,name)))!==digest)throw Error('Vendored NFT differs from its verified archive: '+name);
  return {version:upstream.version,files:actual.length,archiveSha256:upstream.archiveSha256};
}

if(isMainModule(import.meta.url)){
  const [command,filename,integrity]=process.argv.slice(2);
  if(command==='verify'&&!filename)console.log(JSON.stringify(await verifyVendoredNft()));
  else if(command==='import'&&filename&&integrity)console.log(JSON.stringify(await importNftArchive(filename,integrity)));
  else throw Error('Use vendor-nft.mjs verify or import <exact-npm-archive> <reviewed-sha512-integrity>.');
}
