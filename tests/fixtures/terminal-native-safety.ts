export interface TerminalWindowMetadata {windowId:number;selectedTTY:string;tabs:string[]}
export interface OwnedTerminalTarget {windowId:number;tty:string;pid:number;startIdentity:string}

export function assertOwnedTerminalWindow(target:OwnedTerminalTarget,baseline:TerminalWindowMetadata[],current:TerminalWindowMetadata[]){
 if(baseline.some(w=>w.windowId===target.windowId))throw Error('Refusing a baseline Terminal window target');
 const window=current.find(w=>w.windowId===target.windowId);
 if(!window||window.tabs.length!==1)throw Error('Owned Terminal window must contain exactly one tab');
 if(window.selectedTTY!==target.tty||window.tabs[0]!==target.tty)throw Error('Owned Terminal TTY changed');
}
export function assertTerminalBaselineUnchanged(baseline:TerminalWindowMetadata[],current:TerminalWindowMetadata[]){
 for(const original of baseline){
  const window=current.find(w=>w.windowId===original.windowId);
  if(!window||JSON.stringify([...window.tabs].sort())!==JSON.stringify([...original.tabs].sort()))throw Error('Terminal baseline window IDs or tab TTYs changed; stop without restoring foreign objects');
 }
}

/** Metadata only: never query terminal names, titles, contents, or history. */
export const terminalMetadataScript=`tell application id "com.apple.Terminal"
 set output to ""
 repeat with w in windows
  set output to output & (id of w as text) & (ASCII character 9) & (tty of selected tab of w)
  repeat with t in tabs of w
   set output to output & (ASCII character 9) & (tty of t)
  end repeat
  set output to output & linefeed
 end repeat
 return output
end tell`;
export function parseTerminalMetadata(output:string):TerminalWindowMetadata[]{
 return output.trim().split('\n').filter(Boolean).map(line=>{
  const [id,selectedTTY,...tabs]=line.split('\t'),windowId=Number(id);
  if(!Number.isSafeInteger(windowId)||windowId<=0||!selectedTTY||!tabs.length||[selectedTTY,...tabs].some(tty=>!/^\/dev\/ttys\d+$/.test(tty)))throw Error('Invalid Terminal metadata; no cleanup permitted');
  return {windowId,selectedTTY,tabs};
 }).sort((a,b)=>a.windowId-b.windowId);
}
export function ownedTerminalCloseScript(target:OwnedTerminalTarget,baseline:TerminalWindowMetadata[]){
 if(!Number.isSafeInteger(target.windowId)||target.windowId<=0||!/^\/dev\/ttys\d+$/.test(target.tty))throw Error('Invalid owned Terminal close target');
 if(baseline.some(w=>w.windowId===target.windowId))throw Error('Refusing a baseline Terminal close target');
 return `tell application id "com.apple.Terminal"
 set forbiddenIDs to {${baseline.map(w=>w.windowId).join(', ')}}
 if forbiddenIDs contains ${target.windowId} then error "Baseline Terminal target rejected"
 set w to window id ${target.windowId}
 if (count tabs of w) is not 1 then error "Foreign tabs retained"
 if tty of selected tab of w is not ${JSON.stringify(target.tty)} then error "Owned TTY changed"
 close w
 return "closed-owned-window:${target.windowId}:${target.tty}"
end tell`;
}

export const terminalQuitInput=()=>'\u0015/hub-test-quit';
