export function consolePrompt(entries, {kind='logs',version,route='/',source='Page',dropped=0}={}) {
  const groups = new Map();
  const hasServer=entries.some(entry=>entry.source==='server');
  for (const entry of entries) {
    const key = (entry.source||'browser')+'\0'+entry.level + '\0' + entry.text;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key,{entry,count:1});
  }
  const instruction = kind === 'errors' ? 'Fix all errors below.' : kind === 'message' ? `Investigate the ${hasServer?'server':'client'} message below and fix its root cause if it indicates a problem.` : `Review the ${hasServer?'development':'client'} logs below and fix the errors they reveal.`;
  // The report deliberately omits URL query/fragment and browser/session data.
  let path='/';try{path=new URL(route,'http://prnext.local').pathname;}catch{}
  const header = [instruction,'','Context:',`- Framework: PRNext ${version || ''}`.trimEnd(),`- Route: ${path}`,`- Source: ${source} ${hasServer?'development console (browser and server)':'client console'}`,`- Captured messages: ${entries.length} (${groups.size} unique)`];
  if(dropped)header.push('- Earlier messages were removed from the bounded console buffer.');
  header.push('','Diagnostic messages:');
  for (const {entry,count} of groups.values()) header.push('',`--- ${entry.level.toUpperCase()}${hasServer?' · '+(entry.source||'browser'):''}${count>1?` · ${count} occurrences`:''} ---`,entry.text);
  header.push('','Find the root cause, make the smallest safe code changes, preserve intended behavior, and run the relevant checks.');
  return header.join('\n');
}
