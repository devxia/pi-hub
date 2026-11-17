import {expect,type ElectronApplication,type Page} from '@playwright/test';
export async function openSettings(app:ElectronApplication,main:Page,category?:'终端'|'会话存储'|'Pi 启动'){
 await main.getByRole('button',{name:'设置',exact:true}).click();
 await expect.poll(()=>app.windows().filter(p=>p.url().includes('view=settings')).length).toBe(1);
 const page=app.windows().find(p=>p.url().includes('view=settings'))!;
 await expect(page.getByRole('navigation',{name:'设置类目'})).toBeVisible();
 if(category)await page.getByRole('button',{name:category,exact:true}).click();
 return page;
}
export async function closeSettings(page:Page){
 const closed=page.waitForEvent('close');await page.getByRole('button',{name:'关闭设置',exact:true}).click();await closed;
}
