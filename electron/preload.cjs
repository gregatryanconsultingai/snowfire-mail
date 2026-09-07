const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('snowfire', {
  platform: () => ipcRenderer.invoke('app:platform'),
  windowAction: action => ipcRenderer.invoke('app:window-action', action),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  settings: {
    get: () => ipcRenderer.invoke('app:settings'),
    update: value => ipcRenderer.invoke('app:update-settings', value)
  },
  metadata: {
    labelIcons: () => ipcRenderer.invoke('metadata:label-icons'),
    chooseLabelIcon: labelName => ipcRenderer.invoke('metadata:choose-label-icon', labelName),
    removeLabelIcon: labelName => ipcRenderer.invoke('metadata:remove-label-icon', labelName),
    senderLabels: () => ipcRenderer.invoke('metadata:sender-labels'),
    setSenderLabels: (email,labels) => ipcRenderer.invoke('metadata:set-sender-labels', email, labels),
    removeSenderLabel: labelName => ipcRenderer.invoke('metadata:remove-sender-label', labelName),
    senderFolderRules: () => ipcRenderer.invoke('metadata:sender-folder-rules'),
    setSenderFolderRule: (email,folderName) => ipcRenderer.invoke('metadata:set-sender-folder-rule', email, folderName),
    removeSenderFolderRule: email => ipcRenderer.invoke('metadata:remove-sender-folder-rule', email),
    removeSenderFolderRules: folderNames => ipcRenderer.invoke('metadata:remove-sender-folder-rules', folderNames),
    messagePriorities: () => ipcRenderer.invoke('metadata:message-priorities'),
    setMessagePriority: (messageId,priority) => ipcRenderer.invoke('metadata:set-message-priority', messageId, priority),
    senderPriorityRules: () => ipcRenderer.invoke('metadata:sender-priority-rules'),
    setSenderPriorityRule: (email,priority) => ipcRenderer.invoke('metadata:set-sender-priority-rule', email, priority),
    removeSenderPriorityRule: email => ipcRenderer.invoke('metadata:remove-sender-priority-rule', email),
    folderOrder: () => ipcRenderer.invoke('metadata:folder-order'),
    setFolderOrder: order => ipcRenderer.invoke('metadata:set-folder-order', order),
    renameFolderReferences: changes => ipcRenderer.invoke('metadata:rename-folder-references', changes)
  },
  contacts: {
    list: () => ipcRenderer.invoke('contacts:list'),
    create: contact => ipcRenderer.invoke('contacts:create', contact),
    update: contact => ipcRenderer.invoke('contacts:update', contact)
  },
  calendar: {
    today: () => ipcRenderer.invoke('calendar:today'),
    list: (start,end) => ipcRenderer.invoke('calendar:list', start, end),
    create: event => ipcRenderer.invoke('calendar:create', event),
    update: event => ipcRenderer.invoke('calendar:update', event),
    delete: event => ipcRenderer.invoke('calendar:delete', event),
    suggestions: duration => ipcRenderer.invoke('calendar:suggestions', duration)
  },
  gmail: {
    status: () => ipcRenderer.invoke('gmail:status'), connect: value => ipcRenderer.invoke('gmail:connect', value), chooseCredentials: () => ipcRenderer.invoke('gmail:choose-credentials'),
    list: (query,allowRemoteImages) => ipcRenderer.invoke('gmail:list', query, allowRemoteImages), get: (id,allowRemoteImages) => ipcRenderer.invoke('gmail:get',id,allowRemoteImages), counts: () => ipcRenderer.invoke('gmail:counts'), labels: () => ipcRenderer.invoke('gmail:labels'), createLabel: name => ipcRenderer.invoke('gmail:create-label',name), updateLabel: (id,name) => ipcRenderer.invoke('gmail:update-label',id,name), deleteLabel: id => ipcRenderer.invoke('gmail:delete-label',id), modify: (id,add,remove) => ipcRenderer.invoke('gmail:modify',id,add,remove),
    trash: id => ipcRenderer.invoke('gmail:trash',id), untrash: id => ipcRenderer.invoke('gmail:untrash',id), snooze: (id,until) => ipcRenderer.invoke('gmail:snooze',id,until), unsnooze: id => ipcRenderer.invoke('gmail:unsnooze',id), chooseFiles: () => ipcRenderer.invoke('gmail:choose-files'), openAttachment: (messageId,attachment) => ipcRenderer.invoke('gmail:open-attachment',messageId,attachment), saveAttachment: (messageId,attachment) => ipcRenderer.invoke('gmail:save-attachment',messageId,attachment), saveAllAttachments: (messageId,attachments) => ipcRenderer.invoke('gmail:save-all-attachments',messageId,attachments), queueSend: message => ipcRenderer.invoke('gmail:queue-send',message), pendingSends: () => ipcRenderer.invoke('gmail:pending-sends'), undoSend: id => ipcRenderer.invoke('gmail:undo-send',id), onSendStatus: callback => {const listener=(_event,status)=>callback(status);ipcRenderer.on('gmail:send-status',listener);return()=>ipcRenderer.removeListener('gmail:send-status',listener)}, disconnect: () => ipcRenderer.invoke('gmail:disconnect')
  }
})
