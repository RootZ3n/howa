import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const marker="howa-ddv1-test-owned.v1\n"; const owned=new Set<string>();
export async function ownedDailyDriverTemp(label:string):Promise<string>{const root=await fs.mkdtemp(path.join(os.tmpdir(),`howa-ddv1-test-${label}-`));await fs.writeFile(path.join(root,".howa-ddv1-test-owner"),marker,{flag:"wx",mode:0o400});owned.add(root);return root;}
export async function cleanupOwnedDailyDriverTemps():Promise<void>{for(const root of [...owned]){try{if(await fs.readFile(path.join(root,".howa-ddv1-test-owner"),"utf8")!==marker)throw new Error(`ownership marker mismatch: ${root}`);await fs.rm(root,{recursive:true,force:false});owned.delete(root);}catch(error){throw new Error(`refusing unowned Daily Driver temp cleanup: ${root}: ${String(error)}`);}}}
