export {}
type OutgoingAttachment = {filename:string;mimeType:string;size:number;data:string}
type OutgoingMessage = {to:string;subject:string;body:string;attachments:OutgoingAttachment[];threadId?:string;inReplyTo?:string}
type QueuedSend = {id:string;sendAt:number;message:OutgoingMessage}
type SendStatus = {id:string;status:'sent'|'failed';error?:string;message?:OutgoingMessage}
type AppSettings = {remoteImages:boolean}

declare global {
  interface Window {
    snowfire?: {
      platform():Promise<string>
      windowAction(action:'minimize'|'maximize'|'close'):Promise<boolean>
      openExternal(url:string):Promise<void>
      settings:{get():Promise<AppSettings>;update(value:AppSettings):Promise<AppSettings>}
      metadata:{labelIcons():Promise<Record<string,string>>;chooseLabelIcon(labelName:string):Promise<string|null>;removeLabelIcon(labelName:string):Promise<boolean>;senderLabels():Promise<Record<string,string[]>>;setSenderLabels(email:string,labels:string[]):Promise<Record<string,string[]>>;removeSenderLabel(labelName:string):Promise<Record<string,string[]>>;senderFolderRules():Promise<Record<string,string>>;setSenderFolderRule(email:string,folderName:string):Promise<Record<string,string>>;removeSenderFolderRule(email:string):Promise<Record<string,string>>;removeSenderFolderRules(folderNames:string[]):Promise<Record<string,string>>;messagePriorities():Promise<Record<string,'top'|'high'|'medium'|'low'>>;setMessagePriority(messageId:string,priority:'top'|'high'|'medium'|'low'|''):Promise<Record<string,'top'|'high'|'medium'|'low'>>;senderPriorityRules():Promise<Record<string,'top'|'high'|'medium'|'low'>>;setSenderPriorityRule(email:string,priority:'top'|'high'|'medium'|'low'):Promise<Record<string,'top'|'high'|'medium'|'low'>>;removeSenderPriorityRule(email:string):Promise<Record<string,'top'|'high'|'medium'|'low'>>;folderOrder():Promise<string[]>;setFolderOrder(order:string[]):Promise<string[]>;renameFolderReferences(changes:Record<string,string>):Promise<{order:string[];rules:Record<string,string>}>}
      contacts:{list():Promise<any[]>;create(contact:any):Promise<any>;update(contact:any):Promise<any>}
      calendar:{list(start:string,end:string):Promise<any[]>;today():Promise<any[]>;create(event:any):Promise<any>;update(event:any):Promise<any>;delete(event:any):Promise<boolean>;suggestions(duration:number):Promise<any[]>}
      gmail:{status():Promise<any>;connect(value:string):Promise<any>;chooseCredentials():Promise<string|null>;list(query?:string,allowRemoteImages?:boolean):Promise<any[]>;get(id:string,allowRemoteImages?:boolean):Promise<any>;counts():Promise<Record<string,number>>;labels():Promise<any[]>;createLabel(name:string):Promise<any>;updateLabel(id:string,name:string):Promise<any>;deleteLabel(id:string):Promise<any>;modify(id:string,add:string[],remove:string[]):Promise<any>;trash(id:string):Promise<any>;untrash(id:string):Promise<any>;snooze(id:string,until:number):Promise<boolean>;unsnooze(id:string):Promise<boolean>;chooseFiles():Promise<OutgoingAttachment[]>;openAttachment(messageId:string,attachment:any):Promise<boolean>;saveAttachment(messageId:string,attachment:any):Promise<boolean>;saveAllAttachments(messageId:string,attachments:any[]):Promise<string|false>;queueSend(message:OutgoingMessage):Promise<QueuedSend>;pendingSends():Promise<QueuedSend[]>;undoSend(id:string):Promise<QueuedSend|null>;onSendStatus(callback:(status:SendStatus)=>void):()=>void;disconnect():Promise<boolean>}
    }
  }
}
