import {expect,test} from 'vitest';
import {assertOwnedTerminalWindow,assertTerminalBaselineUnchanged,terminalQuitInput} from '../fixtures/terminal-native-safety';

const baseline=[{windowId:7,selectedTTY:'/dev/ttys010',tabs:['/dev/ttys010']}];
const owned={windowId:8,tty:'/dev/ttys011',pid:101,startIdentity:'owned-start'};
const current=[...baseline,{windowId:8,selectedTTY:'/dev/ttys011',tabs:['/dev/ttys011']}];
test('Terminal native fixture rejects baseline targets even if an asserted live process matches',()=>{
 expect(()=>assertOwnedTerminalWindow({...owned,windowId:7,tty:'/dev/ttys010'},baseline,current)).toThrow('baseline');
});
test('Terminal native fixture rejects extra tabs and a changed selected TTY before close',()=>{
 expect(()=>assertOwnedTerminalWindow(owned,baseline,[...baseline,{...current[1],tabs:['/dev/ttys011','/dev/ttys012']}])).toThrow('one tab');
 expect(()=>assertOwnedTerminalWindow(owned,baseline,[...baseline,{...current[1],selectedTTY:'/dev/ttys012'}])).toThrow('TTY');
});
test('Terminal native fixture fails when a baseline window or tab disappears and accepts unchanged baseline',()=>{
 expect(()=>assertTerminalBaselineUnchanged(baseline,[])).toThrow('baseline');
 expect(()=>assertTerminalBaselineUnchanged(baseline,[{...baseline[0],tabs:['/dev/ttys099']}])).toThrow('baseline');
 expect(()=>assertTerminalBaselineUnchanged(baseline,current)).not.toThrow();
 expect(()=>assertOwnedTerminalWindow(owned,baseline,current)).not.toThrow();
});

test('Terminal native cleanup protocol clears an existing editor draft before the quit command',()=>{
 const input=terminalQuitInput();
 expect(input).toBe('\u0015/hub-test-quit');
 let editor='11';
 for(const character of input)editor=character==='\u0015'?'':editor+character;
 expect(editor).toBe('/hub-test-quit');
});
