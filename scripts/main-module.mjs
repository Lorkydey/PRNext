import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Node resolves ESM filenames physically; argv can retain a junction, symlink,
// Windows short name or a differently cased drive spelling.
export function isMainModule(url){
  if(!process.argv[1])return false;
  try{return realpathSync.native(process.argv[1])===realpathSync.native(fileURLToPath(url));}
  catch{return false;}
}
