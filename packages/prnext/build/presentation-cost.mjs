import {gzipSync} from 'node:zlib';

/** Cold-transfer admission, not a promise about a particular CPU or network.
 * Count repeated Flight element/prop-name overhead, charge the template and a
 * conservative module/request allowance, and never benchmark a live request.
 */
export function presentationCost({elements,maps,slots,repeatedElements,repeatedAttributeBytes,client}) {
  const templateBytes=Buffer.byteLength(client),templateGzipBytes=gzipSync(client,{level:6}).length;
  const rowSavings=repeatedElements*32+repeatedAttributeBytes;
  const fixedSavings=Math.max(0,elements-repeatedElements)*32;
  const minArrayEntries=maps?Math.max(32,Math.ceil(Math.max(0,templateGzipBytes+512-fixedSavings)/Math.max(1,rowSavings)/8)*8):0;
  const ordinaryEstimate=elements*32;
  const decision=maps?minArrayEntries>20000||!rowSavings&&fixedSavings<=templateGzipBytes+512?'ordinary':'compact':ordinaryEstimate>templateGzipBytes+128?'compact':'ordinary';
  return {version:1,decision,elements,maps,slots,templateBytes,templateGzipBytes,
    estimatedSavedBytesPerEntry:maps?rowSavings:0,estimatedFixedSavedBytes:fixedSavings,minArrayEntries,
    reason:decision==='ordinary'?'Estimated cold template cost exceeds the supported display workload':undefined};
}
