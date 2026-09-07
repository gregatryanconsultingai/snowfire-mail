const { app, safeStorage, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const sanitizeHtml = require('sanitize-html')

// gmail.modify covers mail without Google's broadest Gmail scope. contacts is
// requested separately so the Contacts view can list and create Google contacts.
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts'
const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
const GOOGLE_EVENT_COLORS={1:'#7986cb',2:'#33b679',3:'#8e24aa',4:'#e67c73',5:'#f6c026',6:'#f5511d',7:'#039be5',8:'#616161',9:'#3f51b5',10:'#0b8043',11:'#d60000'}
const SCOPES = [GMAIL_SCOPE, CONTACTS_SCOPE, CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE]
const LEGACY_FULL_SCOPE = 'https://mail.google.com/'
const storePath = () => path.join(app.getPath('userData'), 'gmail-auth.json')
const snoozePath = () => path.join(app.getPath('userData'), 'snoozes.json')
let credentials = null
let tokens = null

function b64url(value) { return Buffer.from(value).toString('base64url') }
const secretAttributes = ['application','snowfire-mail','key','gmail-auth']
function secretTool(args,input) { return spawnSync('secret-tool',args,{input,encoding:'utf8',timeout:5000,windowsHide:true}) }
function secretServiceAvailable() { const result=secretTool(['lookup','application','snowfire-mail','key','availability-probe']);return !result.error&&(result.status===0||(result.status===1&&!String(result.stderr||'').trim())) }
function keyringRead() { if(!secretServiceAvailable())return null;const result=secretTool(['lookup',...secretAttributes]);return result.status===0?String(result.stdout||'').trim()||null:null }
function keyringWrite(value) { if(!secretServiceAvailable())return false;const result=secretTool(['store','--label=SnowFire Mail Gmail',...secretAttributes],value);return result.status===0 }
function keyringClear() { if(secretServiceAvailable())secretTool(['clear',...secretAttributes]) }
function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
}
function credentialStorage() { return secretServiceAvailable()?'keyring':secureStorageAvailable()?'encrypted':'local' }
function save() {
  const value = JSON.stringify({ credentials, tokens })
  if (keyringWrite(value)) {
    try { fs.unlinkSync(storePath()) } catch {}
    return 'keyring'
  }
  const secure=secureStorageAvailable()
  const encrypted=secure?safeStorage.encryptString(value).toString('base64'):Buffer.from(value).toString('base64')
  fs.writeFileSync(storePath(),JSON.stringify({encrypted,secure,backend:secure?'safeStorage':'local'}),{mode:0o600})
  return secure?'encrypted':'local'
}
function load() {
  try {
    const keyringValue=keyringRead()
    if(keyringValue){({credentials,tokens}=JSON.parse(keyringValue));return}
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    const buf = Buffer.from(raw.encrypted, 'base64')
    const value = raw.secure&&safeStorage.isEncryptionAvailable()?safeStorage.decryptString(buf):buf.toString()
    ;({ credentials, tokens } = JSON.parse(value))
    if (secretServiceAvailable()) save()
  } catch { credentials = null; tokens = null }
}
function parseCredentials(input) {
  let parsed
  try { parsed = JSON.parse(input) } catch { parsed = { installed: { client_id: input.trim() } } }
  const cfg = parsed.installed || parsed.desktop || parsed
  if (!cfg.client_id?.endsWith('.apps.googleusercontent.com')) throw new Error('Paste a valid Google Desktop OAuth client JSON or client ID.')
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret || '' }
}
async function connect(input) {
  if (input?.trim()) credentials = parseCredentials(input)
  if (!credentials) throw new Error('Paste a valid Google Desktop OAuth client JSON or client ID.')
  const verifier = b64url(crypto.randomBytes(64))
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = b64url(crypto.randomBytes(24))
  const server = http.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  const redirectUri = `http://127.0.0.1:${port}`
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  Object.entries({ client_id:credentials.clientId, redirect_uri:redirectUri, response_type:'code', scope:SCOPES.join(' '), access_type:'offline', prompt:'consent', state, code_challenge:challenge, code_challenge_method:'S256' }).forEach(([k,v])=>authUrl.searchParams.set(k,v))
  const codePromise = new Promise((resolve,reject) => {
    const timer = setTimeout(()=>{ server.close(); reject(new Error('Google sign-in timed out.')) }, 180000)
    server.on('request',(req,res)=>{
      const url = new URL(req.url, redirectUri)
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'})
      res.end('<body style="background:#070709;color:#dcdce2;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div><h1>Connected to SnowFire Mail</h1><p>You can close this tab and return to the app.</p></div></body>')
      clearTimeout(timer); server.close()
      if (url.searchParams.get('state') !== state) return reject(new Error('OAuth security check failed.'))
      if (url.searchParams.get('error')) return reject(new Error(url.searchParams.get('error')))
      resolve(url.searchParams.get('code'))
    })
  })
  await shell.openExternal(authUrl.toString())
  const code = await codePromise
  const body = new URLSearchParams({ client_id:credentials.clientId, code, code_verifier:verifier, grant_type:'authorization_code', redirect_uri:redirectUri })
  if (credentials.clientSecret) body.set('client_secret', credentials.clientSecret)
  const response = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body})
  const result = await response.json()
  if (!response.ok) throw new Error(result.error_description || result.error || 'Token exchange failed.')
  tokens = {...result, expires_at:Date.now()+(result.expires_in*1000)}; save()
  return profile()
}
async function accessToken() {
  if (!tokens) throw new Error('Not connected to Gmail.')
  if (tokens.expires_at > Date.now()+60000) return tokens.access_token
  const body = new URLSearchParams({ client_id:credentials.clientId, refresh_token:tokens.refresh_token, grant_type:'refresh_token' })
  if (credentials.clientSecret) body.set('client_secret', credentials.clientSecret)
  const response = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body})
  const result = await response.json(); if (!response.ok) throw new Error('Gmail session expired. Please reconnect.')
  tokens = {...tokens,...result,expires_at:Date.now()+(result.expires_in*1000)}; save(); return tokens.access_token
}
async function api(endpoint, options={}) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${endpoint}`,{...options,headers:{Authorization:`Bearer ${await accessToken()}`,'Content-Type':'application/json',...(options.headers||{})}})
  if (!response.ok) { const e=await response.json().catch(()=>({})); throw new Error(e.error?.message||`Gmail request failed (${response.status})`) }
  return response.status===204?null:response.json()
}
async function peopleApi(endpoint, options={}) {
  const response = await fetch(`https://people.googleapis.com/v1${endpoint}`,{...options,headers:{Authorization:`Bearer ${await accessToken()}`,'Content-Type':'application/json',...(options.headers||{})}})
  if (!response.ok) { const e=await response.json().catch(()=>({})); throw new Error(e.error?.message||`Google Contacts request failed (${response.status})`) }
  return response.status===204?null:response.json()
}
async function calendarApi(endpoint, options={}) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3${endpoint}`,{...options,headers:{Authorization:`Bearer ${await accessToken()}`,'Content-Type':'application/json',...(options.headers||{})}})
  if (!response.ok) { const e=await response.json().catch(()=>({})); throw new Error(e.error?.message||`Google Calendar request failed (${response.status})`) }
  return response.status===204?null:response.json()
}
async function profile(){ return api('/profile') }
async function counts(){const [inbox,drafts]=await Promise.all([api('/labels/INBOX'),api('/labels/DRAFT')]);return {Inbox:inbox.messagesUnread||0,Drafts:drafts.messagesTotal||0}}
async function labels(){const list=await api('/labels'),refs=(list.labels||[]).filter(label=>label.type==='user'),result=[];for(let i=0;i<refs.length;i+=5){result.push(...await Promise.all(refs.slice(i,i+5).map(label=>api(`/labels/${encodeURIComponent(label.id)}`))))}return result.sort((a,b)=>a.name.localeCompare(b.name))}
async function createLabel(name){const trimmed=name.trim();if(!trimmed)throw new Error('Enter a label name.');return api('/labels',{method:'POST',body:JSON.stringify({name:trimmed,labelListVisibility:'labelShow',messageListVisibility:'show'})})}
async function updateLabel(id,name){const trimmed=String(name||'').trim();if(!id)throw new Error('Choose a label to update.');if(!trimmed)throw new Error('Enter a label name.');return api(`/labels/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({name:trimmed})})}
async function deleteLabel(id){if(!id)throw new Error('Choose a label to delete.');return api(`/labels/${encodeURIComponent(id)}`,{method:'DELETE'})}
function contactValue(items=[]){return items.find(item=>item.metadata?.primary)||items[0]}
function parseContact(person){
  const name=contactValue(person.names),email=contactValue(person.emailAddresses),phone=contactValue(person.phoneNumbers),organization=contactValue(person.organizations)
  const displayName=name?.displayName||email?.value||phone?.value||'Unnamed contact'
  return {resourceName:person.resourceName,name:displayName,givenName:name?.givenName||'',familyName:name?.familyName||'',email:email?.value||'',emails:(person.emailAddresses||[]).map(item=>item.value).filter(Boolean),phone:phone?.value||'',phones:(person.phoneNumbers||[]).map(item=>item.value).filter(Boolean),company:organization?.name||'',title:organization?.title||'',initials:displayName.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'?'}
}
async function listContacts(){
  const contacts=[];let pageToken=''
  do {const params=new URLSearchParams({pageSize:'1000',sortOrder:'FIRST_NAME_ASCENDING',personFields:'names,emailAddresses,phoneNumbers,organizations,metadata'});if(pageToken)params.set('pageToken',pageToken);const result=await peopleApi(`/people/me/connections?${params}`);contacts.push(...(result.connections||[]).filter(person=>!person.metadata?.deleted).map(parseContact));pageToken=result.nextPageToken||''} while(pageToken)
  return contacts.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}))
}
function contactPerson(input={}){
  const givenName=String(input.givenName||'').trim().slice(0,200),familyName=String(input.familyName||'').trim().slice(0,200),emails=[...new Set((Array.isArray(input.emails)?input.emails:[input.email]).map(value=>String(value||'').trim().slice(0,320)).filter(Boolean))],phone=String(input.phone||'').trim().slice(0,100),company=String(input.company||'').trim().slice(0,200),title=String(input.title||'').trim().slice(0,200)
  if(!givenName&&!familyName&&!emails.length&&!phone)throw new Error('Add a name, email address, or phone number.')
  if(emails.some(email=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw new Error('Enter valid email addresses.')
  const person={}
  if(givenName||familyName)person.names=[{givenName,familyName}]
  if(emails.length)person.emailAddresses=emails.map((value,index)=>({value,type:index?'other':'work'}))
  if(phone)person.phoneNumbers=[{value:phone,type:'mobile'}]
  if(company||title)person.organizations=[{name:company,title,type:'work'}]
  return person
}
async function createContact(input={}){
  const person=contactPerson(input)
  const result=await peopleApi('/people:createContact?personFields=names,emailAddresses,phoneNumbers,organizations',{method:'POST',body:JSON.stringify(person)})
  return parseContact(result)
}
async function updateContact(input={}){
  const resourceName=String(input.resourceName||'')
  if(!/^people\/[a-zA-Z0-9_-]+$/.test(resourceName))throw new Error('Choose a valid Google contact to edit.')
  const current=await peopleApi(`/${resourceName}?personFields=metadata`),person={...contactPerson(input),resourceName,etag:current.etag,metadata:current.metadata}
  const fields='names,emailAddresses,phoneNumbers,organizations',params=new URLSearchParams({updatePersonFields:fields,personFields:fields})
  const result=await peopleApi(`/${resourceName}:updateContact?${params}`,{method:'PATCH',body:JSON.stringify(person)})
  return parseContact(result)
}
async function selectedCalendars(){
  const calendarList=await calendarApi('/users/me/calendarList?maxResults=250&minAccessRole=reader')
  const available=(calendarList.items||[]).filter(calendar=>!calendar.hidden)
  const selected=available.filter(calendar=>calendar.primary||calendar.selected)
  return selected.length?selected:available.filter(calendar=>calendar.primary).slice(0,1)
}
function parseCalendarEvent(event,calendar){
  const attendees=(event.attendees||[]).map(attendee=>({email:attendee.email||'',name:attendee.displayName||attendee.email||'Guest',responseStatus:attendee.responseStatus||'needsAction',self:Boolean(attendee.self),organizer:Boolean(attendee.organizer),optional:Boolean(attendee.optional)}))
  const conferenceUrl=event.hangoutLink||(event.conferenceData?.entryPoints||[]).find(point=>point.entryPointType==='video')?.uri||''
  return {id:`${calendar.id}:${event.id}`,eventId:event.id,calendarId:calendar.id,summary:event.summary||'(Untitled event)',description:event.description||'',start:event.start?.dateTime||event.start?.date||'',end:event.end?.dateTime||event.end?.date||'',allDay:Boolean(event.start?.date&&!event.start?.dateTime),calendar:calendar.summaryOverride||calendar.summary||'Calendar',calendarPrimary:Boolean(calendar.primary),colorId:String(event.colorId||''),color:GOOGLE_EVENT_COLORS[event.colorId]||calendar.backgroundColor||'#8e4bb1',location:event.location||'',htmlLink:event.htmlLink||'',conferenceUrl,attendees,organizer:{email:event.organizer?.email||'',name:event.organizer?.displayName||event.organizer?.email||'',self:Boolean(event.organizer?.self)},creator:{email:event.creator?.email||'',name:event.creator?.displayName||event.creator?.email||'',self:Boolean(event.creator?.self)},recurring:Boolean(event.recurringEventId||event.recurrence?.length),status:event.status||'confirmed',visibility:event.visibility||'default',transparency:event.transparency||'opaque',editable:['owner','writer'].includes(calendar.accessRole)&&Boolean(event.organizer?.self||event.creator?.self)}
}
async function listCalendarEvents(startValue,endValue){
  const start=new Date(startValue),end=new Date(endValue)
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)throw new Error('Choose a valid calendar range.')
  if(end.getTime()-start.getTime()>110*24*60*60*1000)throw new Error('Calendar ranges cannot exceed one quarter.')
  const calendars=await selectedCalendars()
  const params=new URLSearchParams({timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:'true',orderBy:'startTime',maxResults:'2500'})
  const batches=await Promise.all(calendars.map(async calendar=>{const result=await calendarApi(`/calendars/${encodeURIComponent(calendar.id)}/events?${params}`);return (result.items||[]).filter(event=>event.status!=='cancelled'&&event.eventType!=='workingLocation').map(event=>parseCalendarEvent(event,calendar))}))
  return batches.flat().sort((a,b)=>Number(b.allDay)-Number(a.allDay)||new Date(a.start).getTime()-new Date(b.start).getTime()||a.summary.localeCompare(b.summary))
}
async function listTodayEvents(){const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);return listCalendarEvents(start.toISOString(),end.toISOString())}
function calendarEventBody(input={}){
  const summary=String(input.summary||'').trim().slice(0,500),location=String(input.location||'').trim().slice(0,1000),description=String(input.description||'').trim().slice(0,8000),colorId=String(input.colorId||'')
  if(!summary)throw new Error('Add an event title.')
  const base={summary,location,description,...(Object.prototype.hasOwnProperty.call(GOOGLE_EVENT_COLORS,colorId)?{colorId}:{})}
  if(input.allDay){const start=String(input.start||'').slice(0,10),end=String(input.end||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<=start)throw new Error('Choose valid event dates.');return {...base,start:{date:start},end:{date:end}}}
  const start=new Date(input.start),end=new Date(input.end);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)throw new Error('Choose valid start and end times.');return {...base,start:{dateTime:start.toISOString()},end:{dateTime:end.toISOString()}}
}
async function createCalendarEvent(input={}){
  const body=calendarEventBody(input),sourceUrl=/^https:\/\//i.test(String(input.sourceUrl||''))?String(input.sourceUrl):''
  if(sourceUrl)body.source={title:String(input.sourceTitle||'Source email').slice(0,1024),url:sourceUrl}
  return calendarApi('/calendars/primary/events',{method:'POST',body:JSON.stringify(body)})
}
async function updateCalendarEvent(input={}){
  const calendarId=String(input.calendarId||''),eventId=String(input.eventId||'');if(!calendarId||!eventId)throw new Error('Choose an event to edit.')
  const body=calendarEventBody(input);if(String(input.colorId||'')==='')body.colorId=null
  return calendarApi(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,{method:'PATCH',body:JSON.stringify(body)})
}
async function deleteCalendarEvent(input={}){
  const calendarId=String(input.calendarId||''),eventId=String(input.eventId||'');if(!calendarId||!eventId)throw new Error('Choose an event to delete.')
  await calendarApi(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,{method:'DELETE'})
  return true
}
function eventBusyRange(event){
  if(event.status==='cancelled'||event.transparency==='transparent'||event.eventType==='workingLocation'||(event.attendees||[]).some(attendee=>attendee.self&&attendee.responseStatus==='declined'))return null
  const start=event.start?.dateTime?new Date(event.start.dateTime):event.start?.date?new Date(`${event.start.date}T00:00:00`):null,end=event.end?.dateTime?new Date(event.end.dateTime):event.end?.date?new Date(`${event.end.date}T00:00:00`):null
  return start&&end&&Number.isFinite(start.getTime())&&Number.isFinite(end.getTime())?{start:start.getTime(),end:end.getTime()}:null
}
async function suggestCalendarTimes(durationValue){
  const duration=[15,30,60].includes(Number(durationValue))?Number(durationValue):30,calendars=await selectedCalendars(),rangeStart=new Date(),rangeEnd=new Date();rangeEnd.setDate(rangeEnd.getDate()+9);rangeEnd.setHours(18,0,0,0)
  const params=new URLSearchParams({timeMin:rangeStart.toISOString(),timeMax:rangeEnd.toISOString(),singleEvents:'true',orderBy:'startTime',maxResults:'500'})
  const batches=await Promise.all(calendars.map(async calendar=>(await calendarApi(`/calendars/${encodeURIComponent(calendar.id)}/events?${params}`)).items||[])),busy=batches.flat().map(eventBusyRange).filter(Boolean),slots=[]
  for(let offset=0;offset<9&&slots.length<8;offset++){const day=new Date();day.setDate(day.getDate()+offset);day.setHours(0,0,0,0);if(day.getDay()===0||day.getDay()===6)continue;const workStart=new Date(day);workStart.setHours(8,0,0,0);const workEnd=new Date(day);workEnd.setHours(18,0,0,0);let candidate=Math.max(workStart.getTime(),Date.now()+5*60*1000);candidate=Math.ceil(candidate/(15*60*1000))*(15*60*1000);for(;candidate+duration*60*1000<=workEnd.getTime()&&slots.length<8;candidate+=15*60*1000){const finish=candidate+duration*60*1000;if(!busy.some(item=>candidate<item.end&&finish>item.start))slots.push({start:new Date(candidate).toISOString(),end:new Date(finish).toISOString()})}}
  return slots
}
function decode(data=''){ return Buffer.from(data.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8') }
function textPart(payload) {
  if (payload.mimeType==='text/plain'&&payload.body?.data) return decode(payload.body.data)
  for (const p of payload.parts||[]) { const value=textPart(p); if(value) return value }
  if (payload.body?.data) return decode(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
  return ''
}
function htmlPart(payload) {
  if (payload.mimeType === 'text/html' && payload.body?.data) return decode(payload.body.data)
  for (const p of payload.parts || []) { const value = htmlPart(p); if (value) return value }
  return ''
}
function safeEmailHtml(raw, inlineImages={}, allowRemoteImages=false) {
  if (!raw) return ''
  for (const [cid,dataUrl] of Object.entries(inlineImages)) raw=raw.split(`cid:${cid}`).join(dataUrl)
  const clean = sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','table','tbody','thead','tfoot','tr','td','th','center','picture','source']),
    allowedAttributes: { '*':['class','id','style','title','width','height','align','valign','bgcolor','role','aria-label'], a:['href','name','target','rel'], img:['src','srcset','alt','width','height','style'], source:['srcset','media','type'], table:['cellpadding','cellspacing','border','width','style'] },
    allowedSchemes: ['http','https','mailto','cid','data'],
    transformTags: { a: sanitizeHtml.simpleTransform('a',{target:'_blank',rel:'noreferrer noopener'}) },
    exclusiveFilter: frame => !allowRemoteImages && frame.tag === 'img' && /^(https?:)?\/\//i.test(String(frame.attribs?.src || '')),
    disallowedTagsMode: 'discard'
  })
  const remotePolicy = allowRemoteImages ? 'https: http:' : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${remotePolicy} data: cid:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; media-src 'none'; object-src 'none';"><base target="_blank"><style>html{color-scheme:dark;background:#070709}body{margin:0;background:#070709;color:#dcdce2;font:14px/1.55 Arial,sans-serif;overflow-wrap:anywhere}.sf-dark-email{min-height:calc(100vh - 48px);padding:24px;background:#fff;color:#202124;filter:invert(1) hue-rotate(180deg) brightness(.9)}.sf-dark-email img,.sf-dark-email picture,.sf-dark-email video,.sf-dark-email svg{filter:invert(1) hue-rotate(180deg) brightness(1.111)}img{max-width:100%;height:auto}table{max-width:100%}a{color:#7b43c3}</style></head><body><div class="sf-dark-email">${clean}</div></body></html>`
}
function header(headers,name){ return headers?.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value||'' }
function flattenParts(payload,result=[]){ result.push(payload);for(const part of payload.parts||[])flattenParts(part,result);return result }
function contentId(part){return header(part.headers,'Content-ID').replace(/^<|>$/g,'')}
function senderParts(from){ const match=from.match(/^(.*?)\s*<([^>]+)>$/); return {sender:(match?.[1]||from.split('@')[0]).replace(/^"|"$/g,''),email:match?.[2]||from} }
async function parseMessage(m, allowRemoteImages=false) {
  const h=m.payload.headers, from=senderParts(header(h,'From')), date=new Date(Number(m.internalDate)), body=textPart(m.payload), parts=flattenParts(m.payload), inlineImages={}
  for(const part of parts.filter(p=>contentId(p)&&p.mimeType?.startsWith('image/')&&(p.body?.attachmentId||p.body?.data))){const cid=contentId(part);const encoded=part.body.data||(await api(`/messages/${m.id}/attachments/${part.body.attachmentId}`)).data;inlineImages[cid]=`data:${part.mimeType};base64,${encoded.replace(/-/g,'+').replace(/_/g,'/')}`}
  const attachments=parts.filter(p=>p.filename&&p.body?.attachmentId&&!contentId(p)).map(p=>({id:p.body.attachmentId,filename:p.filename,mimeType:p.mimeType,size:p.body.size||0}))
  const rawHtml=htmlPart(m.payload)
  const remoteImagesBlocked=!allowRemoteImages&&/(?:src|srcset)\s*=\s*["']?https?:\/\//i.test(rawHtml)
  const bodyHtml=safeEmailHtml(rawHtml,inlineImages,allowRemoteImages)
  return {id:m.id,threadId:m.threadId,messageIdHeader:header(h,'Message-ID'),...from,initials:from.sender.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(),color:'#694884',subject:header(h,'Subject')||'(No subject)',preview:m.snippet,body:body||m.snippet,bodyHtml,remoteImagesBlocked,attachments,labelIds:m.labelIds||[],receivedAt:Number(m.internalDate),time:date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),date:date.toLocaleDateString([],{month:'short',day:'numeric'}),unread:m.labelIds?.includes('UNREAD'),starred:m.labelIds?.includes('STARRED'),label:'Primary',tags:[]}
}
async function getMessage(id, allowRemoteImages=false) {
  return parseMessage(await api(`/messages/${encodeURIComponent(id)}?format=full`), allowRemoteImages)
}
function readSnoozes(){try{return JSON.parse(fs.readFileSync(snoozePath(),'utf8')).filter(item=>item?.id&&Number.isFinite(item.until))}catch{return[]}}
function writeSnoozes(items){fs.writeFileSync(snoozePath(),JSON.stringify(items,null,2),{mode:0o600})}
async function processSnoozes(){if(!tokens)return;const account=(await profile()).emailAddress,items=readSnoozes(),pending=[];for(const item of items){if(item.account&&item.account!==account||item.until>Date.now()){pending.push(item);continue}try{await modify(item.id,['INBOX'],[])}catch{pending.push(item)}}if(pending.length!==items.length)writeSnoozes(pending)}
async function listSnoozed(allowRemoteImages=false){await processSnoozes();const account=(await profile()).emailAddress,items=[];for(const entry of readSnoozes().filter(item=>(!item.account||item.account===account)&&item.until>Date.now()).sort((a,b)=>a.until-b.until)){try{items.push({...await getMessage(entry.id,allowRemoteImages),snoozedUntil:entry.until})}catch{}}return items}
async function snooze(id,until){const due=Number(until);if(!id||!Number.isFinite(due)||due<=Date.now())throw new Error('Choose a future snooze time.');const account=(await profile()).emailAddress;await modify(id,[],['INBOX']);const items=readSnoozes().filter(item=>item.id!==id);items.push({id,until:due,account});writeSnoozes(items);return true}
async function unsnooze(id){await modify(id,['INBOX'],[]);writeSnoozes(readSnoozes().filter(item=>item.id!==id));return true}
async function listMessages(query='in:inbox', allowRemoteImages=false) {
  if(query==='snoozed:local')return listSnoozed(allowRemoteImages)
  const labelId=query.startsWith('labelId:')?query.slice(8):''
  const labelIds=query.startsWith('labelIds:')?[...new Set(query.slice(9).split(',').map(id=>id.trim()).filter(Boolean))]:[]
  let refs=[]
  if(query==='in:drafts'){const list=await api('/drafts?maxResults=100');refs=(list.drafts||[]).map(d=>d.message)}
  else if(labelIds.length){const lists=await Promise.all(labelIds.map(id=>api(`/messages?maxResults=100&labelIds=${encodeURIComponent(id)}`))),seen=new Set();for(const list of lists)for(const ref of list.messages||[])if(!seen.has(ref.id)){seen.add(ref.id);refs.push(ref)}}
  else {const list=labelId?await api(`/messages?maxResults=100&labelIds=${encodeURIComponent(labelId)}`):await api(`/messages?maxResults=100&q=${encodeURIComponent(query)}`);refs=list.messages||[]}
  const items=[]
  for(let i=0;i<refs.length;i+=5) {
    const batch=await Promise.all(refs.slice(i,i+5).map(({id})=>getMessage(id,allowRemoteImages)))
    items.push(...batch)
  }
  return items.sort((a,b)=>b.receivedAt-a.receivedAt)
}
async function modify(id, addLabelIds=[], removeLabelIds=[]){ return api(`/messages/${id}/modify`,{method:'POST',body:JSON.stringify({addLabelIds,removeLabelIds})}) }
async function trash(id){ return api(`/messages/${id}/trash`,{method:'POST'}) }
async function untrash(id){ return api(`/messages/${id}/untrash`,{method:'POST'}) }
async function attachment(messageId,attachmentId){return api(`/messages/${messageId}/attachments/${attachmentId}`)}
function cleanHeader(value=''){return String(value).replace(/[\r\n]+/g,' ').trim()}
function encodeFilename(value='attachment'){return cleanHeader(value).replace(/["\\]/g,'_')}
async function send({to,subject,body,threadId,inReplyTo,attachments=[]}) {
  if(!cleanHeader(to)||!String(body||'').trim())throw new Error('Add a recipient and message.')
  if(attachments.reduce((total,file)=>total+Number(file.size||0),0)>24*1024*1024)throw new Error('Gmail attachments must total less than 24 MB.')
  const lines=[`To: ${cleanHeader(to)}`,`Subject: ${cleanHeader(subject)}`,'MIME-Version: 1.0']
  if(inReplyTo){lines.push(`In-Reply-To: ${inReplyTo}`,`References: ${inReplyTo}`)}
  let content
  if(attachments.length){
    const boundary=`snowfire_${crypto.randomBytes(18).toString('hex')}`
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    const parts=[`--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`]
    for(const file of attachments){const filename=encodeFilename(file.filename);parts.push(`--${boundary}\r\nContent-Type: ${cleanHeader(file.mimeType)||'application/octet-stream'}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${String(file.data||'').replace(/\s/g,'').match(/.{1,76}/g)?.join('\r\n')||''}`)}
    parts.push(`--${boundary}--`)
    content=`${lines.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    content=`${lines.join('\r\n')}\r\n\r\n${body}`
  }
  const raw=b64url(content)
  return api('/messages/send',{method:'POST',body:JSON.stringify({raw,...(threadId?{threadId}:{})})})
}
function disconnect(){ keyringClear();try{fs.unlinkSync(storePath())}catch{} credentials=null;tokens=null;return true }
function needsScopeUpgrade(){const scopes=String(tokens?.scope||'').split(/\s+/);return Boolean(tokens&&((!scopes.includes(GMAIL_SCOPE)&&!scopes.includes(LEGACY_FULL_SCOPE))||!scopes.includes(CONTACTS_SCOPE)||!scopes.includes(CALENDAR_EVENTS_SCOPE)||!scopes.includes(CALENDAR_LIST_SCOPE)))}
load()
module.exports={connect,profile,counts,labels,createLabel,updateLabel,deleteLabel,listContacts,createContact,updateContact,listCalendarEvents,listTodayEvents,createCalendarEvent,updateCalendarEvent,deleteCalendarEvent,suggestCalendarTimes,listMessages,getMessage,modify,trash,untrash,snooze,unsnooze,processSnoozes,attachment,send,disconnect,needsScopeUpgrade,secureStorageAvailable,credentialStorage,status:()=>Boolean(tokens)}
