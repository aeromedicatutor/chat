// operador.js v2.3
import { db, auth } from './app.js';
import {
  ref, onValue, onChildAdded, onChildChanged, push, update, serverTimestamp,
  get, set, remove, query, orderByChild, onDisconnect
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const $=s=>document.querySelector(s);
const esc=s=>String(s||'').replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scroll=el=>el&&(el.scrollTop=el.scrollHeight);
const since=(ms)=>{const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;};
const tick=(m)=>`<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>`;

const notifyEl=document.getElementById('notify');
const playNotify=()=>{ try{ if(notifyEl){ notifyEl.currentTime=0; notifyEl.play().catch(()=>{});} }catch(_){ } };

let currentRoom=null, previousRoom=null, currentMsgsRef=null, allChats={}, waitInt=null, roomIsClosed=false;
let unsubs=[]; const selection=new Set();
let initializedList=false;
const knownIds=new Set(); // ids conhecidos no boot

const roomTitle=$('#roomTitle'), roomOnlineDot=$('#roomOnlineDot'), roomSub=$('#roomSub'), opTyping=$('#opTyping');
const opMessages=$('#opMessages'), opForm=$('#opForm'), opInput=$('#opInput');
const btnFinish=$('#btnFinish'), btnSave=$('#btnSave'), waitBadge=$('#waitBadge');
const opOverlay=$('#opOverlay'), btnOverlayDelete=$('#btnOverlayDelete');
const roomsList=$('#roomsList'), filterInput=$('#filterInput');
const btnExport=$('#btnExport'), btnGoSaved=$('#btnGoSaved'), btnBulkDelete=$('#btnBulkDelete');

async function ensureOpSession(){ try{ await signInAnonymously(auth);}catch(e){ console.error('auth anônima',e);} }
onAuthStateChanged(auth,u=>{ if(!u) ensureOpSession(); });

function toggleClosedUI(c){ roomIsClosed=!!c; opOverlay.style.display=c?'flex':'none'; opInput.disabled=c; opForm.querySelector('button').disabled=c; btnSave.disabled=!currentRoom; }

function setAdminPresence(roomId, online){ const p=ref(db,`chats/${roomId}/status/adminOnline`); set(p,online).catch(()=>{}); if(online) onDisconnect(p).set(false); }
function clearPreviousPresence(){ if(previousRoom && previousRoom!==currentRoom){ update(ref(db,`chats/${previousRoom}/status`),{adminOnline:false}).catch(()=>{}); } }
function zeroAlerts(roomId){ update(ref(db,`chats/${roomId}/alerts`),{count:0}).catch(()=>{}); set(ref(db,`chats/${roomId}/alerts/events`),null).catch(()=>{}); }

/* ========== LISTA ========= */
function renderRooms(filter=''){
  const sel=currentRoom, term=filter.trim().toLowerCase();
  const items=Object.entries(allChats)
    .sort(([,a],[,b])=>(b.lastMessageAt||0)-(a.lastMessageAt||0))
    .filter(([,c])=>!term || [c.userLabel,c.userInfo?.nome,c.assunto].filter(Boolean).some(v=>String(v).toLowerCase().includes(term)));

  roomsList.innerHTML=items.map(([id,c])=>{
    const on=!!c?.status?.userOnline;
    const lm=c?.lastMessage||'—';
    const when=c?.lastMessageAt?since(Date.now()-c.lastMessageAt):'—';
    const ac=c?.alerts?.count||0;
    const badge=ac>0?`<span class="badge-alert">${ac} ${ac===1?'alerta':'alertas'}</span>`:'';
    const isNew = !!c?.status?.newForOp;
    const newBadge = isNew ? `<span class="badge-alert">novo</span>` : '';
    const selected=id===sel?'selected':'';
    return `
      <div class="room ${selected}" data-id="${id}">
        <input type="checkbox" class="sel" data-id="${id}" ${selection.has(id)?'checked':''} />
        <div style="flex:1">
          <div class="title">${esc(c.userLabel||id)}</div>
          <div class="sub">${esc(c.assunto||'')}</div>
          <div class="meta-line">
            <span class="status ${on?'online':'offline'}"><span class="dot"></span> ${on?'online':'offline'}</span>
            ${newBadge}
            ${badge}
            <span class="wait">última: ${when}</span>
          </div>
          <div class="sub" style="margin-top:4px">“${esc(lm)}”</div>
        </div>
        <button class="trash" title="Apagar" data-trash="${id}">🗑️</button>
      </div>`;
  }).join('');

  roomsList.querySelectorAll('.room').forEach(el=>{
    el.onclick=e=>{
      const t=e.target; if(t instanceof HTMLElement){
        if(t.classList && t.classList.contains('sel')) return;
        if(t.getAttribute && t.getAttribute('data-trash')) return;
      }
      openRoom(el.dataset.id);
    };
  });
  roomsList.querySelectorAll('.sel').forEach(chk=>{
    chk.addEventListener('change', ev=>{
      const input=ev.currentTarget instanceof HTMLInputElement?ev.currentTarget:chk;
      const id=input.dataset.id; if(!id) return;
      if(input.checked) selection.add(id); else selection.delete(id);
    });
  });
  roomsList.querySelectorAll('[data-trash]').forEach(btn=>{
    btn.addEventListener('click', ev=>{
      ev.stopPropagation();
      const id=(ev.currentTarget instanceof HTMLElement)?ev.currentTarget.getAttribute('data-trash'):null;
      if(!id) return;
      if(confirm('Apagar este chat PERMANENTEMENTE?')) purgeChat(id);
    });
  });
}

/* ===== loading inicial + novos ===== */
async function startRoomsListener(){
  const orderedQ=query(ref(db,'chats'), orderByChild('lastMessageAt'));
  const purged=(await get(ref(db,'purged'))).val()||{};
  const shouldShow=id=>!purged[id];

  const first=await get(orderedQ);
  allChats=Object.fromEntries(Object.entries(first.val()||{}).filter(([id])=>shouldShow(id)));
  Object.keys(allChats).forEach(id=>knownIds.add(id));
  renderRooms(filterInput.value||''); initializedList=true;

  // atualizações gerais
  onValue(orderedQ, s=>{
    const all=s.val()||{};
    allChats=Object.fromEntries(Object.entries(all).filter(([id])=>shouldShow(id)));
    renderRooms(filterInput.value||'');
  });

  // chat novo depois do boot → tocar som se vier marcado como newForOp
  onChildAdded(ref(db,'chats'), s=>{
    const id=s.key; if(!shouldShow(id)) return;
    const data=s.val()||{};
    if(!knownIds.has(id)){ // não estava no snapshot inicial
      if(data?.status?.newForOp) playNotify();
      knownIds.add(id);
    }
    allChats[id]=data;
    renderRooms(filterInput.value||'');
  });

  onChildChanged(ref(db,'chats'), s=>{
    if(!shouldShow(s.key)) return;
    allChats[s.key]=s.val();
    renderRooms(filterInput.value||'');
  });
}

/* ========== ABRIR SALA ========== */
function openRoom(id){
  roomsList.querySelectorAll('.room.selected').forEach(r=>r.classList.remove('selected'));
  roomsList.querySelector(`.room[data-id="${id}"]`)?.classList.add('selected');

  // limpa listeners antigos
  unsubs.forEach(fn=>{ try{fn();}catch(_){ } }); unsubs=[];
  clearInterval(waitInt);

  previousRoom=currentRoom; currentRoom=id;
  clearPreviousPresence(); setAdminPresence(id,true); zeroAlerts(id);

  // remove "novo" ao abrir
  update(ref(db,`chats/${id}/status`),{ newForOp:false }).catch(()=>{});

  const c=allChats[id]||{}; roomTitle.textContent=c.userLabel||id; roomSub.textContent=c.assunto?`Assunto: ${c.assunto}`:'—'; opMessages.innerHTML='';

  unsubs.push(onValue(ref(db,`chats/${id}/status/userOnline`), s=>{
    const on=!!s.val(); roomOnlineDot.classList.toggle('online',on); roomOnlineDot.classList.toggle('offline',!on);
    roomOnlineDot.innerHTML=`<span class="dot"></span> ${on?'online':'offline'}`;
  }));
  unsubs.push(onValue(ref(db,`chats/${id}/status/typing/user`), s=>{
    opTyping.textContent = s.val() ? 'Usuário está digitando…' : '';
  }));
  unsubs.push(onValue(ref(db,`chats/${id}/status/closed`), s=> toggleClosedUI(!!s.val()) ));
  unsubs.push(onChildAdded(ref(db,`chats/${id}/alerts/events`), ()=>{ playNotify(); waitBadge.textContent='aguardando —'; }));

  const updWait=()=>{ const chat=allChats[id]; waitBadge.textContent=(chat?.lastMessageRole==='user'&&chat?.lastMessageAt)?`aguardando ${since(Date.now()-chat.lastMessageAt)}`:'aguardando —'; };
  updWait(); waitInt=setInterval(updWait,1000);

  currentMsgsRef=ref(db,`chats/${id}/messages`);
  unsubs.push(onChildAdded(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val();
    if(document.getElementById(`msg-${k}`)) return;
    const mine=m.autorRole==='agent';
    const d=document.createElement('div'); d.id=`msg-${k}`; d.className=`msg ${mine?'me':'op'}`;
    d.innerHTML=`${esc(m.texto||'')}<div class="meta">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${mine?tick(m):''}</div>`;
    opMessages.appendChild(d); scroll(opMessages);
    if(!mine){
      playNotify();
      // como a sala está aberta, removemos a marca "novo"
      update(ref(db,`chats/${id}/status`),{ newForOp:false }).catch(()=>{});
      update(ref(db,`chats/${id}/messages/${k}`),{readAt:serverTimestamp()});
    }
  }));
  unsubs.push(onChildChanged(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val(); const el=document.getElementById(`msg-${k}`); if(!el) return;
    const mine=m.autorRole==='agent'; if(mine){ const meta=el.querySelector('.meta'); if(meta) meta.innerHTML=`${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${tick(m)}`; }
  }));

  opInput.disabled=roomIsClosed; opForm.querySelector('button').disabled=roomIsClosed; btnFinish.disabled=false; btnSave.disabled=false;
  btnOverlayDelete.onclick=()=>purgeChat(id);
  opInput.removeEventListener('input', onOpTyping); opInput.addEventListener('input', onOpTyping);
  scroll(opMessages);
}

/* digitação */
function onOpTyping(){ if(!currentRoom) return; try{ set(ref(db,`chats/${currentRoom}/status/typing/admin`), !!opInput.value).catch(()=>{});}catch(_){ } }

/* enviar */
opForm.addEventListener('submit', async ev=>{
  ev.preventDefault(); if(!currentRoom) return; if(roomIsClosed){ alert('Atendimento encerrado.'); return; }
  const text=opInput.value.trim(); if(!text) return;
  try{
    const data={ texto:text, autorRole:'agent', timestamp:serverTimestamp() };
    const msgRef=push(currentMsgsRef); await set(msgRef,data);
    await update(ref(db,`chats/${currentRoom}`),{ lastMessage:text, lastMessageAt: Date.now(), lastMessageRole:'agent' });
    opInput.value=''; set(ref(db,`chats/${currentRoom}/status/typing/admin`),false); scroll(opMessages);
  }catch(e){ alert('Falha ao enviar.'); }
});

/* finalizar */
btnFinish.addEventListener('click', async ()=>{
  if(!currentRoom) return;
  try{
    const now=Date.now();
    await update(ref(db,`chats/${currentRoom}/status`),{closed:true,adminOnline:true});
    await push(ref(db,`chats/${currentRoom}/messages`),{ autorRole:'system', autorName:'Sistema', texto:'Atendimento finalizado pelo operador.', timestamp: now });
    await update(ref(db,`chats/${currentRoom}`),{ lastMessage:'Atendimento finalizado pelo operador.', lastMessageAt: now, lastMessageRole:'system' });
    toggleClosedUI(true);
  }catch(_){}
});

/* salvar */
btnSave.addEventListener('click', ()=>{ if(currentRoom) saveChat(currentRoom); });
async function saveChat(id){
  try{
    const chat=(await get(ref(db,`chats/${id}`))).val()||{};
    const msgs=(await get(ref(db,`chats/${id}/messages`))).val()||{};
    await set(ref(db,`saved/${id}`),{ meta:{ id, ...chat, savedAt: serverTimestamp() }, messages: msgs });
    await update(ref(db,`chats/${id}/status`),{ closed:true });
    alert('Chat salvo.');
  }catch(_){ alert('Falha ao salvar.'); }
}

/* purga definitiva */
async function purgeChat(id){
  try{
    await set(ref(db,`purged/${id}`),true);
    await remove(ref(db,`chats/${id}`));
    await remove(ref(db,`archives/${id}`)).catch(()=>{});
    await remove(ref(db,`saved/${id}`)).catch(()=>{});
    delete allChats[id];
    if(currentRoom===id){
      currentRoom=null; roomTitle.textContent='Selecione um chat'; roomSub.textContent='—'; opMessages.innerHTML='';
      opInput.disabled=true; opForm.querySelector('button').disabled=true; btnFinish.disabled=true; btnSave.disabled=true;
    }
    renderRooms(filterInput.value||'');
  }catch(_){ alert('Não foi possível apagar definitivamente.'); }
}

/* ações extras */
btnBulkDelete.addEventListener('click', async ()=>{
  if(selection.size===0) return alert('Nenhum chat selecionado.');
  if(!confirm(`Apagar ${selection.size} chats permanentemente?`)) return;
  for(const id of Array.from(selection)) await purgeChat(id);
  selection.clear();
});

btnExport.addEventListener('click', async ()=>{
  try{
    if(!window.XLSX){ const s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/xlsx@0.20.2/dist/xlsx.full.min.js';
      await new Promise((res,rej)=>{ s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
    const rows=Object.entries(allChats).map(([id,c])=>({
      id, nome:c?.userInfo?.nome||c?.userLabel||'', contato:c?.userInfo?.contato||'',
      categoria:c?.userInfo?.categoria||'', assunto:c?.assunto||'', ultima_msg:c?.lastMessage||'',
      papel_ultima:c?.lastMessageRole||'', ultima_em:c?.lastMessageAt?new Date(c.lastMessageAt).toLocaleString():'',
      online:c?.status?.userOnline?'sim':'não', alertas:c?.alerts?.count||0
    }));
    const ws=XLSX.utils.json_to_sheet(rows), wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'chats'); XLSX.writeFile(wb,`chats_${new Date().toISOString().slice(0,10)}.xlsx`);
  }catch(_){ alert('Falha ao exportar.'); }
});

filterInput.addEventListener('input', ()=>renderRooms(filterInput.value||''));
btnGoSaved.addEventListener('click', ()=>{ location.hash='#/salvos'; });

/* ====== SALVOS / ARQUIVOS ====== */
const savedListEl=$('#savedList'), savedFilter=$('#savedFilter'), tabs=document.querySelectorAll('.tab'), btnBackToOp=$('#btnBackToOp');
btnBackToOp?.addEventListener('click', ()=>{ location.hash='#/operador'; });
let currentSavedTab='saved';
tabs.forEach(t=>{ t.addEventListener('click',()=>{ tabs.forEach(x=>x.classList.remove('active')); t.classList.add('active'); currentSavedTab=t.dataset.tab; loadSaved(); }); });
savedFilter?.addEventListener('input', ()=>loadSaved());

function cardSaved(id,c){
  const title=c?.meta?.userLabel||id, assunto=c?.meta?.assunto||'', when=c?.meta?.lastMessageAt?new Date(c.meta.lastMessageAt).toLocaleString():'—';
  return `<div class="room" data-id="${id}" style="grid-template-columns:1fr auto;cursor:default">
    <div><div class="title">${esc(title)}</div><div class="sub">${esc(assunto)}</div>
    <div class="meta-line"><span class="wait">última: ${esc(when)}</span></div></div>
    <div style="display:flex;gap:6px;align-items:center">
      ${currentSavedTab==='saved'?`<button class="btn btn--pill btn--ghost" data-restore="${id}">Restaurar</button>`:''}
      <button class="btn btn--pill" data-purge="${id}">Apagar</button>
    </div></div>`;
}
async function loadSaved(){
  const base=currentSavedTab==='saved'?'saved':'archives';
  const term=(savedFilter?.value||'').toLowerCase().trim();
  const all=(await get(ref(db,base))).val()||{};
  const items=Object.entries(all).filter(([_,c])=>{ const s=[c?.meta?.userLabel,c?.meta?.assunto].join(' ').toLowerCase(); return !term||s.includes(term); });
  savedListEl.innerHTML=items.map(([id,c])=>cardSaved(id,c)).join('')||'<div style="padding:16px">Nada por aqui.</div>';
  savedListEl.querySelectorAll('[data-restore]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const id=b.getAttribute('data-restore'); const data=(await get(ref(db,`saved/${id}`))).val(); if(!data) return;
      await set(ref(db,`chats/${id}`),{ ...data.meta, lastMessage:data.meta.lastMessage||'', lastMessageAt:data.meta.lastMessageAt||Date.now(), lastMessageRole:data.meta.lastMessageRole||'system',
        status:{queue:false,closed:true,userOnline:false,adminOnline:false,typing:{user:false,admin:false}, newForOp:false } });
      await set(ref(db,`chats/${id}/messages`), data.messages||{}); alert('Restaurado para a fila de chats (fechado).');
    });
  });
  savedListEl.querySelectorAll('[data-purge]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const id=b.getAttribute('data-purge'); if(!confirm('Apagar definitivamente?')) return;
      await purgeChat(id); await remove(ref(db,`${base}/${id}`)).catch(()=>{}); loadSaved();
    });
  });
}

ensureOpSession(); startRoomsListener();
addEventListener('beforeunload', ()=>{ if(currentRoom) setAdminPresence(currentRoom,false); });
