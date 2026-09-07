import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Archive, ArrowLeft, BriefcaseBusiness, Building2, CalendarDays, Check, ChevronDown, Clock3, Download, Eye, FileArchive, FileImage, FileSpreadsheet, FileText, Flame, Folder, FolderInput, GripVertical, House, ImagePlus, Inbox, LogOut, Mail, Menu, Minus, Newspaper, Paperclip, PenLine, Phone, Plus, RefreshCw, Reply, Search, Send, Settings, ShieldCheck, Square, Star, Tag, Trash2, UserPlus, UsersRound, X, type LucideIcon } from 'lucide-react'
import { CalendarWorkspace, EVENT_COLOR_OPTIONS, type CalendarEvent } from './CalendarWorkspace'

type Attachment = {id:string;filename:string;mimeType:string;size:number}
type OutgoingAttachment = {filename:string;mimeType:string;size:number;data:string}
type OutgoingMessage = {to:string;subject:string;body:string;attachments:OutgoingAttachment[];threadId?:string;inReplyTo?:string}
type QueuedSend = {id:string;sendAt:number;message:OutgoingMessage}
type SendStatus = {id:string;status:'sent'|'failed';error?:string;message?:OutgoingMessage}
type GmailLabel = {id:string;name:string;messagesTotal?:number;messagesUnread?:number;color?:{backgroundColor?:string;textColor?:string}}
type Message = { id:string; threadId?:string; messageIdHeader?:string; sender:string; email:string; initials:string; color:string; subject:string; preview:string; body:string; bodyHtml?:string; remoteImagesBlocked?:boolean; attachments?:Attachment[]; labelIds?:string[]; receivedAt?:number; time:string; date:string; unread?:boolean; starred?:boolean; label:string; tags?:string[] }
type MessageMeta = {label:string;detail?:string;tone:'family'|'customer'|'internal'|'newsletter'|'network'|'general';color:string;icon:LucideIcon;iconSrc?:string}
type GoogleContact = {resourceName:string;name:string;givenName:string;familyName:string;email:string;emails:string[];phone:string;phones:string[];company:string;title:string;initials:string}
type ContactDraft = {givenName:string;familyName:string;emails:string[];phone:string;company:string;title:string}
type SenderLabels = Record<string,string[]>
type SenderFolderRules = Record<string,string>
type CalendarSlot = {start:string;end:string}

const CONTACT_ICONS_KEY='snowfire-contact-icons'
const COLLAPSED_FOLDERS_KEY='snowfire-collapsed-folders'
const CONTACT_ICON_OPTIONS=['👤','⭐','🔥','💼','🛠️','🎨','💡','🚀','🤝','💬','📌','🌱']
const readContactIcons=():Record<string,string>=>{try{const stored=JSON.parse(localStorage.getItem(CONTACT_ICONS_KEY)||'{}');return stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{}}catch{return {}}}
const readCollapsedFolders=():Set<string>=>{try{const stored=JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY)||'[]');return new Set(Array.isArray(stored)?stored.filter((name):name is string=>typeof name==='string'):[])}catch{return new Set()}}
const contactIcon=(contact:GoogleContact)=>readContactIcons()[contact.resourceName]||''
const saveContactIcon=(resourceName:string,icon:string)=>{try{const icons=readContactIcons();if(icon)icons[resourceName]=icon;else delete icons[resourceName];localStorage.setItem(CONTACT_ICONS_KEY,JSON.stringify(icons))}catch{}}

const formatBytes = (bytes:number) => bytes < 1048576 ? `${Math.max(1,Math.ceil(bytes/1024))} KB` : `${(bytes/1048576).toFixed(1)} MB`
const emailDomain = (email:string) => email.toLowerCase().split('@')[1] || ''
const normalizeSenderEmail = (email:string) => email.trim().toLowerCase()
const iconForAttachment = (file:Attachment) => file.mimeType.startsWith('image/') ? FileImage : /spreadsheet|excel|csv/i.test(file.mimeType + file.filename) ? FileSpreadsheet : /zip|archive|compressed/i.test(file.mimeType + file.filename) ? FileArchive : FileText
const newOutgoingMessage=():OutgoingMessage=>({to:'',subject:'',body:'',attachments:[]})
const newContactDraft=():ContactDraft=>({givenName:'',familyName:'',emails:[''],phone:'',company:'',title:''})
const contactDraftForMessage=(message:Message):ContactDraft=>{const name=message.sender.replace(/^"|"$/g,'').trim(),parts=name.includes('@')?[]:name.split(/\s+/);return {givenName:parts[0]||'',familyName:parts.slice(1).join(' '),emails:[message.email],phone:'',company:'',title:''}}
const cleanContactError=(error:unknown)=>{const message=error instanceof Error?error.message:'Could not reach Google Contacts';return message.replace(/^Error invoking remote method '[^']+': Error:\s*/,'')}

const labelParts = (name:string) => name.split('/').map(part=>part.trim()).filter(Boolean)
const labelDepth = (name:string) => labelParts(name).length-1
const labelLeaf = (name:string) => labelParts(name).at(-1)||name
const labelRoot = (name:string) => labelParts(name)[0]||name
const labelIconFor = (name:string,icons:Record<string,string>) => {const parts=labelParts(name);for(let depth=parts.length;depth>0;depth--){const icon=icons[parts.slice(0,depth).join('/')];if(icon)return icon}return undefined}
const FOLDER_ROOT = 'Folders'
const isFolderLabel = (name:string) => labelRoot(name).toLowerCase()===FOLDER_ROOT.toLowerCase()
const folderParts = (name:string) => labelParts(name).slice(1)
const folderName = (name:string) => folderParts(name).at(-1)||name
const folderDepth = (name:string) => Math.max(0,folderParts(name).length-1)
const folderParent = (name:string) => labelParts(name).slice(0,-1).join('/')||FOLDER_ROOT
const folderContains = (parent:string,child:string) => child===parent||child.startsWith(`${parent}/`)
const orderFolderTree = (labels:GmailLabel[],order:string[]) => {
  const rank=new Map(order.map((name,index)=>[name,index])),groups=new Map<string,GmailLabel[]>()
  for(const label of labels){const parent=folderParent(label.name),siblings=groups.get(parent)||[];siblings.push(label);groups.set(parent,siblings)}
  const sort=(items:GmailLabel[])=>items.sort((a,b)=>(rank.get(a.name)??Number.MAX_SAFE_INTEGER)-(rank.get(b.name)??Number.MAX_SAFE_INTEGER)||a.name.localeCompare(b.name,undefined,{sensitivity:'base'}))
  const result:GmailLabel[]=[],seen=new Set<string>()
  const visit=(parent:string)=>{for(const label of sort(groups.get(parent)||[])){if(seen.has(label.id))continue;seen.add(label.id);result.push(label);visit(label.name)}}
  visit(FOLDER_ROOT)
  for(const label of sort([...labels]))if(!seen.has(label.id))result.push(label)
  return result
}

function messageMeta(message:Message, labels:GmailLabel[], labelIcons:Record<string,string>, senderLabels:SenderLabels={}):MessageMeta {
  const masterPriority=['customer','family','internal','newsletter','newsletters']
  const contactLabels=senderLabels[normalizeSenderEmail(message.email)]||[]
  const assignedLabels=labels.filter(label=>!isFolderLabel(label.name)&&(message.labelIds?.includes(label.id)||contactLabels.some(name=>name.toLowerCase()===label.name.toLowerCase())))
  const masterLabels=assignedLabels.filter(label=>masterPriority.includes(labelRoot(label.name).toLowerCase()))
  const candidates=masterLabels.length?masterLabels:assignedLabels
  const deepest=[...candidates].sort((a,b)=>labelDepth(b.name)-labelDepth(a.name)||masterPriority.indexOf(labelRoot(a.name).toLowerCase())-masterPriority.indexOf(labelRoot(b.name).toLowerCase())||a.name.localeCompare(b.name))[0]
  const root=deepest?labelRoot(deepest.name):''
  const leaf=deepest?labelLeaf(deepest.name):''
  const rootLower=root.toLowerCase()
  const customIcon=deepest?labelIconFor(deepest.name,labelIcons):undefined
  const domain=emailDomain(message.email)
  const gmailColor=deepest?.color?.backgroundColor
  if(rootLower==='customer')return {label:leaf===root?'Customer':`Customer · ${leaf}`,tone:'customer',color:gmailColor||'#38bdf8',icon:BriefcaseBusiness,iconSrc:customIcon}
  if(rootLower==='family')return {label:'Family',detail:'Personal',tone:'family',color:gmailColor||'#fb5f82',icon:House,iconSrc:customIcon}
  if(rootLower==='internal')return {label:'Internal',detail:'SnowFire',tone:'internal',color:gmailColor||'#a979f8',icon:UsersRound,iconSrc:customIcon||labelIconFor('Internal',labelIcons)||'./brand/snowfire_icon.svg'}
  if(rootLower==='newsletter'||rootLower==='newsletters')return {label:'Newsletter',tone:'newsletter',color:gmailColor||'#f5b53f',icon:Newspaper,iconSrc:customIcon}
  if(deepest)return {label:leaf===root?root:`${root} · ${leaf}`,tone:'general',color:gmailColor||'#70707d',icon:Tag,iconSrc:customIcon}
  const family=message.sender.toLowerCase()==='scott ryan'||message.tags?.some(tag=>/personal|family/i.test(tag))
  const internal=domain==='snowfire.ai'||domain.endsWith('.snowfire.ai')||message.sender.toLowerCase().startsWith('snowfire')
  const newsletter=/newsletter/i.test(`${message.label} ${message.tags?.join(' ')||''}`)
  if(family)return {label:'Family',detail:'Personal',tone:'family',color:'#fb5f82',icon:House,iconSrc:labelIconFor('Family',labelIcons)}
  if(internal)return {label:'Internal',detail:'SnowFire',tone:'internal',color:'#a979f8',icon:UsersRound,iconSrc:labelIconFor('Internal',labelIcons)||'./brand/snowfire_icon.svg'}
  if(newsletter)return {label:'Newsletter',tone:'newsletter',color:'#f5b53f',icon:Newspaper,iconSrc:labelIconFor('Newsletter',labelIcons)||labelIconFor('Newsletters',labelIcons)}
  if(message.tags?.some(tag=>/network/i.test(tag)))return {label:'Network',tone:'network',color:'#4fd1c5',icon:UsersRound}
  return {label:'General',tone:'general',color:'#70707d',icon:Mail}
}

function MetaIcon({meta,size=14}:{meta:MessageMeta;size?:number}) {
  const [failed,setFailed]=useState(false)
  useEffect(()=>setFailed(false),[meta.iconSrc])
  const Icon=meta.icon
  if(meta.iconSrc&&!failed)return <img className="meta-icon-image" src={meta.iconSrc} alt="" width={size} height={size} onError={()=>setFailed(true)}/>
  return <Icon size={size}/>
}

function LabelGlyph({name,icons,size=14}:{name:string;icons:Record<string,string>;size?:number}) {
  const root=labelRoot(name).toLowerCase()
  const iconSrc=labelIconFor(name,icons)||(root==='internal'?'./brand/snowfire_icon.svg':undefined)
  const icon=root==='customer'?BriefcaseBusiness:root==='family'?House:root==='internal'?UsersRound:/^newsletters?$/.test(root)?Newspaper:Tag
  return <MetaIcon meta={{label:name,tone:root==='customer'?'customer':root==='family'?'family':root==='internal'?'internal':/^newsletters?$/.test(root)?'newsletter':'general',color:'#777784',icon,iconSrc}} size={size}/>
}

function FolderSearchPicker({folders,value,onChange,onCreate}:{folders:GmailLabel[];value:string;onChange:(value:string)=>void;onCreate:(path:string)=>Promise<string>}) {
  const listboxId=useId()
  const inputRef=useRef<HTMLInputElement>(null)
  const activeOptionRef=useRef<HTMLButtonElement>(null)
  const [open,setOpen]=useState(false)
  const [query,setQuery]=useState('')
  const [activeIndex,setActiveIndex]=useState(0)
  const [creating,setCreating]=useState(false)
  const [createError,setCreateError]=useState('')
  const selected=folders.find(folder=>folder.name===value)
  const selectedPath=selected?folderParts(selected.name).join(' / '):''
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches=terms.length?folders.filter(folder=>{const path=folderParts(folder.name).join(' / ').toLocaleLowerCase();return terms.every(term=>path.includes(term))}):[]
  const createPath=labelParts(query).join(' / ')
  const canCreate=Boolean(createPath)&&!folders.some(folder=>folderParts(folder.name).join(' / ').toLocaleLowerCase()===createPath.toLocaleLowerCase())
  const optionCount=matches.length+(canCreate?1:0)
  const safeActiveIndex=Math.min(activeIndex,Math.max(0,optionCount-1))
  const activeOptionId=open&&optionCount?(safeActiveIndex<matches.length?`${listboxId}-${matches[safeActiveIndex].id}`:`${listboxId}-create`):undefined
  useEffect(()=>{if(open)activeOptionRef.current?.scrollIntoView({block:'nearest'})},[activeIndex,open,query])
  const select=(folder:GmailLabel)=>{onChange(folder.name);setQuery('');setOpen(false);inputRef.current?.focus()}
  const create=async()=>{if(!canCreate||creating)return;setCreating(true);setCreateError('');try{const name=await onCreate(createPath);onChange(name);setQuery('');setOpen(false);inputRef.current?.focus()}catch(error){setCreateError(error instanceof Error?error.message:'Could not create the folder')}finally{setCreating(false)}}
  const openPicker=()=>{setQuery('');setCreateError('');setActiveIndex(0);setOpen(true)}
  return <div className={`folder-search-picker${open?' open':''}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false)}}>
    <Search size={13}/>
    <input ref={inputRef} type="text" role="combobox" aria-label="Destination folder" aria-expanded={open} aria-controls={listboxId} aria-autocomplete="list" aria-activedescendant={activeOptionId} aria-busy={creating} autoComplete="off" placeholder="Search or create folder…" value={open?query:selectedPath} readOnly={creating} onFocus={openPicker} onChange={event=>{setQuery(event.target.value);setCreateError('');onChange('');setActiveIndex(0);setOpen(true)}} onKeyDown={event=>{if(event.key==='ArrowDown'&&optionCount){event.preventDefault();setOpen(true);setActiveIndex(index=>Math.min(optionCount-1,index+1))}else if(event.key==='ArrowUp'&&optionCount){event.preventDefault();setOpen(true);setActiveIndex(index=>Math.max(0,index-1))}else if(event.key==='Enter'&&open&&optionCount){event.preventDefault();if(safeActiveIndex<matches.length)select(matches[safeActiveIndex]);else void create()}else if(event.key==='Escape'&&open&&!creating){event.preventDefault();setOpen(false)}}}/>
    <ChevronDown size={13}/>
    {open&&<div className="folder-search-results" id={listboxId} role="listbox" aria-label="Matching folders">
      {!terms.length&&<p>Type to search folders or enter a new folder name.</p>}
      {terms.length&&!matches.length&&<p>No existing folders match “{query.trim()}”.</p>}
      {matches.map((folder,index)=>{const path=folderParts(folder.name).join(' / ');return <button ref={index===activeIndex?activeOptionRef:undefined} id={`${listboxId}-${folder.id}`} type="button" role="option" aria-selected={folder.name===value} className={index===activeIndex?'active':''} key={folder.id} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActiveIndex(index)} onClick={()=>select(folder)}><Folder size={13}/><span>{path}</span>{folder.name===value&&<Check size={13}/>}</button>})}
      {canCreate&&<button ref={activeIndex===matches.length?activeOptionRef:undefined} id={`${listboxId}-create`} type="button" role="option" aria-selected={false} className={`folder-search-create${activeIndex===matches.length?' active':''}`} disabled={creating} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActiveIndex(matches.length)} onClick={()=>void create()}><Plus size={14}/><span><b>{creating?'Creating folder…':`Create “${createPath}”`}</b><small>{createPath.includes(' / ')?'New nested folder':'New top-level folder'} · use / for subfolders</small></span></button>}
      {createError&&<div className="folder-search-error">{createError}</div>}
    </div>}
  </div>
}

function FolderDashboard({folders,allFolders,messagesByFolder,loading,error,folderNameInput,parent,busy,createError,onRefresh,onOpenFolder,onOpenMessage,onStartCreate,onNameChange,onParentChange,onCreate}:{folders:GmailLabel[];allFolders:GmailLabel[];messagesByFolder:Record<string,Message[]>;loading:boolean;error:string;folderNameInput:string;parent:string;busy:boolean;createError:string;onRefresh:()=>void;onOpenFolder:(folder:GmailLabel)=>void;onOpenMessage:(folder:GmailLabel,message:Message)=>void;onStartCreate:(parent:string)=>void;onNameChange:(value:string)=>void;onParentChange:(value:string)=>void;onCreate:(event:FormEvent)=>void}) {
  return <section className="folder-dashboard">
    <header><div><span>MAIL / ORGANIZATION</span><h1>Folders</h1><p>Latest activity and folder management in one place.</p></div><div><button className={loading?'spinning':''} disabled={loading} onClick={onRefresh}><RefreshCw size={16}/> Refresh</button><button className="folder-dashboard-manage" onClick={()=>onStartCreate('')}><Plus size={16}/> New folder</button></div></header>
    <form className="folder-dashboard-create" onSubmit={onCreate}><select aria-label="Parent folder" value={parent} onChange={event=>onParentChange(event.target.value)}><option value="">Top level</option>{allFolders.map(folder=><option key={folder.id} value={folder.name}>Under {folderParts(folder.name).join(' / ')}</option>)}</select><input value={folderNameInput} maxLength={180} onChange={event=>onNameChange(event.target.value)} placeholder={parent?'New subfolder name':'New top-level folder'}/><button disabled={busy||!folderNameInput.trim()}><Plus size={15}/>{busy?'Creating…':'Create folder'}</button></form>
    {createError&&<div className="folder-dashboard-error folder-create-error">{createError}</div>}{error&&<div className="folder-dashboard-error">{error}</div>}
    <div className="folder-dashboard-grid">{folders.map(folder=>{const recent=messagesByFolder[folder.id]||[],total=folderMessageCountForDashboard(folder,allFolders),unread=folderUnreadCountForDashboard(folder,allFolders);return <article className="folder-dashboard-column" key={folder.id}><header><button onClick={()=>onOpenFolder(folder)}><span><Folder size={17}/></span><div><h2>{folderName(folder.name)}</h2><p>{total} email{total===1?'':'s'} · {unread} unread</p></div><ChevronDown size={15}/></button></header><div className="folder-dashboard-messages">{loading&&!recent.length?Array.from({length:4},(_,index)=><div className="folder-dashboard-skeleton" key={index}><i/><span/><span/></div>):recent.length?recent.slice(0,5).map(message=><button className={message.unread?'folder-dashboard-message unread':'folder-dashboard-message'} key={message.id} onClick={()=>onOpenMessage(folder,message)}><div><span>{message.sender}</span><time>{message.time}</time></div><strong>{message.subject}</strong><p>{message.preview}</p></button>):<div className="folder-dashboard-empty"><Mail size={18}/><span>No recent email</span></div>}</div><footer><button onClick={()=>onOpenFolder(folder)}>Open {folderName(folder.name)}<ChevronDown size={14}/></button><button className="folder-column-add" title={`Add subfolder under ${folderName(folder.name)}`} onClick={()=>onStartCreate(folder.name)}><Plus size={14}/></button></footer></article>})}{!folders.length&&!loading&&<div className="folder-dashboard-no-folders"><Folder size={24}/><h2>No folders yet</h2><p>Create a top-level folder to add its activity column here.</p><button onClick={()=>onStartCreate('')}><Plus size={15}/> Create folder</button></div>}</div>
  </section>
}

const folderMessageCountForDashboard=(folder:GmailLabel,folders:GmailLabel[])=>folders.filter(label=>folderContains(folder.name,label.name)).reduce((total,label)=>total+(label.messagesTotal||0),0)
const folderUnreadCountForDashboard=(folder:GmailLabel,folders:GmailLabel[])=>folders.filter(label=>folderContains(folder.name,label.name)).reduce((total,label)=>total+(label.messagesUnread||0),0)

function TodayAgenda({events,loading,error,emailDragging,onRefresh,onCreate,onCreateRange,onEdit,onOpen,onEmailDrop,onEventMove}:{events:CalendarEvent[];loading:boolean;error:string;emailDragging:boolean;onRefresh:()=>void;onCreate:()=>void;onCreateRange:(start:Date,end:Date)=>void;onEdit:(event:CalendarEvent)=>void;onOpen:()=>void;onEmailDrop:(messageId:string,start:Date)=>void;onEventMove:(event:CalendarEvent,start:Date)=>void}) {
  const [dropTime,setDropTime]=useState<Date|null>(null)
  const [createSelection,setCreateSelection]=useState<{start:Date;end:Date}|null>(null)
  const createSelectionRef=useRef<{anchor:Date;current:Date;initialY:number;moved:boolean}|null>(null)
  const date=new Date().toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})
  const project=error.match(/project(?:\s+|=)(\d+)/i)?.[1]
  const start=new Date();start.setHours(8,0,0,0);const end=new Date(start);end.setHours(17,0,0,0)
  const timed=events.filter(event=>!event.allDay&&new Date(event.start)<end&&new Date(event.end)>start)
  const allDay=events.filter(event=>event.allDay)
  const open=(event:CalendarEvent)=>event.editable?onEdit(event):event.htmlLink&&window.snowfire?.openExternal(event.htmlLink)
  const position=(event:CalendarEvent)=>{const eventStart=Math.max(start.getTime(),new Date(event.start).getTime()),eventEnd=Math.min(end.getTime(),new Date(event.end).getTime()),top=((eventStart-start.getTime())/(end.getTime()-start.getTime()))*94;return {top:`${3+top}%`,height:`${Math.max(5,((eventEnd-eventStart)/(end.getTime()-start.getTime()))*94)}%`}}
  const canDrop=(types:readonly string[])=>types.includes('application/x-snowfire-email-id')||types.includes('application/x-snowfire-calendar-event')
  const timeAt=(clientY:number,bounds:DOMRect)=>{const ratio=Math.max(0,Math.min(1,(clientY-bounds.top)/bounds.height)),minutes=Math.round((8*60+ratio*9*60)/15)*15,next=new Date(start);next.setHours(Math.floor(minutes/60),minutes%60,0,0);return next}
  const dropPosition=dropTime?3+((dropTime.getTime()-start.getTime())/(end.getTime()-start.getTime()))*94:0
  const createTimeAt=(clientY:number,bounds:DOMRect)=>{const value=timeAt(clientY,bounds),latest=new Date(end.getTime()-15*60_000);return value>latest?latest:value}
  const selectionRange=(anchor:Date,current:Date)=>{const rangeStart=new Date(Math.min(anchor.getTime(),current.getTime())),rangeEnd=new Date(Math.min(end.getTime(),Math.max(anchor.getTime(),current.getTime())+15*60_000));return {start:rangeStart,end:rangeEnd}}
  return <section className="today-agenda"><header><button className="agenda-open" onClick={onOpen}><CalendarDays size={14}/><span><b>Today</b><small>{date}</small></span></button><button aria-label="Create calendar event" title="New event" onClick={onCreate}><Plus size={13}/></button><button className={loading?'spinning':''} aria-label="Refresh today’s calendar" title="Refresh calendar" onClick={onRefresh}><RefreshCw size={13}/></button></header>{error?<div className="agenda-error"><span>Calendar unavailable</span>{/calendar api|disabled|accessNotConfigured/i.test(error)&&<button onClick={()=>window.snowfire?.openExternal(`https://console.cloud.google.com/apis/library/calendar-json.googleapis.com${project?`?project=${project}`:''}`)}>Enable Calendar API</button>}<button onClick={onRefresh}>Try again</button></div>:<>{allDay.length>0&&<div className="agenda-all-day">{allDay.slice(0,2).map(event=><button key={event.id} onClick={()=>open(event)}><i style={{background:event.color}}/>{event.summary}</button>)}</div>}<div className={`agenda-workday${dropTime?' accepting-drop':''}${emailDragging?' ready-drop':''}${createSelection?' creating-event':''}`} onPointerDown={event=>{if(event.button!==0||(event.target instanceof Element&&event.target.closest('button')))return;event.preventDefault();const anchor=createTimeAt(event.clientY,event.currentTarget.getBoundingClientRect());createSelectionRef.current={anchor,current:anchor,initialY:event.clientY,moved:false};setCreateSelection(selectionRange(anchor,anchor));event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{const draft=createSelectionRef.current;if(!draft||!event.currentTarget.hasPointerCapture(event.pointerId))return;const current=createTimeAt(event.clientY,event.currentTarget.getBoundingClientRect());draft.current=current;if(Math.abs(event.clientY-draft.initialY)>4)draft.moved=true;setCreateSelection(selectionRange(draft.anchor,current))}} onPointerUp={event=>{const draft=createSelectionRef.current;if(!draft)return;const range=selectionRange(draft.anchor,createTimeAt(event.clientY,event.currentTarget.getBoundingClientRect())),moved=draft.moved;createSelectionRef.current=null;setCreateSelection(null);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(moved)onCreateRange(range.start,range.end)}} onPointerCancel={()=>{createSelectionRef.current=null;setCreateSelection(null)}} onDragEnter={event=>{if(!canDrop(event.dataTransfer.types))return;event.preventDefault();event.dataTransfer.dropEffect='move';setDropTime(timeAt(event.clientY,event.currentTarget.getBoundingClientRect()))}} onDragOver={event=>{if(!canDrop(event.dataTransfer.types))return;event.preventDefault();event.dataTransfer.dropEffect='move';setDropTime(timeAt(event.clientY,event.currentTarget.getBoundingClientRect()))}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDropTime(null)}} onDrop={event=>{if(!canDrop(event.dataTransfer.types))return;event.preventDefault();const target=timeAt(event.clientY,event.currentTarget.getBoundingClientRect()),messageId=event.dataTransfer.getData('application/x-snowfire-email-id'),calendarEventId=event.dataTransfer.getData('application/x-snowfire-calendar-event');setDropTime(null);if(messageId)onEmailDrop(messageId,target);else{const calendarEvent=events.find(item=>item.id===calendarEventId);if(calendarEvent)onEventMove(calendarEvent,target)}}}>{Array.from({length:10},(_,index)=>{const hour=8+index;return <div className={`agenda-hour${hour===17?' end':''}`} style={{top:`${3+(index/9)*94}%`}} key={hour}><time>{new Date(2000,0,1,hour).toLocaleTimeString([],{hour:'numeric'})}</time><i/></div>})}{timed.map(event=><button draggable={event.editable} className={!event.allDay&&new Date(event.end).getTime()<Date.now()?'agenda-mini-event past':'agenda-mini-event'} style={{...position(event),borderColor:event.color}} key={event.id} title={event.editable?`${event.summary} · drag to reschedule`:`${event.summary} · ${event.calendar}`} onDragStart={drag=>{drag.stopPropagation();drag.dataTransfer.effectAllowed='move';drag.dataTransfer.setData('application/x-snowfire-calendar-event',event.id)}} onDragEnd={()=>setDropTime(null)} onClick={()=>open(event)}><b>{event.summary}</b><small>{new Date(event.start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</small></button>)}{createSelection&&<div className="agenda-create-selection" style={{top:`${3+((createSelection.start.getTime()-start.getTime())/(end.getTime()-start.getTime()))*94}%`,height:`${((createSelection.end.getTime()-createSelection.start.getTime())/(end.getTime()-start.getTime()))*94}%`}}><b>New event</b><span>{createSelection.start.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} – {createSelection.end.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span></div>}{emailDragging&&!dropTime&&<div className="agenda-drop-help"><CalendarDays size={14}/><span>Drop email at a time</span></div>}{dropTime&&<div className="agenda-drop-indicator" style={{top:`${dropPosition}%`}}><time>{dropTime.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</time><i/></div>}{loading&&<div className="agenda-loading"><RefreshCw className="spin-icon" size={13}/></div>}</div></>}</section>
}

const localDate=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
const localTime=(date:Date)=>`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`

function CalendarEventEditor({event,seedDate,seedEndDate,seedMessage,onClose,onSaved,onDeleted}:{event?:CalendarEvent|null;seedDate?:Date|null;seedEndDate?:Date|null;seedMessage?:Message|null;onClose:()=>void;onSaved:()=>void;onDeleted:()=>void}) {
  const initial=useMemo(()=>{const base=event?.start?new Date(event.start):seedDate?new Date(seedDate):new Date(Math.ceil(Date.now()/(15*60*1000))*(15*60*1000)),finish=event?.end?new Date(event.end):seedEndDate?new Date(seedEndDate):new Date(base.getTime()+30*60*1000);return {summary:event?.summary||(seedMessage?`Handle: ${seedMessage.subject}`:''),date:event?.allDay?event.start.slice(0,10):localDate(base),start:event?.allDay?'09:00':localTime(base),end:event?.allDay?'09:30':localTime(finish),allDay:event?.allDay||false,location:event?.location||'',description:event?.description||(seedMessage?`Email from ${seedMessage.sender} <${seedMessage.email}>\n\n${seedMessage.preview}`:''),colorId:event?.colorId||''}},[event,seedDate,seedEndDate,seedMessage])
  const [draft,setDraft]=useState(initial),[saving,setSaving]=useState(false),[deleting,setDeleting]=useState(false),[confirmDelete,setConfirmDelete]=useState(false),[error,setError]=useState('')
  const save=async(submit:FormEvent)=>{submit.preventDefault();setSaving(true);setError('');try{let start:string,end:string;if(draft.allDay){start=draft.date;const next=new Date(`${draft.date}T12:00:00`);next.setDate(next.getDate()+1);end=localDate(next)}else{start=new Date(`${draft.date}T${draft.start}:00`).toISOString();end=new Date(`${draft.date}T${draft.end}:00`).toISOString()}const payload={summary:draft.summary,location:draft.location,description:draft.description,colorId:draft.colorId,start,end,allDay:draft.allDay,...(event?{calendarId:event.calendarId,eventId:event.eventId}:seedMessage?{sourceTitle:seedMessage.subject,sourceUrl:`https://mail.google.com/mail/u/0/#all/${seedMessage.threadId||seedMessage.id}`}:{})};if(event)await window.snowfire?.calendar.update(payload);else await window.snowfire?.calendar.create(payload);onSaved()}catch(e){setError(cleanContactError(e))}finally{setSaving(false)}}
  const remove=async()=>{if(!event)return;if(!confirmDelete){setConfirmDelete(true);return}setDeleting(true);setError('');try{await window.snowfire?.calendar.delete({calendarId:event.calendarId,eventId:event.eventId});onDeleted()}catch(e){setError(cleanContactError(e));setConfirmDelete(false)}finally{setDeleting(false)}}
  const busy=saving||deleting
  return <div className="calendar-modal-backdrop" onMouseDown={()=>!busy&&onClose()}><form className="calendar-editor" onSubmit={save} onMouseDown={click=>click.stopPropagation()}><header><div><span>GOOGLE CALENDAR</span><h2>{event?'Edit event':'New event'}</h2></div><button type="button" disabled={busy} aria-label="Close" onClick={onClose}><X size={18}/></button></header><label><span>Title</span><input autoFocus value={draft.summary} onChange={change=>setDraft(current=>({...current,summary:change.target.value}))} placeholder="Event title"/></label><div className="calendar-date-row"><label><span>Date</span><input type="date" value={draft.date} onChange={change=>setDraft(current=>({...current,date:change.target.value}))}/></label><label className="all-day-toggle"><input type="checkbox" checked={draft.allDay} onChange={change=>setDraft(current=>({...current,allDay:change.target.checked}))}/><span>All day</span></label></div>{!draft.allDay&&<div className="calendar-time-row"><label><span>Starts</span><input type="time" value={draft.start} onChange={change=>setDraft(current=>({...current,start:change.target.value}))}/></label><label><span>Ends</span><input type="time" value={draft.end} onChange={change=>setDraft(current=>({...current,end:change.target.value}))}/></label></div>}<fieldset className="calendar-color-picker"><legend>Event color</legend>{EVENT_COLOR_OPTIONS.map(option=>{const selected=draft.colorId===option.id;return <button type="button" className={`${selected?'selected ':''}${option.id?'':'default-color'}`} style={option.id?{background:option.color}:undefined} aria-label={option.name} aria-pressed={selected} title={option.name} onClick={()=>setDraft(current=>({...current,colorId:option.id}))} key={option.id||'default'}>{selected?<Check size={11}/>:!option.id?<CalendarDays size={11}/>:null}</button>})}</fieldset><label><span>Location</span><input value={draft.location} onChange={change=>setDraft(current=>({...current,location:change.target.value}))} placeholder="Optional"/></label><label><span>Notes</span><textarea value={draft.description} onChange={change=>setDraft(current=>({...current,description:change.target.value}))} placeholder="Optional notes"/></label>{error&&<div className="calendar-editor-error">{error}</div>}<footer>{event&&<button type="button" className={confirmDelete?'calendar-delete confirming':'calendar-delete'} disabled={busy} onClick={remove}><Trash2 size={14}/>{deleting?'Deleting…':confirmDelete?(event.recurring?'Delete occurrence?':'Delete event?'):'Delete'}</button>}<button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="calendar-save" disabled={busy}>{saving?'Saving…':event?'Save changes':'Create event'}</button></footer></form></div>
}

function EmailScheduleModal({message,onClose,onCreated}:{message:Message;onClose:()=>void;onCreated:()=>void}) {
  const [duration,setDuration]=useState(30),[slots,setSlots]=useState<CalendarSlot[]>([]),[loading,setLoading]=useState(true),[saving,setSaving]=useState(''),[error,setError]=useState('')
  useEffect(()=>{let active=true;setLoading(true);setError('');window.snowfire?.calendar.suggestions(duration).then(result=>{if(active)setSlots(result||[])}).catch(e=>{if(active)setError(cleanContactError(e))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[duration])
  const create=async(slot:CalendarSlot)=>{setSaving(slot.start);setError('');try{await window.snowfire?.calendar.create({summary:`Handle: ${message.subject}`,description:`Email from ${message.sender} <${message.email}>\n\n${message.preview}`,start:slot.start,end:slot.end,allDay:false,sourceTitle:message.subject,sourceUrl:`https://mail.google.com/mail/u/0/#all/${message.threadId||message.id}`});onCreated()}catch(e){setError(cleanContactError(e))}finally{setSaving('')}}
  const slotLabel=(slot:CalendarSlot)=>{const start=new Date(slot.start),end=new Date(slot.end);return {day:start.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}),time:`${start.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} – ${end.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`}}
  return <div className="calendar-modal-backdrop" onMouseDown={()=>!saving&&onClose()}><section className="email-scheduler" onMouseDown={click=>click.stopPropagation()}><header><div><span>EMAIL → CALENDAR</span><h2>Make time for this</h2><p>{message.subject}</p></div><button disabled={!!saving} aria-label="Close" onClick={onClose}><X size={18}/></button></header><div className="duration-picker"><span>Duration</span>{[15,30,60].map(minutes=><button className={duration===minutes?'active':''} disabled={!!saving} key={minutes} onClick={()=>setDuration(minutes)}>{minutes} min</button>)}</div><div className="recommended-times"><b>Recommended open times</b><small>Checked against every selected Google calendar.</small>{error?<div className="schedule-error">{error}</div>:loading?<div className="schedule-loading"><RefreshCw className="spin-icon" size={15}/>Finding open time…</div>:slots.length?<div>{slots.map(slot=>{const label=slotLabel(slot);return <button key={slot.start} disabled={!!saving} onClick={()=>create(slot)}><CalendarDays size={15}/><span><b>{label.day}</b><small>{label.time}</small></span><i>{saving===slot.start?'Adding…':'Add'}</i></button>})}</div>:<div className="schedule-loading">No open workday times found in the next week.</div>}</div></section></div>
}

function RecipientInput({value,onChange,contacts,autoFocus=false,placeholder='name@example.com'}:{value:string;onChange:(value:string)=>void;contacts:GoogleContact[];autoFocus?:boolean;placeholder?:string}) {
  const [focused,setFocused]=useState(false)
  const [highlighted,setHighlighted]=useState(0)
  const lastSeparator=Math.max(value.lastIndexOf(','),value.lastIndexOf(';'))
  const term=value.slice(lastSeparator+1).trim().toLowerCase()
  const options=useMemo(()=>{const seen=new Set<string>();return contacts.flatMap(contact=>contact.emails.map(email=>({email,name:contact.name}))).filter(option=>{const key=option.email.toLowerCase();if(seen.has(key)){return false}seen.add(key);return !term||option.name.toLowerCase().includes(term)||key.includes(term)}).slice(0,7)},[contacts,term])
  const showing=focused&&term.length>0&&options.length>0&&!options.some(option=>option.email.toLowerCase()===term)
  useEffect(()=>setHighlighted(0),[term])
  const choose=(email:string)=>{const prefix=lastSeparator>=0?`${value.slice(0,lastSeparator+1)} `:'';onChange(`${prefix}${email}`);setFocused(false)}
  const keyDown=(event:ReactKeyboardEvent<HTMLInputElement>)=>{if(event.ctrlKey||event.metaKey||!showing)return;if(event.key==='ArrowDown'){event.preventDefault();setHighlighted(index=>(index+1)%options.length)}else if(event.key==='ArrowUp'){event.preventDefault();setHighlighted(index=>(index-1+options.length)%options.length)}else if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();choose(options[highlighted].email)}else if(event.key==='Escape'){event.preventDefault();setFocused(false)}}
  return <div className="recipient-combobox"><input autoFocus={autoFocus} role="combobox" aria-autocomplete="list" aria-expanded={showing} value={value} onChange={event=>{onChange(event.target.value);setFocused(true)}} onFocus={()=>setFocused(true)} onBlur={()=>window.setTimeout(()=>setFocused(false),100)} onKeyDown={keyDown} placeholder={placeholder}/>{showing&&<div className="recipient-suggestions" role="listbox">{options.map((option,index)=><button type="button" role="option" aria-selected={index===highlighted} className={index===highlighted?'highlighted':''} key={option.email} onMouseEnter={()=>setHighlighted(index)} onMouseDown={event=>{event.preventDefault();choose(option.email)}}><b>{option.name}</b><small>{option.email}</small></button>)}</div>}</div>
}

function ContactEditor({contact,seed,onClose,onSaved}:{contact?:GoogleContact|null;seed?:ContactDraft;onClose:()=>void;onSaved:(contact:GoogleContact)=>void}) {
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const [draft,setDraft]=useState<ContactDraft>(()=>contact?{givenName:contact.givenName,familyName:contact.familyName,emails:contact.emails.length?[...contact.emails]:[''],phone:contact.phone,company:contact.company,title:contact.title}:seed?{...seed,emails:[...seed.emails]}:newContactDraft())
  const [icon,setIcon]=useState(()=>contact?contactIcon(contact):'')
  const draftName=`${draft.givenName} ${draft.familyName}`.trim()||draft.emails.find(Boolean)||'New contact'
  const draftInitials=draftName.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'?'
  const save=async(event:FormEvent)=>{event.preventDefault();setSaving(true);setError('');try{const saved=contact?await window.snowfire?.contacts.update({...draft,resourceName:contact.resourceName}):await window.snowfire?.contacts.create(draft);if(saved){saveContactIcon(saved.resourceName,icon);onSaved(saved)}}catch(e){setError(cleanContactError(e))}finally{setSaving(false)}}
  return <div className="contact-modal-backdrop" onMouseDown={()=>!saving&&onClose()}><form className="contact-editor" onSubmit={save} onMouseDown={event=>event.stopPropagation()}><header><div><span>GOOGLE CONTACTS</span><h2>{contact?'Edit contact':'New contact'}</h2></div><button type="button" aria-label="Close" disabled={saving} onClick={onClose}><X size={18}/></button></header><div className="contact-name-fields"><label><span>First name</span><input autoFocus value={draft.givenName} onChange={event=>setDraft(current=>({...current,givenName:event.target.value}))}/></label><label><span>Last name</span><input value={draft.familyName} onChange={event=>setDraft(current=>({...current,familyName:event.target.value}))}/></label></div><div className="contact-icon-editor"><span>Contact icon</span><div><button type="button" className={!icon?'selected':''} aria-label="Use contact initials" aria-pressed={!icon} onClick={()=>setIcon('')}><i>{draftInitials}</i><small>Initials</small></button><div>{CONTACT_ICON_OPTIONS.map(option=><button type="button" className={icon===option?'selected':''} aria-label={`Use ${option} as contact icon`} aria-pressed={icon===option} onClick={()=>setIcon(option)} key={option}>{option}</button>)}</div></div></div><div className="contact-email-fields"><span>Email addresses</span>{draft.emails.map((email,index)=><div key={index}><input type="email" value={email} onChange={event=>setDraft(current=>({...current,emails:current.emails.map((value,emailIndex)=>emailIndex===index?event.target.value:value)}))} placeholder={index?'Another email address':'name@company.com'}/>{draft.emails.length>1&&<button type="button" aria-label={`Remove email ${index+1}`} onClick={()=>setDraft(current=>({...current,emails:current.emails.filter((_,emailIndex)=>emailIndex!==index)}))}><X size={14}/></button>}</div>)}<button type="button" className="add-email" onClick={()=>setDraft(current=>({...current,emails:[...current.emails,'']}))}><Plus size={13}/> Add another email</button></div><label><span>Phone</span><input type="tel" value={draft.phone} onChange={event=>setDraft(current=>({...current,phone:event.target.value}))} placeholder="+1 555 555 0100"/></label><div className="contact-name-fields"><label><span>Company</span><input value={draft.company} onChange={event=>setDraft(current=>({...current,company:event.target.value}))}/></label><label><span>Title</span><input value={draft.title} onChange={event=>setDraft(current=>({...current,title:event.target.value}))}/></label></div>{error&&<div className="contact-editor-error">{error}</div>}<footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="save-contact" disabled={saving}>{saving?'Saving…':contact?'Save changes':'Save contact'}</button></footer></form></div>
}

function ContactsView({composeTo,onContactsLoaded,onContactSaved}:{composeTo:(email:string)=>void;onContactsLoaded:(contacts:GoogleContact[])=>void;onContactSaved:(contact:GoogleContact)=>void}) {
  const [contacts,setContacts]=useState<GoogleContact[]>([])
  const [filter,setFilter]=useState('')
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [editorOpen,setEditorOpen]=useState(false)
  const [editing,setEditing]=useState<GoogleContact|null>(null)
  const load=async()=>{setLoading(true);setError('');try{const result=await window.snowfire?.contacts.list(),next=result||[];setContacts(next);onContactsLoaded(next)}catch(e){setError(cleanContactError(e))}finally{setLoading(false)}}
  useEffect(()=>{load()},[])
  const filtered=useMemo(()=>{const needle=filter.trim().toLowerCase();return needle?contacts.filter(contact=>`${contact.name} ${contact.emails.join(' ')} ${contact.phones.join(' ')} ${contact.company} ${contact.title}`.toLowerCase().includes(needle)):contacts},[contacts,filter])
  const organizationGroups=useMemo(()=>{
    const groups=new Map<string,{name:string;contacts:GoogleContact[]}>()
    for(const contact of filtered){
      const name=contact.company.trim(),key=name.toLocaleLowerCase()
      const group=groups.get(key)||{name,contacts:[]}
      group.contacts.push(contact)
      groups.set(key,group)
    }
    return [...groups.entries()].map(([key,group])=>({key,name:group.name||'No organization',contacts:group.contacts.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}))})).sort((a,b)=>a.key?b.key?a.name.localeCompare(b.name,undefined,{sensitivity:'base'}):-1:b.key?1:0)
  },[filtered])
  const apiProject=error.match(/project(?:\s+|=)(\d+)/i)?.[1]
  const openEditor=(contact:GoogleContact|null)=>{setEditing(contact);setEditorOpen(true)}
  const contactSaved=(saved:GoogleContact)=>{setContacts(current=>{const found=current.some(contact=>contact.resourceName===saved.resourceName),next=found?current.map(contact=>contact.resourceName===saved.resourceName?saved:contact):[...current,saved];return next.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}))});onContactSaved(saved);setEditorOpen(false);setEditing(null)}
  return <section className="contacts-view">
    <header className="contacts-header"><div><span>GOOGLE / LIVE SYNC</span><h1>Contacts</h1><p>{contacts.length} contact{contacts.length===1?'':'s'} in your Google account</p></div><button onClick={()=>openEditor(null)}><Plus size={16}/> Add contact</button></header>
    <div className="contacts-toolbar"><Search size={17}/><input value={filter} onChange={event=>setFilter(event.target.value)} placeholder="Search contacts"/><button className={loading?'spinning':''} title="Refresh contacts" onClick={load}><RefreshCw size={16}/></button></div>
    {error&&<div className="contacts-error"><span>{error}</span>{/people api|disabled|accessNotConfigured/i.test(error)&&<button onClick={()=>window.snowfire?.openExternal(`https://console.cloud.google.com/apis/library/people.googleapis.com${apiProject?`?project=${apiProject}`:''}`)}>Enable People API</button>}<button onClick={load}>Try again</button></div>}
    <div className="contacts-list-head"><span>Contact</span><span>Email</span><span>Phone</span><span>Organization</span><span>Actions</span></div>
    <div className="contacts-list">{loading?<div className="contacts-state"><RefreshCw className="spin-icon" size={22}/><b>Loading Google Contacts</b></div>:organizationGroups.length?organizationGroups.map(group=><section className="contact-organization-group" key={group.key||'unassigned'}><header><div><Building2 size={13}/><b>{group.name}</b></div><span>{group.contacts.length} contact{group.contacts.length===1?'':'s'}</span></header>{group.contacts.map(contact=>{const icon=contactIcon(contact);return <article key={contact.resourceName}><div className="contact-identity"><span className={`google-contact-avatar${icon?' custom-icon':''}`}>{icon||contact.initials}</span><div className="contact-name"><b>{contact.name}</b>{contact.title&&<small>{contact.title}</small>}</div></div><div className="contact-detail email-detail"><Mail size={14}/><span title={contact.emails.join('\n')}>{contact.email||'—'}{contact.emails.length>1&&<small>+{contact.emails.length-1}</small>}</span></div><div className="contact-detail phone-detail"><Phone size={14}/><span>{contact.phone||'—'}</span></div><div className="contact-detail organization-detail"><Building2 size={14}/><span>{contact.company||'—'}</span></div><div className="contact-actions"><button title={`Edit ${contact.name}`} onClick={()=>openEditor(contact)}><PenLine size={14}/></button><button disabled={!contact.email} title={contact.email?`Email ${contact.name}`:'No email address'} onClick={()=>composeTo(contact.email)}><Send size={14}/></button></div></article>})}</section>):<div className="contacts-state"><UsersRound size={24}/><b>{error?'Contacts unavailable':filter?'No matching contacts':'No Google Contacts yet'}</b><span>{error?'Enable the People API, then try again.':filter?'Try a different search.':'Add your first contact to get started.'}</span></div>}</div>
    {editorOpen&&<ContactEditor key={editing?.resourceName||'new-contact'} contact={editing} onClose={()=>{setEditorOpen(false);setEditing(null)}} onSaved={contactSaved}/>}
  </section>
}

function EmailDocument({message}:{message:Message}) {
  const frameRef=useRef<HTMLIFrameElement|null>(null)
  useEffect(()=>{
    const frame=frameRef.current
    return()=>{const observer=(frame as HTMLIFrameElement&{_snowfireObserver?:ResizeObserver})?._snowfireObserver;observer?.disconnect()}
  },[message.id,message.bodyHtml])
  const fitFrame=(frame:HTMLIFrameElement)=>{
    const doc=frame.contentDocument
    if(!doc)return
    const tracked=frame as HTMLIFrameElement&{_snowfireObserver?:ResizeObserver}
    tracked._snowfireObserver?.disconnect()
    const resize=()=>{const height=Math.max(doc.body?.scrollHeight||0,doc.documentElement?.scrollHeight||0);frame.style.height=`${Math.max(240,height)}px`}
    resize()
    const observer=new ResizeObserver(()=>window.requestAnimationFrame(resize))
    if(doc.documentElement)observer.observe(doc.documentElement)
    if(doc.body)observer.observe(doc.body)
    tracked._snowfireObserver=observer
  }
  return <iframe ref={frameRef} className="email-html" title={`Message from ${message.sender}`} scrolling="no" sandbox="allow-popups allow-same-origin" srcDoc={message.bodyHtml} onLoad={event=>fitFrame(event.currentTarget)}/>
}

const initialLabels:GmailLabel[] = [
  {id:'sample-customer',name:'Customer',messagesTotal:1,color:{backgroundColor:'#38bdf8'}},
  {id:'sample-walmart',name:'Customer/Walmart',messagesTotal:1,color:{backgroundColor:'#38bdf8'}},
  {id:'sample-family',name:'Family',messagesTotal:1,color:{backgroundColor:'#fb5f82'}},
  {id:'sample-internal',name:'Internal',messagesTotal:1,color:{backgroundColor:'#a979f8'}},
  {id:'sample-newsletter',name:'Newsletter',messagesTotal:1,color:{backgroundColor:'#f5b53f'}},
]

const initialMessages: Message[] = [
  { id:'1', sender:'Maya Chen', email:'maya@northstar.studio', initials:'MC', color:'#ef7b5b', subject:'Re: SnowFire brand direction', preview:'The warmer palette is exactly right. I left a few thoughts on the final screens…', body:'Hi Alex,\n\nThe warmer palette is exactly right. I left a few thoughts on the final screens, but the direction feels distinctive and genuinely useful — not like another inbox clone.\n\nCould we spend ten minutes tomorrow looking at the compose experience? I especially like the focus mode and the idea of keeping the tools quiet until they are needed.\n\nThanks,\nMaya', time:'10:42 AM', date:'Today', unread:true, starred:true, label:'Primary', tags:['Design'] },
  { id:'8', sender:'Jennifer Lee', email:'jennifer.lee@walmart.com', initials:'JL', color:'#1976d2', subject:'Q4 retail rollout — final dates', preview:'Here are the confirmed dates and the updated store list for the Q4 rollout.', body:'Hi team,\n\nHere are the confirmed dates and the updated store list for the Q4 rollout.\n\nThanks,\nJennifer', attachments:[{id:'sample-brief',filename:'rollout-brief.pdf',mimeType:'application/pdf',size:1842200},{id:'sample-stores',filename:'store-list.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:86016}], labelIds:['sample-walmart'], time:'10:18 AM', date:'Today', unread:true, label:'Primary', tags:[] },
  { id:'2', sender:'SnowFire AI', email:'brief@snowfire.ai', initials:'SF', color:'#111d24', subject:'Your morning brief is ready', preview:'Seven messages need your attention. Two can be handled in under five minutes.', body:'Good morning, Alex.\n\nSeven messages need your attention today. Two can be handled in under five minutes, and three are waiting on someone else.\n\nYour calmest focus window begins at 10:30 AM.', labelIds:['sample-internal'], time:'9:15 AM', date:'Today', unread:true, label:'Primary', tags:['Brief'] },
  { id:'3', sender:'Scott Ryan', email:'scottryan@thescottryan.com', initials:'SR', color:'#694884', subject:'Fwd: Your Weekly Used Vehicles Are Here', preview:'Also you should get one of these with you $$$ Best Regards, Scott Ryan…', body:'Also you should get one of these with you $$$\n\nBest Regards,\nScott Ryan\n214-207-0600', attachments:[{id:'sample-vehicles',filename:'vehicle-list.pdf',mimeType:'application/pdf',size:1887436},{id:'sample-pricing',filename:'pricing.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:86016},{id:'sample-photo',filename:'grenadier.jpg',mimeType:'image/jpeg',size:2516582}], labelIds:['sample-family'], time:'8:31 AM', date:'Today', unread:true, label:'Primary', tags:['Personal'] },
  { id:'4', sender:'Linear', email:'notifications@linear.app', initials:'LI', color:'#6764a8', subject:'8 updates in SnowFire', preview:'Maya moved “Compose polish” to In Progress and mentioned you in a comment.', body:'There are 8 new updates in your SnowFire workspace.\n\nMaya moved “Compose polish” to In Progress and mentioned you in a comment.', time:'Yesterday', date:'Yesterday', label:'Updates', tags:['Work'] },
  { id:'5', sender:'Elena Torres', email:'elena@commonroom.com', initials:'ET', color:'#d19457', subject:'Introduction: Alex × Priya', preview:'You two are thinking about many of the same problems around calmer software.', body:'Alex, Priya —\n\nYou two are thinking about many of the same problems around calmer software, so I wanted to connect you. I will let you take it from here!\n\nElena', time:'Yesterday', date:'Yesterday', label:'Primary', tags:['Network'] },
  { id:'6', sender:'Figma', email:'notifications@figma.com', initials:'FI', color:'#d2656e', subject:'New comments on Inbox exploration', preview:'3 new comments were added to your design file.', body:'Three new comments were added to Inbox exploration.', time:'Aug 27', date:'Aug 27', label:'Updates', tags:['Design'] },
  { id:'7', sender:'The Browser Company', email:'hello@browser.company', initials:'BC', color:'#826f61', subject:'A quieter internet', preview:'This week: designing tools that respect your attention.', body:'This week: designing tools that respect your attention, building slower, and leaving room for thinking.', labelIds:['sample-newsletter'], time:'Aug 26', date:'Aug 26', label:'Newsletters', tags:['Read later'] },
]

const nav = [
  ['Inbox', Inbox, 0], ['Starred', Star, 0], ['Snoozed', Clock3, 0], ['Sent', Send, 0], ['Drafts', FileText, 0], ['Archive', Archive, 0], ['Trash', Trash2, 0], ['Contacts', UsersRound, 0]
] as const

function App() {
  const [messages, setMessages] = useState(initialMessages)
  const [selected, setSelected] = useState<string | null>('1')
  const [folder, setFolder] = useState('Inbox')
  const [activeLabelId, setActiveLabelId] = useState<string|null>(null)
  const [mailboxesOpen, setMailboxesOpen] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(true)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(readCollapsedFolders)
  const [query, setQuery] = useState('')
  const [compose, setCompose] = useState(false)
  const [contactSeed, setContactSeed] = useState<ContactDraft|null>(null)
  const [recipientContacts, setRecipientContacts] = useState<GoogleContact[]>([])
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [responseMode, setResponseMode] = useState<'reply'|'forward'|null>(null)
  const [responseDraft, setResponseDraft] = useState<{to:string;body:string;attachments:OutgoingAttachment[]}>({to:'',body:'',attachments:[]})
  const [sending, setSending] = useState(false)
  const [pendingSends, setPendingSends] = useState<QueuedSend[]>([])
  const [undoClock, setUndoClock] = useState(Date.now())
  const [toast, setToast] = useState('')
  const [lastDeleted, setLastDeleted] = useState<Array<{message:Message;index:number}>|null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dropLabelId, setDropLabelId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{x:number;y:number;message:Message}|null>(null)
  const [folderContextMenu, setFolderContextMenu] = useState<{x:number;y:number;label:GmailLabel}|null>(null)
  const [showContextLabels, setShowContextLabels] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [upgradeRequired, setUpgradeRequired] = useState(false)
  const [account, setAccount] = useState('')
  const [credential, setCredential] = useState('')
  const [authError, setAuthError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [mailboxLoading, setMailboxLoading] = useState(false)
  const [mailboxCounts, setMailboxCounts] = useState<Record<string,number>>({})
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState('')
  const [calendarEditorOpen, setCalendarEditorOpen] = useState(false)
  const [editingCalendarEvent, setEditingCalendarEvent] = useState<CalendarEvent|null>(null)
  const [calendarSeedDate, setCalendarSeedDate] = useState<Date|null>(null)
  const [calendarSeedEndDate, setCalendarSeedEndDate] = useState<Date|null>(null)
  const [calendarSeedMessage, setCalendarSeedMessage] = useState<Message|null>(null)
  const [calendarRefreshToken, setCalendarRefreshToken] = useState(0)
  const [scheduleMessage, setScheduleMessage] = useState<Message|null>(null)
  const [gmailLabels, setGmailLabels] = useState<GmailLabel[]>(initialLabels)
  const [labelIcons, setLabelIcons] = useState<Record<string,string>>({})
  const [senderLabels, setSenderLabels] = useState<SenderLabels>({})
  const [senderLabelsReady, setSenderLabelsReady] = useState(false)
  const [senderFolderRules, setSenderFolderRules] = useState<SenderFolderRules>({})
  const [senderFolderRulesReady, setSenderFolderRulesReady] = useState(false)
  const [labelManager, setLabelManager] = useState(false)
  const [folderManager, setFolderManager] = useState(false)
  const [routingManager, setRoutingManager] = useState(false)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [senderDetailsOpen, setSenderDetailsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState({remoteImages:false})
  const [credentialStorage, setCredentialStorage] = useState<'keyring'|'encrypted'|'local'>('local')
  const [searchLoading, setSearchLoading] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelParent, setNewLabelParent] = useState('')
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelError, setLabelError] = useState('')
  const [confirmDeleteLabel, setConfirmDeleteLabel] = useState<GmailLabel|null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderParent, setNewFolderParent] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<GmailLabel|null>(null)
  const [ruleEmail, setRuleEmail] = useState('')
  const [ruleFolder, setRuleFolder] = useState('')
  const [ruleBusy, setRuleBusy] = useState(false)
  const [ruleError, setRuleError] = useState('')
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const [folderDashboardMessages, setFolderDashboardMessages] = useState<Record<string,Message[]>>({})
  const [folderDashboardLoading, setFolderDashboardLoading] = useState(false)
  const [folderDashboardError, setFolderDashboardError] = useState('')
  const [draggingFolderName, setDraggingFolderName] = useState('')
  const [folderOrderTarget, setFolderOrderTarget] = useState('')
  const [draft, setDraft] = useState<OutgoingMessage>(newOutgoingMessage)
  const searchGeneration = useRef(0)
  const routingInProgress = useRef(false)
  const folderDashboardGeneration = useRef(0)
  const active = messages.find(m => m.id === selected)
  const pendingSend = pendingSends[0]
  const undoSeconds = pendingSend ? Math.max(0,Math.ceil((pendingSend.sendAt-undoClock)/1000)) : 0
  const activeMeta = active ? messageMeta(active,gmailLabels,labelIcons,senderLabels) : null
  const classificationLabels = useMemo(()=>gmailLabels.filter(label=>!isFolderLabel(label.name)),[gmailLabels])
  const folderLabels = useMemo(()=>gmailLabels.filter(label=>isFolderLabel(label.name)&&folderParts(label.name).length).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})),[gmailLabels])
  const orderedFolderLabels = useMemo(()=>orderFolderTree(folderLabels,folderOrder),[folderLabels,folderOrder])
  const topLevelFolderLabels = useMemo(()=>orderedFolderLabels.filter(label=>folderDepth(label.name)===0),[orderedFolderLabels])
  const topLevelFolderKey = topLevelFolderLabels.map(label=>label.id).join('|')
  const visibleFolderLabels = useMemo(()=>orderedFolderLabels.filter(label=>{let parent=folderParent(label.name);while(parent!==FOLDER_ROOT){if(collapsedFolders.has(parent))return false;parent=folderParent(parent)}return true}),[orderedFolderLabels,collapsedFolders])
  const folderUnreadCount = (name:string) => folderLabels.filter(label=>folderContains(name,label.name)).reduce((total,label)=>total+(label.messagesUnread||0),0)
  const folderMessageCount = (name:string) => folderLabels.filter(label=>folderContains(name,label.name)).reduce((total,label)=>total+(label.messagesTotal||0),0)
  const visible = useMemo(() => messages
    .filter(m => connected&&query.trim()?true:`${m.sender} ${m.subject} ${m.preview}`.toLowerCase().includes(query.toLowerCase()))
    .map((message,index)=>({message,index}))
    .sort((a,b)=>(b.message.receivedAt??0)-(a.message.receivedAt??0)||a.index-b.index)
    .map(({message})=>message), [messages, query, connected])
  const flash = (text:string) => { setToast(text); window.setTimeout(() => setToast(''), 2600) }
  const toggleFolderCollapse = (name:string) => setCollapsedFolders(current=>{const next=new Set(current);if(next.has(name))next.delete(name);else next.add(name);try{localStorage.setItem(COLLAPSED_FOLDERS_KEY,JSON.stringify([...next]))}catch{}return next})
  const rememberContact = (saved:GoogleContact) => setRecipientContacts(current=>{const found=current.some(contact=>contact.resourceName===saved.resourceName),next=found?current.map(contact=>contact.resourceName===saved.resourceName?saved:contact):[...current,saved];return next.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}))})
  const messageHasLabel = (message:Message,label:GmailLabel) => Boolean(message.labelIds?.includes(label.id)||(senderLabels[normalizeSenderEmail(message.email)]||[]).some(name=>name.toLowerCase()===label.name.toLowerCase()))
  const folderLabelQuery = (labelId:string) => {const selected=folderLabels.find(label=>label.id===labelId);if(!selected)return `labelId:${labelId}`;const ids=folderLabels.filter(label=>folderContains(selected.name,label.name)).map(label=>label.id);return ids.length>1?`labelIds:${ids.join(',')}`:`labelId:${labelId}`}
  const loadFolderDashboard = async () => {
    const generation=++folderDashboardGeneration.current
    if(!connected||!window.snowfire){setFolderDashboardMessages({});setFolderDashboardError('');setFolderDashboardLoading(false);return}
    setFolderDashboardLoading(true);setFolderDashboardError('')
    try{
      const results=await Promise.all(topLevelFolderLabels.map(async label=>{const mail=await window.snowfire!.gmail.list(folderLabelQuery(label.id),settings.remoteImages),recent=[...mail].sort((a,b)=>(b.receivedAt??0)-(a.receivedAt??0)).slice(0,5);return [label.id,recent] as const}))
      if(generation===folderDashboardGeneration.current)setFolderDashboardMessages(Object.fromEntries(results))
    }catch(e){if(generation===folderDashboardGeneration.current)setFolderDashboardError(e instanceof Error?e.message:'Could not load folder activity')}
    finally{if(generation===folderDashboardGeneration.current)setFolderDashboardLoading(false)}
  }
  const currentFolderQuery = () => query.trim()?`in:anywhere ${query.trim()}`:activeLabelId?folderLabelQuery(activeLabelId):(folderQuery[folder]||'in:inbox')
  const routeInboxMessages = async (mail:Message[],rules:SenderFolderRules=senderFolderRules) => {
    if(!window.snowfire||!connected||routingInProgress.current)return {mail,routed:[] as Message[]}
    const foldersByName=new Map(folderLabels.map(label=>[label.name.toLowerCase(),label])),folderIds=folderLabels.map(label=>label.id)
    const moves=mail.flatMap(message=>{const folderName=rules[normalizeSenderEmail(message.email)],target=folderName?foldersByName.get(folderName.toLowerCase()):undefined;if(!target)return[];const remove=[...new Set(['INBOX',...folderIds.filter(id=>id!==target.id&&message.labelIds?.includes(id))])];return [{message,target,remove}]})
    if(!moves.length)return {mail,routed:[] as Message[]}
    routingInProgress.current=true
    try{await Promise.all(moves.map(({message,target,remove})=>window.snowfire!.gmail.modify(message.id,message.labelIds?.includes(target.id)?[]:[target.id],remove)));const routed=moves.map(move=>move.message),ids=new Set(routed.map(message=>message.id));return {mail:mail.filter(message=>!ids.has(message.id)),routed}}
    finally{routingInProgress.current=false}
  }
  const loadMailbox = async (gmailQuery:string, selectFirst=true) => {let mail=await window.snowfire!.gmail.list(gmailQuery,settings.remoteImages);if(senderFolderRulesReady&&/\bin:inbox\b/i.test(gmailQuery))mail=(await routeInboxMessages(mail)).mail;setMessages(mail);if(selectFirst)setSelected(mail[0]?.id||null);return mail}
  const refreshMailboxIndicators = async (includeLabels=false) => {
    if(!window.snowfire||!connected)return
    const tasks:Promise<unknown>[]=[window.snowfire.gmail.counts().then(counts=>setMailboxCounts(counts||{})).catch(()=>{})]
    if(includeLabels)tasks.push(window.snowfire.gmail.labels().then(labels=>setGmailLabels(labels||[])).catch(()=>{}))
    await Promise.all(tasks)
  }
  const sync = async () => { if(!window.snowfire||!connected)return; setSyncing(true);setSelectedIds(new Set());try{await Promise.all([loadMailbox(query.trim()?`in:anywhere ${query.trim()}`:currentFolderQuery()),refreshMailboxIndicators(true)])}catch(e){flash(e instanceof Error?e.message:'Sync failed')}finally{setSyncing(false)} }
  const loadCalendar = async () => {if(!window.snowfire||!connected)return;setCalendarLoading(true);setCalendarError('');try{setCalendarEvents(await window.snowfire.calendar.today()||[])}catch(e){setCalendarError(cleanContactError(e))}finally{setCalendarLoading(false)}}
  const openDroppedEmailEvent = (messageId:string,start:Date) => {const message=messages.find(item=>item.id===messageId);if(!message)return;setEditingCalendarEvent(null);setCalendarSeedMessage(message);setCalendarSeedDate(start);setCalendarSeedEndDate(new Date(start.getTime()+30*60_000));setCalendarEditorOpen(true);setDraggingIds([])}
  const openCalendarRange = (start:Date,end:Date) => {setEditingCalendarEvent(null);setCalendarSeedMessage(null);setCalendarSeedDate(start);setCalendarSeedEndDate(end);setCalendarEditorOpen(true)}
  const moveTodayCalendarEvent = async (event:CalendarEvent,start:Date) => {
    if(!window.snowfire||!event.editable)return
    const originalStart=new Date(event.start),originalEnd=new Date(event.end),duration=Math.max(15*60_000,originalEnd.getTime()-originalStart.getTime()),end=new Date(start.getTime()+duration),previous=calendarEvents
    setCalendarEvents(items=>items.map(item=>item.id===event.id?{...item,start:start.toISOString(),end:end.toISOString()}:item))
    try{await window.snowfire.calendar.update({calendarId:event.calendarId,eventId:event.eventId,summary:event.summary,location:event.location,description:event.description,colorId:event.colorId,start:start.toISOString(),end:end.toISOString(),allDay:false});setCalendarRefreshToken(value=>value+1);flash(`Moved to ${start.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`)}catch(e){setCalendarEvents(previous);flash(cleanContactError(e))}
  }
  useEffect(()=>{(async()=>{try{if(!window.snowfire){setConnected(null);return}const preferences=await window.snowfire.settings.get();setSettings(preferences);const s=await window.snowfire.gmail.status();setConnected(s.connected);setUpgradeRequired(Boolean(s.upgradeRequired));setCredentialStorage(s.credentialStorage||(s.secureStorage===false?'local':'encrypted'));if(s.profile?.emailAddress)setAccount(s.profile.emailAddress);if(s.connected){const mail=await window.snowfire.gmail.list('in:inbox',preferences.remoteImages);setMessages(mail);setSelected(mail[0]?.id||null)}}catch{setConnected(false)}})()},[])
  useEffect(()=>{window.snowfire?.metadata.labelIcons().then(setLabelIcons).catch(()=>{})},[])
  useEffect(()=>{window.snowfire?.metadata.senderLabels().then(labels=>setSenderLabels(labels||{})).catch(()=>{}).finally(()=>setSenderLabelsReady(true))},[])
  useEffect(()=>{window.snowfire?.metadata.senderFolderRules().then(rules=>setSenderFolderRules(rules||{})).catch(()=>{}).finally(()=>setSenderFolderRulesReady(true))},[])
  useEffect(()=>{window.snowfire?.metadata.folderOrder().then(order=>setFolderOrder(order||[])).catch(()=>{})},[])
  useEffect(()=>{if(folder==='Folders')loadFolderDashboard()},[folder,connected,topLevelFolderKey,settings.remoteImages])
  useEffect(()=>{if(connected)refreshMailboxIndicators(true)},[connected])
  useEffect(()=>{const api=window.snowfire?.gmail;if(!api)return;api.pendingSends().then(items=>setPendingSends(items||[])).catch(()=>{});return api.onSendStatus((status:SendStatus)=>{setPendingSends(items=>items.filter(item=>item.id!==status.id));if(status.status==='sent')flash('Message sent');else{if(status.message){setDraft({...status.message,attachments:status.message.attachments||[]});setCompose(true)}flash(status.error?`Send failed: ${status.error}`:'Message could not be sent')}})},[])
  useEffect(()=>{if(!pendingSends.length)return;setUndoClock(Date.now());const timer=window.setInterval(()=>setUndoClock(Date.now()),250);return()=>window.clearInterval(timer)},[pendingSends.length])
  useEffect(()=>{if(connected)window.snowfire?.contacts.list().then(contacts=>setRecipientContacts(contacts||[])).catch(()=>{});else setRecipientContacts([])},[connected])
  useEffect(()=>{if(!connected){setCalendarEvents([]);setCalendarError('');return}loadCalendar();const timer=window.setInterval(loadCalendar,5*60*1000);return()=>window.clearInterval(timer)},[connected])
  useEffect(()=>{if(!connected||!senderFolderRulesReady||!Object.keys(senderFolderRules).length||!window.snowfire)return;let active=true;const run=async()=>{try{const inbox=await window.snowfire!.gmail.list('in:inbox',settings.remoteImages),result=await routeInboxMessages(inbox);if(!active||!result.routed.length)return;const ids=new Set(result.routed.map(message=>message.id));if(folder==='Inbox'){setMessages(items=>items.filter(message=>!ids.has(message.id)));setSelected(current=>current&&ids.has(current)?null:current)}refreshMailboxIndicators(true);flash(`Auto-routed ${result.routed.length} email${result.routed.length===1?'':'s'}`)}catch{}};run();const timer=window.setInterval(run,60_000);return()=>{active=false;window.clearInterval(timer)}},[connected,senderFolderRulesReady,senderFolderRules,gmailLabels,settings.remoteImages,folder])
  useEffect(()=>{if(!senderLabelsReady||!gmailLabels.length)return;const labelsById=new Map(gmailLabels.map(label=>[label.id,label.name])),next={...senderLabels},updates:Array<[string,string[]]>=[];for(const message of messages){const email=normalizeSenderEmail(message.email);if(!email||Object.prototype.hasOwnProperty.call(next,email))continue;const names=[...new Set((message.labelIds||[]).map(id=>labelsById.get(id)).filter((name):name is string=>typeof name==='string'&&!isFolderLabel(name)))];if(names.length){next[email]=names;updates.push([email,names])}}if(updates.length){setSenderLabels(next);Promise.all(updates.map(([email,names])=>window.snowfire?.metadata.setSenderLabels(email,names))).catch(()=>{})}},[messages,gmailLabels,senderLabels,senderLabelsReady])
  useEffect(()=>{if(!connected||!query.trim()||!window.snowfire||folder==='Contacts'||folder==='Calendar')return;const generation=++searchGeneration.current;setSearchLoading(true);const timer=window.setTimeout(async()=>{try{const mail=await window.snowfire!.gmail.list(`in:anywhere ${query.trim()}`,settings.remoteImages);if(generation===searchGeneration.current){setMessages(mail);setSelected(mail[0]?.id||null);setActiveLabelId(null);setFolder('Search')}}catch(e){if(generation===searchGeneration.current)flash(e instanceof Error?e.message:'Search failed')}finally{if(generation===searchGeneration.current)setSearchLoading(false)}},350);return()=>window.clearTimeout(timer)},[query,connected,settings.remoteImages,folder])
  const connectGmail = async () => {setAuthError('');try{const p=await window.snowfire?.gmail.connect(upgradeRequired?'':credential);setCredential('');setAccount(p.emailAddress);setConnected(true);setUpgradeRequired(false);const mail=await window.snowfire!.gmail.list('in:inbox',settings.remoteImages);setMessages(mail);setSelected(mail[0]?.id||null);const labels=await window.snowfire!.gmail.labels();setGmailLabels(labels)}catch(e){setAuthError(e instanceof Error?e.message:'Could not connect Gmail')}}
  const chooseCredentialFile = async () => {try{const value=await window.snowfire?.gmail.chooseCredentials();if(value){setCredential(value);setAuthError('')}}catch(e){setAuthError(e instanceof Error?e.message:'Could not read that OAuth file')}}
  const toggleStar = (id:string) => {const current=messages.find(m=>m.id===id);setMessages(ms => ms.map(m => m.id === id ? {...m, starred:!m.starred} : m));if(connected&&current)window.snowfire?.gmail.modify(id,current.starred?[]:['STARRED'],current.starred?['STARRED']:[]).catch(()=>flash('Could not update Gmail'))}
  const selectMessage = (id:string) => { const current=messages.find(m=>m.id===id);setSelected(id);setMessages(ms => ms.map(m => m.id === id ? {...m, unread:false} : m));if(connected&&current?.unread)window.snowfire?.gmail.modify(id,[],['UNREAD']).then(()=>refreshMailboxIndicators(true)).catch(()=>{setMessages(ms=>ms.map(m=>m.id===id?{...m,unread:true}:m));flash('Could not mark that message as read')});setResponseMode(null);setSnoozeMenuOpen(false);setSenderDetailsOpen(false) }
  const toggleMessageSelection = (id:string) => {setSelectedIds(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next})}
  const selectedMessages = () => messages.filter(message=>selectedIds.has(message.id))
  const archiveMessages = async (targets:Message[]) => {if(!targets.length)return;const ids=new Set(targets.map(message=>message.id)),restoring=folder==='Archive';try{if(connected)await Promise.all(targets.map(message=>window.snowfire?.gmail.modify(message.id,restoring?['INBOX']:[],restoring?[]:['INBOX'])))}catch(e){flash(e instanceof Error?e.message:'Could not update Gmail');return}setMessages(items=>items.filter(message=>!ids.has(message.id)));setSelectedIds(new Set());if(selected&&ids.has(selected))setSelected(null);refreshMailboxIndicators(true);flash(restoring?(targets.length===1?'Moved to inbox':`${targets.length} emails moved to inbox`):(targets.length===1?'Conversation archived':`${targets.length} conversations archived`))}
  const archiveMessage = async (message:Message) => archiveMessages([message])
  const archive = async () => {const targets=selectedIds.size?selectedMessages():(active?[active]:[]);await archiveMessages(targets)}
  const trashMessages = async (targets:Message[]) => {if(!targets.length)return;if(folder==='Trash'){flash('Gmail permanently removes trash after 30 days');return}const ids=new Set(targets.map(message=>message.id));const deleted=targets.map(message=>({message,index:messages.findIndex(item=>item.id===message.id)}));try{if(connected)await Promise.all(targets.map(message=>window.snowfire?.gmail.trash(message.id)))}catch(e){flash(e instanceof Error?e.message:'Could not move that message');return}setLastDeleted(deleted);setMessages(items=>items.filter(message=>!ids.has(message.id)));setSelectedIds(new Set());if(selected&&ids.has(selected))setSelected(null);refreshMailboxIndicators(true);flash(`${targets.length===1?'Moved to trash':`${targets.length} moved to trash`} · Ctrl Z to undo`)}
  const trashMessage = async (message:Message) => trashMessages([message])
  const restoreMessages = async (targets:Message[]) => {if(!targets.length)return;const ids=new Set(targets.map(message=>message.id));try{if(connected)await Promise.all(targets.map(message=>window.snowfire?.gmail.untrash(message.id)))}catch(e){flash(e instanceof Error?e.message:'Could not restore that message');return}setMessages(items=>items.filter(message=>!ids.has(message.id)));setSelectedIds(new Set());if(selected&&ids.has(selected))setSelected(null);refreshMailboxIndicators(true);flash(targets.length===1?'Message restored to inbox':`${targets.length} messages restored to inbox`)}
  const snoozeMessage = async (until:number) => {if(!active)return;try{if(connected)await window.snowfire?.gmail.snooze(active.id,until);setMessages(items=>items.filter(message=>message.id!==active.id));setSelected(null);setSnoozeMenuOpen(false);refreshMailboxIndicators(true);flash(`Snoozed until ${new Date(until).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})}`)}catch(e){flash(e instanceof Error?e.message:'Could not snooze this message')}}
  const unsnoozeMessage = async () => {if(!active)return;try{if(connected)await window.snowfire?.gmail.unsnooze(active.id);setMessages(items=>items.filter(message=>message.id!==active.id));setSelected(null);refreshMailboxIndicators(true);flash('Returned to inbox')}catch(e){flash(e instanceof Error?e.message:'Could not return this message')}}
  const moveToTrash = async () => {const targets=selectedIds.size?selectedMessages():(active?[active]:[]);if(folder==='Trash')await restoreMessages(targets);else await trashMessages(targets)}
  const undoDelete = async () => {if(!lastDeleted)return;try{if(connected)await Promise.all(lastDeleted.map(({message})=>window.snowfire?.gmail.untrash(message.id)))}catch(e){flash(e instanceof Error?e.message:'Could not restore that message');return}const restored=[...lastDeleted].sort((a,b)=>a.index-b.index);setMessages(items=>{const next=[...items];for(const {message,index} of restored)next.splice(Math.min(index,next.length),0,message);return next});setSelected(restored[0]?.message.id||null);setLastDeleted(null);refreshMailboxIndicators(true);flash(restored.length===1?'Message restored':`${restored.length} messages restored`)}
  const chooseOutgoingFiles = async (target:'compose'|'response') => {try{const files=await window.snowfire?.gmail.chooseFiles()||[];if(!files.length)return;if(target==='compose')setDraft(current=>({...current,attachments:[...current.attachments,...files]}));else setResponseDraft(current=>({...current,attachments:[...current.attachments,...files]}))}catch(e){flash(e instanceof Error?e.message:'Could not attach those files')}}
  const queueOutgoing = async (message:OutgoingMessage) => {if(!connected||!window.snowfire)throw new Error('Connect Gmail before sending.');const queued=await window.snowfire.gmail.queueSend(message);setPendingSends(items=>[...items.filter(item=>item.id!==queued.id),queued].sort((a,b)=>a.sendAt-b.sendAt));return queued}
  const sendDraft = async () => {if(!draft.to.trim()||!draft.body.trim())return flash('Add a recipient and message');setSending(true);try{await queueOutgoing(draft);setCompose(false);setDraft(newOutgoingMessage())}catch(e){flash(e instanceof Error?e.message:'Message could not be queued')}finally{setSending(false)}}
  const beginResponse = (mode:'reply'|'forward') => {const message=contextMenu?.message||active;if(!message)return;setResponseMode(mode);setResponseDraft({to:mode==='reply'?message.email:'',body:mode==='forward'?`\n\n---------- Forwarded message ----------\nFrom: ${message.sender} <${message.email}>\nDate: ${message.date}, ${message.time}\nSubject: ${message.subject}\n\n${message.body}`:'',attachments:[]})}
  const sendResponse = async () => {if(!active||!responseMode)return;if(!responseDraft.to.trim()||!responseDraft.body.trim())return flash('Add a recipient and message');setSending(true);try{const subject=responseMode==='reply'?(/^re:/i.test(active.subject)?active.subject:`Re: ${active.subject}`):(/^fwd:/i.test(active.subject)?active.subject:`Fwd: ${active.subject}`);await queueOutgoing({to:responseDraft.to,subject,body:responseDraft.body,attachments:responseDraft.attachments,...(responseMode==='reply'?{threadId:active.threadId,inReplyTo:active.messageIdHeader}:{})});setResponseMode(null);setResponseDraft({to:'',body:'',attachments:[]})}catch(e){flash(e instanceof Error?e.message:'Message could not be queued')}finally{setSending(false)}}
  const undoQueuedSend = async (item:QueuedSend) => {try{const undone=await window.snowfire?.gmail.undoSend(item.id);setPendingSends(items=>items.filter(send=>send.id!==item.id));if(!undone)return flash('That message has already been sent');setDraft({...undone.message,attachments:undone.message.attachments||[]});setCompose(true);setResponseMode(null);flash('Send canceled — your message is back in compose')}catch(e){flash(e instanceof Error?e.message:'Could not pull that message back')}}
  const folderQuery:Record<string,string> = {Inbox:'in:inbox',Starred:'is:starred',Snoozed:'snoozed:local',Sent:'in:sent',Drafts:'in:drafts',Archive:'in:anywhere -in:inbox -in:sent -in:drafts -in:trash -in:spam',Trash:'in:trash'}
  const openFolder = async (name:string, labelId?:string, messageId?:string) => {
    searchGeneration.current++;setQuery('');setSearchLoading(false);setActiveLabelId(labelId||null);setFolder(name);setMobileNavOpen(false);setSelected(null);setSelectedIds(new Set());setResponseMode(null);setSenderDetailsOpen(false)
    if(name==='Contacts'||name==='Calendar'||name==='Folders'||!connected||!window.snowfire) return
    setMailboxLoading(true)
    try { const mail=await loadMailbox(labelId?folderLabelQuery(labelId):(folderQuery[name]||'in:inbox'));const target=messageId?mail.find(message=>message.id===messageId):undefined;if(target){setSelected(target.id);if(target.unread){setMessages(items=>items.map(message=>message.id===target.id?{...message,unread:false}:message));window.snowfire.gmail.modify(target.id,[],['UNREAD']).then(()=>refreshMailboxIndicators(true)).catch(()=>{})}} }
    catch(e){flash(e instanceof Error?e.message:`Could not open ${name}`)} finally{setMailboxLoading(false)}
  }
  const beginFolderCreate = async (parentName='') => {
    setNewFolderParent(parentName===FOLDER_ROOT?'':parentName);setNewFolderName('');setFolderError('');setFolderContextMenu(null);setFoldersOpen(true)
    if(folder!=='Folders')await openFolder('Folders')
    window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('.folder-dashboard-create input')?.focus()))
  }
  const updateRemoteImageSetting = async (remoteImages:boolean) => {setSettings({remoteImages});try{await window.snowfire?.settings.update({remoteImages});if(connected){setMailboxLoading(true);const mail=await window.snowfire!.gmail.list(currentFolderQuery(),remoteImages);setMessages(mail);setSelected(mail[0]?.id||null)}}catch(e){flash(e instanceof Error?e.message:'Could not save settings')}finally{setMailboxLoading(false)}}
  const showRemoteImages = async (message:Message) => {if(!connected||!window.snowfire)return;try{const full=await window.snowfire.gmail.get(message.id,true);setMessages(items=>items.map(item=>item.id===message.id?full:item));flash('Remote images loaded for this message')}catch(e){flash(e instanceof Error?e.message:'Could not load remote images')}}
  const disconnectGmail = async () => {await window.snowfire?.gmail.disconnect();setConnected(false);setAccount('');setSettingsOpen(false);setMessages(initialMessages);setGmailLabels(initialLabels);setRecipientContacts([]);setSelected('1');flash('Gmail disconnected')}
  const refreshLabels = async () => {const labels=await window.snowfire?.gmail.labels();if(labels)setGmailLabels(labels);return labels||[]}
  const createGmailLabel = async () => {
    const leaf=newLabelName.trim().replace(/^\/+|\/+$/g,'')
    const name=newLabelParent?`${newLabelParent}/${leaf}`:leaf
    if(!name)return
    setLabelBusy(true);setLabelError('')
    try{await window.snowfire?.gmail.createLabel(name);await refreshLabels();setNewLabelName('');flash(`Created ${name}`)}
    catch(e){setLabelError(e instanceof Error?e.message:'Could not create the label')}
    finally{setLabelBusy(false)}
  }
  const createCustomerRoot = async () => {setLabelBusy(true);setLabelError('');try{await window.snowfire?.gmail.createLabel('Customer');await refreshLabels();flash('Customer label is ready')}catch(e){setLabelError(e instanceof Error?e.message:'Could not create Customer')}finally{setLabelBusy(false)}}
  const createSenderFolderRule = async () => {
    const email=normalizeSenderEmail(ruleEmail),target=folderLabels.find(label=>label.name===ruleFolder)
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setRuleError('Enter a valid sender email address.');return}
    if(!target){setRuleError('Choose the destination folder.');return}
    setRuleBusy(true);setRuleError('')
    try{
      const saved=await window.snowfire?.metadata.setSenderFolderRule(email,target.name)||{...senderFolderRules,[email]:target.name}
      setSenderFolderRules(saved);setRuleEmail('');setRuleFolder('')
      const inbox=connected&&window.snowfire?await window.snowfire.gmail.list('in:inbox',settings.remoteImages):[],result=await routeInboxMessages(inbox,saved),ids=new Set(result.routed.map(message=>message.id))
      if(folder==='Inbox'&&ids.size){setMessages(items=>items.filter(message=>!ids.has(message.id)));setSelected(current=>current&&ids.has(current)?null:current)}
      if(ids.size)refreshMailboxIndicators(true)
      flash(ids.size?`Rule saved · routed ${ids.size} email${ids.size===1?'':'s'}`:`Routing rule saved for ${email}`)
    }catch(e){setRuleError(e instanceof Error?e.message:'Could not save the routing rule')}
    finally{setRuleBusy(false)}
  }
  const createRoutingFolder = async (path:string) => {
    const parts=labelParts(path)
    if(!parts.length)throw new Error('Enter a folder name.')
    if(!window.snowfire)throw new Error('Connect Gmail before creating a folder.')
    const known=[...folderLabels]
    const createdNames:string[]=[]
    let name=FOLDER_ROOT
    for(const part of parts){
      const requested=`${name}/${part}`
      const existing=known.find(label=>label.name.toLocaleLowerCase()===requested.toLocaleLowerCase())
      if(existing){name=existing.name;continue}
      const created=await window.snowfire.gmail.createLabel(requested)
      name=requested
      createdNames.push(name)
      known.push(created)
    }
    await refreshLabels()
    const createdSet=new Set(createdNames)
    const next=[...folderOrder.filter(item=>!createdSet.has(item)),...createdNames]
    setFolderOrder(next)
    window.snowfire.metadata.setFolderOrder(next).catch(()=>{})
    flash(`Created ${folderParts(name).join(' / ')}`)
    return name
  }
  const removeSenderFolderRule = async (email:string) => {setRuleBusy(true);setRuleError('');try{const next=await window.snowfire?.metadata.removeSenderFolderRule(email)||Object.fromEntries(Object.entries(senderFolderRules).filter(([sender])=>sender!==email));setSenderFolderRules(next);flash(`Removed routing rule for ${email}`)}catch(e){setRuleError(e instanceof Error?e.message:'Could not remove the routing rule')}finally{setRuleBusy(false)}}
  const openRoutingForSender = (message:Message) => {const email=normalizeSenderEmail(message.email);setRuleEmail(email);setRuleFolder(senderFolderRules[email]||'');setRuleError('');setRoutingManager(true);setContextMenu(null)}
  const createFolder = async () => {
    const leaf=newFolderName.trim().replace(/^\/+|\/+$/g,'').replace(/\/+/g,' ')
    if(!leaf)return
    const name=newFolderParent?`${newFolderParent}/${leaf}`:`${FOLDER_ROOT}/${leaf}`
    setFolderBusy(true);setFolderError('')
    try{await window.snowfire?.gmail.createLabel(name);await refreshLabels();const next=[...folderOrder.filter(item=>item!==name),name];setFolderOrder(next);window.snowfire?.metadata.setFolderOrder(next).catch(()=>{});setNewFolderName('');flash(`Created ${folderName(name)}`)}
    catch(e){setFolderError(e instanceof Error?e.message:'Could not create the folder')}
    finally{setFolderBusy(false)}
  }
  const removeFolder = async () => {
    if(!confirmDeleteFolder)return
    const root=confirmDeleteFolder.name.toLowerCase()
    const removing=gmailLabels.filter(label=>label.name.toLowerCase()===root||label.name.toLowerCase().startsWith(`${root}/`))
    setFolderBusy(true);setFolderError('')
    try{
      await Promise.all(removing.map(label=>window.snowfire?.gmail.deleteLabel(label.id)))
      setGmailLabels(labels=>labels.filter(label=>!removing.some(item=>item.id===label.id)))
      const removedNames=new Set(removing.map(label=>label.name)),nextOrder=folderOrder.filter(name=>!removedNames.has(name));setFolderOrder(nextOrder);window.snowfire?.metadata.setFolderOrder(nextOrder).catch(()=>{})
      window.snowfire?.metadata.removeSenderFolderRules([...removedNames]).then(setSenderFolderRules).catch(()=>{})
      setConfirmDeleteFolder(null)
      if(removing.some(label=>label.id===activeLabelId))await openFolder('Inbox')
      flash(`Deleted ${folderName(confirmDeleteFolder.name)}${removing.length>1?' and its subfolders':''}`)
    }catch(e){setFolderError(e instanceof Error?e.message:'Could not delete the folder')}
    finally{setFolderBusy(false)}
  }
  const moveFolderInto = async (sourceName:string,targetName:string) => {
    setDraggingFolderName('');setFolderOrderTarget('')
    const source=folderLabels.find(label=>label.name===sourceName),target=folderLabels.find(label=>label.name===targetName)
    if(!source||!target||source.id===target.id)return
    if(folderContains(source.name,target.name)){flash('A folder cannot be moved into itself or one of its subfolders');return}
    const destinationRoot=`${target.name}/${folderName(source.name)}`
    if(destinationRoot===source.name){flash(`${folderName(source.name)} is already inside ${folderName(target.name)}`);return}
    const subtree=folderLabels.filter(label=>folderContains(source.name,label.name)).sort((a,b)=>folderDepth(a.name)-folderDepth(b.name)),mapping=Object.fromEntries(subtree.map(label=>[label.name,`${destinationRoot}${label.name.slice(source.name.length)}`])),movingIds=new Set(subtree.map(label=>label.id)),destinationNames=new Set(Object.values(mapping).map(name=>name.toLowerCase()))
    if(folderLabels.some(label=>!movingIds.has(label.id)&&destinationNames.has(label.name.toLowerCase()))){flash(`A folder named ${folderName(source.name)} already exists inside ${folderName(target.name)}`);return}
    setFolderBusy(true);setFolderError('')
    const renamed:GmailLabel[]=[]
    try{
      for(const label of subtree){await window.snowfire?.gmail.updateLabel(label.id,mapping[label.name]);renamed.push(label)}
      const references=await window.snowfire?.metadata.renameFolderReferences(mapping)
      if(references){setFolderOrder(references.order);setSenderFolderRules(references.rules)}
      const refreshed=await window.snowfire?.gmail.labels();if(refreshed)setGmailLabels(refreshed)
      setCollapsedFolders(current=>{const next=new Set([...current].map(name=>mapping[name]||name));next.delete(target.name);try{localStorage.setItem(COLLAPSED_FOLDERS_KEY,JSON.stringify([...next]))}catch{}return next})
      const activeFolder=folderLabels.find(label=>label.id===activeLabelId);if(activeFolder&&mapping[activeFolder.name])setFolder(folderName(mapping[activeFolder.name]))
      flash(`Moved ${folderName(source.name)} into ${folderName(target.name)}`)
    }catch(e){for(const label of [...renamed].reverse()){try{await window.snowfire?.gmail.updateLabel(label.id,label.name)}catch{}}try{await refreshLabels()}catch{}setFolderError(e instanceof Error?e.message:'Could not move that folder');flash('Folder move was rolled back')}
    finally{setFolderBusy(false)}
  }
  const reorderFolder = async (sourceName:string,targetName:string) => {
    setDraggingFolderName('');setFolderOrderTarget('')
    if(!sourceName||sourceName===targetName)return
    if(folderParent(sourceName)!==folderParent(targetName)){flash('Reorder folders within the same level');return}
    const current=orderedFolderLabels.map(label=>label.name),from=current.indexOf(sourceName),to=current.indexOf(targetName)
    if(from<0||to<0)return
    current.splice(from,1)
    const targetIndex=current.indexOf(targetName),insertAt=from<to?targetIndex+1:targetIndex
    current.splice(insertAt,0,sourceName)
    const previous=folderOrder
    setFolderOrder(current)
    try{await window.snowfire?.metadata.setFolderOrder(current)}catch(e){setFolderOrder(previous);flash(e instanceof Error?e.message:'Could not save folder order')}
  }
  const chooseLabelIcon = async (label:GmailLabel) => {try{const icon=await window.snowfire?.metadata.chooseLabelIcon(label.name);if(icon){setLabelIcons(current=>({...current,[label.name]:icon}));flash(`Updated ${label.name} icon`)}}catch(e){setLabelError(e instanceof Error?e.message:'Could not use that icon')}}
  const removeLabelIcon = async (label:GmailLabel) => {try{await window.snowfire?.metadata.removeLabelIcon(label.name);setLabelIcons(current=>{const next={...current};delete next[label.name];return next});flash(`Removed ${label.name} icon`)}catch(e){setLabelError(e instanceof Error?e.message:'Could not remove the icon')}}
  const removeGmailLabel = async () => {
    if(!confirmDeleteLabel)return
    const label=confirmDeleteLabel
    setLabelBusy(true);setLabelError('')
    try{
      await window.snowfire?.gmail.deleteLabel(label.id)
      if(labelIcons[label.name])await window.snowfire?.metadata.removeLabelIcon(label.name)
      const cleanedSenderLabels=await window.snowfire?.metadata.removeSenderLabel(label.name)
      setGmailLabels(labels=>labels.filter(item=>item.id!==label.id))
      setLabelIcons(current=>{const next={...current};delete next[label.name];return next})
      if(cleanedSenderLabels)setSenderLabels(cleanedSenderLabels)
      setMessages(items=>items.map(message=>({...message,labelIds:message.labelIds?.filter(id=>id!==label.id)})))
      setConfirmDeleteLabel(null)
      if(folder===label.name)await openFolder('Inbox')
      flash(`Deleted ${label.name}`)
    }catch(e){setLabelError(e instanceof Error?e.message:'Could not delete the label')}
    finally{setLabelBusy(false)}
  }
  const markReadState = async (message:Message) => {const makeUnread=!message.unread;setMessages(ms=>ms.map(m=>m.id===message.id?{...m,unread:makeUnread}:m));try{if(connected)await window.snowfire?.gmail.modify(message.id,makeUnread?['UNREAD']:[],makeUnread?[]:['UNREAD']);refreshMailboxIndicators(true);flash(makeUnread?'Marked unread':'Marked read')}catch(e){setMessages(ms=>ms.map(m=>m.id===message.id?{...m,unread:message.unread}:m));flash(e instanceof Error?e.message:'Could not update Gmail')}}
  const moveMessagesToFolder = async (ids:string[],target:GmailLabel) => {
    const chosen=messages.filter(message=>ids.includes(message.id))
    if(!chosen.length)return
    const previous=messages
    const otherFolderIds=folderLabels.filter(label=>label.id!==target.id).map(label=>label.id)
    const activeFolder=folderLabels.find(label=>label.id===activeLabelId),leavingCurrent=folder==='Inbox'||Boolean(activeFolder&&!folderContains(activeFolder.name,target.name))
    setDropLabelId(null);setDraggingIds([])
    setMessages(items=>leavingCurrent?items.filter(message=>!ids.includes(message.id)):items.map(message=>ids.includes(message.id)?{...message,labelIds:[...(message.labelIds||[]).filter(id=>!otherFolderIds.includes(id)&&id!==target.id),target.id]}:message))
    setSelectedIds(new Set())
    if(leavingCurrent&&selected&&ids.includes(selected))setSelected(null)
    try{
      if(connected)await Promise.all(chosen.map(message=>window.snowfire?.gmail.modify(message.id,[target.id],['INBOX',...otherFolderIds.filter(id=>message.labelIds?.includes(id))])))
      refreshMailboxIndicators(true)
      flash(`Moved ${chosen.length===1?'email':`${chosen.length} emails`} to ${folderName(target.name)}`)
    }catch(e){setMessages(previous);flash(e instanceof Error?e.message:'Could not move the email')}
  }
  const toggleLabel = async (message:Message,label:GmailLabel) => {const email=normalizeSenderEmail(message.email),hasLabel=messageHasLabel(message,label),related=messages.filter(item=>normalizeSenderEmail(item.email)===email),targets=related.filter(item=>hasLabel?item.labelIds?.includes(label.id):!item.labelIds?.includes(label.id)),previousRules=senderLabels,nextRules={...senderLabels},currentNames=nextRules[email]||[];nextRules[email]=hasLabel?currentNames.filter(name=>name.toLowerCase()!==label.name.toLowerCase()):currentNames.some(name=>name.toLowerCase()===label.name.toLowerCase())?currentNames:[...currentNames,label.name];setSenderLabels(nextRules);setMessages(items=>items.map(item=>normalizeSenderEmail(item.email)===email?{...item,labelIds:hasLabel?(item.labelIds||[]).filter(id=>id!==label.id):[...(item.labelIds||[]).filter(id=>id!==label.id),label.id]}:item));setContextMenu(current=>current?{...current,message:{...current.message,labelIds:hasLabel?(current.message.labelIds||[]).filter(id=>id!==label.id):[...(current.message.labelIds||[]).filter(id=>id!==label.id),label.id]}}:null);try{await Promise.all([...(connected?targets.map(item=>window.snowfire?.gmail.modify(item.id,hasLabel?[]:[label.id],hasLabel?[label.id]:[])):[]),window.snowfire?.metadata.setSenderLabels(email,nextRules[email])]);flash(hasLabel?`Removed ${label.name} from ${message.sender}`:`Classified ${message.sender} as ${label.name}`)}catch(e){setSenderLabels(previousRules);setMessages(items=>items.map(item=>{const original=related.find(previous=>previous.id===item.id);return original||item}));flash(e instanceof Error?e.message:'Could not update Gmail')}}
  useEffect(()=>{if(!contextMenu)return;const close=()=>setContextMenu(null);window.addEventListener('click',close);window.addEventListener('blur',close);return()=>{window.removeEventListener('click',close);window.removeEventListener('blur',close)}},[contextMenu])
  useEffect(()=>{if(!folderContextMenu)return;const close=()=>setFolderContextMenu(null);window.addEventListener('click',close);window.addEventListener('blur',close);return()=>{window.removeEventListener('click',close);window.removeEventListener('blur',close)}},[folderContextMenu])
  useEffect(()=>{if(!snoozeMenuOpen)return;const close=(event:MouseEvent)=>{if(!(event.target instanceof Element)||!event.target.closest('.snooze-anchor'))setSnoozeMenuOpen(false)};window.addEventListener('click',close);return()=>window.removeEventListener('click',close)},[snoozeMenuOpen])
  useEffect(()=>{if(!senderDetailsOpen)return;const close=(event:MouseEvent)=>{if(!(event.target instanceof Element)||!event.target.closest('.sender-details-anchor'))setSenderDetailsOpen(false)};window.addEventListener('click',close);return()=>window.removeEventListener('click',close)},[senderDetailsOpen])
  useEffect(()=>{
    const onKeyDown=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement|null
      const key=event.key.toLowerCase()
      if(key==='escape'){setCompose(false);setContactSeed(null);setCalendarEditorOpen(false);setEditingCalendarEvent(null);setCalendarSeedEndDate(null);setCalendarSeedMessage(null);setScheduleMessage(null);setMobileNavOpen(false);setResponseMode(null);setContextMenu(null);setFolderContextMenu(null);setLabelManager(false);setFolderManager(false);setRoutingManager(false);setSettingsOpen(false);setSnoozeMenuOpen(false);setSenderDetailsOpen(false);setConfirmDeleteLabel(null);setConfirmDeleteFolder(null);setSelectedIds(new Set());return}
      if((event.ctrlKey||event.metaKey)&&key==='k'){event.preventDefault();(document.querySelector('.search input') as HTMLInputElement|null)?.focus();return}
      if(target?.matches('input, textarea, [contenteditable="true"]')) return
      if((event.ctrlKey||event.metaKey)&&key==='a'){event.preventDefault();setSelectedIds(new Set(visible.map(message=>message.id)));setContextMenu(null);flash(`${visible.length} email${visible.length===1?'':'s'} selected`);return}
      if((event.ctrlKey||event.metaKey)&&key==='z'){if(lastDeleted){event.preventDefault();undoDelete()}return}
      if(event.ctrlKey||event.metaKey||event.altKey)return
      if(event.key==='Delete'){if(folder!=='Trash'&&(selectedIds.size||active)){event.preventDefault();moveToTrash()}return}
      if(key==='c'){event.preventDefault();setCompose(true)}
      else if(key==='r'&&active){event.preventDefault();beginResponse('reply')}
      else if(key==='e'&&active){event.preventDefault();archive()}
      else if((key==='j'||key==='k')&&visible.length){event.preventDefault();const index=Math.max(0,visible.findIndex(m=>m.id===selected));const next=key==='j'?Math.min(visible.length-1,index+1):Math.max(0,index-1);selectMessage(visible[next].id)}
    }
    window.addEventListener('keydown',onKeyDown)
    return()=>window.removeEventListener('keydown',onKeyDown)
  },[active,connected,folder,lastDeleted,messages,selected,selectedIds,visible])

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNavOpen?'mobile-open':''}`}>
      <div className="brand"><img src="./brand/snowfire_logo_title_right_light.svg" alt="SnowFire"/></div>
      <button className="compose-btn" onClick={() => setCompose(true)}><PenLine size={17}/> Compose <span className="shortcut">C</span></button>
      <button className={folder==='Calendar'?'nav-item calendar-nav active':'nav-item calendar-nav'} onClick={()=>openFolder('Calendar')}><CalendarDays size={17}/><span>Calendar</span></button>
      <button className={folder==='Contacts'?'nav-item contacts-nav active':'nav-item contacts-nav'} onClick={()=>openFolder('Contacts')}><UsersRound size={17}/><span>Contacts</span></button>
      <nav><div className="mailbox-inbox-row"><button className={folder==='Inbox'?'nav-item active':'nav-item'} onClick={()=>openFolder('Inbox')}><Inbox size={17}/><span>Inbox</span>{(mailboxCounts.Inbox||0)>0&&<b>{mailboxCounts.Inbox}</b>}</button><button className="mailbox-toggle" aria-label={mailboxesOpen?'Collapse mailboxes':'Expand mailboxes'} aria-expanded={mailboxesOpen} title={mailboxesOpen?'Collapse mailboxes':'Show Starred, Sent, Drafts, Archive, and Trash'} onClick={()=>setMailboxesOpen(open=>!open)}><ChevronDown className={mailboxesOpen?'open':''} size={14}/></button></div>
        <div className="folder-heading promoted-folder-nav"><button className={folder==='Folders'?'nav-item folder-dashboard-link active':'nav-item folder-dashboard-link'} onClick={()=>openFolder('Folders')}><Folder size={17}/><span>Folders</span></button><button className="folder-tree-toggle" aria-label={foldersOpen?'Collapse folder tree':'Expand folder tree'} aria-expanded={foldersOpen} title={foldersOpen?'Collapse folder tree':'Expand folder tree'} onClick={()=>setFoldersOpen(open=>!open)}><ChevronDown className={foldersOpen?'open':''} size={13}/></button><button aria-label="Add folder" title="Add folder" disabled={!connected} onClick={()=>beginFolderCreate('')}><Plus size={13}/></button></div>
        {foldersOpen&&<div className="sidebar-folder-list" role="tree">{orderedFolderLabels.length?visibleFolderLabels.map(label=>{const depth=Math.min(4,folderDepth(label.name)),unread=folderUnreadCount(label.name),hasChildren=folderLabels.some(child=>folderParent(child.name)===label.name),collapsed=collapsedFolders.has(label.name);return <div draggable={!folderBusy} role="treeitem" aria-level={depth+1} aria-expanded={hasChildren?!collapsed:undefined} style={{'--folder-depth':depth} as CSSProperties} className={`${activeLabelId===label.id?'nav-item folder-item active':'nav-item folder-item'}${draggingIds.length?' drop-ready':''}${dropLabelId===label.id?' drop-hover':''}${draggingFolderName===label.name?' ordering':''}${folderOrderTarget===label.name?' folder-nest-target':''}`} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setFolderContextMenu({x:Math.min(event.clientX,window.innerWidth-236),y:Math.min(event.clientY,window.innerHeight-118),label})}} onDragStart={event=>{setDraggingFolderName(label.name);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-snowfire-folder',label.name)}} onDragEnter={event=>{if(draggingFolderName){if(draggingFolderName===label.name||folderContains(draggingFolderName,label.name))return;event.preventDefault();setFolderOrderTarget(label.name);return}if(!draggingIds.length)return;event.preventDefault();setDropLabelId(label.id)}} onDragOver={event=>{if(draggingFolderName){if(draggingFolderName===label.name||folderContains(draggingFolderName,label.name))return;event.preventDefault();event.dataTransfer.dropEffect='move';setFolderOrderTarget(label.name);return}if(!draggingIds.length)return;event.preventDefault();event.dataTransfer.dropEffect='move'}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)){setDropLabelId(current=>current===label.id?null:current);setFolderOrderTarget(current=>current===label.name?'':current)}}} onDrop={event=>{event.preventDefault();const source=event.dataTransfer.getData('application/x-snowfire-folder')||draggingFolderName;if(source){moveFolderInto(source,label.name);return}const ids=draggingIds.length?draggingIds:event.dataTransfer.getData('application/x-snowfire-message-ids').split(',').filter(Boolean);moveMessagesToFolder(ids,label)}} onDragEnd={()=>{setDraggingFolderName('');setFolderOrderTarget('')}} key={label.id}>{hasChildren?<button className="folder-disclosure" aria-label={collapsed?`Expand ${folderName(label.name)}`:`Collapse ${folderName(label.name)}`} title={collapsed?'Expand subfolders':'Collapse subfolders'} onClick={()=>toggleFolderCollapse(label.name)}><ChevronDown className={collapsed?'':'open'} size={12}/></button>:<span className="folder-disclosure-spacer"/>}<button className="folder-open" title={`Open ${folderName(label.name)} · right-click for folder options`} onClick={()=>openFolder(folderParts(label.name).join(' / '),label.id)}><span className={`folder-glyph ${hasChildren?'parent':''}`}><Folder size={13}/></span><span>{folderName(label.name)}</span>{dropLabelId===label.id&&draggingIds.length?<b className="drop-count">+{draggingIds.length}</b>:unread>0&&<b>{unread}</b>}</button></div>}):<button className="empty-folders" onClick={()=>beginFolderCreate('')}><Plus size={11}/> Add your first folder</button>}</div>}
        {mailboxesOpen&&nav.slice(1,-1).map(([name, Icon]) => <button key={name} className={folder===name?'nav-item active':'nav-item'} onClick={() => openFolder(name)}><Icon size={17}/><span>{name}</span>{(mailboxCounts[name]||0)>0&&<b>{mailboxCounts[name]}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><button className="nav-item" onClick={()=>setSettingsOpen(true)}><Settings size={17}/>Settings</button></div>
    </aside>{mobileNavOpen&&<button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={()=>setMobileNavOpen(false)}/>}

    <main className="workspace">
      <header className="topbar"><button className="icon-btn mobile" aria-label="Open navigation" onClick={()=>setMobileNavOpen(true)}><Menu size={20}/></button><div className="search"><Search className={searchLoading?'search-spin':''} size={18}/><input value={query} onChange={e=>{const value=e.target.value;setQuery(value);if(!value&&folder==='Search')openFolder('Inbox')}} placeholder="Search all Gmail"/><span>Ctrl K</span></div><span className="topbar-spacer"/><div className="window-controls"><button aria-label="Minimize" title="Minimize" onClick={()=>window.snowfire?.windowAction('minimize')}><Minus size={15}/></button><button aria-label="Maximize" title="Maximize" onClick={()=>window.snowfire?.windowAction('maximize')}><Square size={12}/></button><button className="window-close" aria-label="Close" title="Close" onClick={()=>window.snowfire?.windowAction('close')}><X size={15}/></button></div></header>
      <div className={`content ${folder==='Calendar'?'calendar-content':folder==='Folders'?'folder-dashboard-content':'with-day-column'}`}>
        {folder==='Calendar'?<CalendarWorkspace refreshToken={calendarRefreshToken} onMoved={loadCalendar} onEdit={event=>{setEditingCalendarEvent(event);setCalendarSeedDate(null);setCalendarSeedEndDate(null);setCalendarSeedMessage(null);setCalendarEditorOpen(true)}} onCreate={(date,end)=>{if(date&&end){openCalendarRange(date,end);return}setEditingCalendarEvent(null);setCalendarSeedMessage(null);setCalendarSeedEndDate(null);setCalendarSeedDate(date||new Date());setCalendarEditorOpen(true)}}/>:folder==='Folders'?<FolderDashboard folders={topLevelFolderLabels} allFolders={folderLabels} messagesByFolder={folderDashboardMessages} loading={folderDashboardLoading} error={folderDashboardError} folderNameInput={newFolderName} parent={newFolderParent} busy={folderBusy} createError={folderError} onRefresh={loadFolderDashboard} onOpenFolder={label=>openFolder(folderName(label.name),label.id)} onOpenMessage={(label,message)=>openFolder(folderName(label.name),label.id,message.id)} onStartCreate={beginFolderCreate} onNameChange={setNewFolderName} onParentChange={setNewFolderParent} onCreate={event=>{event.preventDefault();createFolder()}}/>:<><div className="primary-column">{folder==='Contacts'?<ContactsView composeTo={email=>{setDraft(current=>({...current,to:email}));setCompose(true)}} onContactsLoaded={setRecipientContacts} onContactSaved={rememberContact}/>:<>
        <section className={selected?'mail-list has-reader':'mail-list'}>
          <div className={`list-head ${selectedIds.size?'selection-active':''}`}><div><h1>{selectedIds.size?`${selectedIds.size} selected`:folder}</h1><span>{selectedIds.size?'Ctrl A selects all':query.trim()?`${messages.length} result${messages.length===1?'':'s'}`:`${messages.filter(m=>m.unread).length} unread`}</span></div><div>{selectedIds.size?<><button className="icon-btn" title={folder==='Archive'?'Move selected to inbox':'Archive selected'} onClick={archive}>{folder==='Archive'?<Inbox size={17}/>:<Archive size={17}/>}</button><button className={`icon-btn ${folder==='Trash'?'':'destructive-icon'}`} title={folder==='Trash'?'Restore selected to inbox':'Move selected to trash'} onClick={moveToTrash}>{folder==='Trash'?<Inbox size={17}/>:<Trash2 size={17}/>}</button><button className="icon-btn" title="Clear selection" onClick={()=>setSelectedIds(new Set())}><X size={17}/></button></>:<button className={`icon-btn ${syncing?'spinning':''}`} title="Refresh mailbox" onClick={sync}><RefreshCw size={17}/></button>}</div></div>
          <div className="message-list">{mailboxLoading?<div className="mailbox-state"><RefreshCw className="spin-icon" size={21}/><b>Loading {folder}</b><span>Syncing with Gmail</span></div>:visible.length===0?<div className="mailbox-state empty"><Inbox size={24}/><b>Nothing in {folder}</b><span>This mailbox is clear.</span></div>:visible.map(m=>{const meta=messageMeta(m,gmailLabels,labelIcons,senderLabels);return <article key={m.id} style={{'--meta-color':meta.color} as CSSProperties} draggable onDragStart={event=>{const ids=selectedIds.has(m.id)?Array.from(selectedIds):[m.id];setDraggingIds(ids);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-snowfire-message-ids',ids.join(','));event.dataTransfer.setData('application/x-snowfire-email-id',m.id);event.dataTransfer.setData('text/plain',m.subject)}} onDragEnd={()=>{setDraggingIds([]);setDropLabelId(null)}} onClick={()=>selectMessage(m.id)} onContextMenu={event=>{event.preventDefault();setSelected(m.id);setShowContextLabels(false);setContextMenu({x:Math.min(event.clientX,window.innerWidth-224),y:Math.min(event.clientY,window.innerHeight-286),message:m})}} className={`${selected===m.id?'selected ':''}${selectedIds.has(m.id)?'bulk-selected ':''}${draggingIds.includes(m.id)?'dragging ':''}${m.unread?'unread':''}`}>
            <i className="meta-rail" aria-hidden="true"/>
            <button className={`mail-select ${selectedIds.has(m.id)?'checked':''}`} aria-label={selectedIds.has(m.id)?`Deselect ${m.subject}`:`Select ${m.subject}`} aria-pressed={selectedIds.has(m.id)} onClick={event=>{event.stopPropagation();toggleMessageSelection(m.id)}}>{selectedIds.has(m.id)&&<Check size={12}/>}</button>
            <div className="message-copy">
              <div className={`message-meta-overline ${meta.tone}`} style={{color:meta.color}}><MetaIcon meta={meta}/><span>{meta.label}</span></div>
              <div className="sender-line"><b>{m.sender}</b><time>{m.time}</time></div>
              <strong>{m.subject}</strong><p>{m.preview}</p>
            </div>
            <button className="star-btn" aria-label="Star" onClick={e=>{e.stopPropagation();toggleStar(m.id)}}><Star size={16} fill={m.starred?'currentColor':'none'} /></button>
          </article>})}</div>
        </section>

        {active && <section className="reader">
          <div className="reader-tools"><button className="icon-btn back" aria-label="Back to message list" onClick={()=>setSelected(null)}><ArrowLeft size={18}/></button><button className="icon-btn" title={folder==='Archive'?'Move to inbox':'Archive'} onClick={archive}>{folder==='Archive'?<Inbox size={18}/>:<Archive size={18}/>}</button><button className="icon-btn" title={folder==='Trash'?'Restore to inbox':'Move to trash'} onClick={moveToTrash}>{folder==='Trash'?<Inbox size={18}/>:<Trash2 size={18}/>}</button>{folder==='Snoozed'?<button className="icon-btn" title="Return to inbox now" onClick={unsnoozeMessage}><Clock3 size={18}/></button>:<div className="snooze-anchor"><button className={`icon-btn ${snoozeMenuOpen?'active':''}`} title="Snooze" onClick={()=>setSnoozeMenuOpen(value=>!value)}><Clock3 size={18}/></button>{snoozeMenuOpen&&<div className="snooze-popover"><b>Snooze until</b><button onClick={()=>snoozeMessage(Date.now()+3*60*60*1000)}><span>Later today</span><small>In 3 hours</small></button><button onClick={()=>{const date=new Date();date.setDate(date.getDate()+1);date.setHours(8,0,0,0);snoozeMessage(date.getTime())}}><span>Tomorrow</span><small>8:00 AM</small></button><button onClick={()=>{const date=new Date();date.setDate(date.getDate()+7);date.setHours(8,0,0,0);snoozeMessage(date.getTime())}}><span>Next week</span><small>8:00 AM</small></button></div>}</div>}<span/></div>
          <div className="reader-inner"><div className="subject-line"><h2>{active.subject}</h2><button aria-label={active.starred?'Remove star':'Star message'} onClick={()=>toggleStar(active.id)}><Star size={19} fill={active.starred?'currentColor':'none'}/></button></div>
            <div className="email-meta"><span className="sender-avatar large" style={{background:active.color}}>{active.initials}</span><div className="sender-summary"><b>{active.sender}</b>{activeMeta&&<div className="reader-meta-line" style={{color:activeMeta.color}}><MetaIcon meta={activeMeta} size={12}/><span>{activeMeta.label}{activeMeta.detail&&activeMeta.detail!==activeMeta.label?` · ${activeMeta.detail}`:''}</span></div>}<div className="sender-details-anchor"><button className={senderDetailsOpen?'sender-details-toggle active':'sender-details-toggle'} aria-expanded={senderDetailsOpen} onClick={()=>setSenderDetailsOpen(open=>!open)}>to me <ChevronDown size={12}/></button>{senderDetailsOpen&&<div className="sender-details-popover" role="dialog" aria-label="Sender information"><header><span className="sender-avatar" style={{background:active.color}}>{active.initials}</span><div><b>{active.sender}</b><small>{active.email}</small></div></header><dl><div><dt>From</dt><dd><b>{active.sender}</b><small>{active.email}</small></dd></div><div><dt>To</dt><dd>{account||'me'}</dd></div><div><dt>Date</dt><dd>{active.date}, {active.time}</dd></div><div><dt>Domain</dt><dd>{emailDomain(active.email)||'Unknown'}</dd></div>{activeMeta&&<div><dt>Classification</dt><dd>{activeMeta.label}{activeMeta.detail&&activeMeta.detail!==activeMeta.label?` · ${activeMeta.detail}`:''}</dd></div>}</dl></div>}</div></div><button className="schedule-email" title="Schedule time to handle this email" onClick={()=>setScheduleMessage(active)}><CalendarDays size={13}/> Schedule</button><button className="add-sender-contact" title={`Add ${active.sender} to Google Contacts`} onClick={()=>setContactSeed(contactDraftForMessage(active))}><UserPlus size={13}/> Add contact</button><time>{active.date}, {active.time}</time></div>
            {!responseMode ? <div className="response-actions reader-response-actions"><button onClick={()=>beginResponse('reply')}><Reply size={17}/> Reply</button><button onClick={()=>beginResponse('forward')}><Send size={16}/> Forward</button></div> : <div className="inline-reply reader-response-editor" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.repeat){event.preventDefault();sendResponse()}}}><div>{responseMode==='reply'?<>Replying to <b>{active.sender}</b></>:<><b>Forward message</b></>}</div><label className="inline-recipient"><span>To</span><RecipientInput autoFocus={responseMode==='forward'} contacts={recipientContacts} value={responseDraft.to} onChange={to=>setResponseDraft(current=>({...current,to}))}/></label><textarea autoFocus={responseMode==='reply'} value={responseDraft.body} onChange={event=>setResponseDraft(current=>({...current,body:event.target.value}))} placeholder={responseMode==='reply'?'Write a reply…':'Add a note…'}/>{!!responseDraft.attachments.length&&<div className="outgoing-files">{responseDraft.attachments.map((file,index)=><span key={`${file.filename}-${index}`}><Paperclip size={12}/><b>{file.filename}</b><button aria-label={`Remove ${file.filename}`} onClick={()=>setResponseDraft(current=>({...current,attachments:current.attachments.filter((_,fileIndex)=>fileIndex!==index)}))}><X size={12}/></button></span>)}</div>}<footer><button className="send-btn" title="Send in 60 seconds (Ctrl+Enter)" disabled={sending} onClick={sendResponse}><Send size={15}/> {sending?'Queueing…':responseMode==='reply'?'Send reply':'Forward'}</button><button className="icon-btn" title="Attach files" onClick={()=>chooseOutgoingFiles('response')}><Paperclip size={17}/></button><span/><button className="icon-btn" title="Discard" onClick={()=>setResponseMode(null)}><Trash2 size={17}/></button></footer></div>}
            {!!active.attachments?.length&&<div className="attachment-shelf"><header><h3><Paperclip size={13}/>{active.attachments.length} attachment{active.attachments.length===1?'':'s'}</h3><button title="Download all attachments" onClick={async()=>{const directory=await window.snowfire?.gmail.saveAllAttachments(active.id,active.attachments||[]);if(directory)flash(`Attachments saved`)}}><Download size={14}/><span>Download all</span></button></header><div className="attachment-items">{active.attachments.map(file=>{const AttachmentIcon=iconForAttachment(file);return <div className="attachment-item" key={file.id}><button className="attachment-open" title={`Open ${file.filename}`} onClick={async()=>{try{await window.snowfire?.gmail.openAttachment(active.id,file)}catch(e){flash(e instanceof Error?e.message:'Could not open attachment')}}}><AttachmentIcon size={15}/><span><b>{file.filename}</b><small>{formatBytes(file.size)}</small></span></button><button className="attachment-download" aria-label={`Download ${file.filename}`} title="Save as" onClick={async()=>{const saved=await window.snowfire?.gmail.saveAttachment(active.id,file);if(saved)flash(`${file.filename} saved`)}}><Download size={13}/></button></div>})}</div></div>}
            {active.remoteImagesBlocked&&<button className="remote-images" onClick={()=>showRemoteImages(active)}><Eye size={14}/><span>Remote images are blocked for your privacy</span><b>Load images</b></button>}
            {active.bodyHtml ? <EmailDocument message={active}/> : <div className="email-body">{active.body.split('\n').map((line,i)=><p key={i}>{line||'\u00a0'}</p>)}</div>}
          </div>
        </section>}
        </>}</div><aside className="day-column" aria-label="Today’s calendar"><TodayAgenda events={calendarEvents} loading={calendarLoading} error={calendarError} emailDragging={draggingIds.length>0} onRefresh={loadCalendar} onOpen={()=>openFolder('Calendar')} onEmailDrop={openDroppedEmailEvent} onEventMove={moveTodayCalendarEvent} onCreateRange={openCalendarRange} onCreate={()=>{setEditingCalendarEvent(null);setCalendarSeedMessage(null);setCalendarSeedEndDate(null);setCalendarSeedDate(new Date());setCalendarEditorOpen(true)}} onEdit={event=>{setEditingCalendarEvent(event);setCalendarSeedDate(null);setCalendarSeedEndDate(null);setCalendarSeedMessage(null);setCalendarEditorOpen(true)}}/></aside></>}
      </div>
    </main>

    {compose&&<div className="compose-window" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.repeat){event.preventDefault();sendDraft()}}}><header><div><span className="tiny-flame"><Flame size={14}/></span>New message</div><button aria-label="Close compose" onClick={()=>setCompose(false)}><X size={17}/></button></header><div className="field"><span>To</span><RecipientInput autoFocus contacts={recipientContacts} value={draft.to} onChange={to=>setDraft(current=>({...current,to}))}/></div><div className="field"><input value={draft.subject} onChange={e=>setDraft({...draft,subject:e.target.value})} placeholder="Subject"/></div><textarea value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})} placeholder="Write something thoughtful…"/>{!!draft.attachments.length&&<div className="outgoing-files">{draft.attachments.map((file,index)=><span key={`${file.filename}-${index}`}><Paperclip size={12}/><b>{file.filename}</b><small>{formatBytes(file.size)}</small><button aria-label={`Remove ${file.filename}`} onClick={()=>setDraft(current=>({...current,attachments:current.attachments.filter((_,fileIndex)=>fileIndex!==index)}))}><X size={12}/></button></span>)}</div>}<footer><button className="send-btn" title="Send in 60 seconds (Ctrl+Enter)" disabled={sending} onClick={sendDraft}><Send size={15}/> {sending?'Queueing…':'Send'}</button><button className="icon-btn" title="Attach files" onClick={()=>chooseOutgoingFiles('compose')}><Paperclip size={18}/></button><span/><button className="icon-btn" title="Discard draft" onClick={()=>{setCompose(false);setDraft(newOutgoingMessage())}}><Trash2 size={18}/></button></footer></div>}
    {calendarEditorOpen&&<CalendarEventEditor key={editingCalendarEvent?.id||calendarSeedMessage?.id||calendarSeedDate?.toISOString()||'new-calendar-event'} event={editingCalendarEvent} seedDate={calendarSeedDate} seedEndDate={calendarSeedEndDate} seedMessage={calendarSeedMessage} onClose={()=>{setCalendarEditorOpen(false);setEditingCalendarEvent(null);setCalendarSeedDate(null);setCalendarSeedEndDate(null);setCalendarSeedMessage(null)}} onSaved={()=>{setCalendarEditorOpen(false);setEditingCalendarEvent(null);setCalendarSeedDate(null);setCalendarSeedEndDate(null);setCalendarSeedMessage(null);loadCalendar();setCalendarRefreshToken(value=>value+1);flash(editingCalendarEvent?'Calendar event updated':calendarSeedMessage?'Email added to calendar':'Calendar event created')}} onDeleted={()=>{setCalendarEditorOpen(false);setEditingCalendarEvent(null);setCalendarSeedDate(null);setCalendarSeedEndDate(null);setCalendarSeedMessage(null);loadCalendar();setCalendarRefreshToken(value=>value+1);flash('Calendar event deleted')}}/>}
    {scheduleMessage&&<EmailScheduleModal key={scheduleMessage.id} message={scheduleMessage} onClose={()=>setScheduleMessage(null)} onCreated={()=>{setScheduleMessage(null);loadCalendar();setCalendarRefreshToken(value=>value+1);flash('Focus time added to Google Calendar')}}/>}
    {contactSeed&&<ContactEditor key={contactSeed.emails.join(',')} seed={contactSeed} onClose={()=>setContactSeed(null)} onSaved={contact=>{rememberContact(contact);setContactSeed(null);flash(`${contact.name} added to contacts`)}}/>}
    {settingsOpen&&<div className="label-modal-backdrop" onMouseDown={()=>setSettingsOpen(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={event=>event.stopPropagation()}><header><div><span>SNOWFIRE MAIL</span><h2 id="settings-title">Settings</h2></div><button aria-label="Close settings" onClick={()=>setSettingsOpen(false)}><X size={18}/></button></header><div className="settings-connection"><div className="usage"><span>{connected?'Gmail connected':'Local preview'}</span><b>{connected?'Live sync':'Sample data'}</b><div><i/></div></div>{account&&<small>{account}</small>}</div><div className="settings-section"><div className="settings-icon"><ShieldCheck size={18}/></div><div><b>Privacy</b><p>Remote images can reveal when and where you opened an email. They are blocked by default.</p></div></div><label className="settings-toggle"><span><b>Load remote images automatically</b><small>You can always load them for one message from the reader.</small></span><input type="checkbox" checked={settings.remoteImages} onChange={event=>updateRemoteImageSetting(event.target.checked)}/><i/></label><button className="settings-action" disabled={!connected} onClick={()=>{setSettingsOpen(false);setLabelError('');setLabelManager(true)}}><span className="settings-action-icon"><Tag size={17}/></span><span><b>Manage labels</b><small>Create classifications, organize customer sub-labels, and assign custom icons.</small></span><ChevronDown size={14}/></button><button className="settings-action" disabled={!connected} onClick={()=>{setSettingsOpen(false);setRuleError('');setRoutingManager(true)}}><span className="settings-action-icon"><FolderInput size={17}/></span><span><b>Routing rules</b><small>Auto-route Inbox mail to folders using exact sender addresses.</small></span><ChevronDown size={14}/></button><div className="settings-section storage"><div className="settings-icon"><ShieldCheck size={18}/></div><div><b>{credentialStorage==='local'?'Credentials saved locally':'Credentials protected'}</b><p>{credentialStorage==='keyring'?'Your Gmail connection is stored in your operating system keyring and restored automatically.':credentialStorage==='encrypted'?'Your Gmail connection is encrypted by your operating system and restored automatically.':'This system has no credential service, so SnowFire uses a permission-locked local credentials file.'}</p></div></div>{connected&&<footer><div><b>{account}</b><small>Connected Google account</small></div><button onClick={disconnectGmail}><LogOut size={15}/> Disconnect</button></footer>}</section></div>}
    {labelManager&&<div className="label-modal-backdrop" onMouseDown={()=>{if(!labelBusy){setLabelManager(false);setConfirmDeleteLabel(null)}}}><section className="label-manager" role="dialog" aria-modal="true" aria-labelledby="label-manager-title" onMouseDown={event=>event.stopPropagation()}>
      <header><div><span className="label-manager-kicker">GMAIL / LIVE SYNC</span><h2 id="label-manager-title">Manage labels</h2><p>Labels drive classification. Upload an icon for any level; the deepest matching label wins.</p></div><button className="label-manager-close" aria-label="Close label manager" disabled={labelBusy} onClick={()=>{setLabelManager(false);setConfirmDeleteLabel(null)}}><X size={18}/></button></header>
      {!classificationLabels.some(label=>labelRoot(label.name).toLowerCase()==='customer')&&<button className="customer-setup" disabled={labelBusy} onClick={createCustomerRoot}><BriefcaseBusiness size={16}/><span><b>Create Customer classification</b><small>Add individual clients underneath it, such as Customer/Walmart.</small></span><Plus size={15}/></button>}
      <form className="label-create" onSubmit={event=>{event.preventDefault();createGmailLabel()}}><select aria-label="Parent label" value={newLabelParent} onChange={event=>setNewLabelParent(event.target.value)}><option value="">Top level</option>{classificationLabels.filter(label=>labelDepth(label.name)===0).map(label=><option key={label.id} value={label.name}>Under {label.name}</option>)}</select><input autoFocus value={newLabelName} maxLength={225} onChange={event=>setNewLabelName(event.target.value)} placeholder={newLabelParent?`New ${newLabelParent} sub-label`:'New label name'}/><button disabled={labelBusy||!newLabelName.trim()}><Plus size={15}/>{labelBusy?'Working…':'Create'}</button></form>
      {labelError&&<div className="label-manager-error">{labelError}</div>}
      <div className="label-manager-list">{classificationLabels.length?classificationLabels.map(label=><div className="label-manager-row" style={{'--label-depth':Math.min(3,labelDepth(label.name))} as CSSProperties} key={label.id}><button className="label-icon-picker" aria-label={`Choose icon for ${label.name}`} title={`Choose icon for ${label.name}`} disabled={labelBusy} onClick={()=>chooseLabelIcon(label)}>{labelIcons[label.name]?<img src={labelIcons[label.name]} alt=""/>:<LabelGlyph name={label.name} icons={labelIcons} size={16}/>}<ImagePlus className="label-icon-add" size={10}/></button><div><b>{labelLeaf(label.name)}</b><small>{labelDepth(label.name)>0?`${labelRoot(label.name)} · `:''}{label.messagesTotal||0} message{label.messagesTotal===1?'':'s'}</small></div>{labelIcons[label.name]&&<button className="clear-label-icon" aria-label={`Remove icon from ${label.name}`} title="Remove custom icon" disabled={labelBusy} onClick={()=>removeLabelIcon(label)}><X size={14}/></button>}<button aria-label={`Delete ${label.name}`} title={`Delete ${label.name}`} disabled={labelBusy} onClick={()=>{setLabelError('');setConfirmDeleteLabel(label)}}><Trash2 size={15}/></button></div>):<div className="label-manager-empty"><Tag size={20}/><span>No classifications yet</span></div>}</div>
      {confirmDeleteLabel&&<div className="label-delete-confirm"><div><span><Trash2 size={18}/></span><h3>Delete “{confirmDeleteLabel.name}”?</h3><p>This removes the label from Gmail and every message that uses it. Your emails will not be deleted.</p><footer><button disabled={labelBusy} onClick={()=>setConfirmDeleteLabel(null)}>Cancel</button><button className="delete-label-button" disabled={labelBusy} onClick={removeGmailLabel}>{labelBusy?'Deleting…':'Delete label'}</button></footer></div></div>}
    </section></div>}
    {folderManager&&<div className="label-modal-backdrop" onMouseDown={()=>{if(!folderBusy){setFolderManager(false);setConfirmDeleteFolder(null)}}}><section className="label-manager folder-manager" role="dialog" aria-modal="true" aria-labelledby="folder-manager-title" onMouseDown={event=>event.stopPropagation()}>
      <header><div><span className="label-manager-kicker">GMAIL / ORGANIZATION</span><h2 id="folder-manager-title">Folders</h2><p>Create nested folders and drag the grip to reorder folders within the same level.</p></div><button className="label-manager-close" aria-label="Close folder manager" disabled={folderBusy} onClick={()=>{setFolderManager(false);setConfirmDeleteFolder(null)}}><X size={18}/></button></header>
      <form className="label-create folder-create" onSubmit={event=>{event.preventDefault();createFolder()}}><select aria-label="Parent folder" value={newFolderParent} onChange={event=>setNewFolderParent(event.target.value)}><option value="">Top level</option>{orderedFolderLabels.map(label=><option key={label.id} value={label.name}>Under {folderParts(label.name).join(' / ')}</option>)}</select><input autoFocus value={newFolderName} maxLength={180} onChange={event=>setNewFolderName(event.target.value)} placeholder={newFolderParent?'New subfolder name':'New folder name'}/><button disabled={folderBusy||!newFolderName.trim()}><Plus size={15}/>{folderBusy?'Working…':'Create'}</button></form>
      {folderError&&<div className="label-manager-error">{folderError}</div>}
      <div className="label-manager-list folder-order-list">{orderedFolderLabels.length?orderedFolderLabels.map(label=>{const total=folderMessageCount(label.name),hasChildren=folderLabels.some(child=>folderParent(child.name)===label.name);return <div draggable={!folderBusy} onDragStart={event=>{setDraggingFolderName(label.name);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-snowfire-folder',label.name)}} onDragEnter={event=>{if(!draggingFolderName||draggingFolderName===label.name)return;event.preventDefault();if(folderParent(draggingFolderName)===folderParent(label.name))setFolderOrderTarget(label.name)}} onDragOver={event=>{if(folderParent(draggingFolderName)!==folderParent(label.name))return;event.preventDefault();event.dataTransfer.dropEffect='move'}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setFolderOrderTarget(current=>current===label.name?'':current)}} onDrop={event=>{event.preventDefault();reorderFolder(event.dataTransfer.getData('application/x-snowfire-folder')||draggingFolderName,label.name)}} onDragEnd={()=>{setDraggingFolderName('');setFolderOrderTarget('')}} className={`label-manager-row folder-manager-row${draggingFolderName===label.name?' ordering':''}${folderOrderTarget===label.name?' order-target':''}`} style={{'--label-depth':Math.min(4,folderDepth(label.name))} as CSSProperties} key={label.id}><button className="folder-grip" aria-label={`Drag to reorder ${folderName(label.name)}`} title="Drag to reorder" disabled={folderBusy}><GripVertical size={15}/></button><span className={`folder-manager-icon ${hasChildren?'parent':''}`}><Folder size={16}/></span><div><b>{folderName(label.name)}</b><small>{folderDepth(label.name)>0?`${folderParts(label.name).slice(0,-1).join(' / ')} · `:''}{total} email{total===1?'':'s'}{hasChildren?' including subfolders':''}</small></div><button aria-label={`Delete ${folderName(label.name)}`} title={`Delete ${folderName(label.name)}`} disabled={folderBusy} onClick={()=>{setFolderError('');setConfirmDeleteFolder(label)}}><Trash2 size={15}/></button></div>}):<div className="label-manager-empty"><Folder size={20}/><span>No folders yet</span></div>}</div>
      {confirmDeleteFolder&&<div className="label-delete-confirm"><div><span><Trash2 size={18}/></span><h3>Delete “{folderName(confirmDeleteFolder.name)}”?</h3><p>This removes the folder{folderLabels.some(label=>label.name.startsWith(`${confirmDeleteFolder.name}/`))?' and its subfolders':''} from Gmail. Emails inside will be archived, not deleted.</p><footer><button disabled={folderBusy} onClick={()=>setConfirmDeleteFolder(null)}>Cancel</button><button className="delete-label-button" disabled={folderBusy} onClick={removeFolder}>{folderBusy?'Deleting…':'Delete folder'}</button></footer></div></div>}
    </section></div>}
    {routingManager&&<div className="label-modal-backdrop" onMouseDown={()=>{if(!ruleBusy)setRoutingManager(false)}}><section className="label-manager routing-manager" role="dialog" aria-modal="true" aria-labelledby="routing-manager-title" onMouseDown={event=>event.stopPropagation()}>
      <header><div><span className="label-manager-kicker">GMAIL / AUTOMATION</span><h2 id="routing-manager-title">Routing rules</h2><p>Search or create a destination folder, then route mail using the sender's exact address.</p></div><button className="label-manager-close" aria-label="Close routing rules" disabled={ruleBusy} onClick={()=>setRoutingManager(false)}><X size={18}/></button></header>
      <section className="folder-routing routing-only"><header><div><FolderInput size={17}/><span><b>Sender routing rules</b><small>Checks new Inbox mail every minute while SnowFire is open.</small></span></div><i>{Object.keys(senderFolderRules).length}</i></header><form onSubmit={event=>{event.preventDefault();createSenderFolderRule()}}><input autoFocus type="email" aria-label="Sender email address" value={ruleEmail} onChange={event=>setRuleEmail(event.target.value)} placeholder="sender@company.com"/><FolderSearchPicker folders={orderedFolderLabels} value={ruleFolder} onChange={setRuleFolder} onCreate={createRoutingFolder}/><button disabled={ruleBusy||!ruleEmail.trim()||!ruleFolder}><Plus size={14}/>{ruleBusy?'Saving…':'Save rule'}</button></form>{!orderedFolderLabels.length&&<div className="routing-folder-note">Search above to create your first folder without leaving routing rules.</div>}{ruleError&&<div className="routing-rule-error">{ruleError}</div>}<div className="routing-rule-list">{Object.entries(senderFolderRules).sort(([a],[b])=>a.localeCompare(b)).map(([email,folderName])=><div key={email}><span><Mail size={14}/></span><div><b>{email}</b><small>Move to {folderParts(folderName).join(' / ')}</small></div><button aria-label={`Remove routing rule for ${email}`} title="Remove rule" disabled={ruleBusy} onClick={()=>removeSenderFolderRule(email)}><X size={14}/></button></div>)}{!Object.keys(senderFolderRules).length&&<p>No sender rules yet.</p>}</div></section>
    </section></div>}
    {connected===false&&<div className="auth-gate"><div className="auth-card"><img src="./brand/snowfire_logo_title_right_light.svg" alt="SnowFire"/><span className="auth-kicker">MAIL / GOOGLE CONNECTION</span><h2>{upgradeRequired?'Add Calendar access.':'Bring your Gmail into SnowFire.'}</h2><p>{upgradeRequired?'Reconnect once so SnowFire can show, create, and edit Google Calendar events alongside your mail.':'Your browser handles Google sign-in. Mail stays between this device and Gmail. After approval, SnowFire saves the connection in your system keyring, with a permission-locked local fallback.'}</p>{!upgradeRequired&&<><label>Desktop OAuth client JSON or client ID<textarea value={credential} onChange={e=>setCredential(e.target.value)} placeholder={'Paste the downloaded OAuth JSON here\n—or paste the client ID'}/></label><button className="oauth-file" onClick={chooseCredentialFile}><FileText size={15}/>{credential.trim()?'Choose a different JSON file':'Choose OAuth JSON file'}</button></>}{authError&&<div className="auth-error">{authError}</div>}<button className="connect-btn" disabled={!upgradeRequired&&!credential.trim()} onClick={connectGmail}>{upgradeRequired?'Reconnect Google':'Continue with Google'} <ArrowLeft size={16}/></button><small>{upgradeRequired?'Your saved OAuth client will be reused.':'Requires the Gmail, People, and Calendar APIs enabled in your Google Cloud project.'}</small></div></div>}
    {folderContextMenu&&<div className="folder-context-menu" style={{left:folderContextMenu.x,top:folderContextMenu.y}} onClick={event=>event.stopPropagation()}><header><Folder size={13}/><span>{folderParts(folderContextMenu.label.name).join(' / ')}</span></header><button onClick={()=>beginFolderCreate(folderParent(folderContextMenu.label.name)===FOLDER_ROOT?'':folderParent(folderContextMenu.label.name))}><Plus size={15}/><span><b>Add folder</b><small>At the same level</small></span></button><button onClick={()=>beginFolderCreate(folderContextMenu.label.name)}><FolderInput size={15}/><span><b>Add subfolder</b><small>Inside {folderName(folderContextMenu.label.name)}</small></span></button></div>}
    {contextMenu&&<div className="mail-context" style={{left:contextMenu.x,top:contextMenu.y}} onClick={e=>e.stopPropagation()}><button onClick={()=>{selectMessage(contextMenu.message.id);beginResponse('reply');setContextMenu(null)}}><Reply size={15}/>Reply<span>R</span></button><button onClick={()=>{markReadState(contextMenu.message);setContextMenu(null)}}><Mail size={15}/>{contextMenu.message.unread?'Mark as read':'Mark as unread'}</button><button onClick={()=>{toggleStar(contextMenu.message.id);setContextMenu(null)}}><Star size={15}/>{contextMenu.message.starred?'Remove star':'Add star'}</button><button onClick={()=>setShowContextLabels(value=>!value)}><Tag size={15}/>Labels<span>›</span></button>{showContextLabels&&<div className="context-labels">{classificationLabels.length?classificationLabels.map(label=><button key={label.id} onClick={()=>toggleLabel(contextMenu.message,label)}><i><LabelGlyph name={label.name} icons={labelIcons} size={12}/></i><span>{label.name}</span>{messageHasLabel(contextMenu.message,label)&&<Check size={13}/>}</button>):<small>No classifications yet</small>}</div>}<button onClick={()=>openRoutingForSender(contextMenu.message)}><FolderInput size={15}/>Auto-route sender</button><i/><button onClick={()=>{archiveMessage(contextMenu.message);setContextMenu(null)}}>{folder==='Archive'?<Inbox size={15}/>:<Archive size={15}/>} {folder==='Archive'?'Move to inbox':'Archive'}<span>E</span></button><button className={folder==='Trash'?'':'destructive'} onClick={()=>{if(folder==='Trash')restoreMessages([contextMenu.message]);else trashMessage(contextMenu.message);setContextMenu(null)}}>{folder==='Trash'?<Inbox size={15}/>:<Trash2 size={15}/>} {folder==='Trash'?'Restore to inbox':'Move to trash'}<span>Del</span></button></div>}
    {pendingSend&&<div className="undo-send" style={{'--undo-progress':`${Math.max(0,Math.min(100,((pendingSend.sendAt-undoClock)/60000)*100))}%`} as CSSProperties}><Clock3 size={17}/><div><b>{pendingSends.length>1?`${pendingSends.length} messages queued`:'Message queued'}</b><span>Sends in {undoSeconds} second{undoSeconds===1?'':'s'}</span></div><button onClick={()=>undoQueuedSend(pendingSend)}>Oh shit! Undo</button></div>}
    {toast&&<div className="toast"><Check size={16}/>{toast}</div>}
  </div>
}

export default App
