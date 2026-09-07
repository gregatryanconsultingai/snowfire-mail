import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, ExternalLink, MapPin, Plus, RefreshCw, UsersRound, Video } from 'lucide-react'

export type CalendarAttendee = {email:string;name:string;responseStatus:string;self:boolean;organizer:boolean;optional:boolean}
export type CalendarPerson = {email:string;name:string;self:boolean}
export type CalendarEvent = {id:string;eventId:string;calendarId:string;summary:string;description:string;start:string;end:string;allDay:boolean;calendar:string;calendarPrimary:boolean;colorId:string;color:string;location:string;htmlLink:string;conferenceUrl:string;attendees:CalendarAttendee[];organizer:CalendarPerson;creator:CalendarPerson;recurring:boolean;status:string;visibility:string;transparency:string;editable:boolean}
export const EVENT_COLOR_OPTIONS=[{id:'',name:'Calendar default',color:'transparent'},{id:'1',name:'Lavender',color:'#7986cb'},{id:'2',name:'Sage',color:'#33b679'},{id:'3',name:'Grape',color:'#8e24aa'},{id:'4',name:'Flamingo',color:'#e67c73'},{id:'5',name:'Banana',color:'#f6c026'},{id:'6',name:'Tangerine',color:'#f5511d'},{id:'7',name:'Peacock',color:'#039be5'},{id:'8',name:'Graphite',color:'#616161'},{id:'9',name:'Blueberry',color:'#3f51b5'},{id:'10',name:'Basil',color:'#0b8043'},{id:'11',name:'Tomato',color:'#d60000'}]
type CalendarViewMode = 'day'|'week'|'month'|'quarter'

const dayStart=(value:Date)=>new Date(value.getFullYear(),value.getMonth(),value.getDate())
const addDays=(value:Date,count:number)=>{const next=new Date(value);next.setDate(next.getDate()+count);return next}
const dateKey=(value:Date)=>`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`
const startOfWeek=(value:Date)=>addDays(dayStart(value),-value.getDay())
const parseEventDate=(value:string,allDay=false)=>allDay&&/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(`${value}T00:00:00`):new Date(value)
const sameDay=(left:Date,right:Date)=>left.getFullYear()===right.getFullYear()&&left.getMonth()===right.getMonth()&&left.getDate()===right.getDate()
const eventRange=(event:CalendarEvent)=>({start:parseEventDate(event.start,event.allDay),end:parseEventDate(event.end,event.allDay)})
const eventsForDay=(events:CalendarEvent[],date:Date)=>{const start=dayStart(date),end=addDays(start,1);return events.filter(event=>{const range=eventRange(event);return range.start<end&&range.end>start})}
const monthGridStart=(date:Date)=>startOfWeek(new Date(date.getFullYear(),date.getMonth(),1))
const monthDays=(date:Date)=>Array.from({length:42},(_,index)=>addDays(monthGridStart(date),index))
const hourLabel=(hour:number)=>new Date(2000,0,1,hour).toLocaleTimeString([],{hour:'numeric'})
const timeLabel=(date:Date)=>date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})
const durationLabel=(minutes:number)=>minutes<=0?'0 min':minutes<60?`${Math.round(minutes)} min`:`${Math.floor(minutes/60)}h${minutes%60?` ${Math.round(minutes%60)}m`:''}`
const responseLabel=(status:string)=>status==='accepted'?'Accepted':status==='declined'?'Declined':status==='tentative'?'Tentative':status==='needsAction'?'Awaiting reply':status||'Unknown'

function rangeFor(view:CalendarViewMode,anchor:Date){
  if(view==='day'){const start=dayStart(anchor);return {start,end:addDays(start,1)}}
  if(view==='week'){const start=startOfWeek(anchor);return {start,end:addDays(start,7)}}
  if(view==='month'){const start=monthGridStart(anchor);return {start,end:addDays(start,42)}}
  const start=new Date(anchor.getFullYear(),Math.floor(anchor.getMonth()/3)*3,1)
  return {start,end:new Date(start.getFullYear(),start.getMonth()+3,1)}
}

function viewTitle(view:CalendarViewMode,anchor:Date){
  if(view==='day')return anchor.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric',year:'numeric'})
  if(view==='week'){const start=startOfWeek(anchor),end=addDays(start,6);return start.getMonth()===end.getMonth()?`${start.toLocaleDateString([],{month:'long',day:'numeric'})} – ${end.getDate()}, ${end.getFullYear()}`:`${start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`}
  if(view==='month')return anchor.toLocaleDateString([],{month:'long',year:'numeric'})
  const quarter=Math.floor(anchor.getMonth()/3)+1
  return `Q${quarter} · ${anchor.getFullYear()}`
}

function moveAnchor(view:CalendarViewMode,anchor:Date,direction:number){
  if(view==='day')return addDays(anchor,direction)
  if(view==='week')return addDays(anchor,direction*7)
  if(view==='month')return new Date(anchor.getFullYear(),anchor.getMonth()+direction,1)
  return new Date(anchor.getFullYear(),anchor.getMonth()+direction*3,1)
}

function bookedMinutes(events:CalendarEvent[],date:Date){
  const start=new Date(date.getFullYear(),date.getMonth(),date.getDate(),8),end=new Date(date.getFullYear(),date.getMonth(),date.getDate(),17)
  const ranges=events.filter(event=>!event.allDay&&event.transparency!=='transparent').map(event=>eventRange(event)).map(range=>({start:Math.max(start.getTime(),range.start.getTime()),end:Math.min(end.getTime(),range.end.getTime())})).filter(range=>range.end>range.start).sort((a,b)=>a.start-b.start)
  const merged:{start:number;end:number}[]=[]
  for(const range of ranges){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range})}
  return Math.round(merged.reduce((total,range)=>total+(range.end-range.start),0)/60000)
}

function EventButton({event,compact=false,onOpen}:{event:CalendarEvent;compact?:boolean;onOpen:(event:CalendarEvent)=>void}){
  const start=parseEventDate(event.start,event.allDay)
  return <button draggable={event.editable} className={compact?'calendar-event-chip compact':'calendar-event-chip'} style={{'--event-color':event.color||'#9b6bc1'} as CSSProperties} title={event.editable?`${event.summary} · drag to reschedule`:`${event.summary} · ${event.calendar}`} onDragStart={drag=>{drag.stopPropagation();drag.dataTransfer.effectAllowed='move';drag.dataTransfer.setData('application/x-snowfire-calendar-event',event.id)}} onDoubleClick={click=>click.stopPropagation()} onClick={click=>{click.stopPropagation();onOpen(event)}}><i/><span><b>{event.summary||'(No title)'}</b>{!compact&&<small>{event.allDay?'All day':timeLabel(start)}</small>}</span></button>
}

function MonthPanel({month,events,mini=false,onDay,onEvent,dropDayKey,onDragDay,onDropEvent}:{month:Date;events:CalendarEvent[];mini?:boolean;onDay:(date:Date)=>void;onEvent:(event:CalendarEvent)=>void;dropDayKey:string;onDragDay:(date:Date|null)=>void;onDropEvent:(eventId:string,date:Date)=>void}){
  const days=monthDays(month),today=new Date()
  return <section className={mini?'calendar-mini-month':'calendar-month-panel'}>
    {mini&&<header>{month.toLocaleDateString([],{month:'long'})}<span>{events.filter(event=>parseEventDate(event.start,event.allDay).getMonth()===month.getMonth()).length}</span></header>}
    <div className="calendar-weekdays">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=><b key={day}>{mini?day.slice(0,1):day}</b>)}</div>
    <div className="calendar-month-grid">{days.map(date=>{const dayEvents=eventsForDay(events,date),outside=date.getMonth()!==month.getMonth(),key=dateKey(date),accept=(drag:DragEvent<HTMLElement>)=>{if(!drag.dataTransfer.types.includes('application/x-snowfire-calendar-event'))return;drag.preventDefault();drag.dataTransfer.dropEffect='move';onDragDay(date)};return <div className={`${outside?'outside ':''}${sameDay(date,today)?'today ':''}${dayEvents.length?'has-events ':''}${dropDayKey===key?'calendar-drop-day':''}`} key={date.toISOString()} onDragEnter={accept} onDragOver={accept} onDragLeave={drag=>{if(!drag.currentTarget.contains(drag.relatedTarget as Node))onDragDay(null)}} onDrop={drag=>{const eventId=drag.dataTransfer.getData('application/x-snowfire-calendar-event');if(!eventId)return;drag.preventDefault();onDragDay(null);onDropEvent(eventId,date)}} onDoubleClick={()=>onDay(date)}><button className="month-day-number" onClick={()=>onDay(date)}>{date.getDate()}</button>{mini?<div className="mini-event-dots">{dayEvents.slice(0,4).map(event=><i style={{background:event.color}} key={event.id}/>)}</div>:<div className="month-events">{dayEvents.slice(0,3).map(event=><EventButton compact event={event} onOpen={onEvent} key={event.id}/>)}{dayEvents.length>3&&<small>+{dayEvents.length-3} more</small>}</div>}</div>})}</div>
  </section>
}

export function CalendarWorkspace({refreshToken,onEdit,onCreate,onMoved}:{refreshToken:number;onEdit:(event:CalendarEvent)=>void;onCreate:(date?:Date,end?:Date)=>void;onMoved:()=>void}){
  const [view,setView]=useState<CalendarViewMode>('day')
  const [anchor,setAnchor]=useState(()=>new Date())
  const [events,setEvents]=useState<CalendarEvent[]>([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [revision,setRevision]=useState(0)
  const [dropTime,setDropTime]=useState<Date|null>(null)
  const [dropDayKey,setDropDayKey]=useState('')
  const [movingEventId,setMovingEventId]=useState('')
  const [createSelection,setCreateSelection]=useState<{start:Date;end:Date}|null>(null)
  const createSelectionRef=useRef<{anchor:Date;current:Date;initialY:number;moved:boolean}|null>(null)
  const range=useMemo(()=>rangeFor(view,anchor),[view,anchor])
  useEffect(()=>{let live=true;setLoading(true);setError('');window.snowfire?.calendar.list(range.start.toISOString(),range.end.toISOString()).then(result=>{if(live)setEvents(result||[])}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:'Could not load Google Calendar')}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[range.start.getTime(),range.end.getTime(),refreshToken,revision])
  const openEvent=(event:CalendarEvent)=>event.editable?onEdit(event):event.htmlLink&&window.snowfire?.openExternal(event.htmlLink)
  const drillInto=(date:Date)=>{setAnchor(date);setView('day')}
  const dayEvents=useMemo(()=>eventsForDay(events,anchor),[events,anchor])
  const allDay=dayEvents.filter(event=>event.allDay)
  const booked=bookedMinutes(dayEvents,anchor),available=Math.max(0,9*60-booked)
  const dayTimelineStart=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate(),6),dayTimelineEnd=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate(),23)
  const timed=dayEvents.filter(event=>{if(event.allDay)return false;const range=eventRange(event);return range.start<dayTimelineEnd&&range.end>dayTimelineStart}).sort((a,b)=>parseEventDate(a.start).getTime()-parseEventDate(b.start).getTime())
  const dayPosition=(event:CalendarEvent)=>{const eventDates=eventRange(event),start=Math.max(dayTimelineStart.getTime(),eventDates.start.getTime()),end=Math.min(dayTimelineEnd.getTime(),eventDates.end.getTime()),span=dayTimelineEnd.getTime()-dayTimelineStart.getTime();return {top:`${((start-dayTimelineStart.getTime())/span)*100}%`,height:`${Math.max(2.6,((end-start)/span)*100)}%`}}
  const weekDays=Array.from({length:7},(_,index)=>addDays(startOfWeek(anchor),index))
  const quarterStart=new Date(anchor.getFullYear(),Math.floor(anchor.getMonth()/3)*3,1)
  const timeAt=(clientY:number,bounds:DOMRect)=>{const ratio=Math.max(0,Math.min(1,(clientY-bounds.top)/bounds.height)),date=new Date(dayTimelineStart.getTime()+ratio*(dayTimelineEnd.getTime()-dayTimelineStart.getTime()));date.setMinutes(Math.round(date.getMinutes()/15)*15,0,0);return date}
  const createTimeAt=(clientY:number,bounds:DOMRect)=>{const value=timeAt(clientY,bounds),latest=new Date(dayTimelineEnd.getTime()-15*60_000);return value>latest?latest:value}
  const selectionRange=(left:Date,right:Date)=>({start:new Date(Math.min(left.getTime(),right.getTime())),end:new Date(Math.min(dayTimelineEnd.getTime(),Math.max(left.getTime(),right.getTime())+15*60_000))})
  const moveEvent=async(eventId:string,target:Date,exactTime=false)=>{
    const event=events.find(item=>item.id===eventId)
    if(!event?.editable||!window.snowfire)return
    const previous=events
    let start:string,end:string,allDay=event.allDay
    if(event.allDay&&!exactTime){const oldStart=parseEventDate(event.start,true),oldEnd=parseEventDate(event.end,true),span=Math.max(1,Math.round((oldEnd.getTime()-oldStart.getTime())/86_400_000)),nextStart=dayStart(target);start=dateKey(nextStart);end=dateKey(addDays(nextStart,span))}
    else{const oldStart=parseEventDate(event.start,event.allDay),oldEnd=parseEventDate(event.end,event.allDay),duration=event.allDay&&exactTime?60*60_000:Math.max(15*60_000,oldEnd.getTime()-oldStart.getTime()),nextStart=exactTime?new Date(target):new Date(target.getFullYear(),target.getMonth(),target.getDate(),oldStart.getHours(),oldStart.getMinutes());start=nextStart.toISOString();end=new Date(nextStart.getTime()+duration).toISOString();allDay=false}
    setMovingEventId(event.id);setError('');setEvents(items=>items.map(item=>item.id===event.id?{...item,start,end,allDay}:item))
    try{await window.snowfire.calendar.update({calendarId:event.calendarId,eventId:event.eventId,summary:event.summary,location:event.location,description:event.description,colorId:event.colorId,start,end,allDay});setRevision(value=>value+1);onMoved()}
    catch(reason){setEvents(previous);setError(reason instanceof Error?reason.message:'Could not move the calendar event')}
    finally{setMovingEventId('');setDropTime(null);setDropDayKey('')}
  }

  return <section className="calendar-workspace">
    <header className="calendar-header"><div><span>GOOGLE / LIVE CALENDAR</span><h1>{viewTitle(view,anchor)}</h1><p>{loading?'Syncing every selected calendar…':`${events.length} event${events.length===1?'':'s'} in view`}</p></div><button className="calendar-create" onClick={()=>onCreate(view==='day'?anchor:undefined)}><Plus size={16}/> New event</button></header>
    <div className="calendar-toolbar"><button onClick={()=>setAnchor(new Date())}>Today</button><div className="calendar-stepper"><button aria-label="Previous period" onClick={()=>setAnchor(current=>moveAnchor(view,current,-1))}><ChevronLeft size={16}/></button><button aria-label="Next period" onClick={()=>setAnchor(current=>moveAnchor(view,current,1))}><ChevronRight size={16}/></button></div><div className="calendar-view-switch">{(['day','week','month','quarter'] as CalendarViewMode[]).map(mode=><button className={view===mode?'active':''} onClick={()=>setView(mode)} key={mode}>{mode}</button>)}</div><button className={loading?'calendar-refresh spinning':'calendar-refresh'} aria-label="Refresh calendar" onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15}/></button></div>
    {error&&<div className="calendar-workspace-error"><span>{error.replace(/^Error invoking remote method '[^']+': Error:\s*/,'')}</span><button onClick={()=>setRevision(value=>value+1)}>Try again</button></div>}
    <div className={`calendar-canvas ${view}-canvas`}>
      {view==='day'&&<div className="calendar-day-layout">
        <section className="calendar-day-main">
          <div className="calendar-day-summary"><div><CalendarDays size={16}/><span><b>{dayEvents.length}</b><small>events</small></span></div><div><Clock3 size={16}/><span><b>{durationLabel(booked)}</b><small>booked 8–5</small></span></div><div><span className="availability-ring" style={{'--free':`${Math.round((available/(9*60))*100)}%`} as CSSProperties}/><span><b>{durationLabel(available)}</b><small>workday open</small></span></div></div>
          {!!allDay.length&&<div className="calendar-all-day"><b>All day</b><div>{allDay.map(event=><EventButton event={event} onOpen={openEvent} key={event.id}/>)}</div></div>}
          <div className={`calendar-day-timeline${dropTime?' accepting-drop':''}${createSelection?' creating-event':''}`} onPointerDown={event=>{if(event.button!==0||(event.target instanceof Element&&event.target.closest('button')))return;event.preventDefault();const anchor=createTimeAt(event.clientY,event.currentTarget.getBoundingClientRect());createSelectionRef.current={anchor,current:anchor,initialY:event.clientY,moved:false};setCreateSelection(selectionRange(anchor,anchor));event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{const draft=createSelectionRef.current;if(!draft||!event.currentTarget.hasPointerCapture(event.pointerId))return;const current=createTimeAt(event.clientY,event.currentTarget.getBoundingClientRect());draft.current=current;if(Math.abs(event.clientY-draft.initialY)>4)draft.moved=true;setCreateSelection(selectionRange(draft.anchor,current))}} onPointerUp={event=>{const draft=createSelectionRef.current;if(!draft)return;const range=selectionRange(draft.anchor,createTimeAt(event.clientY,event.currentTarget.getBoundingClientRect())),moved=draft.moved;createSelectionRef.current=null;setCreateSelection(null);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(moved)onCreate(range.start,range.end)}} onPointerCancel={()=>{createSelectionRef.current=null;setCreateSelection(null)}} onDragEnter={drag=>{if(!drag.dataTransfer.types.includes('application/x-snowfire-calendar-event'))return;drag.preventDefault();drag.dataTransfer.dropEffect='move';setDropTime(timeAt(drag.clientY,drag.currentTarget.getBoundingClientRect()))}} onDragOver={drag=>{if(!drag.dataTransfer.types.includes('application/x-snowfire-calendar-event'))return;drag.preventDefault();drag.dataTransfer.dropEffect='move';setDropTime(timeAt(drag.clientY,drag.currentTarget.getBoundingClientRect()))}} onDragLeave={drag=>{if(!drag.currentTarget.contains(drag.relatedTarget as Node))setDropTime(null)}} onDrop={drag=>{const eventId=drag.dataTransfer.getData('application/x-snowfire-calendar-event');if(!eventId)return;drag.preventDefault();moveEvent(eventId,timeAt(drag.clientY,drag.currentTarget.getBoundingClientRect()),true)}} onDoubleClick={event=>onCreate(timeAt(event.clientY,event.currentTarget.getBoundingClientRect()))}>{Array.from({length:18},(_,index)=>{const hour=6+index;return <div className="calendar-hour-line" style={{top:`${(index/17)*100}%`}} key={hour}><time>{hourLabel(hour)}</time><i/></div>})}<div className="work-hours-shade"/>{timed.map(event=><button draggable={event.editable&&!movingEventId} className={`calendar-timeline-event${movingEventId===event.id?' moving':''}`} style={{...dayPosition(event),'--event-color':event.color||'#9b6bc1'} as CSSProperties} title={event.editable?'Drag to reschedule':event.calendar} onDragStart={drag=>{drag.stopPropagation();drag.dataTransfer.effectAllowed='move';drag.dataTransfer.setData('application/x-snowfire-calendar-event',event.id)}} onDragEnd={()=>setDropTime(null)} onDoubleClick={click=>click.stopPropagation()} onClick={()=>openEvent(event)} key={event.id}><b>{event.summary||'(No title)'}</b><span>{timeLabel(parseEventDate(event.start))} – {timeLabel(parseEventDate(event.end))}</span>{event.location&&<small><MapPin size={10}/>{event.location}</small>}</button>)}{createSelection&&<div className="calendar-create-selection" style={{top:`${((createSelection.start.getTime()-dayTimelineStart.getTime())/(dayTimelineEnd.getTime()-dayTimelineStart.getTime()))*100}%`,height:`${((createSelection.end.getTime()-createSelection.start.getTime())/(dayTimelineEnd.getTime()-dayTimelineStart.getTime()))*100}%`}}><b>New event</b><span>{timeLabel(createSelection.start)} – {timeLabel(createSelection.end)}</span></div>}{dropTime&&<div className="calendar-drop-time" style={{top:`${((dropTime.getTime()-dayTimelineStart.getTime())/(dayTimelineEnd.getTime()-dayTimelineStart.getTime()))*100}%`}}><time>{timeLabel(dropTime)}</time><i/></div>}</div>
        </section>
        <aside className="calendar-day-details"><header><span>DAY BRIEF</span><b>Every useful detail</b></header>{dayEvents.length?dayEvents.map(event=>{const start=parseEventDate(event.start,event.allDay),end=parseEventDate(event.end,event.allDay),minutes=(end.getTime()-start.getTime())/60000;return <article style={{'--event-color':event.color||'#9b6bc1'} as CSSProperties} key={event.id}><div className="event-detail-title"><i/><div><b>{event.summary||'(No title)'}</b><span>{event.allDay?'All day':`${timeLabel(start)} – ${timeLabel(end)} · ${durationLabel(minutes)}`}</span></div><button aria-label={event.editable?'Edit event':'Open in Google Calendar'} onClick={()=>openEvent(event)}>{event.editable?'Edit':<ExternalLink size={13}/>}</button></div><dl><div><dt>Calendar</dt><dd>{event.calendar}{event.calendarPrimary?' · Primary':''}</dd></div><div><dt>Status</dt><dd>{event.transparency==='transparent'?'Free':'Busy'} · {event.status||'confirmed'}{event.recurring?' · Recurring':''}</dd></div>{event.location&&<div><dt>Location</dt><dd><MapPin size={11}/>{event.location}</dd></div>}{event.conferenceUrl&&<div><dt>Meeting</dt><dd><button onClick={()=>window.snowfire?.openExternal(event.conferenceUrl)}><Video size={11}/>Join video call</button></dd></div>}{(event.organizer?.name||event.organizer?.email)&&<div><dt>Organizer</dt><dd>{event.organizer.name||event.organizer.email}</dd></div>}</dl>{event.attendees?.length>0&&<div className="event-attendees"><span><UsersRound size={12}/>{event.attendees.length} attendee{event.attendees.length===1?'':'s'}</span>{event.attendees.slice(0,8).map(attendee=><div key={attendee.email}><i className={attendee.responseStatus}/><b>{attendee.name||attendee.email}</b><small>{responseLabel(attendee.responseStatus)}</small></div>)}</div>}{event.description&&<p>{event.description}</p>}{event.htmlLink&&<button className="google-event-link" onClick={()=>window.snowfire?.openExternal(event.htmlLink)}>Open in Google Calendar <ExternalLink size={11}/></button>}</article>}):<div className="calendar-empty-detail"><CalendarDays size={22}/><b>A clear day</b><span>Double-click a time to add something.</span></div>}</aside>
      </div>}
      {view==='week'&&<div className="calendar-week-grid">{weekDays.map(date=>{const items=eventsForDay(events,date),key=dateKey(date),accept=(drag:DragEvent<HTMLElement>)=>{if(!drag.dataTransfer.types.includes('application/x-snowfire-calendar-event'))return;drag.preventDefault();drag.dataTransfer.dropEffect='move';setDropDayKey(key)};return <section className={`${sameDay(date,new Date())?'today ':''}${dropDayKey===key?'calendar-drop-day':''}`} key={date.toISOString()} onDragEnter={accept} onDragOver={accept} onDragLeave={drag=>{if(!drag.currentTarget.contains(drag.relatedTarget as Node))setDropDayKey('')}} onDrop={drag=>{const eventId=drag.dataTransfer.getData('application/x-snowfire-calendar-event');if(!eventId)return;drag.preventDefault();moveEvent(eventId,date)}}><button className="week-day-head" onClick={()=>drillInto(date)}><span>{date.toLocaleDateString([],{weekday:'short'})}</span><b>{date.getDate()}</b><small>{durationLabel(bookedMinutes(items,date))} booked</small></button><div className="week-day-events" onDoubleClick={()=>onCreate(new Date(date.getFullYear(),date.getMonth(),date.getDate(),9))}>{items.length?items.map(event=><EventButton event={event} onOpen={openEvent} key={event.id}/>):<span>Open</span>}</div></section>})}</div>}
      {view==='month'&&<MonthPanel month={anchor} events={events} dropDayKey={dropDayKey} onDragDay={date=>setDropDayKey(date?dateKey(date):'')} onDropEvent={moveEvent} onDay={drillInto} onEvent={openEvent}/>}
      {view==='quarter'&&<div className="calendar-quarter-grid">{Array.from({length:3},(_,index)=>{const month=new Date(quarterStart.getFullYear(),quarterStart.getMonth()+index,1);return <MonthPanel mini month={month} events={events} dropDayKey={dropDayKey} onDragDay={date=>setDropDayKey(date?dateKey(date):'')} onDropEvent={moveEvent} onDay={drillInto} onEvent={openEvent} key={month.toISOString()}/>})}</div>}
      {loading&&<div className="calendar-loading"><RefreshCw className="spin-icon" size={18}/><span>Reading Google Calendar</span></div>}
    </div>
  </section>
}
