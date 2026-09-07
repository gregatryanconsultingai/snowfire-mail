const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const gmail = require('./gmail.cjs')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let mainWindow = null
const SEND_DELAY_MS = 60_000
const pendingSends = new Map()
let activeSendCount = 0
const lifecycleLogPath = () => path.join(app.getPath('userData'), 'lifecycle.log')
function logLifecycle(event, details = {}) {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...details })
    fs.appendFileSync(lifecycleLogPath(), `${line}\n`, { mode: 0o600 })
  } catch {}
}

const labelIconDirectory = () => path.join(app.getPath('userData'), 'label-icons')
const labelIconIndexPath = () => path.join(labelIconDirectory(), 'index.json')
const iconMime = {'.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg'}
function readLabelIconIndex() { try { return JSON.parse(fs.readFileSync(labelIconIndexPath(),'utf8')) } catch { return {} } }
function writeLabelIconIndex(index) { fs.mkdirSync(labelIconDirectory(),{recursive:true});fs.writeFileSync(labelIconIndexPath(),JSON.stringify(index,null,2),{mode:0o600}) }
function iconDataUrl(filename) { const extension=path.extname(filename).toLowerCase(),mime=iconMime[extension];if(!mime)return null;const filePath=path.join(labelIconDirectory(),path.basename(filename));if(!fs.existsSync(filePath))return null;return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}` }
function listLabelIcons() { const index=readLabelIconIndex(),result={};for(const [label,filename] of Object.entries(index)){const dataUrl=iconDataUrl(filename);if(dataUrl)result[label]=dataUrl}return result }
async function chooseLabelIcon(labelName) { const label=String(labelName||'').trim();if(!label)throw new Error('Choose a label first.');const result=await dialog.showOpenDialog({title:`Choose an icon for ${label}`,properties:['openFile'],filters:[{name:'Images',extensions:['svg','png','webp','jpg','jpeg']}]});if(result.canceled||!result.filePaths[0])return null;const source=result.filePaths[0],stat=fs.statSync(source);if(stat.size>2*1024*1024)throw new Error('Label icons must be smaller than 2 MB.');const extension=path.extname(source).toLowerCase();if(!iconMime[extension])throw new Error('Choose an SVG, PNG, WebP, or JPEG icon.');const index=readLabelIconIndex(),old=index[label],filename=`${crypto.createHash('sha256').update(label).digest('hex').slice(0,24)}${extension}`;fs.mkdirSync(labelIconDirectory(),{recursive:true});fs.copyFileSync(source,path.join(labelIconDirectory(),filename));fs.chmodSync(path.join(labelIconDirectory(),filename),0o600);if(old&&old!==filename){try{fs.unlinkSync(path.join(labelIconDirectory(),path.basename(old)))}catch{}}index[label]=filename;writeLabelIconIndex(index);return iconDataUrl(filename) }
function removeLabelIcon(labelName) { const label=String(labelName||'').trim(),index=readLabelIconIndex(),filename=index[label];if(filename){try{fs.unlinkSync(path.join(labelIconDirectory(),path.basename(filename)))}catch{}delete index[label];writeLabelIconIndex(index)}return true }

const senderLabelsPath = () => path.join(app.getPath('userData'), 'sender-labels.json')
const normalizeSenderEmail = value => String(value||'').trim().toLowerCase()
function readSenderLabels() { try { const stored=JSON.parse(fs.readFileSync(senderLabelsPath(),'utf8')),result={};for(const [email,labels] of Object.entries(stored)){const key=normalizeSenderEmail(email);if(key&&Array.isArray(labels))result[key]=[...new Set(labels.map(label=>String(label||'').trim()).filter(Boolean))]}return result } catch { return {} } }
function setSenderLabels(email,labels=[]) { const key=normalizeSenderEmail(email);if(!key)throw new Error('Choose a sender email address.');const index=readSenderLabels();index[key]=[...new Set((Array.isArray(labels)?labels:[]).map(label=>String(label||'').trim()).filter(Boolean))];fs.writeFileSync(senderLabelsPath(),JSON.stringify(index,null,2),{mode:0o600});return index }
function removeSenderLabel(labelName) { const target=String(labelName||'').trim().toLowerCase(),index=readSenderLabels();for(const email of Object.keys(index))index[email]=index[email].filter(label=>label.toLowerCase()!==target);fs.writeFileSync(senderLabelsPath(),JSON.stringify(index,null,2),{mode:0o600});return index }

const senderFolderRulesPath = () => path.join(app.getPath('userData'), 'sender-folder-rules.json')
const FOLDER_ROOT = 'Folders'
function readSenderFolderRules() { try { const stored=JSON.parse(fs.readFileSync(senderFolderRulesPath(),'utf8')),result={};for(const [email,folderName] of Object.entries(stored)){const key=normalizeSenderEmail(email),folder=String(folderName||'').trim();if(key&&folder)result[key]=folder}return result } catch { return {} } }
function writeSenderFolderRules(rules) { fs.writeFileSync(senderFolderRulesPath(),JSON.stringify(rules,null,2),{mode:0o600});return rules }
function setSenderFolderRule(email,folderName) { const key=normalizeSenderEmail(email),folder=String(folderName||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key))throw new Error('Enter a valid sender email address.');if(!folder.startsWith(`${FOLDER_ROOT}/`))throw new Error('Choose a SnowFire folder.');const rules=readSenderFolderRules();rules[key]=folder;return writeSenderFolderRules(rules) }
function removeSenderFolderRule(email) { const rules=readSenderFolderRules();delete rules[normalizeSenderEmail(email)];return writeSenderFolderRules(rules) }
function removeSenderFolderRules(folderNames=[]) { const removed=new Set((Array.isArray(folderNames)?folderNames:[]).map(name=>String(name||'').trim().toLowerCase()).filter(Boolean)),rules=readSenderFolderRules();for(const [email,folderName] of Object.entries(rules))if(removed.has(folderName.toLowerCase()))delete rules[email];return writeSenderFolderRules(rules) }

function publicPendingSend(entry) { return { id:entry.id, sendAt:entry.sendAt, message:entry.message } }
function broadcastSendStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('gmail:send-status', status)
}
async function deliverPendingSend(id) {
  const entry=pendingSends.get(id)
  if(!entry)return
  pendingSends.delete(id)
  activeSendCount++
  try {
    await gmail.send(entry.message)
    logLifecycle('send-completed', { queued:true })
    broadcastSendStatus({ id, status:'sent' })
  } catch (error) {
    const message=error instanceof Error?error.message:String(error)
    logLifecycle('send-failed', { queued:true, message })
    broadcastSendStatus({ id, status:'failed', error:message, message:entry.message })
  } finally {
    activeSendCount--
  }
  if(!pendingSends.size&&!activeSendCount&&!BrowserWindow.getAllWindows().length&&process.platform!=='darwin')app.quit()
}
function queueSend(message) {
  if(!String(message?.to||'').trim()||!String(message?.body||'').trim())throw new Error('Add a recipient and message.')
  if((message.attachments||[]).reduce((total,file)=>total+Number(file?.size||0),0)>24*1024*1024)throw new Error('Gmail attachments must total less than 24 MB.')
  const id=crypto.randomUUID(),sendAt=Date.now()+SEND_DELAY_MS
  const entry={id,sendAt,message,timer:setTimeout(()=>deliverPendingSend(id),SEND_DELAY_MS)}
  pendingSends.set(id,entry)
  logLifecycle('send-queued', { delaySeconds:SEND_DELAY_MS/1000, hasAttachments:Boolean(message.attachments?.length) })
  return publicPendingSend(entry)
}
function undoSend(id) {
  const entry=pendingSends.get(String(id||''))
  if(!entry)return null
  clearTimeout(entry.timer)
  pendingSends.delete(entry.id)
  logLifecycle('send-undone')
  return publicPendingSend(entry)
}
function listPendingSends() { return [...pendingSends.values()].sort((a,b)=>a.sendAt-b.sendAt).map(publicPendingSend) }

const folderOrderPath = () => path.join(app.getPath('userData'), 'folder-order.json')
function readFolderOrder() { try { const stored=JSON.parse(fs.readFileSync(folderOrderPath(),'utf8'));return Array.isArray(stored)?[...new Set(stored.map(name=>String(name||'').trim()).filter(Boolean))]:[] } catch { return [] } }
function setFolderOrder(order=[]) { const next=[...new Set((Array.isArray(order)?order:[]).map(name=>String(name||'').trim()).filter(Boolean))];fs.writeFileSync(folderOrderPath(),JSON.stringify(next,null,2),{mode:0o600});return next }
function renameFolderReferences(changes={}) { const entries=Object.entries(changes&&typeof changes==='object'?changes:{}).map(([from,to])=>[String(from||'').trim(),String(to||'').trim()]).filter(([from,to])=>from.startsWith(`${FOLDER_ROOT}/`)&&to.startsWith(`${FOLDER_ROOT}/`)),renames=new Map(entries),order=setFolderOrder(readFolderOrder().map(name=>renames.get(name)||name)),rules=readSenderFolderRules();for(const email of Object.keys(rules))rules[email]=renames.get(rules[email])||rules[email];writeSenderFolderRules(rules);return {order,rules} }

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const defaultSettings = { remoteImages: false }
function readSettings() { try { return {...defaultSettings,...JSON.parse(fs.readFileSync(settingsPath(),'utf8'))} } catch { return {...defaultSettings} } }
function updateSettings(value={}) { const next={...readSettings(),remoteImages:Boolean(value.remoteImages)};fs.writeFileSync(settingsPath(),JSON.stringify(next,null,2),{mode:0o600});return next }
function trustedSender(event) {
  const url=event.senderFrame?.url||event.sender.getURL()
  return app.isPackaged ? url.startsWith('file:') : url.startsWith('http://127.0.0.1:5173')
}
function handle(channel,listener){ipcMain.handle(channel,(event,...args)=>{if(!trustedSender(event))throw new Error('Blocked an untrusted app request.');return listener(event,...args)})}
const attachmentMime={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain','.csv':'text/csv','.zip':'application/zip','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'}
async function chooseMessageAttachments(){const result=await dialog.showOpenDialog({title:'Attach files',properties:['openFile','multiSelections']});if(result.canceled)return[];let total=0;const files=[];for(const filePath of result.filePaths){const stat=fs.statSync(filePath);total+=stat.size;if(total>24*1024*1024)throw new Error('Gmail attachments must total less than 24 MB.');files.push({filename:path.basename(filePath),mimeType:attachmentMime[path.extname(filePath).toLowerCase()]||'application/octet-stream',size:stat.size,data:fs.readFileSync(filePath).toString('base64')})}return files}
async function chooseOAuthCredentials(){const result=await dialog.showOpenDialog({title:'Choose Google Desktop OAuth JSON',properties:['openFile'],filters:[{name:'JSON files',extensions:['json']}]});if(result.canceled||!result.filePaths[0])return null;const stat=fs.statSync(result.filePaths[0]);if(stat.size>128*1024)throw new Error('That OAuth file is unexpectedly large.');return fs.readFileSync(result.filePaths[0],'utf8')}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    return mainWindow
  }
  const windowOptions = {
    width: 1500, height: 940, minWidth: 1040, minHeight: 700,
    backgroundColor: '#070709', frame: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  }
  if (process.platform === 'darwin') windowOptions.titleBarStyle = 'hiddenInset'
  const win = new BrowserWindow(windowOptions)
  mainWindow = win
  logLifecycle('window-created')
  win.on('closed', () => {
    logLifecycle('window-closed')
    if (mainWindow === win) mainWindow = null
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logLifecycle('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
  })
  win.webContents.on('unresponsive', () => logLifecycle('renderer-unresponsive'))
  win.webContents.on('responsive', () => logLifecycle('renderer-responsive'))
  win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url)||/^mailto:/i.test(url))shell.openExternal(url);return{action:'deny'}})
  win.webContents.on('will-navigate',(event,url)=>{const current=win.webContents.getURL();if(url!==current){event.preventDefault();if(/^https?:\/\//i.test(url)||/^mailto:/i.test(url))shell.openExternal(url)}})
  win.webContents.on('before-input-event', (event, input) => {
    const modifier = process.platform === 'darwin' ? input.meta : input.control
    if (!modifier || input.alt) return
    const key = String(input.key || '').toLowerCase()
    const zoomIn = key === '+' || key === '=' || input.code === 'NumpadAdd'
    const zoomOut = key === '-' || input.code === 'NumpadSubtract'
    const zoomReset = key === '0' || input.code === 'Numpad0'
    if (!zoomIn && !zoomOut && !zoomReset) return
    event.preventDefault()
    if (zoomReset) return win.webContents.setZoomFactor(1)
    const current = win.webContents.getZoomFactor()
    const next = Math.min(2, Math.max(.7, Math.round((current + (zoomIn ? .1 : -.1)) * 10) / 10))
    win.webContents.setZoomFactor(next)
  })
  const load = app.isPackaged
    ? win.loadFile(path.join(__dirname, '../dist/index.html'))
    : win.loadURL('http://127.0.0.1:5173')
  load.catch(error => logLifecycle('window-load-failed', { message: error.message }))
  return win
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false))
  handle('app:platform', () => process.platform)
  handle('app:window-action', (event, action) => {const win=BrowserWindow.fromWebContents(event.sender);if(!win)return false;if(action==='minimize')win.minimize();else if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();else if(action==='close')win.close();return true})
  handle('app:open-external', (_event,url) => {if(!/^https?:\/\//i.test(String(url))&&!/^mailto:/i.test(String(url)))throw new Error('That link type is not allowed.');return shell.openExternal(String(url))})
  handle('app:settings', () => readSettings())
  handle('app:update-settings', (_event,value) => updateSettings(value))
  handle('metadata:label-icons', () => listLabelIcons())
  handle('metadata:choose-label-icon', (_e, labelName) => chooseLabelIcon(labelName))
  handle('metadata:remove-label-icon', (_e, labelName) => removeLabelIcon(labelName))
  handle('metadata:sender-labels', () => readSenderLabels())
  handle('metadata:set-sender-labels', (_e, email, labels) => setSenderLabels(email, labels))
  handle('metadata:remove-sender-label', (_e, labelName) => removeSenderLabel(labelName))
  handle('metadata:sender-folder-rules', () => readSenderFolderRules())
  handle('metadata:set-sender-folder-rule', (_e, email, folderName) => setSenderFolderRule(email, folderName))
  handle('metadata:remove-sender-folder-rule', (_e, email) => removeSenderFolderRule(email))
  handle('metadata:remove-sender-folder-rules', (_e, folderNames) => removeSenderFolderRules(folderNames))
  handle('metadata:folder-order', () => readFolderOrder())
  handle('metadata:set-folder-order', (_e, order) => setFolderOrder(order))
  handle('metadata:rename-folder-references', (_e, changes) => renameFolderReferences(changes))
  handle('gmail:status', async () => {
    const storage = gmail.credentialStorage()
    const base = {secureStorage:storage !== 'local', credentialStorage:storage}
    return gmail.status()
      ? {...base, connected:!gmail.needsScopeUpgrade(), upgradeRequired:gmail.needsScopeUpgrade(), profile:await gmail.profile()}
      : {...base, connected:false, upgradeRequired:false}
  })
  handle('gmail:connect', (_e, value) => gmail.connect(value))
  handle('gmail:choose-credentials', () => chooseOAuthCredentials())
  handle('gmail:list', (_e, query, allowRemoteImages) => gmail.listMessages(query,Boolean(allowRemoteImages)))
  handle('gmail:get', (_e, id, allowRemoteImages) => gmail.getMessage(id,Boolean(allowRemoteImages)))
  handle('gmail:counts', () => gmail.counts())
  handle('gmail:labels', () => gmail.labels())
  handle('gmail:create-label', (_e, name) => gmail.createLabel(name))
  handle('gmail:update-label', (_e, id, name) => gmail.updateLabel(id, name))
  handle('gmail:delete-label', (_e, id) => gmail.deleteLabel(id))
  handle('contacts:list', () => gmail.listContacts())
  handle('contacts:create', (_e, contact) => gmail.createContact(contact))
  handle('contacts:update', (_e, contact) => gmail.updateContact(contact))
  handle('calendar:today', () => gmail.listTodayEvents())
  handle('calendar:list', (_e, start, end) => gmail.listCalendarEvents(start, end))
  handle('calendar:create', (_e, event) => gmail.createCalendarEvent(event))
  handle('calendar:update', (_e, event) => gmail.updateCalendarEvent(event))
  handle('calendar:delete', (_e, event) => gmail.deleteCalendarEvent(event))
  handle('calendar:suggestions', (_e, duration) => gmail.suggestCalendarTimes(duration))
  handle('gmail:modify', (_e, id, add, remove) => gmail.modify(id, add, remove))
  handle('gmail:trash', (_e, id) => gmail.trash(id))
  handle('gmail:untrash', (_e, id) => gmail.untrash(id))
  handle('gmail:snooze', (_e, id, until) => gmail.snooze(id, until))
  handle('gmail:unsnooze', (_e, id) => gmail.unsnooze(id))
  handle('gmail:choose-files', () => chooseMessageAttachments())
  handle('gmail:save-attachment', async (_e, messageId, attachment) => { const result=await dialog.showSaveDialog({defaultPath:path.basename(attachment.filename)});if(result.canceled||!result.filePath)return false;const data=await gmail.attachment(messageId,attachment.id);fs.writeFileSync(result.filePath,Buffer.from(data.data.replace(/-/g,'+').replace(/_/g,'/'),'base64'),{mode:0o600});return true })
  handle('gmail:open-attachment', async (_e, messageId, attachment) => { const data=await gmail.attachment(messageId,attachment.id),dir=path.join(app.getPath('temp'),'snowfire-mail-previews'),safeName=path.basename(attachment.filename).replace(/[^a-zA-Z0-9._ -]/g,'_'),filePath=path.join(dir,`${messageId.slice(0,10)}-${safeName}`);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(filePath,Buffer.from(data.data.replace(/-/g,'+').replace(/_/g,'/'),'base64'),{mode:0o600});const error=await shell.openPath(filePath);if(error)throw new Error(error);return true })
  handle('gmail:save-all-attachments', async (_e, messageId, attachments) => { const result=await dialog.showOpenDialog({title:'Download all attachments',properties:['openDirectory','createDirectory']});if(result.canceled||!result.filePaths[0])return false;const directory=result.filePaths[0];for(const attachment of attachments){const data=await gmail.attachment(messageId,attachment.id),parsed=path.parse(path.basename(attachment.filename).replace(/[^a-zA-Z0-9._ -]/g,'_'));let candidate=path.join(directory,`${parsed.name}${parsed.ext}`),index=2;while(fs.existsSync(candidate))candidate=path.join(directory,`${parsed.name} ${index++}${parsed.ext}`);fs.writeFileSync(candidate,Buffer.from(data.data.replace(/-/g,'+').replace(/_/g,'/'),'base64'),{mode:0o600})}return directory })
  handle('gmail:send', async (_e, message) => {
    logLifecycle('send-started', { hasAttachments: Boolean(message?.attachments?.length) })
    try {
      const result = await gmail.send(message)
      logLifecycle('send-completed')
      return result
    } catch (error) {
      logLifecycle('send-failed', { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  })
  handle('gmail:queue-send', (_e, message) => queueSend(message))
  handle('gmail:pending-sends', () => listPendingSends())
  handle('gmail:undo-send', (_e, id) => undoSend(id))
  handle('gmail:disconnect', () => gmail.disconnect())
  createWindow()
  gmail.processSnoozes().catch(()=>{})
  const snoozeTimer=setInterval(()=>gmail.processSnoozes().catch(()=>{}),60000)
  snoozeTimer.unref()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('second-instance',()=>{const win=mainWindow&&!mainWindow.isDestroyed()?mainWindow:BrowserWindow.getAllWindows()[0];if(win){if(win.isMinimized())win.restore();win.focus()}else if(app.isReady())createWindow()})
app.on('child-process-gone', (_event, details) => logLifecycle('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name }))
app.on('before-quit', () => logLifecycle('before-quit'))
app.on('window-all-closed', () => { logLifecycle('window-all-closed', { pendingSends:pendingSends.size, activeSends:activeSendCount });if (process.platform !== 'darwin'&&!pendingSends.size&&!activeSendCount) app.quit() })
process.on('uncaughtExceptionMonitor', error => logLifecycle('uncaught-exception', { message: error.message, stack: error.stack }))
