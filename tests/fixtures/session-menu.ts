import {expect,type ElectronApplication,type Page,type Locator} from '@playwright/test';
/** Choose one native Menu item at the OS UI boundary; all IPC/service actions remain real. */
export async function sessionMenu(app:ElectronApplication,page:Page,row?:Locator){
 await app.evaluate(({Menu,BrowserWindow})=>{
  const window=BrowserWindow.getAllWindows()[0];window.show();window.focus();
  if(!(globalThis as any).ownedMenuInstalled){const original=Menu.prototype.popup;Menu.prototype.popup=function(options:any){(globalThis as any).ownedSessionMenu={menu:this,options};};(globalThis as any).ownedMenuInstalled=true;(globalThis as any).ownedOriginalPopup=original;}
  (globalThis as any).ownedSessionMenu=null;
 });
 const target=row??page.locator('.session-row button[aria-pressed="true"]').first();
 if(await page.locator('main[inert]').count())await page.getByRole('button',{name:'关闭预览',exact:true}).click();
 await expect.poll(async()=>{if(await app.evaluate(()=>!!(globalThis as any).ownedSessionMenu))return true;await target.click({button:'right'});return app.evaluate(()=>!!(globalThis as any).ownedSessionMenu);}).toBe(true);
 return app.evaluate(()=>{const read=(menu:any):any[]=>menu.items.map((i:any)=>({id:i.id,label:i.label,enabled:i.enabled,type:i.type,submenu:i.submenu?read(i.submenu):undefined}));return read((globalThis as any).ownedSessionMenu.menu);});
}
export async function cancelMenu(app:ElectronApplication){await app.evaluate(()=>{const captured=(globalThis as any).ownedSessionMenu;captured?.options.callback?.();(globalThis as any).ownedSessionMenu=null;});}
export async function chooseMenu(app:ElectronApplication,id:string){
 await app.evaluate(({BrowserWindow},id)=>{const captured=(globalThis as any).ownedSessionMenu,item=captured?.menu.getMenuItemById(id);if(!item||!item.enabled)throw Error('Unavailable native menu item: '+id);item.click(item,BrowserWindow.getAllWindows()[0],{});captured.options.callback?.();(globalThis as any).ownedSessionMenu=null;},id);
}
export async function sessionAction(app:ElectronApplication,page:Page,id:string,row?:Locator){await sessionMenu(app,page,row);await chooseMenu(app,id);}
