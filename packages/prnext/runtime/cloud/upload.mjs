import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// The checkpoint contains identifiers/checksums only, never source or env contents.
export async function uploadSource(api, link, archive, {save, signal, log = () => {}}) {
  const base = `/projects/${encodeURIComponent(link.projectId)}/uploads`;
  const retry = async fn => {
    for (let attempt=0;;attempt++) {
      signal?.throwIfAborted();
      try { return await fn(); }
      catch (error) {
        if (signal?.aborted || attempt >= 3 || error.status && ![408,429,500,502,503,504].includes(error.status) && error.code !== 'upload_busy') throw error;
        await delay(500 * 2**attempt,undefined,{signal});
      }
    }
  };
  if (link.upload && link.upload.digest !== archive.digest) {
    await api(`${base}/${link.upload.id}`,{method:'DELETE'}).catch(error => {if (![404,410].includes(error.status)) throw error;});
    delete link.upload;
  }
  link.upload ||= {id:randomUUID(),digest:archive.digest};
  await save(link);
  let session;
  try {
    session = await retry(() => api(base,{method:'POST',body:{requestId:link.upload.id,bytes:archive.size,sourceBytes:archive.expandedBytes,digest:archive.digest}}));
  } catch(error) {
    if ([404,410].includes(error.status)) {delete link.upload;await save(link);}
    throw error;
  }
  if (session.result) return session.result;
  if (!Number.isSafeInteger(session.chunkBytes) || session.chunkBytes < 1 || session.chunkBytes > 4*1048576) throw new Error('Unsupported server upload chunk size.');
  const parts = new Map(session.parts.map(p => [p.part,p.digest]));
  const handle = await open(archive.path,'r');
  try {
    for (let offset=0,part=0;offset<archive.size;offset+=session.chunkBytes,part++) {
      signal?.throwIfAborted();
      const body = Buffer.alloc(Math.min(session.chunkBytes,archive.size-offset));
      let read=0;
      while (read<body.length) {const result=await handle.read(body,read,body.length-read,offset+read);if(!result.bytesRead)throw new Error('Temporary archive changed. Run the command again.');read+=result.bytesRead;}
      const digest = createHash('sha256').update(body).digest('hex');
      if (parts.has(part) && parts.get(part) !== digest) throw new Error('Resumed upload checksum differs. Cancel this upload and try again.');
      if (!parts.has(part)) await retry(() => api(`${base}/${link.upload.id}/chunks/${part}`,{method:'PUT',body}));
      log(`Uploading sources: ${Math.round(100*(offset+body.length)/archive.size)}%`);
    }
  } finally { await handle.close(); }
  return retry(() => api(`${base}/${link.upload.id}/complete`,{method:'POST',body:{}}));
}
